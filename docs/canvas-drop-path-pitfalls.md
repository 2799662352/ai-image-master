# 画布「来源即可见」踩坑文档(拖拽即写路径 + 网页链接)

> 目标:**不管内容用什么方式进画布**,它的「来源」(本地磁盘路径 *或* 网页 URL)都要立刻
> 出现在 `canvas_snapshot` 里,Agent 不必再单独调 `get_canvas_video` 之类工具去临时
> materialize。这是一个**公用能力**,而不是只给某一类文件/某一条入口开的小灶。
> 参考实现:`reference-projects/AI-Canvas`(改 `registerExternalAssetHandler`,让路径在创建时
> 就写进 asset meta)与 `reference-projects/tldraw`。
>
> 适用版本:路径部分 CATIMATION 4.3.61 起;网页链接 + 读侧统一(`sourceUrl`)4.3.62 起。
> 涉及文件见文末「改动清单」。

---

## TL;DR(结论先行)

「来源」字段统一两类:**`assetPath`**(本地磁盘文件)/ **`sourceUrl`**(网页链接)。
覆盖**所有入口**(OS 拖拽 / 工作区树拖拽 / Agent 生成 / 粘贴):

| 内容 / 入口 | OS 桌面拖拽 | 工作区树拖拽 | Agent 生成 | 粘贴 (Ctrl+V) | 来源字段 |
|---|---|---|---|---|---|
| 图片 (png/jpg/webp/…) | ✅ shape + `meta.assetPath` | ✅ shape + `assetPath` | ✅ shape + `assetPath`(insert_image_*) | ✅(剪贴板→base64 落盘) | `assetPath` |
| 视频 (mp4/webm/mov/…) | ✅ shape + `meta.assetPath` | ✅ shape + `assetPath` | ✅ shape + `assetPath`(insert_video) | ✅ | `assetPath` |
| 音频 (mp3/wav/m4a/…) | ✅ 占位便签 + `meta.assetPath` | ✅ 占位便签 + `meta.assetPath` | ✅ 占位便签(若放上画布) | — | `assetPath` |
| 其他 (zip/pdf/md/txt/…) | ✅ 占位便签 + `meta.assetPath` | ✅ 占位便签 + `meta.assetPath` | ✅ 占位便签(若放上画布) | — | `assetPath` |
| **网页链接** | ✅ bookmark/embed → `props.url` | — | ✅(putExternalContent) | ✅(粘贴链接) | **`sourceUrl`** |

- **图片 / 视频** → tldraw 原生能渲染,生成真实 image/video shape,路径写进 asset `meta.assetPath`;Agent 生成的(`insert_image_into_holder` / `insert_video` / `create_image_version`)在插入时把 `imagePath`/`videoPath` 落进 `assetPath`,所以**生成的内容天然带路径**。
- **音频 / 其他(mp3/md/txt/zip…)** → tldraw **无法渲染**(原生不会建任何 shape),我们改为放一个**带路径的占位文本便签**(`meta.assetPath` + `meta.assetKind`)。
- **网页链接** → 用户粘贴 URL,tldraw 原生建 `bookmark`(或 `embed`)shape,链接就在 `props.url` 里;我们在**读侧**(`summarizeShape`)把它吐成 `sourceUrl`,无需为这条入口单独接线。
- **读侧统一(关键设计)**:真正把它做成「公用能力」的是 `summarizeShape` —— 它对**每一种 shape** 统一暴露来源:image/video 从 backing asset 取 `assetPath`/`src`,占位便签从 `meta.assetPath`,bookmark/embed 从 `props.url`(→ `sourceUrl`),任意 shape 还可读 `meta.sourceUrl`。这样新增入口只要把信息写进 shape 的原生位置或 meta,快照就自动可见。
- **关键前提**:本 app **未开沙箱**(`sandbox: false`),所以 OS 拖拽能用 `electronAPI.getFilePath`(= `webUtils.getPathForFile`)拿到**真实磁盘路径**,**零拷贝、任意类型、任意大小**。base64 复制只作为合成/剪贴板文件(无 OS 路径)的兜底。

---

## 坑位全记录(按踩到的先后顺序)

### 坑 1 —— OS 拖拽的 `asset:<id>` 引用根本不是路径
tldraw 把 OS 拖进来的媒体字节塞进 **IndexedDB**,shape 的 `src` 只是一个不透明的
`asset:<id>` 引用。`canvas_snapshot` 里既没有磁盘路径,Agent 也无法直接用它去跑 ffmpeg。

- 早期补丁:`summarizeShape` 对 video 富化 `assetPath/assetUrl`;新增 `get_canvas_video`
  工具用 `editor.resolveAssetUrl()` 把 `asset:<id>` 解析成 `blob:` 再 materialize 落盘。
- 但这是「**按需 materialize**」,不是「**创建即有路径**」,体验差(Agent 要多调一次工具)。

### 坑 2 —— `blob:` URL 过不了 IPC
渲染进程拿到的 `blob:` URL **不能直接通过 IPC 传到主进程**(主进程没有该 blob 上下文)。
`understand_canvas_video` 早期就因为走 COS 中转 + `blob:` 而对 OS 拖拽视频失败。
→ 必须先在渲染进程把 blob materialize 成磁盘文件,再把**路径**交给主进程。

### 坑 3 —— PGlite `P1017` 数据库抖动会「吞掉」路径
文件其实已经成功写盘了,但 `AttachmentService.ingestOne` 在写元数据(Prisma/PGlite)那一步
若抛 `Server has closed the connection (P1017)`,整个方法失败,**已落盘的路径被丢弃**,
表现为用户说的「好像没成功存储 / 没有披露链接」。

- 修复:`ingestOne` 用 try/catch 包住 DB insert;DB 失败时**返回一个仍带 `localPath` 的合成
  记录**(文件已经安全在盘上)。配套回归测试模拟 `P1017` 断言路径不丢。

### 坑 4 —— tldraw 默认只接受 image/video,音频/其他**连 shape 都不建**
`reference-projects/tldraw/.../defaultExternalContentHandlers.ts`:

- `getAssetInfo()` → `getAssetUtilForMimeType(file.type)`,只有注册了 asset util 的
  mime(默认就是 image/* 和 video/*)才返回 util,否则 `return null`。
- `notifyIfFileNotAllowed()` 对没有 util 的 mime 直接弹 `assets.files.type-not-allowed`
  toast 并拒绝。

所以 **OS 拖一个 mp3 / zip 上来,tldraw 什么都不会建**,自然没有 shape 可挂路径。
→ 想让音频/其他「有路径」,必须**我们自己造一个占位 shape**。

### 坑 5 —— 不能在 **asset handler** 层处理非媒体(它会 `assert` 抛错)
`defaultHandleExternalFileAsset` 对非媒体走 `assert(false, 'File checks failed')` **抛异常**;
而 `defaultHandleExternalFileContent`(**content** 层)对非媒体是 `continue` **静默跳过**。

→ 结论:**要 wrap 的是 `files` 这个 external-CONTENT handler,不是 asset handler**。
我们在 content 层把一次拖拽里的文件**拆两拨**:

- tldraw 能渲染的(`getAssetUtilForMimeType` 为真)→ 委托给捕获到的默认 content handler
  (它内部再走 asset handler,于是图片/视频仍享受我们在 asset handler 里写的 `meta.assetPath`);
- 其余 → 各自生成一个占位便签(`placeOther`)。

### 坑 6 —— `attachments:save` IPC 只收 image/video,且 base64 内联有 ~100MB 上限
`src/main/index.ts` 的 `attachments:save` 显式 `if (!mime.startsWith('image/') && !mime.startsWith('video/')) reject`,
而且字节是 base64 走 IPC 在内存里转,大文件会撑爆渲染进程堆。

→ 如果继续走「读字节 → base64 → save」,音频/其他/大文件全卡死。

### 坑 7(关键反转)—— `sandbox: false` ⇒ 直接拿真实路径,零拷贝
本 app `BrowserWindow` 是 `sandbox: false`(`src/main/index.ts`),preload 已暴露
`electronAPI.getFilePath`(= Electron `webUtils.getPathForFile`)。对 **OS 拖进来的 File**,
它返回**真实磁盘路径**:

- 零拷贝(不读字节、不 base64、不走 save IPC);
- 任意类型(音频/zip/pdf 都行);
- 任意大小(2GB 视频也行,绕过坑 6 的 100MB 上限);

所以 `resolveDroppedFileDiskPath` 的策略是 **「OS 真实路径优先,复制兜底」**:

1. 先 `electronAPI.getFilePath(file)` → 有就直接用(覆盖绝大多数桌面拖拽场景);
2. 拿不到(合成/剪贴板 File,`getFilePath` 返回 `''`)才回退到 base64 → `attachments:save`
   (因此**未改主进程 IPC**;兜底仍是 image/video + 100MB 上限,够用)。

> 副作用提醒:OS 真实路径指向用户**原始文件**,若用户事后移动/删除该文件,路径会失效
> (但 tldraw 仍在 IndexedDB 留有字节用于画面渲染,只是「按路径跑 ffmpeg」会失败)。
> 这是「零拷贝 + 支持任意大小」换来的取舍;需要持久副本时可让 Agent 显式落盘。

### 坑 8 —— `onMount` 执行顺序:默认 handler 先注册
`reference-projects/tldraw/.../Tldraw.tsx`:框架的默认 external handlers 在内部
`onMount` 里注册,用户传入的 `onMount` **最后**跑。所以我们在自己的 `handleMount` 里
`editor.externalAssetContentHandlers.file` / `editor.externalContentHandlers.files`
**capture 到的就是默认实现**,wrap 之后再 `registerExternalAssetHandler` /
`registerExternalContentHandler` 覆盖回去,安全。

### 坑 9 —— 两条拖拽路径机制完全不同,别混
- **工作区树(FILES 面板)拖拽**:走自定义 MIME `application/x-catimation-file-paths`,
  CanvasSection 在 capture 阶段拦截 → `canvasBridge.insertFileAt(path, point)`。
  **本来就有真实磁盘路径,无需任何拷贝/`getFilePath`**。
- **OS 桌面拖拽**:走 tldraw 自己的 drop pipeline → external content/asset handler。
  路径靠 `getFilePath`(坑 7)。

两条路径都要支持音频/其他,但实现点不一样:树拖拽改 `insertFileAt`,OS 拖拽改两个 handler 的 wrap。

### 坑 10 —— 网页链接的「路径」在 `props.url`,不在 meta,也不在 asset
用户粘贴一个网页链接,tldraw 默认走 **`url` external-content handler**(`putExternalContent({type:'url'})`),
建一个 `bookmark`(普通链接)或 `embed`(YouTube 这类可嵌入的)shape。和图片/视频不同:

- 链接的「来源」就在 **`shape.props.url`**(context7 `/tldraw/tldraw` + 本地源都确认:
  bookmark `props: { assetId, h, url, w }`);
- bookmark 虽然也有一个 backing asset(存 title/缩略图/favicon),但那不是「链接本身」;
- 它**不经过**我们 wrap 的 `file` / `files` handler(那是文件通道),所以**不能靠那套写 meta**。

→ 正确做法:**不要再去 wrap `url` handler 写 meta**(多此一举、还要管 embed/bookmark 两种),
而是在**读侧** `summarizeShape` 直接读原生 `shape.props.url` → `sourceUrl`。这样不论链接是粘贴、
`putExternalContent` 还是 `createBookmarkFromUrl` 建的,快照都能看到 —— 这正是「读侧统一」的价值。

> 经验:能在**读侧**用 shape 的**原生数据**表达的来源,就不要在写侧为每条入口接线。
> 写侧 `meta.assetPath` 是不得已(磁盘路径不是 tldraw 原生字段);链接是原生字段,读侧解决最干净。

---

## 最终实现要点

1. `canvasBridge.resolveDroppedFileDiskPath(file, threadId)`(原 `persistDroppedAssetFile`):
   OS 真实路径优先 → base64 复制兜底(媒体 + ≤100MB)。
2. `canvasBridge.placeDroppedNonMediaFile(file, point, index, threadId)`:OS 拖拽的音频/其他 →
   解析路径 + 放占位便签。
3. `canvasBridge.insertFileAt`:树拖拽时 image/video → 真实 shape;audio/other → 占位便签(直接用树给的真实路径)。
4. `shapeOps.insertFilePlaceholder(...)`:造一个带 `meta.assetPath` / `meta.assetKind` 的 text shape。
5. `shapeOps.makeFilesContentHandlerWithPlaceholders(default, isHandledByTldraw, placeOther)`:
   纯函数,content 层拆「媒体委托默认 / 其余占位」,可单测。
6. `CanvasSection.handleMount`:capture 默认 `file` asset handler + `files` content handler,各自 wrap 后覆盖;
   `isHandledByTldraw = (f) => !!editor.getAssetUtilForMimeType(f.type)`(用 tldraw 自己的判定,和原生行为对齐)。
7. **`shapeOps.summarizeShape`(读侧统一 / 公用能力)**:对每种 shape 暴露来源 ——
   image/video 从 backing asset 取 `assetPath`/`src`,占位便签从 `meta.assetPath`,
   **bookmark/embed 从 `props.url` → `sourceUrl`**(并 mirror 进 `assetUrl`),任意 shape 还可读 `meta.sourceUrl`。
   `ShapeSummary` 新增 `sourceUrl?: string`(`src/types/canvas.ts`)。

## 验证

- 单测:`canvas/__tests__/dropTimePath.test.ts`(asset wrap / 路径解析 / 占位便签 / content 拆分)、
  `canvas/__tests__/droppedMedia.test.ts`(`insertFileAt` 路由)、
  `canvas/__tests__/imageFocusedSnapshot.test.ts`(image/video 富化 + **bookmark/embed `sourceUrl` 暴露**)。
- 套件:上述 3 文件 37 测试全绿;`canvas_snapshot` 用 `JSON.stringify` 整个吐 shapes,无字段白名单,`sourceUrl` 自动可见。
- `tsc --noEmit`:改动文件零新增类型错误。

## 容易再次踩的雷(给后来者)

- 不要试图在 asset handler 里处理音频/其他 —— 它对非媒体 `assert` 抛错(坑 5)。
- 不要为了支持音频去无脑放开 `attachments:save` 的 mime —— OS 拖拽用 `getFilePath` 就够了,
  放开反而扩大了「base64 进内存」的攻击/OOM 面(坑 6 / 坑 7)。
- 改 handler 必须在用户 `onMount` 里 capture 默认实现(坑 8),且 wrap 要对「全是媒体」的拖拽
  保持和原生**逐字节一致**的行为(content wrap 的 `supported` 分支)。
- 记得两条拖拽路径(坑 9)都要覆盖,否则会出现「从 FILES 面板拖 mp3 有路径,从桌面拖 mp3 没路径」之类的不一致。
- 网页链接别去写侧 wrap `url` handler(坑 10):链接是 tldraw 原生字段(`props.url`),读侧 `summarizeShape` 一处解决,
  否则要分别处理 bookmark / embed,还可能和默认 unfurl 逻辑打架。

## 改动清单

- `src/renderer/src/features/agent-workspace/canvas/canvasBridge.ts`
- `src/renderer/src/features/agent-workspace/canvas/shapeOps.ts`(`summarizeShape` 加 `sourceUrl`)
- `src/renderer/src/features/agent-workspace/CanvasSection.tsx`
- `src/types/canvas.ts`(`ShapeSummary.sourceUrl`)
- `src/main/agent/AttachmentService.ts`(坑 3 容错,先前提交)
- 测试:`canvas/__tests__/dropTimePath.test.ts`、`canvas/__tests__/droppedMedia.test.ts`、
  `canvas/__tests__/imageFocusedSnapshot.test.ts`(bookmark/embed `sourceUrl`)、
  `src/main/agent/__tests__/AttachmentService.streaming.test.ts`
