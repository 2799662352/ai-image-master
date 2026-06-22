# catimation 画布(图片闭环 MVP)设计

- 日期:2026-06-22
- 状态:已批准设计,待写实现计划(writing-plans)
- 参考:AI-Canvas(`reference-projects/AI-Canvas`,MIT)、现有 catimation MCP / ToolRouter / AgentToolExecutor

## 1. 目标与范围

把 AI-Canvas 的「自然语言出图 → 画布图片框 → 标注(箭头/文字/圈) → 按标注修图 → 新版放右侧、旧图保留」交互闭环,**适配**进现有 catimation Electron 应用,**最大化复用 AI-Canvas 的纯逻辑代码,不重复开发传输层**(传输层用现有 ToolRouter + IPC)。

### MVP 范围(本 spec)

- 仅图片闭环:出图 / 建图片框 / 插图 / 标注解析 / 按标注修图 / 版本(新版放右侧 + 箭头)。
- 编辑触发方式:**画布按钮 +「改图请求队列」**(完整搬运 AI-Canvas 的 watch / queue / 状态卡机制)。
- 出图统一用现有 `generate_image` 工具(不引入 AI-Canvas 的 codex image 2.0 反向委托)。

### 非目标(YAGNI,后续版本)

- 分镜网格(grid-to-seedance)、视频片段上画布。
- 磁盘快照文件:MVP 依赖 tldraw `persistenceKey` 本地持久化;`save_snapshot` 仅触发 flush。
- 独立画布窗口、多页面、多画布管理。

## 2. 复用边界:搬什么 / 扔什么 / 改写什么

### ✅ 直接搬运(纯逻辑 / 纯 tldraw 操作,零传输耦合)

| AI-Canvas 来源 | 内容 | 迁移方式 |
|---|---|---|
| `shared/src/geometry.ts` | 相交/距离/相对区域计算 | 整文件复制 |
| `shared/src/annotationParser.ts` | 箭头↔文字配对、圈/框相交、区域归一化、改图 prompt 生成 | 整文件复制(在 renderer 运行) |
| `shared/src/types.ts` | `Bounds/ShapeSummary/AnnotationInstruction/CanvasStatePayload/AiCanvasRole/EditRequest*` 数据模型 | 整文件复制到共享 types |
| `mcp-server/src/annotations/parseAnnotations.test.ts` | 解析器单测 | 复制(证明迁移正确) |
| `canvas-app/src/App.tsx` 内:`createHolder` / `insertImageIntoHolder` / `createImageVersion` / `summarizeShape` / `extractText` / `getBounds` / `loadImageDimensions` | tldraw 画框、贴图、新版放右侧+箭头、读画布为 ShapeSummary | 几乎逐字搬进 renderer 的 `shapeOps.ts` |
| `mcp-server/src/index.ts` 内:`generationPrompt` / `editPrompt` / `holderSize` / `findPreferredHolder` | 提示词与尺寸/holder 选择 | 复制到 renderer 的 `promptBuilders.ts` |

### ❌ 扔掉(现有 app 已有更好等价物)

| AI-Canvas 来源 | 它干的事 | 现有替代 |
|---|---|---|
| `canvas-app/src/server.ts` | Express+WS 服务器、状态持久化、改图队列 | ToolRouter + IPC + 主进程 `EditRequestRegistry` |
| `canvas/client.ts` + `canvas/process.ts` | HTTP 客户端 + 子进程拉起画布服务 | `router.call()` |
| `.mcp.json` + 独立 Vite app + `main.tsx` | 独立打包画布网页 | tldraw 已嵌入 renderer 的 Agent Workspace |
| `image/codexImage20Adapter.ts` | 反向委托 codex 出图 | 现有 `generate_image`(VIP 通道,落地+持久化) |

### 🔁 改写(名字 / schema / 语义照搬,只换传输)

`mcp-server/src/index.ts` 的工具**躯壳**:工具体里的 `postJson('/api/...')` → 改为 `router.call(...)`(renderer 工具)或直接读写主进程 registry(main 工具)。

## 3. 代码落位

```
src/types/canvas.ts                         ← 搬 types.ts,main + renderer 共用
src/renderer/src/features/agent-workspace/canvas/
  ├─ geometry.ts                            ← 整文件搬(纯数学)
  ├─ annotationParser.ts                    ← 整文件搬(在 renderer 跑)
  ├─ promptBuilders.ts                      ← 搬 generationPrompt/editPrompt/holderSize/findPreferredHolder
  ├─ shapeOps.ts                            ← 从 App.tsx 搬画布操作(createHolder/insertImage/createVersion/summarizeShape/getBounds/extractText/loadImageDimensions)
  └─ CanvasSection.tsx                      ← tldraw 宿主 + 右栏「按标注修图」按钮 + 状态卡(替换当前 smoke 版)
src/main/mcp/canvas/EditRequestRegistry.ts  ← 新建,镜像现有 imageTaskManager 的长轮询模型
src/main/mcp/tools/canvasTools.ts           ← 画布 MCP 工具注册
```

接入点:
- `src/main/mcp/tools/index.ts` 的 `registerTools()` 增加 `registerCanvasTools(server, router)`。
- `src/renderer/src/features/agent-chat/AgentToolExecutor.ts` 的 `call()` switch 增加 `canvas_*` renderer 工具分支。
- 新 IPC:`canvas:submit-edit-request`(renderer → main 入队)、`canvas:edit-queue-status`(renderer 拉状态卡)。preload 暴露对应 API。

## 4. 队列放主进程(镜像 `imageTaskManager`)

AI-Canvas 把改图队列放它的 Express server;本 app 无该 server,故队列放**主进程** `EditRequestRegistry`,照抄现有 `ImageTaskManager.waitForTerminal` 的服务端长轮询。

**解析在 renderer 跑**(tldraw editor 在 renderer,parser 是纯函数):用户点「按标注修图」时,renderer 跑 `parseAnnotations` + 建 `editPrompt`,把"已解析好的改图请求"(annotationPlan + editPrompt + 输入图本地路径 + targetShapeId)经 `canvas:submit-edit-request` 入队主进程。主进程因此无需搬运整张画布状态。

`EditRequestRegistry` 职责:
- `enqueue(request)`:renderer 提交,状态 `queued`。
- `waitForNext(deadline, { claim })`:`watch_edit_requests` 长轮询;有 `queued` 即返回(可标 `processing`)。
- `get(id)` / `update(id, status, result?)`。
- 状态统计:`listenerActive`(watch 在飞)、`queuedCount`、`processingCount` → 供 `canvas:edit-queue-status`。

## 5. MCP 工具清单(名字全照搬 AI-Canvas)

| 工具 | 路由 | 体 |
|---|---|---|
| `canvas_open` | renderer | 切到 Canvas tab(仿 `navigate_page`) |
| `prepare_image_generation` | renderer | 开画布 + 建/找 holder,返回 holder id/bounds + 建议 prompt + aspect |
| `create_image_holder` | renderer | `shapeOps.createHolder` |
| `insert_image_into_holder` | renderer | 本地路径 → data URL(复用 `attachments.readThumb`)→ 贴图 v1 |
| `collect_annotations` | renderer | 跑 parser,返回 annotationPlan |
| `prepare_annotation_edit` | renderer | 跑 parser + 建 editPrompt,返回 ready 编辑请求 |
| `create_image_version` | renderer | 新版放右侧 + 箭头,version+1 |
| `save_snapshot` | renderer | flush tldraw 快照(report state) |
| `watch_edit_requests` | **main** | 长轮询 `EditRequestRegistry`(仿 `check_image_task`,窗口 ~25s) |
| `get_edit_request` | **main** | 读 registry |
| `update_edit_request` | **main** | 改 registry 状态(completed/failed/processing/needs_clarification) |
| `generate_image` | — | 现有,不动 |

## 6. 端到端数据流

1. 用户:"做张拉面广告" → codex 调 `canvas_open` + `prepare_image_generation`(建 holder)。
2. codex 调 `generate_image`(现有)→ 拿到本地路径。
3. codex 调 `insert_image_into_holder({ holderShapeId, imagePath })` → renderer 贴图 v1。
4. codex 调 `watch_edit_requests` → 主进程长轮询(无任务则返回"监听中")。
5. 用户在画布画箭头/文字/圈 → 点「按标注修图」。
6. renderer:`parseAnnotations` → 建 `editPrompt` → IPC `canvas:submit-edit-request` 入队主进程。
7. 主进程挂着的 `watch_edit_requests` 立即返回请求给 codex。
8. codex 调 `generate_image({ prompt: editPrompt, referenceImages: [原图路径] })` → 新图。
9. codex 调 `create_image_version({ sourceShapeId, imagePath })` → renderer 新版放右侧 v2。
10. codex 调 `update_edit_request({ requestId, status: 'completed' })` → registry。
11. 回到第 5 步循环。

状态卡:renderer 定时拉 `canvas:edit-queue-status` 渲染「Codex 监听中 / 正在修图 / 已暂停」(搬 AI-Canvas `listenerView`)。

## 7. 关键技术点 / 错误处理

- **图片加载**:`generate_image` 返回 OS 路径;renderer 的 `<img>` / tldraw asset 不能直接读 OS 路径 → 复用现有 `attachments.readThumb` IPC 转 data URL(与参考图同一条路径,见 `AgentToolExecutor.resolveReferenceImages`)。`insert_image_into_holder` 与 `create_image_version` 都走这条。
- 解析 `needsClarification`(多图未选 / 低置信度 / 无标注)→ 请求标 `needs_clarification` → codex 反问用户而非盲改。
- editor 未就绪 / holder 未找到 / 源图未找到 → throw → 走现有 renderer-tool 错误链(`AgentToolExecutor.execute` 捕获回 `{ ok:false, error }`)。
- `watch_edit_requests` 长轮询窗口须 < codex 工具超时,取 ~25s(仿 `CHECK_IMAGE_LONG_POLL_MS`);超时返回"暂无任务"让 codex 决定是否再 watch。
- 线程归属:画布工具与聊天解耦,MVP 不做按线程隔离的画布(单画布单 Agent Workspace)。

## 8. 测试

- 搬 `parseAnnotations.test.ts`(直接证明解析器迁移正确,作为迁移验收)。
- `EditRequestRegistry` 单测:enqueue / waitForNext(命中 + 超时) / claim / update / 状态统计(仿 `imageTaskRegistry` 测试)。
- `canvasTools` 注册 + 路由单测:renderer 工具走 `router.call`、main 工具读写 registry(仿现有工具测试)。
- 类型检查 + 相关文件零新增 lint;`npm run build:vite` 通过。

## 9. 风险

- tldraw 5.x 生产需 license key,否则水印(沿用现状,MVP 不阻塞)。
- `attachments.readThumb` 的 mime/size 白名单需覆盖生成图尺寸(2K/4K);若超限需放宽或走专用读图通道。
- 队列与聊天 turn 的时序:`watch_edit_requests` 长轮询期间 codex turn 占用 —— 沿用 `check_image_task` 已验证的"短窗口 + 反复调"模型规避。
