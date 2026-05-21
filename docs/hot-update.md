# CATIMATION 热更新发布指南

## 架构概览

应用采用 **COS 优先 + GitHub 兜底** 的双源热更新机制：

```
用户客户端启动
  │
  ├─① 检查腾讯云 COS（国内加速）
  │    https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/latest.yml
  │
  ├─ 成功 → 提示更新 / 下载安装
  │
  └─ 失败 → ② 自动切换 GitHub Releases（海外 / 备用）
       https://github.com/2799662352/ai-image-master/releases
```

核心文件：

| 文件 | 作用 |
|------|------|
| `src/main/updater.ts` | AutoUpdater 类，封装 electron-updater，支持 `switchProvider` 和 `fallback` |
| `src/main/index.ts` | 初始化 updater，配置 COS 主源 + GitHub fallback |
| `electron-builder.yml` | 构建配置，`publish` 段声明 COS + GitHub 双发布目标 |
| `scripts/upload-cos.js` | COS 上传脚本（exe + blockmap + latest.yml） |
| `cos-credentials.json` | 腾讯云 COS 内置凭据（gitignored，打包时通过 extraResources 带入） |

## 发布新版本

### 1. 修改版本号

```bash
# package.json → "version": "x.y.z"
```

### 2. 构建

```bash
npm run build:win
```

产物在 `release/` 目录下：
- `catimation-cyberpunk-master-{version}-setup.exe` — 安装包
- `catimation-cyberpunk-master-{version}-setup.exe.blockmap` — 差分更新数据
- `latest.yml` — 版本元数据（electron-updater 靠它判断是否有新版）

### 3. 上传到 COS（国内用户）

```bash
npm run upload:cos
```

需要 `.env` 文件中配置：
```
COS_SECRET_ID=你的SecretId
COS_SECRET_KEY=你的SecretKey
COS_BUCKET=map-tiles-bucket-1345773498
COS_REGION=ap-guangzhou
```

或一步到位（构建 + 上传）：
```bash
npm run release:cn
```

### 4. 上传到 GitHub（海外 / 备用）

手动上传：
1. 到 https://github.com/2799662352/ai-image-master/releases 创建新 Release
2. Tag 填 `v{version}`（如 `v4.1.16`）
3. 上传 `release/` 下的三个文件

或用 CLI：
```bash
gh release create v4.1.16 --title "v4.1.16" --notes "更新说明" \
  release/catimation-cyberpunk-master-4.1.16-setup.exe \
  release/catimation-cyberpunk-master-4.1.16-setup.exe.blockmap \
  release/latest.yml
```

## Fallback 机制

在 `updater.ts` 中实现：

```typescript
// 初始化时配置 fallback
const updater = getAutoUpdaterInstance({
  provider: 'generic',
  url: 'https://...cos.../releases/',
  fallback: {
    provider: 'github',
    owner: '2799662352',
    repo: 'ai-image-master'
  }
})
```

当 COS 检查更新失败（网络超时、DNS 错误等），`autoUpdater.on('error')` 触发后：
1. 如果还没 fallback 过 → 自动调用 `switchProvider()` 切换到 GitHub
2. 用 GitHub 源重新 `checkForUpdates()`
3. 如果 GitHub 也失败 → 向用户显示错误

## 差分更新

`electron-builder` 的 NSIS 差分更新（blockmap）已启用：

```yaml
# electron-builder.yml
nsis:
  differentialPackage: true
```

用户更新时只下载变化的部分，而非整个 250MB 安装包。前提是 COS / GitHub 上同时存在：
- 新版 `.exe` + `.blockmap`
- `latest.yml`

## 常见问题

### Q: 老版本客户端检测不到 COS 上的更新？

老版本（< v4.1.15）在代码中硬编码了 `provider: 'github'`，只会检查 GitHub。用户需要先手动安装 v4.1.15+，之后的热更新才会走 COS。

### Q: COS 和 GitHub 的 latest.yml 版本不一致？

两边独立上传，可能短暂不一致。建议每次发版都同时上传两边。COS 用 `npm run upload:cos`，GitHub 手动上传或用 `gh` CLI。

### Q: 上传 COS 时 ECONNRESET？

通常是代理/VPN 干扰了 TLS 握手。切换直连或换节点后重试。

### Q: latest.yml 在 COS 上缓存了旧版本？

腾讯云 COS 默认不缓存，上传即生效。如果用了 CDN 加速，需要刷新缓存：
```
https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/latest.yml
```

## Changelog

### v4.3.14 (2026-05-21) — 批量完成卡顿根除 + COS 上传事件驱动重构

**A. 批量页完成瞬间卡顿修复(根因 #1)**

**问题**: 5 张图批量生成完成时，UI 卡顿 150-750ms,"开始生成"按钮无法及时回到可点击状态。

**根因**: `runBatch` finally 里串行 `await historyService.addToHistory(...)` × N，每次都触发 `historyManager.add() → await this.save() → IPC 序列化整个 history 数组 → fs.writeFile(history.json)`。5 张图 = 5 次串行 IPC + 5 次整文件写入，期间 `running=true` 不能切换 → UI 状态卡住。

**修复** (`src/renderer/src/stores/useBatchStore.ts`):

| 改动 | 说明 |
|------|------|
| 删除 finally 里的串行 history 循环 | `runBatch` 末尾不再写 history，立即 `set({running: false})` |
| History 写入下放到 `batch:` COS 事件 handler | 每张图 COS 上传完成时各自异步写一条 history，不阻塞 UI 关键路径 |
| `pendingBatchHistoryContext` Map | 暂存 prompt/ratio/refRaw/modelKey/modelUrl 等闭包变量，event handler 按 itemId 查表后 delete 防泄漏 |
| `removeItem` / `clearAll` 清理 context | 保持"删除/清空后不进 history"语义 |

**额外收益**: History 持久化用 **cosUrl** 而不是会过期的 modelUrl。旧版批量结束时 cosUrl 大概率没回来 → 只能 fallback modelUrl → 几小时后 history 失效。新版在 COS 上传成功后才写，写的就是永久 cosUrl，失败才 fallback。

**B. COS 上传从"预测返回"重构为"事件回推"(根因 #2)**

**v4.3.13 遗留问题**: 立即返回预测 URL + `setImmediate` 延迟实际上传，导致 thumbnail 在 COS 上传完成前就被浏览器请求 → 缓存 404 → 略缩图不显示。

**修复** (`src/main/index.ts` + `src/preload/index.ts`):

| 改动 | 说明 |
|------|------|
| 新 IPC `cos:enqueue-upload-from-url` | 立即返回 `{queued: true}`，主进程后台 fetch URL → buffer → 上传 |
| 新事件 `cos:upload-result` | 主进程通过 `webContents.send` 广播上传结果给所有窗口 |
| `cos:upload-image-history` 恢复 await | 旧 IPC 改回真正 await `enqueueUpload` 完成才 return → 修复 thumbnail 404 |
| `enqueueUpload` 主进程并发门 | 4-wide gate 保留，未 settle 的 `Promise` 收集到 `inflightUploads`，`before-quit` 5s 内 drain |
| `cos:upload-image-from-url` (await 版本) | 保留给需要同步拿到 URL 的调用点 |

**C. 渲染端真 fire-and-forget(根因 #3)**

**问题**: 渲染端 batch / generate 路径每张图都 `void uploadImageUrlToCos().then(set + history)`，N 张图同时完成时 = N 个 pending promise + N 个 .then 微任务 + N 次 React 重渲染，UI 感知卡顿。

**修复**:

| 文件 | 改动 |
|------|------|
| `src/renderer/src/utils/cosUploadDispatcher.ts` (新) | 全局事件路由器，按 `prefix:` 前缀分发到各 store; `enqueueCosUpload(itemId, url, metadata)` 同步入队 0 promise |
| `src/renderer/src/stores/useBatchStore.ts` | 模块底部注册 `batch:` handler，runOne 改用 `enqueueCosUpload` |
| `src/renderer/src/stores/useGenerateStore.ts` | 模块底部注册 `generate:` handler，generate() 改用 `enqueueCosUpload`，删除 N 个并行 `await uploadImageUrlToCos().then()` |

**D. 结果卡显示优先级修复**

**问题**: COS 上传完成后切 `src={cosUrl}`，浏览器要重新下载 + 解码同一张图，N 张同时切 = 主线程卡顿 + thumbnail 闪烁。

**修复** (`src/renderer/src/pages-react/batch/BatchResultGrid.tsx`, `BatchItemRow.tsx`, `batch-punk/PunkResultGrid.tsx`, `useGenerateStore.ts`):

| 改动 | 说明 |
|------|------|
| `pickDisplayUrl: resultUrl ?? cosUrl` | 优先用已加载的模型 URL 展示，避免重新下载/解码 |
| 删除 `useGenerateStore` 里的 `nextUrls[idx] = res.url` 热切 | cosUrl 只通过 resultMeta 暴露给持久化层，live view 继续吃 modelUrl 直到 session 结束 |

**E. 历史页云端徽章修复**

**问题**: `inferStatus` 用 `r2Storage` 字段判断"是否云端"，但新 COS 上传不写 r2Storage → 5 张云端图只有 1 张显示云端徽章。

**修复** (`src/renderer/src/hooks/useHistoryData.ts`):

- 新增 `isCosUrl(url)` helper 检测 `*.cos.*.myqcloud.com` 模式
- `inferStatus` 兜底: `r2Storage` 优先 → `urls` 含 cosUrl → 视为 'ok-cloud'

#### 用户可见行为

1. **批量 5 张生成完成那一刻 UI 不再卡顿**，"开始生成"按钮立刻回到可点击状态
2. **生成多张同时完成不再卡顿**，渲染端零 pending promise 0 .then 微任务
3. **历史页所有云端图都显示 COS 徽章**，不再"只显示一个"
4. **批量历史用 cosUrl 持久化**，不再因 modelUrl 过期失效
5. Thumbnail / 略缩图 100% 显示（修复 v4.3.13 的 use-before-upload race regression）

---

### v4.3.13 (2026-05-21) — COS 图片上传异步化 + 新增 21 个 Storyboard 技能

**A. COS 图片上传性能优化**

**问题**: 用户在生图后触发 COS 历史图片上传时 UI 卡顿，主进程被 `uploadBufferToBucket` 的网络 I/O 阻塞。

**修复** (`src/main/index.ts`):

| 改动 | 说明 |
|------|------|
| Fire-and-forget 返回 | IPC handler 立即返回预测 URL（`https://{bucket}.cos.{region}.myqcloud.com/{key}`），不再 await 上传完成。渲染进程零等待 |
| 主进程并发控制 | 新增 `enqueueUpload()` + `inflightUploads: Set<Promise>`，最多 4 个并发上传。因 IPC 瞬间返回，渲染侧 semaphore 不再有效约束实际并发，改在主进程侧兜底 |
| 优雅退出 drain | `before-quit` handler 中等待 `inflightUploads` settle（最多 5 秒超时），防止关闭 app 时丢上传 |
| 输入验证保留 | `Buffer.from(base64)` + `byteLength === 0` 检查保留在返回之前，无效 payload 仍返回 `{ success: false }` |

**B. 新增 21 个 Storyboard/Director 技能**

从 super-i.cn 提取并创建 21 个中文 SKILL.md 文件，覆盖伪透视、鲁棒性破坏、负面控制、特征坍缩、时间词、导演思维、角色表演、动机驱动、色彩分级、创意想象、情感蒙太奇、前景遮挡、运动学逆向工程、光线重建、真人角色写实、多角色控制、场景拆解、镜头情绪匹配、风格提取逻辑、视频提示词优化、声音控制等方向。已全部注册到 `skill-versions.json` 并更新 `codex-research-grounded-prompting` 母 skill 的 companion 路由表。

#### 用户可见行为

1. 生图后 COS 上传不再卡顿 UI，图片 URL 即时可用
2. Skill Marketplace 新增 21 个可安装技能

---

### v4.3.12 (2026-05-21) — F11 全屏回归(因 `Menu.setApplicationMenu(null)` 副作用丢失多版本)

**问题**: 用户按 F11 完全没反应,既不进全屏也不退。窗口右上角"最大化"按钮还在工作,但 F11 这条全键盘党的标准 affordance 失效。

**根因**: Electron 的 F11 全屏切换不是平台原生的,是 default application menu 上 `role: 'togglefullscreen'` 注册的 accelerator —— menu 在,F11 就能用;menu 没了,F11 也跟着没。

`src/main/index.ts:167` 长期有这一行(为了不让原生菜单栏出现在窗口顶部影响视觉):

```typescript
// 性能优化:禁用默认应用菜单
Menu.setApplicationMenu(null)
```

这条调用把整个 application menu 拆掉,**副作用**是 togglefullscreen 的 accelerator 同时被剥除。同一文件 line 420-444 的 `before-input-event` handler 里覆盖了 F12 (devtools)、F5 / Ctrl-R / Ctrl-Shift-R (reload) 四种快捷键,**唯独没有 F11**。F11 键下放到 webContents → 没人处理 → no-op。

这条 regression 至少从 v4.3.6 切到 pnpm 那波之后就一直存在(或更早,具体哪个版本开始 set null 的还能再考古),v4.3.12 才有用户反馈出来。

**修复** (`src/main/keyboardShortcuts.ts` 新文件 + `src/main/index.ts` wire-in):

| 改动 | 文件 | 说明 |
|------|------|------|
| 抽 pure helper `resolveMainWindowShortcut(input)` | `src/main/keyboardShortcuts.ts`(新增 53 行) | 把 5 条快捷键(F12 / F5 / Ctrl-R / Ctrl-Shift-R / F11)的判定逻辑从 inline closure 抽到独立纯函数。输入 `{key, type, control, meta, shift}`,输出 `{type: 'toggleDevTools' \| 'reload' \| 'reloadIgnoringCache' \| 'toggleFullScreen'} \| null`。**显式过滤 keyDown** —— Electron `before-input-event` 同时报 keyDown 和 keyUp,toggle 类动作(devtools / fullscreen)若 keyUp 也响应会 net 到 no-op,这条防御性约束之前没有,顺便补上。**保留 Ctrl+Shift+R 必须先于 Ctrl+R 的判定顺序约束** —— 这是 v4.2.x 的老坑,反过来强刷会闪两次 |
| Wire-in 到 inline handler | `src/main/index.ts:420-444 → 22 行` | 24 行 if-else 链 → 10 行 switch over 解析结果。行为与旧版 1:1 等价,只多了 F11 这条新分支 |
| 单测覆盖 | `src/main/__tests__/keyboardShortcuts.test.ts`(新增 10 cases) | F12 / F5 / Ctrl-R / Cmd-R / Ctrl-Shift-R(覆盖 Cmd-Shift-R 同款)/ F11 各自一条,加 keyUp 忽略、大写 R 容忍(caps lock)、无 modifier 字母不抢、其他 fn 键 fallthrough 等防御性 case。**4 条已存在的快捷键之前从未有单测**,这次顺手补齐 |

**为什么不用别的方案**:

- ❌ **`Menu.setApplicationMenu(new Menu({...togglefullscreen}))`**: 想保留菜单加速键但让菜单栏不可见。macOS 上 application menu 是顶部菜单栏,空 menu 也会显示 app 名字,跟"性能优化不要菜单"的原意冲突。Windows 上 `setMenuBarVisibility(false)` 可隐藏但 macOS 不行。统一用 `before-input-event` 更跨平台干净。
- ❌ **`globalShortcut.register('F11', ...)`**: 全局热键会"抢"系统其他程序的 F11,用户在浏览器或视频播放器里按 F11 也会触发本 app,违反最小权限。
- ✅ **`before-input-event`**: 只在 app 聚焦时生效,Electron 官方推荐,与现有 4 条快捷键同款 pattern。零迁移成本。

**用户可见行为**: 升 v4.3.12 后,任何视图下按 F11 → 切换到无边框全屏(Windows / Linux),再按 F11 → 退出全屏。窗口右上角 traffic light / max-restore 按钮、`F12` devtools、`Ctrl/Cmd+R` 刷新、`Ctrl/Cmd+Shift+R` 强刷全部保持原行为不变。

---

### v4.3.11 (2026-05-21) — Hotfix: v4.3.10 installer 启动崩溃(缺 @parcel/watcher prebuilt)

**问题**: 用户装上 v4.3.10 双击启动 → 立刻弹白底红 X 错误窗:

```
A JavaScript error occurred in the main process
Error: No prebuild or local build of @parcel/watcher found.
Tried @parcel/watcher-win32-x64. Please ensure it is installed...
  at C:\Users\...\CATIMATION-Cyberpunk Master\resources\app.asar\
     node_modules\@parcel\watcher\index.js:27:13
```

主进程根本没起来。

**根因**: v4.2.9 引入 `@parcel/watcher` 做 ATTACHMENTS 面板的原生 FS watcher,通过 `optionalDependencies` 拉对应平台 prebuilt 子包(`@parcel/watcher-win32-x64` / `-darwin-arm64` / `-linux-x64-glibc` 等),里面装着 `watcher.node` C++ 原生二进制。v4.2.9 当时仓库还在用 npm,npm 默认 hoist 一切到顶层 `node_modules/`,electron-builder 扫顶层就能找到 `node_modules/@parcel/watcher-win32-x64/` 把它复制进 `app.asar.unpacked`,user 装上之后 `require('@parcel/watcher-win32-x64')` 解析正常。

v4.3.6 仓库切到 **pnpm**(`pnpm bootstrap` 脚本,`packageManager: pnpm@10.12.4`)。pnpm 默认 **传递性 optionalDependencies 不 hoist**(只 hoist 直接 dependencies),平台 prebuilt 包躺在 `node_modules/.pnpm/@parcel+watcher-win32-x64@2.5.6/node_modules/@parcel/watcher-win32-x64/`,顶层 `node_modules/@parcel/` 下只有 `watcher/`(JS wrapper)没有 `watcher-win32-x64/`。

electron-builder packaging 阶段 `searching for node modules pm=pnpm searchDir=...` 已经检测出 pnpm,但 walking 仍然只看顶层 `node_modules`,不递归 `.pnpm/`。结果 `app.asar.unpacked\node_modules\@parcel\` 下面只有 `watcher/` 一个目录,**`watcher-win32-x64/` 整个缺失**。装上电脑后 `@parcel/watcher/index.js:27` 的 `require('@parcel/watcher-win32-x64')` 必然失败,主进程 crash。

v4.3.6 ~ v4.3.10 五个版本本质上都中招了 —— 只是 v4.3.6 之前的 build pipeline 还在 npm,问题没暴露;切到 pnpm 后第一波打的安装包就是 v4.3.10。

**修复** (`.npmrc`):

```
public-hoist-pattern[]=@parcel/watcher-*
```

强制 pnpm 把 `@parcel/watcher-win32-x64` / `-darwin-*` / `-linux-*` 等所有平台 prebuilt 子包 hoist 到顶层 `node_modules/@parcel/`,electron-builder 一扫即中。`pnpm install` 一次 reinstall 后 verify:`node_modules/@parcel/watcher-win32-x64/watcher.node` 已经存在(就是缺的那个 .node)。

**为什么不一开始 hoist 全部 6 个平台 prebuilt**: 仓库 `.pnpm/` 里另外 5 个平台 prebuilt(`@esbuild/win32-x64`、`@rolldown/binding-win32-x64-msvc`、`@tailwindcss/oxide-*`、`lightningcss-*`、`@img/sharp-win32-x64`)都是 build-tool 自用,vite / rolldown / tailwind 自己会通过 `.pnpm/` 真实路径 resolve,electron-builder 也不需要把它们打进 app(它们不是 runtime 依赖)。只有 `@parcel/watcher` 是主进程 `import` 的 runtime 依赖,这条 hoist 规则只对它需要。

**预防回归**: 这条 `.npmrc` 进入仓库,后续在新机器、新 worktree 上 `pnpm install` 都会自动 hoist。还在 `.npmrc` 注释里把这次踩坑历史写进去防止后续被无意删掉。

**版本号**: v4.3.10 已上 COS 但不可用。**直接 bump 到 v4.3.11 重发**,electron-updater 看到 v4.3.11 > 已装的 v4.3.9(老用户)就会拉新版;v4.3.10 用户已经 crash 起不来,只能手动重下 v4.3.11 安装包。

**用户操作**: 已经下了 v4.3.10 的人请到 https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/latest.yml 看到的就是 v4.3.11,从 COS 重新下载安装即可。v4.3.10 之前的版本(<=v4.3.9)正常自动更新无需手工干预。

---

### v4.3.10 (2026-05-21) — Codex 聊天 + 文件管理栏接受拖入桌面文件

本版本把"从桌面/Downloads/Finder/Explorer 拖一张图或一个文件进 app"这条体感最低门槛的交互打通到 Codex agent 链路上，分两条主线 + 一条仓库工具链改善：

**A. Codex 聊天输入框接受外部 OS 文件拖入（PR #14）**

老路径：用户把外部 OS 路径(`C:\Users\...\Downloads\foo.png`)拖进对话框 → renderer 调 `fsApi.stat(filePath)` → 主进程 `assertContained` 把任何不在 `allowedRoots` 里的路径直接拒绝 → 提示"已跳过 1 个：xxx（无法读取）"。即使越过 stat 这关，再点 Send 也会撞到 `mapReferencesToInputItems` 这道二级闸 → `agent:send-message` 抛 `Reference path is outside allowed roots`。两道闸 + 一道符号错位，外部拖入完全跑不通。

| 改动 | 文件 | 说明 |
|------|------|------|
| Tier 3 外部拖入分支 | `src/renderer/src/features/agent-chat/MentionInput.tsx` | `onDrop` 增加 Tier 3:`dataTransfer.files` 走 `electronAPI.getFilePath`(Electron 32+ `webUtils.getPathForFile`)拿真实 OS 路径,**File 对象自带 size+type**,跳过 `fsApi.stat` 这道带 `assertContained` 的闸(主进程 `AttachmentService.ingest` 用 `createReadStream` 直接读源路径,不需要 stat) |
| 解耦 attachment vs reference | `MentionInput.tsx` | 外部拖入只 `addAttachment`,**不再** `addPendingReference`。Reference 走 `mapReferencesToInputItems` 时会 `fs.realpath + assertContained` 验证 → 外部路径必拒。文件拣选器(`onFileChange`)从 v4.2.4 起就遵守这条 invariant,这次 onDrop 对齐它 |
| 完整 send-time pipeline | (无代码改动,行为变化) | 外部 file → renderer `addAttachment(rawOSPath)` → main `AttachmentService.ingest` `createReadStream` 流式读外部源 → 写到 `<userData>/agent/uploads/<sha>.<ext>`(canonical 路径,在 allowedRoots 内)→ Codex 收到 `localImage.path` 是 in-root canonical → 后端可读 → `result.userMessageItems` 把乐观消息 patch 成 canonical 路径,attachment chip 点击直达 file viewer |
| Tests | `src/renderer/src/features/agent-chat/__tests__/MentionInput.externalDrop.test.tsx` | 4 个新 case:外部拖入 attachment-only(no reference)/合成 File 无路径忽略/`fs.stat` 失败时仍能 attach(锁定不走 stat 这条 invariant)/内部 MIME 仍 push reference(锁定 Tier 2 vs Tier 3 非对称) |

**B. 文件管理栏接受外部 OS 文件拖入(PR #17 替换被自动关闭的 #15)**

工作流的另一半:用户也希望把外部文件直接 **导入** workspace,而不是只把它附到一次对话上。文件管理栏需要一条独立的 IPC + UI hook,跟 chat attach 的 path-only 模式不同 —— 这边是真复制进 workspace。

| 改动 | 文件 | 说明 |
|------|------|------|
| 主进程 IPC `fs:import-external` | `src/main/file-explorer/fsIpc.ts` + `__tests__/fsIpc.importExternal.test.ts` | `handleImportExternal({ sources, destDir })` 复制外部 OS 路径到 workspace destDir。**destDir 走 `assertContained` 拒绝 workspace 外目标,sources 故意不走**(drag-drop 本身就是用户授权面)。拒绝目录源 / 单文件 >200MB / 不可读源,通过 `written: string[]` 暴露 partial-success 状态。8 个单元测试 |
| Preload bridge | `src/preload/index.ts` + `api.d.ts` | `electronAPI.fs.importExternal(sources, destDir)` 复用现有 `safeInvoke` |
| Renderer store action | `src/renderer/src/features/file-explorer/store.ts` + `__tests__/store.importExternal.test.ts` | `importExternalByDnd(sources, destDir)` 镜像 `moveByDnd`:转发到 main,无论 ok/partial 都 `expandDir` + `selectNode` 最后一个 `written`(防 chokidar 落后 + 视图不刷)。API guard + partial-failure-still-refresh 各自有回归测试。7 个测试 |
| FileTreeNode 外部拖入 | `src/renderer/src/features/file-explorer/FileTreeNode.tsx` + `dragHelpers.ts` + `__tests__/FileTreeNode.externalDrop.test.tsx` | `onDragOver/onDrop` 识别外部 `Files` MIME,`dropEffect` 区分 `copy`(外部)/ `move`(内部)。`resolveDropDestDir` 显式拒绝 `ATTACHMENTS_ROOT` 自身 + attachment 子节点(workspace-tree-only invariant,有两个针对性回归)。`resolveExternalPaths` 抽到 `dragHelpers.ts` 给 MentionInput/FileExplorerPanel/FileTreeNode 三处复用,bridge 缺失时 console.warn。5 个测试 |
| FileExplorerPanel root 拖入 | `FileExplorerPanel.tsx` | 树底下的空白区域也接 drop,目标默认 `workspaceRoot`,不再让用户必须精确瞄准某个子目录 |

**C. 仓库工具链:`pnpm bootstrap`(PR #16)**

`.gitignore` 排除 `resources/codex/`(239MB Codex CLI 不入仓)。`git clone` / `git worktree add` 之后默认没有这个二进制 → app 启动时 `AgentRuntime` 拼一个 `spawn .../codex.exe` 直接 ENOENT → backend `start()` 抛错 → `this.client` 永远 null → 任何 chat 操作都报 `CodexLocalBackend.send called before start`。这条隐性陷阱原 README 没文档化,本版本一站式补上。

| 改动 | 文件 | 说明 |
|------|------|------|
| 一站式初始化脚本 | `package.json` `bootstrap = pnpm install && pnpm codex:fetch` | fresh clone 或新建 worktree 后跑一遍即可(`pnpm install` 自动触发 `postinstall = prisma generate && electron-builder install-app-deps`,串联 codex 二进制下载) |
| README 升级 | `README.md` | Quick Start 把首条命令换成 `pnpm bootstrap`,新增一段解释 worktree 陷阱 + 给出从兄弟 worktree `Copy-Item` 的 fast-path(239MB 不必重下) |

#### 用户可见行为

1. 在 Codex 聊天框,从桌面/下载/任意盘符 拖一张图进来 → 立即出现 attachment chip(以前固定报"无法读取")。点 Send → Codex 收到图 → 正常回复(以前报"Reference path is outside allowed roots"卡 send)。
2. 在 ATTACHMENTS / WORKSPACE 文件管理栏,从桌面拖文件/图进来 → 自动复制进当前选中的文件夹(或 workspace root),tree 即刻刷出新节点。拖到 ATTACHMENTS 树里安全降级为 no-op(`ATTACHMENTS_ROOT` 不再 fall-through 到 workspace root)。
3. fresh clone 或 `git worktree add` 之后:跑 `pnpm bootstrap` → install + 拉 Codex 二进制一次到位,启动不再卡在 `send called before start` 这条隐性错误。

#### 测试

- `pnpm vitest run agent-chat/__tests__/MentionInput.externalDrop.test.tsx` → **4/4**
- `pnpm vitest run file-explorer/__tests__/{fsIpc.importExternal,store.importExternal,FileTreeNode.externalDrop}.test.{ts,tsx}` → **20/20**(8 + 7 + 5)
- `pnpm vitest run agent-chat` → 305 测试中 294 pass,11 fail 全在 `Lightbox.video.test.tsx`(自 PR #10 起未动过,与本次无关)
- 三轮人工 smoke(包含 ATTACHMENTS_ROOT fall-through、attachment-children 误投递、partial-failure UI 不刷新三个边界 bug)

参考:
- PR #14:[2799662352/ai-image-master#14](https://github.com/2799662352/ai-image-master/pull/14)(chat 拖入,含 `3c48116 bypass fs:stat` + `303437f drop external-drop reference` 两条 fix)
- PR #17:[#17](https://github.com/2799662352/ai-image-master/pull/17)(文件管理栏,替换被关闭的 #15)
- PR #16:[#16](https://github.com/2799662352/ai-image-master/pull/16)(`pnpm bootstrap`)
- Codex `localImage.path` 协议沙箱模型:`src/main/agent/codexUserInput.ts` + `AttachmentService.ts`

---

### v4.3.9 (2026-05-20) — Hotfix: 快速点击 tab 闪屏

**问题**: 用户连续快速点击不同 tab(例如 BATCH → AGENT → BATCH),会看到大约 16ms 的旧页面内容闪现,即使最终落点正确。DevTools 控制台还会冒出 Chrome 的 `Throttling navigation to prevent the browser from hanging` 警告。

**根因**: `TabManager.switchTab` 把 `onTabChange` 回调放在两层 `requestAnimationFrame` 之后才触发,闭包里 `newTab` 是 stale 的;再叠加 `ServiceBridge` 里的双向同步 (`tabManager.onTabChange` ↔ `useTabStore.subscribe`),stale 回调会把 React 状态反推回旧 tab,触发一次「面板可见性回滚 → 又被新一轮 RAF 拉回」的奇怪过山车。

**修复** (`src/renderer/src/features/tab-manager/TabManager.ts`):

| 改动 | 说明 |
|------|------|
| `onTabChange` 回调改成 **同步触发** | 与 `updateTabUI` 在同一 task 完成,React mount/unmount 的可见性切换跟 `panel.hidden` 切换原子化,既消除闪屏也消除空帧 |
| Generation counter + `cancelAnimationFrame` | 每次 `switchTab` 自增 generation,RAF 回调进门先核对,stale 的直接放弃;同时显式取消上一次还在排队的 RAF |
| `reentrancyGuard` | 回调里如果再调 `switchTab` 直接吞掉,让最外层那次 `switchTab` 决定最终状态,杜绝双向同步的回环 |
| `deactivatePage` / `activatePage` 仍走 RAF | 这两个可能跑数据加载等重活,保留延迟避免阻塞首帧 |
| `destroy()` 也清理 pending RAF | 防止 hot reload / unmount 时 RAF 漏跑 |

**测试** (`src/renderer/src/features/tab-manager/__tests__/TabManager.rapidClicks.test.ts`):

5 条新增回归用例,覆盖:
1. 快点击 `batch → agentWorkspace` 后 DOM 直接落在最终 tab,中间态不残留
2. `onTabChange` 必须同步触发,且 `newTab` 与调用顺序严格匹配
3. stale RAF 被取消:`activatePage` 只对最终 tab 跑一次
4. `reentrancyGuard` 兜住回调里再调 `switchTab` 的反向同步循环
5. 相同 tab 重复 `switchTab` 是 no-op

**影响范围**: 仅 `TabManager.switchTab` 内部时序,公共 API 完全不变。所有现有 `ServiceBridge` + `useTabStore` 的双向同步代码无需改动,reentrancyGuard 在 TabManager 层兜底即可。

**升级路径**: 直接覆盖安装,无破坏性变更。

---

### v4.3.8 (2026-05-20)

本次发布是一波 **批量页性能 + 系统稳定性硬化** 综合补丁,聚焦"生图过多卡顿 / 内存涨 / 自我删除"三个老用户痛点。两条主线:

**A. 批量结果页性能(BatchResultGrid)**

200+ 张卡片场景下"改一条 item 状态全网格重渲"的渲染风暴,叠加 `items.indexOf` 的 O(N²) 主线程开销 ——

| 改动 | 文件 | 说明 |
|------|------|------|
| `O(N²) indexOf → Map(O(N)) lookup` | `src/renderer/src/pages-react/batch/BatchResultGrid.tsx` | 加 `indexById = useMemo(Map<id, idx>)` 替换 `displayItems.map` 里的 `items.indexOf(item)`。200 items 时单次渲染从 ~4 万次 indexOf 降到 200+200 次 Map 操作 |
| `React.memo(ResultCard)` + 父侧 `useCallback` | `BatchResultGrid.tsx` + `pages-react/BatchPage.tsx` | 把卡片包 memo,父侧 `handleEditItem` / `handlePreview` 改 `useCallback` 引用稳定,grid 内 `handleOpenEditor` 也提到顶层。zustand `items.map` 保留未变 item 的引用 → memo 浅比较跳过未变卡片。单 item 状态翻转从触发全 N 张卡片重渲降为只重渲那 1 张 |
| `failedItems` / `doneItems` / `displayItems` / `injectPrompt` 全部 useMemo / useCallback | `BatchResultGrid.tsx` | 派生数组依赖锁死, 防御性消除 N×O(N) 重扫 |
| `<img decoding="async">` | `BatchResultGrid.tsx` | 大图解码 offload 到后台线程, 大量已完成结果同时进视口时不阻塞主线程 |
| **react-window 2.x 虚拟化** | `BatchResultGrid.tsx` + `package.json` (新增 `react-window@^2.2.7`) | 阈值化策略: `items.length < 30` 走原 CSS Grid 保留页面整体滚动 UX, `>= 30` 切到 react-window `<Grid>` 内嵌滚动只渲染视口可见 cell。`useContainerSize` 用 ResizeObserver 跟踪容器宽度 + window.innerHeight × 0.7 自适应视口高度。`cellProps` 全 useMemo 保持引用稳定 → react-window 内部跳过未变 cell。200 items 满载时 DOM 节点从 ~6000 降到 ~360, decoded image bitmap 内存从 ~800MB 降到 ~50MB |

**B. 主进程稳定性 / 资源泄漏(第五轮系统性挖洞)**

| 改动 | 文件 | 说明 |
|------|------|------|
| **修: 更新冲突自我删除** | `src/main/updater.ts` + `src/main/index.ts` | 真因不是 `before-quit` 逻辑而是 child process (codex agent / docker MCP gateway) 在 `quitAndInstall` 时仍持有文件句柄 → NSIS 装不上去。新增 `UpdaterConfig.preInstallCleanup` 钩子, `handleInstall()` 先 `await cleanup()`(带 8s 超时兜底)再 `quitAndInstall`。`index.ts` 注入 `cleanupAgentRuntime()` 作为 cleanup 实现, 解除所有 child process + 文件句柄 |
| **IPC 大 base64 入参 OOM 防护** | `src/main/index.ts` | `cos:upload-image-history` / `save-image` / `export-image` 三个 IPC 加 `MAX_IPC_BASE64_STRING_BYTES = 80MB` + `rejectOversizedBase64()` helper。超大恶意/异常调用在字符串长度校验阶段就拒掉, 不再走到 Buffer.from(base64) 把主进程 OOM |
| **修: codex agent 日志 FD 泄漏** | `src/main/agent/CodexLocalBackend.ts` | `SpawnedCodexClient` 加 `log: WriteStream \| null` 字段持有日志流引用, `start()` / `stop()` / `restartCodex()` 显式 `log.end()` 关闭。修复 provider 切换 / agent 重启时 fs.WriteStream 一个不放的累计 FD 泄漏 |
| **修: COS sliceUploadFile 异常分支 FD 泄漏** | `src/main/services/tencent/cosClient.ts` + `__tests__/cosClient.test.ts` | `uploadStream` 增加防御层: (a) 代理 `onTaskReady` 抓住 taskId; (b) `SLICE_UPLOAD_HARD_TIMEOUT_MS = 10min` 硬超时, 超时主动 `cancelUpload(taskId)`; (c) sliceUploadFile callback err 分支显式 `safeCancel()` 兜底, 不依赖 SDK 内部 TaskInfo Map 清理。用户提供的 `onTaskReady` 包 try/catch 隔离, 异常不传染 |

**C. 历史/批量页"重新编辑"功能闭环**

| 改动 | 文件 | 说明 |
|------|------|------|
| `BatchItem.snapshot` 字段 | `src/renderer/src/stores/useBatchStore.ts` | `BatchItemSnapshot { prompt, ratio, referenceImages, modelKey }`。`runBatch` 启动时 captures `runSnapshotBase`,`claimNextPending` 把"分发到 worker"的瞬间快照附到每个 BatchItem 上, pending 阶段保持 undefined |
| `restoreForEdit` mode 保留语义 | `useBatchStore.ts` | snapshot.mode 未指定时保留当前 store.mode, BatchPage 显式传 `mode: 'card'` 走单项重编辑, HistoryPage 同款。修复批量页"重编辑只塞文本不载图"的回归 |
| 历史页 + 批量页 ↺ EDIT 按钮 | `pages-react/HistoryPage.tsx` + `pages-react/BatchPage.tsx` + `pages-react/batch/BatchResultGrid.tsx` + `pages-react/generate/ResultGrid.tsx` + `pages-react/batch-punk/PunkResultGrid.tsx` + `pages-react/batch/BatchItemRow.tsx` + `components/donor/DonorCard.tsx` | `onEditPrompt(string)` → `onEditItem(item: BatchItem)` 重命名, 让父组件能拿到完整 snapshot 一起回灌。Donor 卡按钮永久可见(不再 hover 才出), title 区分有/无 snapshot 两态。BatchPage `handleEditItem` 复用 `useBatchStore.restoreForEdit` + `useModelStore.switchModel`, 跟 HistoryPage 走完全同一条 code path |

**D. 异步 COS 转存 URL 上屏**

| 改动 | 文件 | 说明 |
|------|------|------|
| 异步上传 hook | `src/renderer/src/utils/cosImageUpload.ts` (新) | `cosImageUpload(resultUrl, item)` → 返回 cosUrl + status。`useBatchStore` / `useGenerateStore` 生成成功后 fire-and-forget 触发, status 字段(`uploading` / `uploaded` / `failed`) 通过 zustand 同步到 UI |
| 卡片角标 | `BatchResultGrid.tsx` + `ResultGrid.tsx` | 三态角标 `up…` / `cos` / `!cos`, hover title 解释含义。`pickDisplayUrl` 优先选 `cosUrl` 兜底 `resultUrl`, 持久化链接生效后 UI 自动切换 |

**E. 其它打磨**

| 改动 | 文件 | 说明 |
|------|------|------|
| 内置版本号文案修正 | `src/renderer/src/main.tsx` + `src/renderer/src/features/intro-video/IntroVideoController.ts` + `src/renderer/src/features/updater/UpdateNotification.ts` | 启动页 / 更新提示窗口里硬编码的版本号字符串同步到 4.3.8 |
| 历史数据服务签名收紧 | `src/renderer/src/features/history/HistoryDataService.ts` + `hooks/useHistoryData.ts` + `services/cache/ImageCacheService.ts` | 跟 `cosUrl` / snapshot 字段配套的类型补全, 没运行时行为变化 |

#### 测试

- `pnpm exec vitest run useBatchStore.test.ts` → **28/28 全过**(其中含 3 个 batch 队列爆发并发的 timing-sensitive 测试)
- `pnpm exec vitest run cosClient.test.ts` → COS 上传防御层新增的 timeout / cancel 路径全过
- 受影响文件 lint / typecheck 干净(其它存量类型错误在 storage / storyboard-pipeline / LazyLibraries, 跟本次无关)

#### 用户可见行为

1. 升级到 v4.3.8 不再出现"更新装到一半 app 自己消失"(即使没装上, 老 exe 也保留, 重新启动 → 重新拉更新, 不会进死循环)
2. 批量页跑 100+ 任务: 滚动稳定 60fps, 内存涨幅显著降低, 不再有"卡到爆"的体感
3. 历史 / 批量任一项的 ↺ EDIT 按钮永久可见, 点了能把 prompt / 比例 / 参考图 / 模型一起灌回输入框
4. 任一图片生成后, 卡片左下角实时显示 COS 上传状态角标; 升到 `cos` 后即使会话关闭再打开, 图也不会因为模型 URL 过期而 404

参考:
- React 官方 `React.memo` + `useCallback` 配合模式: <https://react.dev/reference/react/useCallback>
- react-window 2.x 文档: <https://github.com/bvaughn/react-window>
- electron-updater `quitAndInstall` 流程: <https://www.electron.build/auto-update>

### v4.3.7 (2026-05-19)

v4.3.5 落地 Skill Marketplace MVP 后，收到的 UX 反馈分两批：

1. "光在 tab bar 加一个『技能市场』tab 不够直观，应该在 Agent Workspace 的 Skills 页面有一个明显按钮一键跳过去；商城页本身应该像 Cursor 应用市场那样——左侧分类导航 + 右侧卡片 grid，而不是平铺三列。"
2. "点不动按钮 / 卸载按钮一直抽搐。"

第一批是预期 UI 抛光；第二批是 bug——marketplace tab 加在 React `useTabStore` 里却没在底层 vanilla DOM 体系（`TabManager.DEFAULT_VALID_TABS` + `index.html` 的 `<div id="xxxPanel">`）里注册，加上"已安装"按钮 hover 时切换两种文案的渲染宽度不一致导致 bounding box 跳变。v4.3.7 把这两批一并发掉。

> **注**：原计划的 v4.3.6 没真正进入仓库历史（commit/tag 都没存在），所以这次直接跳号到 v4.3.7。如果你看到 docs/聊天记录里出现过 v4.3.6 字样，对应的内容已合并进本条目。

| 改动 | 文件 | 说明 |
|------|------|------|
| Agent Workspace 入口 | `src/renderer/src/features/agent-workspace/SkillsSection.tsx` (+18) | "New Skill" 按钮旁加一颗亮黄色 "🛒 Skill 商城" 按钮,点击通过 `useTabStore.switchTab('marketplace')` 跳转。视觉上是头部 3 个 action 中最显眼的一个（cyberpunk yellow filled），优先级高于"打开 Skills 文件夹"和"New Skill" |
| 商城页重写 | `src/renderer/src/pages-react/MarketplacePage.tsx` (重写 ~280 行) | 从三列 tab（可安装/已安装/有更新）变成 Cursor-marketplace 风格的左侧 sidebar + 右侧 grid 卡片：sidebar 7 个分类（Featured / Director / Storyboard / Methodology / Other / Installed / Updates），每项带 emoji icon + 计数；顶部有搜索框（按名称或描述模糊匹配）；卡片每行 2 列（lg breakpoint），包含 emoji 图标 + skill 名称 + 版本号 + 2 行描述截断 + 体积 + 已认领 badge + Get / Installed ✓ / Update 按钮 |
| **Bugfix: marketplace tab 注册** | `src/renderer/src/features/tab-manager/TabManager.ts` (+1), `src/renderer/index.html` (+5), `src/renderer/src/react-app/main.tsx` (+27), `src/renderer/src/services/ServiceBridge.ts` (+8) | 项目目前是两套 tab 系统并存的渐进迁移状态：上层 React `useTabStore` 走 zustand 状态，下层是 vanilla DOM 的 `TabManager` + `index.html` 里手写的 `<div id="xxxPanel">` panel。`marketplace` 之前只加在 React 侧，导致 zustand subscribe 转发到 `TabManager.switchTab('marketplace')` 时被白名单拒绝（控制台 `无效的标签名: marketplace`），按钮点了没反应。修复：(a) `DEFAULT_VALID_TABS` 加 `'marketplace'`，(b) `index.html` 加 `<div id="marketplacePanel">` 容器 + 内嵌 `<div id="marketplace-react-root">`，(c) `react-app/main.tsx` 加 `mountMarketplaceReact` / `unmountMarketplaceReact`（与其他 React-only 页面同款 lazy + Suspense 模式），(d) `ServiceBridge.ts` 把 mount/unmount 接到 onTabChange 桥 + 启动时预 mount 一次 |
| **Bugfix: 已安装按钮抽搐** | `src/renderer/src/pages-react/MarketplacePage.tsx` (-5 +18) | 原实现用 `group-hover:hidden` 切换"✓ Installed" / "Uninstall" 两个 span 的 `display`，但两段文案渲染宽度不同 → hover 时按钮宽度跳变 → 鼠标恰好被甩出 button bounding box → leave 触发 → 文字切回 → 鼠标又落回 → enter 触发，进入 hover-flicker 死循环（CSS 经典坑）。修复：按钮固定 `w-24 h-7`(96×28px) bounding box 永不变；两个 span 全部 `absolute inset-0` 脱离布局流，互不影响尺寸；改用 `opacity` + `transition-opacity duration-150` 平滑切换。同时把 Get / Update 按钮也 lock 成相同尺寸，避免 busy 文案切换（Get ↔ 安装中…）抖动 |

#### 分类推导规则（不需要后端 taxonomy 字段）

```
director-*       → Director (12 个)
storyboard-*     → Storyboard (7 个)
codex-research-* → Methodology (1 个)
其他              → Other
```

Featured 是手动 curated 4 个推荐 skill（`codex-research-grounded-prompting` / `director-prompt-engineering` / `director-structured-captioning` / `storyboard-structure`），写死在 `FEATURED_NAMES` 集合里。后续要加分类只需改 `CATEGORIES` 数组，不动 catalog schema。

#### 双 tab 系统注释（给未来接手的人）

`useTabStore` 是 React 侧状态，`TabManager` + `index.html` panel 是 vanilla DOM 老体系，二者通过 `ServiceBridge` 双向 subscribe 同步。新增任何 React 路由 tab 必须**同时**：(1) 在 `useTabStore.VALID_TABS` 加，(2) 在 `TabManager.DEFAULT_VALID_TABS` 加，(3) 在 `index.html` 加 panel 容器，(4) 在 `react-app/main.tsx` 写 mount/unmount，(5) 在 `ServiceBridge` 接入 onTabChange + 预 mount。漏一处都会出现"按钮点不动"症状。

#### 用户可见行为

1. 升级 v4.3.5 → v4.3.7：自动检测热更新 → 安装 → 重启 → Agent Workspace → Skills tab 多了亮黄色 "Skill 商城" 按钮。
2. 点按钮跳转到全新商城页（左侧 sidebar 分类 + 右侧 grid），搜索 / 浏览 / 安装更顺手。
3. 已安装 skill 的卸载按钮 hover 不再抽搐：默认绿框绿字 "✓ Installed"，hover 平滑淡入红字 "Uninstall"，宽度不变。

### v4.3.6 (未发布 — 内容已合并进 v4.3.7)

### v4.3.5 (2026-05-18)

把 v4.3.3 / v4.3.4 强制 mirror 的"每次启动复制 20 个 bundled skill 到 `~/.agents/skills/`"流程**完全废弃**，改为**用户主动安装**的 Skill Marketplace（插件商城）。源头痛点：bundled skill 的目录级非覆盖镜像让升级用户必须手动删 `~/.agents/skills/<name>/` 才能拿到新版 SKILL.md（v4.3.4 changelog 里那段"升级用户需手动删除"就是这个 bug 的 UX）。MVP 把决定权还给用户——什么时候装、装哪几个、什么时候升级，全在 app 内一个新 tab 里完成。

| 改动 | 文件 | 说明 |
|------|------|------|
| 废弃 bundled mirror | `src/main/index.ts` (-60) + `electron-builder.yml` (-15) | 删除 `bundledCodexSkillsMirrorPromise` 与 `bundledCodexSkillsDir`；`load-skills` IPC 只 await legacy `<userData>/skills` 迁移那一份。installer 不再把 `resources/codex-skills/` 打入 extraResources（用户机器从此不会被自动塞 20 个 skill） |
| 新增 marketplace service | `src/main/marketplace/marketplaceService.ts` (+225) + `src/main/marketplace/ipc.ts` (+100) | DI 化的 `MarketplaceService` 类：`fetchCatalog`（缓存 + force 刷新）/ `install`（下载 zip → sha256 校验 → temp 解压 → 原子 rename → 写 state，**任何失败都不留半成品**）/ `uninstall`（删目录 + 删 state）/ `listInstalled`（读 ledger）/ `adoptExisting`（首启认领 v4.3.4 leftover）。fetcher 注入 `fetch()`（Node 18 全局），不走 Chromium 网络栈 |
| 共享类型 | `src/types/marketplace.ts` (+55) | `Catalog` / `CatalogEntry` / `InstalledRecord` / 5 个 IPC envelope。main + preload + renderer 三处共用 |
| 启动认领 | `src/main/index.ts` | 启动时 fire-and-forget 跑 `adoptExisting()`：扫 `~/.agents/skills/<name>/`，若 `<name>` 命中 catalog 且 state 里没记录 → 写入 `marketplace-state.json` 标记 `source: 'adopted'`。结果：v4.3.4 老用户升级到 v4.3.5 后，marketplace 的"已安装"页直接列出他们机器上现有的 20 个 skill，**不需要重新下载** |
| 上传脚本 | `scripts/upload-skills-to-cos.mjs` (+185) + `resources/codex-skills/skill-versions.json` (+30) | 扫 `resources/codex-skills/*` 每个目录 → 读 SKILL.md `description` + skill-versions.json 的 version → `JSZip` 打包 → sha256 → 上传 `cos://image-master-1345773498/skills/<name>-<version>.zip` → 聚合上传 `catalog.json`。`--dry-run` 不动 COS 只打印。新增 `npm run publish:skills` |
| 渲染层 marketplace 页 | `src/renderer/src/pages-react/MarketplacePage.tsx` (+275) | 三栏视图（可安装 / 已安装 / 有更新）+ 安装/升级/卸载按钮 + sha256 校验失败的 toast。卸载前 `confirm()` 二次确认。版本不一致即显示"有更新"，不假设 semver 比较——避免误判 |
| Tab 入口 | `useTabStore.ts` + `TabBar.tsx` + `AppLayout.tsx` + `pages-react/index.ts` | 新增 `marketplace` tab（🛒 技能市场），居于 Agent Workspace 与设置之间 |
| Preload bridge | `src/preload/index.ts` (+30) | 暴露 `window.electronAPI.marketplace.{fetchCatalog,install,uninstall,listInstalled,adoptExisting}`，复用现有 `safeInvoke` |
| 测试 | `src/main/marketplace/__tests__/marketplaceService.test.ts` (+340) | TDD 11 测试：catalog 缓存 / install 成功+sha256 不匹配+目录消失原子回滚 / 升级覆盖 / uninstall 含 no-op / adopt 认领 + 幂等 + 非 catalog 目录忽略 / state 跨进程持久化。+ legacy migration 6 测试不动。**17 测试全过** |

#### COS 布局

```
image-master-1345773498/
└── skills/
    ├── catalog.json                                  # ~19 KB, 20 skill entries
    ├── codex-research-grounded-prompting-1.0.0.zip   # ~21 KB
    ├── director-anchor-extraction-quality-1.0.0.zip  # ~1.2 KB
    └── ... 18 more zips
```

`catalog.json` 是 source of truth，每个 entry 含 `{name, version, description, size, sha256, url}`。客户端先拉 catalog，安装时按 `url` 下载 zip，按 `sha256` 校验，落盘到 `~/.agents/skills/<name>/`。

#### 用户可见行为

1. 全新安装 v4.3.5：`~/.agents/skills/` 是空的。打开"技能市场"tab → 可安装列表显示 20 个 skill → 用户挑想要的点"安装"。
2. v4.3.4 老用户升级：原 `~/.agents/skills/` 里的 20 个 skill 保留不动，启动时自动被 `adoptExisting` 标记为 `源: 已认领`（蓝色 badge），在"已安装"列表里直接可见。如果 catalog 里的版本与本地一致 → "有更新"是空的；如果 catalog 之后发版了新 skill 内容 → "有更新"亮起对应条目，点"升级"即可。
3. 单 skill 升级：marketplace 不再触发 app 全量热更新——`scripts/upload-skills-to-cos.mjs` 单独跑就能换 skill 内容，无需 build app/发 installer。

#### 发布步骤

```
npm run publish:skills:dry  # build & inspect catalog, no upload
npm run publish:skills      # upload to image-master-1345773498/skills/
npm run release:cn          # then build & publish app binary as usual
```

参考：
- `src/main/marketplace/`（service + ipc）
- `scripts/upload-skills-to-cos.mjs`
- `src/types/marketplace.ts`

### v4.3.4 (2026-05-18)

把 `codex-research-grounded-prompting`（方法论 skill）和 v4.3.3 同期落地的 19 个 `director-* / storyboard-*` cookbook（具体写法 skill）显式建立 method → recipe 两层关系——之前它们仅"并存"，Codex agent 没有信号知道走到某一步该 *调用* 哪一条 cookbook。

| 改动 | 文件 | 说明 |
|------|------|------|
| 新增 `<companion-skills>` 章节 | `resources/codex-skills/codex-research-grounded-prompting/SKILL.md` (+35 行) | 在 `</verification>` 与 `<references>` 之间插入一节：(1) 用 method/recipe 二级模型重述 20 个 skill 的关系；(2) 给出"任务步骤 → 调用哪个 sibling cookbook"路由表，覆盖 Pillar 2/4/5、Lens 1-4 全部主线 + audio/dialogue/sensitive-dodge 三条横切；每行点名 sibling 贡献的具体规则（如 *色彩比 ≥7:3*、*7 字段 prompt 顺序*、*运动矢量 °/cm/m·s⁻¹*）便于模型自校；(3) 调用协议：reasoning 中 call out by name → 引用具体规则 → 多 sibling 冲突时按非重叠子维度组合；(4) caveat 解释 `appliesTo` 在移植中被剥除（pipeline hook，Codex 不认）但 rule body 域无关；(5) "don't double up" 守则——单一 recipe 任务别再戴上五 Pillar 的全套帽子 |
| 镜像生效路径 | `$HOME\.agents\skills\codex-research-grounded-prompting\SKILL.md` | 沿用 v4.3.3 的 `bundledCodexSkillsMirrorPromise` 路径，目录级非覆盖。已知行为：旧版若已存在则新版不会覆盖；release 后用户首次升级时，原 v4.3.3 mirror 仍是上一版 SKILL.md。**升级用户需手动删除** `$HOME\.agents\skills\codex-research-grounded-prompting` 一次再重启 app 才能拿到 `<companion-skills>` 章节；全新安装无需此步 |

参考：
- 5747f45 `feat(codex-skills): wire codex-research-grounded-prompting to dispatch the 19 cookbook siblings`
- 母 skill：`resources/codex-skills/codex-research-grounded-prompting/SKILL.md`
- 19 子 cookbook：`resources/codex-skills/{director-*,storyboard-*}/SKILL.md`

### v4.3.3 (2026-05-18)

Codex agent 获得首个内置 USER-scope skill：`codex-research-grounded-prompting`。

| 改动 | 文件 | 说明 |
|------|------|------|
| 新 skill 源 | `resources/codex-skills/codex-research-grounded-prompting/{SKILL.md, references/methodology-rationale.md, references/papers.md}` | Codex 体例（语义标签 + 散文），五大方法论支柱 + 五个抽取镜头；明确要求模型用自带 `web_search` / `fetch` 工具针对用户实际 brief 验证引用——文档内出现的所有导演 / 作画师 / 影片名都是 *illustrative*，决不作为默认套用 |
| 启动镜像 | `src/main/index.ts` `bundledCodexSkillsMirrorPromise` | 启动时把 `<resources>/codex-skills/` 整目录 **非覆盖** 复制到 `$HOME/.agents/skills/`；用户事后改动永远胜出，下次安装不会被回滚 |
| 打包注入 | `electron-builder.yml` extraResources 新增 `resources/codex-skills → codex-skills` | bundled 源跟随安装包分发 |
| Regression test | `src/main/agent/__tests__/legacySkillsMigration.test.ts` | 新 case 验证 bundled→user 镜像的"用户编辑在再镜像时保留" |

参考：设计 spec `docs/superpowers/specs/2026-05-18-codex-research-grounded-prompting-design.md`

### v4.2.9 (2026-05-16)

Codex 模式附件面板 live-update。修"chat 上传图片之后 ATTACHMENTS 面板不刷新，要重启 app 才能看到"。

| 改动 | 文件 | 说明 |
|------|------|------|
| Track A — in-process 成功信号 | `src/main/agent/AttachmentService.ts` | `ingestOne` 写完 disk + Prisma 后 `emit('attachment-added', { saved })`，对偶 `attachment-error` 失败通道，**保证 chat 上传场景毫秒级触达** renderer 不依赖文件系统事件 |
| Track A — 广播桥 | `src/main/file-explorer/AttachmentTreeProvider.ts` + `__tests__/AttachmentTreeProvider.test.ts` | 新增 `wireAttachmentBroadcast(service, windowsGetter)`，监听 `attachment-added` → 向所有 BrowserWindow 发 `attachments:changed` IPC，自动跳过 destroyed window |
| Track B — 原生 FS watcher | `src/main/file-explorer/AttachmentDirWatcher.ts` (新) + `__tests__/AttachmentDirWatcher.test.ts` (新, 11 tests) | 对齐 VSCode `parcelWatcher.ts` 设计：用 `@parcel/watcher@2.5.6`（VSCode 同款）监听 `userData/agent/uploads/` 递归。Windows 走 ReadDirectoryChangesW、macOS 走 FSEvents、Linux 走 inotify，C++ 层自带 `MIN_WAIT=50 / MAX_WAIT=500` debounce 保证 burst 期间 callback 不超 500ms 不 fire。JS 层加 75ms trailing aggregator（match VSCode `FILE_CHANGES_HANDLER_DELAY`）合并 callback 间事件。**覆盖 chokidar 在 Windows 高负载 burst（robocopy /MT、备份还原）下 ReadDirectoryChangesW kernel buffer 溢出丢事件的盲区** |
| 噪音过滤 | `AttachmentDirWatcher.ts` | parcel `ignore: ['**/_tmp_*']` 把 AttachmentService 的中间 tmp 文件在 C++ 层就过滤掉，砍掉 ingest 期间 ~2/3 事件量（原 3 事件：create tmp / delete tmp / create sha，过滤后只剩 create sha） |
| Race 处理 | `AttachmentDirWatcher.start()` | 处理 dispose-during-subscribe 竞态：如果 `dispose()` 在 `subscribe()` Promise resolved 之前调用，等 resolve 后立即 `unsubscribe()`，避免泄漏 native watcher |
| 渲染端订阅 | `src/preload/index.ts` + `src/renderer/src/features/file-explorer/{store,FileTree}.tsx` + 各自 `__tests__/` | preload 暴露 `attachments.onChanged(cb)` IPC，store 加 `ensureSubscriptions()` 动作（200ms trailing debounce 合并 burst），`FileTree` mount 时调用——单一入口、可测试、race-free |
| 打包配置 | `electron.vite.config.ts` + `electron-builder.yml` | `@parcel/watcher` + `/^@parcel\/watcher-/` 加入 main external（native .node 不可 bundle）；`**/node_modules/@parcel/watcher*/**` 加入 `asarUnpack`（wildcard 通配 wrapper + 平台二进制子包 `@parcel/watcher-win32-x64` 等） |

参考：
- VSCode 文件 watcher：[parcelWatcher.ts](https://github.com/microsoft/vscode/blob/main/src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts)（`FILE_CHANGES_HANDLER_DELAY=75`，excludes 模式，watcher fail 容灾）
- parcel C++ debounce 源码：[Debounce.cc](https://github.com/parcel-bundler/watcher/blob/v2.5.6/src/Debounce.cc)（`MIN_WAIT_TIME=50`, `MAX_WAIT_TIME=500`）
- 没采用 ThrottledWorker(500) chunk size：我们的 broadcast 无 payload，C++ → JS marshal 后只 check `.length`，没有 per-event 工作可 chunk

#### 用户可见行为
- chat 上传图片或拖文件进 chat → ATTACHMENTS 面板 75-275ms 内自动出现新条目（不需重启 app）
- 外部修改 uploads 目录（手动拖入、还原备份、其他进程写入）→ 75-700ms 内面板自动刷新
- 沙箱/EACCES 等极端环境 native watcher 启动失败 → log warn 后降级运行，chat 上传仍能即时刷新（Track A in-process 兜底）

### v4.2.8 (2026-05-15)

三个用户反馈直击的修复。

| 改动 | 文件 | 说明 |
|------|------|------|
| Smart Erase 去超时 | `src/main/services/smartErase/runner.ts` | 删掉 `POLL_TIMEOUT`（原 60min 硬 deadline），改 `while(true)` 直到 MPS 终态（SUCCESS / FAIL / CANCELLED）或用户取消。长任务（≥200 次 PROCESSING）不再被代码主动杀掉 |
| Smart Erase 真实进度 | `runner.ts` + `src/types/smartErase.ts` + `src/renderer/src/pages-react/smart-erase/{EraseQueue,useEraseEvents}.tsx` | 新增 `summarizeTaskDetail()` 把 `DescribeTaskDetail` curate 成 `EraseTaskDetailSnapshot`（progress / workflowStatus / smartEraseStatus / errCode / message / output path / timing），每次 poll 通过 `onProgress` + IPC 透传到 renderer。UI 优先用真实 `mpsProgress`，估计值加 `~` 后缀区分 |
| Smart Erase 查看详情 | `EraseQueue.tsx` | 每行加 `[详情]` 按钮，展开内嵌 `DetailPanel` 显示 curated 字段，对标腾讯控制台"查看结果详情" |
| 批量队列爆发并发 | `src/renderer/src/stores/useBatchStore.ts` | `addItem` 在跑批中触发 `_spawnWorker`；`concurrency` 改为只决定初始池大小，`HARD_MAX_WORKERS = 6` 兜上限。修第二批任务不会立即启动的 UX 问题 |
| 参考图上限 8 → 12 | `ReferenceImageUpload.tsx` / `PunkRefDrop.tsx` / `BatchRefDrop.tsx` / `ExampleGallery.tsx` / `useDirectorStore.ts` / 4 语言 i18n / `index.html` / `GeneratePage.ts` | 所有上传入口、store guard、提示文案统一升到 12 张 |
| 视觉 Prompt 辅助上 Generate / Compare | 新增 `GeneratePromptHelperBar.tsx` + `ComparePromptHelperBar.tsx` + `useVanillaPageRefImages.ts` hook | 多角度 / 打光 按钮在 Generate 和 Compare 也能用了，参考图有/无状态用 `MutationObserver` 事件驱动联动 |

### v4.2.6 (2026-05-14)

修复"Codex 连接失败：PGlite worker error: Aborted()"——升级覆盖安装 / 强杀 / 双开后启动崩溃。

| 改动 | 文件 | 说明 |
|------|------|------|
| Phase 1 | `src/main/agent/pgliteRecovery.ts` (新) + `__tests__/pgliteRecovery.test.ts` (新, 15 tests) | 三个纯函数：`isPgliteAbortedError`（容忍 `Aborted()` / `RuntimeError + callMain` / `wasm-function + callMain` 三种 wrapper）、`moveCorruptDataDir`（同毫秒冲突用 `-N` 防撞）、`isResetAllowedNow` + `recordResetAttempt`（24h 滚动窗口的电路断路器） |
| Phase 2 | `src/main/agent/db.ts` | `startEmbeddedPGlite` 重写：第一次启动失败 → 命中 `Aborted` → 检查 24h 内重置次数 < 4 → 把 `pgdata/` 改名为 `pgdata.corrupted-{ISO}` 留档 → 用同名空目录重试一次。重试也失败 / 断路器跳闸 → 切换到 `pgdata-ephemeral-{pid}` 临时模式（本会话不持久但 app 不再卡死）。三种结果都通过 `consumeStartupNotice()` 留通知 |
| Phase 3 | `src/main/index.ts` | (A) `app.requestSingleInstanceLock()` + `second-instance` 聚焦回主窗口——堵住 PGlite #884 的"双开 → 同时打开同一 dataDir → 必腐化"通道；(B) `initAgentRuntime` 在 `agentManager.start()` 后用 `did-finish-load` + 250ms grace 把 `consumeStartupNotice()` 的内容通过 `agent:event` 发到 renderer，避开 `webContents.send` 在 listener 未挂时静默丢消息的 race |
| Phase 4 | `src/types/agent.ts` + `src/renderer/src/features/agent-chat/NoticesBanner.tsx` | 新 `AgentNotice` kind `pgliteReset`（warning 级别）+ Banner 标签 `database`，details 携带 `backupPath` / `ephemeralDir` / `reason: aborted-recovered \| aborted-rebuild-failed \| breaker-tripped` |

参考：
- 上游 issue 串：[electric-sql/pglite#884](https://github.com/electric-sql/pglite/issues/884)（`Aborted()` 在 callMain，PR #892 in flight 未合）+ [#794](https://github.com/electric-sql/pglite/issues/794)（同根因，第二次 open 必崩）
- PGlite 自陈："Postgres in 'single user mode'... will corrupt the database if you open it multiple times at once"（docs/filesystems.md）
- Codex 类比：[openai/codex#11435](https://github.com/openai/codex/issues/11435)（"per-process unique session directories"，本次 ephemeral 兜底借鉴）

#### 用户可见行为
- 旧用户升级后第一次启动如果命中此 bug：弹一条黄色 banner "数据库目录无法打开（PGlite #884 已知 bug），已自动重建。旧数据备份在：…\pgdata.corrupted-2026-05-14T…"，agent 历史归零但 app 立即可用。备份目录可手动检查或在上游修复后导入。
- 24h 内连续 4 次重置触发断路器后：banner 变成 "切换到临时模式"，提示用户手动清理或排查硬件 / 杀软干扰。
- 双开第二个实例：第二个进程立即 quit，第一个窗口被 focus 到前台。

### v4.2.5 (2026-05-13)

修复"PlanCard 不渲染 / `update_plan` 工具仍走通用 chip"的双向问题。

| 改动 | 文件 | 说明 |
|------|------|------|
| Phase 1 | `src/main/agent/codexNotificationRouter.ts` | `TurnPlanStepStatus` 在 v2 协议是 camelCase（`inProgress`），工具参数是 snake_case（`in_progress`）—— 新增 `normalisePlanStepStatus` 折叠大小写 + 分隔符 + 同义词（`done`/`active`/`running`），所有渠道统一规一化为 snake_case。证据：`codex-rs/app-server-protocol/src/protocol/v2.rs:6450` |
| Phase 2 | `src/main/agent/codexNotificationRouter.ts` | v2 `ThreadItem::DynamicToolCall` 的工具名字段是 `tool`，旧 build 是 `toolName`，MCP 是 `name`。`summarizeActivity` + `readToolName` 都改成 canonical-first（`tool → toolName → name`）。证据：v2.rs:5578 |
| Phase 3 | `src/main/agent/codexNotificationRouter.ts` | plan tool 命中后**始终路由**，即便 args 完全没有结构化 plan 数据也发 placeholder 事件。新增 `extractStepsFromAnywhere` 覆盖 `plan`/`todo`/`todos`/`steps`/`items`/`args` 自身 5+ 种字段形状，外加自由文本回退：解析 `1./1)/1、/-/•/①…⑩` 列表标记 + `[x]/[-]/[ ]` 复选框 + 周围 prose 的"第 N 项进行中" / "已完成第 1、2 项" 状态线索 |
| Phase 4 | `src/renderer/src/features/agent-chat/cards/ActivityCard.tsx` | PlanCard 视觉重写：单行头部 `☰ X of Y Done`（图 1 spec），干净状态图标（`○` pending / `→` in_progress / `⊘` completed），空步骤态显示 `Creating plan…` placeholder 占位（不再回退到通用 chip） |
| Phase 5 | 测试 | +5 router 测试（camelCase / kebab / Pascal / 同义词 / 自由文本 markdown / `args.todo` 单数 / checkbox 标记）；+2 PlanCard 测试（placeholder 态 + explanation 显示）；总计 87 plan 相关测试全过 |

参考：
- Codex protocol 源：`codex-rs/app-server-protocol/src/protocol/v2.rs`
- Codex plan_tool 源：`codex-rs/protocol/src/plan_tool.rs`
- Codex PR #7329（`turn/plan/updated` 通知）/ PR #10124（`update_plan` → `todo_write` rename，未合并）

### v4.2.4 (2026-05-11)

修复"拖大文件进对话框 → Prisma `Server has closed the connection`"崩溃。

| 改动 | 文件 | 说明 |
|------|------|------|
| Phase A | `src/main/agent/AttachmentService.ts` | 改成**流式 ingest**：`pipeline(createReadStream → writeStream)` + chunk-level sha256，串行处理 + 每文件后 `setImmediate` 让出事件循环，单文件失败通过 `attachment-error` event 隔离不杀整轮 |
| Phase A | `src/main/agent/AgentManager.ts` + `src/types/agent.ts` + `src/renderer/src/features/agent-chat/{store,NoticesBanner}` | 新增 `attachment_error` 流事件 + `attachmentSkipped` notice，前端显示"已跳过 xx.md：原因" |
| Phase B | `src/renderer/src/features/agent-chat/MentionInput.tsx` | picker 路径优先用 `webUtils.getPathForFile`（preload 已暴露），只在 fallback 时才读 `arrayBuffer()`。从此 N 个 100MB 文件不再经 IPC structuredClone |
| Phase C | `src/main/agent/pgliteWorker.ts` + `src/main/agent/db.ts` + `scripts/build-pglite-worker.mjs` | PGlite + `PGLiteSocketServer` 搬到 Electron `utilityProcess`，主进程偶发卡顿不再饿死数据库 socket。worker 用 esbuild 单独打成 1.6KB CJS bundle |

参考：
- 复盘 spec：`docs/superpowers/specs/2026-05-11-attachment-streaming-design.md`
- Codex 同类问题：openai/codex#13508、#15270、PR #21108

### v4.2.3 (2026-05-10)

- 取消客户端显式超时（"天荒地老"模式）：删除 `ApiService` 中的 `composeTimeoutSignal`
- 进度条动画窗口从 5 分钟拉到 15 分钟（`GeneratePage`）
- BatchPage 全量重写为 zinc + 赛博朋克黄风格

### v4.2.2 (2026-05-09)

- MCP 端口绑定方案 B：默认 7842 优先，`EACCES`/`EADDRINUSE` 自动回退 ephemeral，全部失败时优雅降级
