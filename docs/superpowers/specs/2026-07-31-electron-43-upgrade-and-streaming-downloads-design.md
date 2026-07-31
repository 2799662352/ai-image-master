# Electron 43 升级与下载流式化

日期：2026-07-31
状态：设计已确认，待转实施计划

## 背景

一次针对「MCP 生成图片/视频/音频」全链路的健壮性审计暴露出两件事。

**上传侧已经是最佳实践。** 本地文件走 COS SDK 的 `sliceUploadFile` 分片上传，整文件不进 Node Buffer，超时按体积放大，失败有退避重试。Electron 官方对大 body 的建议（`ClientRequest.chunkedEncoding` + `write()`，文档原话 "strongly recommended ... instead of being internally buffered inside Electron process memory"）针对的是自己发 HTTP 请求的场景，我们走 SDK，不适用也不需要改。

**下载侧只做了一半。** 五条下载路径里两条流式、三条把整个响应读进内存：

| 路径 | 现状 | 断点续传 |
| --- | --- | --- |
| `seedance/client.ts` `downloadVideo` | `Buffer.concat` 全量进内存 | 无 |
| `main/utils/fetchImageBytes.ts` | `arrayBuffer()` 全量 | 无 |
| `seedance/runtime.ts` `download_portrait_asset` | `pipeline` 流式 | 无，且零重试 |
| `tencent/historyBucketTransfer.ts` | `pipeline` 流式 | 无 |
| `main/index.ts` 若干另存为 | `arrayBuffer()` 全量 | 无，部分无超时 |

其中视频那条最要命：一个 1080p 长视频先整个进 RAM，再把同一份 Buffer 交给 COS 上传——同一份字节在内存里躺两次；120 秒是**整次下载**的硬预算而非空闲超时，慢网下三次重试会连续撞同一堵墙；断线从零重下。而这条路径的失败后果不可逆——`persistVideo` 失败后任务仍标记 `succeeded`、`persistence: 'failed'`，本地无文件、COS 无副本，只剩上游会过期的地址，没有第二轮补救。

与此同时，我们用的 Electron 41 在 **2026-08-25 EOL**（本文档写作时约三周半后）。

## 目标

1. 把 Electron 从 41.2.1 升到 43.2.0，脱离 EOL 窗口。
2. 消除视频下载的内存驻留，让下载全程流式落盘。
3. 引入断点续传，让大文件下载能扛住网络中断和应用重启。

## 非目标

- 不改上传链路（已是最佳实践）。
- 不改 `fetchImageBytes`：图片体积小，全量 buffer 的内存代价可接受，它的错误分类反而是全仓库做得最细的，不动。
- 不给 `download_portrait_asset` 补重试。它已经是流式的，且失败后果可逆——agent 直接再调一次工具即可，临时文件也清理干净。它的零重试属于「可以更好」而非「有缺陷」，混进本设计只会扩大验证面。
- 不顺手清理 `main/index.ts` 里那几处另存为路径。它们是边缘功能，与本设计的主线（生成结果落盘）无关，留给后续单独处理。
- 不撤销 `net.fetch` 的绕行。见下方「保持不变的决定」。

## 关键前提：两件事技术上不耦合

`session.downloadURL` 自 Electron 8.0.0 起可用，`options.headers` 自 25.3.0 起可用，`DownloadItem` 与 `createInterruptedDownload` 一直都有。**我们现在的 41.2.1 已经全部支持**，下载重构不需要等升级。三个阶段串行只是排期选择，理由是 EOL 有硬期限而重构没有，且升级需要干净基线才能对回归明确归因。

---

## Phase 0：Electron 41.2.1 → 43.2.0

### 为什么是 43 而不是 42

41 的 EOL 是 2026-08-25，42 的 EOL 是 2026-10-20。升到 42 意味着两个半月后还要再升一次。43 于 2026-06-30 发布，EOL 到 2027-01-05，是当前 `electron@latest`。

跳版本没有任何官方限制——`breaking-changes.md` 按 major 分节，把 42.0 和 43.0 两节合并阅读就是完整变更集。

### 版本对照

|  | Chromium | Node.js | V8 | Electron ABI |
| --- | --- | --- | --- | --- |
| 41.2.1（当前） | 146.0.7680.188 | v24.14.1 | 14.6 | 145 |
| 43.2.0（目标） | 150.0.7871.129 | v24.18.0 | 15.0 | 148 |

Node 没有跨 major（同为 v24），因此不涉及 API 移除、`node:` 前缀要求变化或 OpenSSL major 迁移。

### 确定要改

**1. CI 的 Node 版本：20 → 22**

`electron@43.2.0` 的 `engines.node` 是 `">= 22.12.0"`。仓库六个 workflow 全部写死 `node-version: '20'`，逐个抬到 `'22'`。

**2. `package.json` 的 postinstall 追加 `install-electron --no`**

Electron 42 起 npm 包不再通过 `postinstall` 下载二进制（供应链安全考虑，RFC #22），改为首次运行 `bin` 脚本时按需下载。而 `electron-vite@5.0.0` 的 `getElectronPath()` 读 `node_modules/electron/path.txt`，读不到就 `throw new Error('Electron uninstall')`——`dev`、`build`、`preview` 三条命令全部会挂。官方修复 PR（alex8088/electron-vite#905）至今未合并。

现有 postinstall 是 `prisma generate && electron-builder install-app-deps`，追加即可：

```
"postinstall": "install-electron --no && prisma generate && electron-builder install-app-deps"
```

放在最前面，因为后面两步都可能依赖 Electron 二进制已就位。

**3. 构建 target 抬到与运行时匹配**

`electron.vite.config.ts` 现在写的是 `target: 'node18'`（main、preload）和 `chrome120`（renderer）。显式写死这件事本身是对的——它让我们躲过了 electron-vite 版本表只更新到 39、查不到就兜底成最老项（`node16.17` / `chrome108`）的坑。但 node18/chrome120 对 Node 24.18 / Chrome 150 来说过旧，白白降级转译、产物变大。改为 `node24` 和 `chrome150`。

### 需要实测验证

**原生模块在 ABI 148 下的表现。** ABI 从 145 跳到 148，原生模块原则上要重编。我们有两个原生依赖：`sharp`（`@img/sharp-<platform>-<arch>` 提供 `.node`，走 media:thumb 热路径）和 `@parcel/watcher`。两者都走 N-API，理论上 ABI 稳定、免疫此次跳变，且 `electron-builder install-app-deps` 会兜底。但这属于不打包跑起来就无法断言的事，必须实测。

### 明确不改（已逐条 grep 核实）

- **`clearStorageData` 的 `quotas` 移除（42.0）**：三处调用（`index.ts` 553 / 2492 / 2746）都只传 `storages`，不受影响。
- **`nativeImage.toBitmap()` 默认归一化到 sRGB（43.0）**：代码库无 `toBitmap` / `getBitmap` 调用。
- **`electronDist` 配置**：未配置，electron-builder 走 `@electron/get` 自行下载 zip，对 postinstall 变更天然免疫。
- **32 位发行**：不发 `win32-ia32`。（但需记录：43 是最后一个提供 32 位预编译产物的系列。）
- **V8 bytecode 缓存**：未开启 electron-vite 的 `build.bytecode`。
- **`ELECTRON_SKIP_BINARY_DOWNLOAD`**：CI 中未使用。
- **43 的四条 Linux 相关变更**（圆角、WCO 布局、`showHiddenFiles` 移除、`chrome.scripting` CSS 注入）：与本项目无关。
- **`utilityProcess`（PGlite worker）**：逐行比对 41 与 43 的 `utility-process.md`，`fork` 签名、stdio 默认值、`exit` 事件负载、MessagePort 行为**一字未改**，差异只有新增的 `session` / `partition` 选项和实例级 `login` 事件；不传 `session` 时行为与 41 完全一致。
- **`net` / `DownloadItem` / `protocol` / `webContents` / `contextBridge` / sandbox 默认值**：42.0 与 43.0 两节破坏性变更清单中均无对应条目。

### 一个需要留意但不阻塞的行为变化

43 起 `dialog.showOpenDialog` / `showSaveDialog`（及其 Sync 版本）在未显式提供 `defaultPath` 时，默认目录改为用户的「下载」文件夹，**且操作系统不再记忆用户上次选择的目录**。这会间接影响未调用 `setSavePath()` 的 `DownloadItem` 弹出的保存对话框。当前代码不依赖该行为，但 Phase 2 引入 `DownloadItem` 后若出现需要用户选择保存位置的场景，应显式传 `defaultPath`。

### 验证口径

升级 PR 必须全部通过：

1. `typecheck:ci` 债务门禁 0 新增
2. 全量单测
3. Electron E2E（CI 已有 `Quality Gate / Electron Stable E2E`）
4. `build:win` 真实打包成功
5. **启动冒烟**，重点验证三处原生/子进程集成：PGlite worker 能起来且能读写、sharp 缩略图能出图、codex 子进程能拉起

第 4、5 项无法靠 CI 覆盖，需要本地执行并在 PR 里留下记录。

### 回滚

单一 PR、改动集中在 `package.json` / workflow / vite config 三处配置，回滚即 revert。不涉及业务代码，无数据迁移。

---

## Phase 1：视频下载流式落盘

### 现状

`seedance/client.ts` 的 `downloadViaNetRequest` 用 `net.request` 收集 chunk，`response.on('end')` 时 `Buffer.concat(chunks)` 返回完整 Buffer。调用方 `runtime.ts` 的 `persistVideo` 拿到 Buffer 后做两件事：交给 `attachments.ingest()` 落盘，以及交给 `relayBufferToCos()` 上传。

用 `net.request` 而非 `net.fetch` 是有意为之，见「保持不变的决定」。

### 目标设计

`downloadViaNetRequest` 改为流式写入临时文件，返回**文件路径**而非 Buffer：

- `pipeline(response, createWriteStream(tmpPath))`，与 `download_portrait_asset` 和 `historyBucketTransfer` 已有的写法保持一致
- 失败时清理临时文件
- 超时语义从「整次下载硬预算」改为**空闲超时**：**60 秒没有收到任何新数据**才判超时，避免大文件在慢网下必然撞墙；同时保留 **30 分钟**的总时长上限防止无限挂起。两个数字都定为常量并写明依据——60 秒远大于正常的 TCP 抖动窗口，30 分钟按最悲观的 0.5MB/s 下行估算足够拉完一个 1080p 长视频

`persistVideo` 相应改为：

- `attachments.ingest()` 传 `path` 而非 `buffer`（`AttachmentService` 已支持 path 入参且内部就是分块 pipeline + 流式 hash）
- COS 转存从 `relayBufferToCos` 换成 `relayFileToCos`（已存在，走 `sliceUploadFile` 分片流式）

改完之后，视频字节全程不进 JS 堆，且消除了当前「同一份字节在内存里躺两次」的浪费。

### 错误处理

保持现有的三次重试与退避不变（`retryDownload`，退避 3s / 6s）。重试前必须清理上一次的残留临时文件——`createWriteStream` 默认 `'w'` 模式会截断，但显式清理更清楚。

`persistVideo` 整体失败时的行为不变：任务仍标记 `succeeded`、`persistence: 'failed'`。本阶段不改变这个语义（改善它属于另一个话题：给失败的落盘留补救路径）。

### 测试

- 流式落盘：模拟分块响应，断言文件内容完整、`Buffer.concat` 不再出现在调用栈
- 空闲超时：模拟「连接不断但长时间无数据」，断言在空闲阈值触发而非总时长阈值
- 失败清理：模拟中途 error，断言临时文件被删除
- 重试：模拟第一次失败第二次成功，断言最终产物正确且临时文件无残留

### 为什么不直接上 Phase 2

Phase 1 不引入任何新 Electron API，风险低、收益立刻兑现（消除 OOM 风险）。Phase 2 要替换整条下载栈，且要处理并发关联和续传缺口——把它们分开，任何回归都能明确归因。

---

## Phase 2：迁移到 DownloadItem，引入断点续传

### 为什么值得做

Electron 官方提供了完整的下载栈，能整体替换我们手写的实现：

| 手写实现 | 官方替代 |
| --- | --- |
| `net.request` 发起下载 | `session.downloadURL(url, { headers })` |
| 自己收 `data` 事件 | `will-download` → `DownloadItem` |
| 自己管落盘 | `item.setSavePath(path)`，字节走 Chromium 下载栈不经 JS 层 |
| 自己算进度 | `getReceivedBytes()` / `getTotalBytes()` / `getPercentComplete()` / `getCurrentBytesPerSecond()` |
| 无暂停/取消 | `pause()` / `resume()` / `canResume()` / `cancel()` |
| 无断点续传 | `session.createInterruptedDownload()` |

顺带的收益：`item.getContentDisposition()` 走 Chromium 下载栈，不经过 undici 的 Latin1 校验，天然绕开中文文件名那个坑。

### 设计

新建 `src/main/services/download/downloadManager.ts`，对外暴露一个 promise 化的接口，内部封装：

**请求关联。** `will-download` 是 session 级全局事件，没有 correlation id。发起下载前把 URL 记入 pending map，在 handler 里用 `item.getURL()` 反查。若出现并发下载命中同一 URL 的场景，改用 `session.fromPartition()` 为每个下载建独立 session 实现天然隔离。

**续传状态持久化。** 下载中断时保存 `getSavePath()` / `getURLChain()` / `getReceivedBytes()`（→ `offset`）/ `getTotalBytes()`（→ `length`）/ `getLastModifiedTime()` / `getETag()` / `getStartTime()` / `getMimeType()`。应用重启后用 `createInterruptedDownload()` 喂回去，再调 `resume()`。

### 两个必须正面处理的缺口

**一、`createInterruptedDownload` 不支持 headers。** `downloadURL` 有 `options.headers`，续传入口没有——这是官方 API 的真实不对称，文档未提供解法。实施前必须先确认 Seedance 返回的 `video_url` 是否自带签名（临时 URL）：是则不受影响；否则续传路径会丢失鉴权，届时该路径只能降级为从头重下。**这是 Phase 2 开工前的第一个待验证项。**

**二、`resume()` 在服务端不支持 Range 时静默从头下载。** 官方文档明确：服务端必须支持 range requests 并同时提供 `Last-Modified` 和 `ETag`，否则 `resume()` 会「dismiss previously received bytes and restart from the beginning」——失败模式是静默回退而非报错。因此续传后必须校验 `getReceivedBytes()` 是否从 `offset` 起步，不是则如实上报「本次为完整重下」而不是假装续上了。

### fallback 策略

Phase 1 的流式实现保留，不删。`downloadManager` 暴露开关，DownloadItem 路径失败或环境不支持时回落到 Phase 1 实现。这条路径的失败后果不可逆（落盘失败等于视频永久丢失），不接受「新实现有 bug 就没有退路」。

### 测试

DownloadItem 依赖真实 Electron 运行时，单测覆盖不到，因此：

- 纯逻辑部分（URL 关联、续传状态的序列化/反序列化、`offset` 校验判据）抽成纯函数单测
- 端到端行为放进 Electron E2E：正常下载、中途 `pause()`/`resume()`、模拟中断后用 `createInterruptedDownload` 接上、服务端不支持 Range 时能识别出「实际是重下」
- fallback 切换路径要有显式用例

---

## 保持不变的决定

**继续用 `net.request` 而非 `net.fetch` 下载。** `net.fetch` 在响应头含非 Latin1 字符时抛 TypeError（上游视频代理会在 `Content-Disposition` 里塞 prompt 派生的中文文件名）。对应 issue electron/electron#42244 状态为官方已确认（`status/confirmed`），至今 open，42/43 均未修复，且无关联修复 PR。相关的 #46819 是被 stale bot 自动关闭的，不是修好了。

实施时应在现有绕行注释里补上 issue 号 `electron/electron#42244`，方便日后 revisit。

**不使用 `net.fetch` + `ReadableStream` 做流式上传。** Electron 文档对此既无背书也未列入限制清单，且 issue #39658 的实测堆栈显示会抛 `ERR_INVALID_ARG_TYPE`（内部经 `webstreams/adapters` 桥到 `ClientRequest.write()`）。`duplex: 'half'` 在 Electron 文档中完全未提及。

---

## 风险汇总

| 风险 | 阶段 | 缓解 |
| --- | --- | --- |
| 原生模块在 ABI 148 下失效 | 0 | 真实打包 + 启动冒烟三点验证；`install-app-deps` 兜底 |
| electron-vite 因 `path.txt` 缺失而构建失败 | 0 | postinstall 追加 `install-electron --no`；本地先验证 dev/build 都能跑 |
| Chromium 跨四个里程碑导致渲染层行为差异 | 0 | Electron E2E + 启动冒烟 |
| 空闲超时改造引入新的挂起路径 | 1 | 保留宽松的总时长上限作为兜底 |
| 续传丢鉴权 | 2 | 开工前先验证 `video_url` 是否自带签名 |
| 续传静默变成重下 | 2 | 校验 `getReceivedBytes()` 起点并如实上报 |
| DownloadItem 新实现有 bug 导致视频永久丢失 | 2 | 保留 Phase 1 实现作为 fallback |

## 交付节奏

三个阶段各自独立 PR、串行合入，**每个阶段单独出一份实施计划**——本文档是三阶段共用的设计依据，不是实施计划本身。合成一份计划会让 Phase 0 的配置改动和 Phase 2 的下载栈重写混在同一个验证周期里，出问题时归因成本过高。

Phase 0 因 EOL 时间压力优先：41 的 EOL 是 2026-08-25，本文档写作时约三周半。Phase 1 和 Phase 2 无外部期限，按 Phase 0 的落地情况顺次排。
