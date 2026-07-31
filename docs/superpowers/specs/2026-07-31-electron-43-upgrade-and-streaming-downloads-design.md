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

以下每一条都对标了 VS Code、electron-updater、Signal Desktop、Joplin、Logseq 五个项目的真实实现（见文末「调研依据」）。

`downloadViaNetRequest` 改为流式写入临时文件，返回**文件路径**而非 Buffer：

- 用 `stream/promises` 的 `pipeline(response, createWriteStream(tmpPath))`，不要裸 `pipe` —— `pipeline` 会在任一环出错时自动销毁整条链、不泄漏文件句柄
- 临时文件用 `.part` 后缀，与最终文件同目录（跨盘 rename 不是原子操作）
- 超时改为**纯空闲超时：60 秒没有收到任何新数据才判超时**。**不设整体超时** —— 五个对标项目无一对下载设整体超时，Joplin 的注释说得最直白：「60s is per-socket-idle, not total」。GB 级文件在慢网下会被整体超时误杀，而这种失败在测试环境（小文件、快网）永远复现不出来
- **`net.request` 不支持 Node 的 `timeout` 选项，传了是静默失效的**，必须自己 `setTimeout` + `abort()`。VS Code 为此专门写了处理（`requestService.ts`）。实施时要确认现有代码没有踩这个坑

落盘完成后、rename 之前做一次**完整性校验**：

- 读响应头的 `content-length`，与 `fs.stat().size` 比对，不符则删除 `.part` 并按失败处理
- 不做 checksum。业界的分界线很清楚：要被执行/安装的下载物全都校验（electron-updater sha512、Signal sha512+Ed25519、VS Code 更新包 sha256），纯内容数据普遍不做。我们下的是视频内容，属于后者。而且上游未必返回 hash，Content-Length 比对不依赖上游配合，成本几乎为零，能抓住绝大多数截断场景

校验通过后 `fs.rename()` 到最终路径：

- **rename 必须能扛 Windows 的 `EBUSY`** —— 杀毒软件扫描刚落盘的大文件会短暂锁住句柄，我们做 GB 级视频撞上的概率不低。照 electron-updater 的做法重试（60 次 × 500ms，只对 `EBUSY` 重试）
- rename 失败时先看目标是否已存在：可能是另一次调用抢先完成了，这种情况应当忽略而非报错（VS Code 的做法）

**启动时清理孤儿 `.part`**：崩溃残留会一直占磁盘。VS Code 在启动和取消时都会扫缓存目录删 `.tmp`。

`persistVideo` 相应改为：

- `attachments.ingest()` 传 `path` 而非 `buffer`（`AttachmentService` 已支持 path 入参且内部就是分块 pipeline + 流式 hash）
- COS 转存从 `relayBufferToCos` 换成 `relayFileToCos`（已存在，走 `sliceUploadFile` 分片流式）

改完之后，视频字节全程不进 JS 堆，且消除了当前「同一份字节在内存里躺两次」的浪费。

### 为什么 `.part` + rename 不是可选项

这是对标里唯一一条 **5/5 全中**的实践，连写得最随意的 Logseq（手写 `.on('data')` + `write()`、不处理背压、出错不清理残留）都老老实实做了 `.pending` + `renameSync`。

不做的后果很具体：进程被杀、断电、磁盘满，都会在目标路径留下一个大小合法、看起来正常的半截视频。而 `persistVideo` 的下游逻辑一旦靠「文件存在」判断就绪，就会直接把坏数据当成品用掉。

### 错误处理：重试必须分两层

对标发现的一个容易做错的地方：**传输层的重试只覆盖建连阶段**。一旦响应流开始（`resolve({ res, stream })` 已返回），传到 800MB 时断线，传输层是兜不住的——那时候请求早就 resolve 了。

业界的结构是两层：

- **传输层**只重试建连阶段的瞬时错误，白名单极窄且各家高度一致：`ECONNREFUSED` / `ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` / `EAI_AGAIN` / `ENETUNREACH` / `EPIPE` / `EHOSTDOWN` / `EHOSTUNREACH` / `EPROTO`，加 HTTP `413/429/503/5xx`。三条铁律：只重试幂等方法、取消不重试、线性退避
- **编排层**重试整个「下载 + 校验」流程（VS Code `ExtensionsDownloader.doDownload` 重试 2 次）

我们现有的 `retryDownload`（3 次，退避 3s / 6s）属于编排层，这点是对的，保持不变。但每次重试前必须删掉上一次的 `.part` 残留。

`persistVideo` 整体失败时的行为不变：任务仍标记 `succeeded`、`persistence: 'failed'`。本阶段不改变这个语义（改善它属于另一个话题：给失败的落盘留补救路径）。

### 测试

- 流式落盘：模拟分块响应，断言文件内容完整、`Buffer.concat` 不再出现在调用栈
- 空闲超时：模拟「连接不断但长时间无数据」，断言在 60 秒空闲阈值触发；同时断言「持续缓慢但有数据」不会超时
- Content-Length 校验：模拟响应头声明 100 字节但只写入 60 字节，断言 `.part` 被删除且按失败处理
- 原子落位：断言下载过程中最终路径不存在，只有校验通过后才出现
- `EBUSY` 重试：mock `fs.rename` 前两次抛 `EBUSY`、第三次成功，断言最终成功
- 目标已存在：mock rename 抛错且目标路径已存在，断言按成功处理而非报错
- 失败清理：模拟中途 error，断言 `.part` 被删除
- 孤儿清理：预置一个残留 `.part`，断言启动清理会删掉它

### 为什么不直接上 Phase 2

Phase 1 不引入任何新依赖，风险低、收益立刻兑现（消除 OOM 风险）。Phase 2 要引入续传状态管理，把它们分开，任何回归都能明确归因。

---

## Phase 2：自管 Range 断点续传

> **设计变更记录（2026-07-31）**：本阶段原方案是「迁移到 Electron 的 `DownloadItem` + `createInterruptedDownload`」。三路独立调研后推翻，改为自管 Range。推翻的理由记录在下一节——这是本设计里最重要的一个决定，后来人如果想改回去，请先读完那一节。

### 为什么放弃 DownloadItem（原方案）

**业界没有人用。** VS Code、Signal Desktop、Joplin、Logseq、electron-updater 五个项目全部自己写流式下载，`will-download` 在这些仓库里的命中数是 0。唯一在用的 Mattermost Desktop 是为了做用户可见的下载列表 UI（进度条、"在文件夹中显示"），而且它**明确放弃了跨重启续传**——启动时发现 `progressing` 状态的记录直接标记为 `interrupted`，不尝试恢复。

`createInterruptedDownload` 全站代码搜索 501 个命中，前 20 名全是 Electron/Chromium 自身源码、`electron.d.ts` 类型定义和语言绑定（Electron.NET、electron-sharp）。**找不到一个真实应用在调用它。**

**它的问题是结构性的：**

1. **Electron 退出时会取消下载并删除半成品文件。** 要做跨重启续传，必须在退出前自己硬链接或复制一份把数据抢救下来。`nav0-browser` 和 `theogravity/electron-dl-manager` 两个互不相关的项目各自独立发明了同一个 workaround。官方文档对此只字未提。
2. **`createInterruptedDownload` 缺 `lastModified` 时静默从 0 重下。** 维护者在 2017 年（issue #8061 评论串）就说「应该报错」，v43.2.0 的 `Session::CreateInterruptedDownload()` 至今只校验 `path` / `urlChain` / `length` / `offset`。而官方测试构造 interrupted 状态的方式是立刻 `cancel()`，此时 offset 为 0——**真正的非零偏移续传没有任何自动化测试守护**。
3. **`session.downloadURL` 丢 Referer。** 修复 PR #47625 只改了 `WebContents::DownloadURL()`，同版本的 `Session::DownloadURL()` 仍是无差别 `add_request_header`。上游若有防盗链会撞静默 403。
4. **Electron 不写 `.crdownload`**，`target_path` 与 `intermediate_path` 是同一个值——中途崩溃会在最终文件名上留下截断的视频。我们反而要自己再加一层 `.part`，而那层保护本来就是自研方案自带的。
5. **无窗口场景是逆流而上。** `session.downloadURL` 的 `will-download` 里 `webContents` 是 `null`；且一旦没有**同步**调用 `setSavePath`，会弹出一个后台进程里没人看得见的模态保存对话框，把流程挂死。
6. **鉴权与代理是死角。** issue #40557（open）下 401/407 不触发 `login` 事件，企业代理无法程序化应答。
7. **生命周期陷阱。** issue #44605（open，2024 年至今）：应用退出时约 1% 概率抛 `Object has been destroyed`；在 `updated` 回调里做同步长操作可 100% 复现。大视频下载周期长，正好是高危场景。

**唯一值得为 DownloadItem 保留的理由**是需要 Windows 任务栏下载进度、系统「下载」文件夹集成、或 Chrome 风格的下载管理面板。这些都不在需求里。

### 目标设计

Phase 1 已经把 `.part` 临时文件、Content-Length 校验、原子 rename 做好了。Phase 2 在此之上加断点续传，改动面很小：

**sidecar 元数据。** 与 `.part` 同目录写一个 `.part.meta` JSON，记录 `url` / `totalBytes`（来自首次响应的 `content-length`）/ `etag` / `lastModified` / `createdAt`。每次写入不需要更新它——真实偏移量直接取 `fs.stat('.part').size`，比维护一个计数器可靠得多（进程被杀时计数器会失真，文件大小不会）。

**续传请求。** 重启或重试时，若 `.part` 与 `.part.meta` 都存在且 URL 一致，发 `Range: bytes=<size>-`，并带上 `If-Range: <etag 或 lastModified>`。`If-Range` 是关键：服务端文件变了就会返回 200 全量而不是 206，我们据此判断必须从头来。

**响应判定，三条分支：**

- `206 Partial Content` 且 `Content-Range` 的起始偏移等于我们请求的 offset → 以 `'a'` 模式追加写入 `.part`
- `200 OK` → 服务端不支持 Range 或文件已变，删掉 `.part` 从头写
- 其他 → 按失败处理

**绝不静默降级。** 这正是 `createInterruptedDownload` 最让人不放心的地方。我们要在日志和返回值里如实区分「续上了，从第 N 字节继续」和「服务端不支持，本次为完整重下」。

**续传条件不成立时优雅退化。** 上游 `video_url` 可能是现场生成的流式响应、可能不支持 Range、可能不给 `ETag`/`Last-Modified`。任何一条不满足就退回 Phase 1 的完整下载——**Phase 1 的行为是 Phase 2 的下界，不是需要单独维护的 fallback 分支**。这比原方案的「保留两套实现互为 fallback」干净得多。

### 开工前的待验证项

**上游是否支持 Range。** 对 Seedance 返回的 `video_url` 发一个 `Range: bytes=0-1023` 的探测请求，看是否返回 `206` 以及 `Accept-Ranges`、`ETag`、`Last-Modified` 三个响应头是否齐备。如果上游是对象存储直出（大概率）则支持；如果是 API 现场流式生成则不支持，那 Phase 2 直接没有意义，应当取消而不是硬做。**这个验证成本只有一条 curl，必须在写任何代码之前完成。**

注意：原方案里「`video_url` 是否自带签名」那个待验证项**不再是阻塞项**——自管 Range 时 header 完全由我们自己设，不存在 `createInterruptedDownload` 不支持 headers 那种不对称。

### 测试

全部可以用纯 Node 单测覆盖，不需要真实 Electron 运行时——这也是自管方案相对 DownloadItem 的一个实际优势：

- 续传成功：预置 60 字节的 `.part` + meta，mock 服务端返回 `206` 且 `Content-Range: bytes 60-99/100`，断言最终文件 100 字节且内容正确
- 服务端不支持 Range：mock 返回 `200`，断言 `.part` 被清空重写、且返回值标明「本次为完整重下」
- 文件已变：mock `If-Range` 不匹配时返回 `200`，断言从头下载
- `Content-Range` 起始偏移与请求不符：断言按失败处理而非盲目追加（否则会拼出损坏文件）
- meta 缺失或 URL 不匹配：断言忽略残留 `.part`，从头下载

---

## 保持不变的决定

**继续用 `net.request` 而非 `net.fetch` 下载。** `net.fetch` 在响应头含非 Latin1 字符时抛 TypeError（上游视频代理会在 `Content-Disposition` 里塞 prompt 派生的中文文件名）。对应 issue electron/electron#42244 状态为官方已确认（`status/confirmed`），至今 open，42/43 均未修复，且无关联修复 PR。相关的 #46819 是被 stale bot 自动关闭的，不是修好了。

实施时应在现有绕行注释里补上 issue 号 `electron/electron#42244`，方便日后 revisit。

**不使用 `net.fetch` + `ReadableStream` 做流式上传。** Electron 文档对此既无背书也未列入限制清单，且 issue #39658 的实测堆栈显示会抛 `ERR_INVALID_ARG_TYPE`（内部经 `webstreams/adapters` 桥到 `ClientRequest.write()`）。`duplex: 'half'` 在 Electron 文档中完全未提及。

---

## 风险汇总

| 风险 | 阶段 | 评级 | 缓解 |
| --- | --- | --- | --- |
| **自定义协议跨域 fetch 被拦** | 0 | **高** | GHSA-v3j7-r9gq-3gjw 在 41.4.0 落地，我们停在 41.2.1 尚未吃到。`protocolHandler.ts` 的 `local-file` 正是 `supportFetchAPI: true` 且无 `corsEnabled`。代码里已普遍改走 IPC 读字节转 blob（`AudioPage.ts` 注释明写「renderer fetch(local-file://) 会被协议门拦」），但必须冒烟实测图片缩略图、音频波形、视频预览三处 |
| electron-vite 因 `path.txt` 缺失而构建失败 | 0 | 中 | postinstall 追加 `install-electron`；本地先验证 dev/build 都能跑 |
| 原生模块在 ABI 148 下失效 | 0 | 低 | sharp 与 @parcel/watcher 均走 N-API，两仓库无任何 43/ABI 148 报告；仍需真实打包 + 启动冒烟验证 |
| Chromium 跨四个里程碑导致渲染层行为差异 | 0 | 低 | Electron E2E + 启动冒烟 |
| electron-builder 26.15.x 自身回归 | 0 | 中 | **本次不升 electron-builder**，锁在 26.4.0。它现在 open 的回归比 Electron 43 还多 |
| 空闲超时改造引入新的挂起路径 | 1 | 低 | 60 秒无数据即断；不设整体超时是有意为之，理由见 Phase 1 |
| `net.request` 的 `timeout` 选项静默失效 | 1 | 中 | 实施时确认现有代码没有依赖它，改用 `setTimeout` + `abort()` |
| Windows 上 rename 撞 `EBUSY` | 1 | 中 | 对 `EBUSY` 重试 60 次 × 500ms（照 electron-updater） |
| 上游不支持 Range，Phase 2 无从做起 | 2 | — | 开工前一条 curl 探测即可判定；不支持就取消 Phase 2 而不是硬做 |
| 续传静默变成重下 | 2 | 中 | 用 `If-Range` + 校验 `Content-Range` 起始偏移；如实区分「续上了」与「完整重下」，绝不静默降级 |
| 续传拼出损坏文件 | 2 | 中 | `Content-Range` 起始偏移与请求不符时按失败处理，不盲目追加 |

## 调研依据

本设计的关键判断都来自一手取证，不是经验之谈。留下线索方便日后复核：

**Electron 官方文档与源码**（41-x-y / 42-x-y / 43-x-y 分支的 `docs/breaking-changes.md`、`docs/api/*.md`、`shell/browser/api/electron_api_session.cc`、`npm/install.js`），以及 `releases.electronjs.org/schedule` 的 EOL 日程。

**Electron issue tracker**：#42244（`net.fetch` 非 Latin1 响应头，open、官方已确认、43 未修）、#8061 与 #9246（`createInterruptedDownload` 缺 `lastModified` 静默从 0 重下）、#47625（Referer 修复只打在 `webContents.downloadURL`）、#40557（下载不触发 `login` 事件，open）、#44605（退出时 `Object has been destroyed`，open）、#52307（`locales/` 为空导致 Windows 启动崩溃，open）。

**业界源码对标**（五个项目的真实实现，全部核到文件与行号）：microsoft/vscode 的 `updateService.win32.ts`（`.tmp` → sha256 → rename）与 `extensionDownloader.ts`（UUID 临时名 + 整包重试 2 次）、electron-builder 的 `httpExecutor.ts`（`DigestTransform` 流内校验、`socket.setTimeout(60s)`、rename 扛 `EBUSY` 60 次）、signalapp/Signal-Desktop 的 `common.main.ts` 与 got 配置、laurent22/joplin 的 `EmbeddingModelDownloader.ts`（注释明写 per-socket-idle）、logseq 的 `plugin.cljs`（`.pending` + `renameSync`）。

**关键统计**：五个生产项目中，流式落盘 5/5、`.part`+rename 5/5、整体超时 0/5、使用 `DownloadItem` 0/5。

`npm view electron@43.2.0 scripts` 返回空（无 `scripts` 字段），而当前 41.2.1 为 `{"postinstall":"node install.js"}` —— 这是「postinstall 不再下载二进制」的直接实证。

## 交付节奏

三个阶段各自独立 PR、串行合入，**每个阶段单独出一份实施计划**——本文档是三阶段共用的设计依据，不是实施计划本身。合成一份计划会让 Phase 0 的配置改动和 Phase 2 的下载栈重写混在同一个验证周期里，出问题时归因成本过高。

Phase 0 因 EOL 时间压力优先：41 的 EOL 是 2026-08-25，本文档写作时约三周半。Phase 1 和 Phase 2 无外部期限，按 Phase 0 的落地情况顺次排。
