# tldraw 官方 mcp-app 能力盘点 & 落地建议（我们还没用上的部分）

- 日期：2026-06-22
- 状态：盘点完成；§7 两个校验崩溃已即时修复；**§4.E1+E2 已实现（原子写入 + 写入不崩画布）**；**§4.A 已实现（focused image 字段 + `list_canvas_images`/`get_canvas_image`）**；**§4.D 已实现（全工具 annotations）**；**§4.C 已实现（版本箭头 binding + 插入后 `zoomToFitShapes`）**；**E3 的 `canvas_open` 真 `waitForEditor` 早已在 renderer 侧落地**；**§4.B 已实现（`canvas_exec` 无限制逃生舱 + `canvas_search` 精选 Editor API 谱）**；**#8/#9 已实现（可恢复 checkpoint：`save_checkpoint`/`load_checkpoint`/`list_checkpoints` + 新文件写 IPC `canvas:{save,read,list}-checkpoint`；用 tldraw 原生 `getSnapshot`/`loadSnapshot`，#8 的 asset 先 shape 后/binding 去重由原生 loadSnapshot 处理）**；**视频已实现（`insert_video`：把生成的视频文件作为 tldraw `video` shape 放上画布，复用 `attachments` 的 video/* 白名单→data URL、原子写入、长边封顶 640、插入后 zoomToFit；`canvas_search` spec 补 `video` 类型）**。全部 A–E + #8/#9 + 视频落地
- 来源：`reference-projects/tldraw/apps/mcp-app`（tldraw 官方 MCP 插件）+ **`github.com/2799662352/sora-canvas-mcp`**（该 mcp-app 的 Node/Express fork，HEAD `671472a0b`；其在官方基础上**新增**的 `list_canvas_images`/`get_canvas_image` 图片对 + 工具 annotations + zod 结果校验，正是我们 §4.A/§4.D 的直接参考）
- 对比对象：我们现有 `src/main/mcp/tools/canvasTools.ts`（7+3 个固定工具）+ `src/renderer/.../canvas/{canvasBridge,shapeOps,annotationParser}.ts`
- 关联：`2026-06-22-catimation-canvas-image-loop-design.md`（图片闭环 MVP 设计）

## 1. 背景

我们的画布集成走的是「**固定工具流**」：`canvas_open` / `prepare_image_generation` / `create_image_holder` / `insert_image_into_holder` / `canvas_snapshot` / `collect_annotations` / `prepare_annotation_edit` / `create_image_version` / `save_snapshot` + 队列三件套（`watch_edit_requests` / `get_edit_request` / `update_edit_request`）。这套对「出图→图框→标注→修图→版本」的产品闭环很清晰。

tldraw 官方 mcp-app 走的是**另一条路**：几乎不堆固定工具，而是用一个通用 `exec`（对 live `editor` 跑任意 JS）+ `search`（查 Editor API 规格）+ 一套「focused 表示法」让模型自由操控画布。本文盘点**它有、我们没有**的能力，并给出适配建议。

## 2. 能力对比总表

| # | 能力 | tldraw 来源文件 | 我们现状 | 价值 | 是否建议落地 |
|---|---|---|---|---|---|
| 1 | **`exec`**：对 live `editor` 跑任意 JS，可 `return` 读数据 | `src/tools/exec.ts` | ✅ **已实现** `canvas_exec`（`shapeExec.executeCanvasCode`，AsyncFunction 跑、注入 raw editor + helpers、**无沙箱限制**、结构化 `{success,error}` 不崩画布） | ★★★ 灵活性天花板 | ✅ B |
| 2 | **`search`**：写 JS 查询 Editor API 规格（方法/shape 类型/helper） | `src/tools/search.ts` | ✅ **已实现** `canvas_search`（精选静态 `EDITOR_API_SPEC`，renderer 内跑，read-only） | ★★ 配合 exec | ✅ B |
| 3 | **Focused 表示法 + Proxy 自动翻译**：`_type`/短 id/扁平 `x,y,w,h,text,color`，方法边界自动 focused↔tldraw | `src/widget/focused/*` | ⚠️ `canvas_snapshot` 对 image 返回 `meta:{}`，无 assetPath | ★★★ 根治 snapshot 信息缺失 | **强烈建议（A）** |
| 4 | exec helper：`boxShapes()` / `createArrowBetweenShapes()` + `Box/Vec/Mat/clamp/createShapeId` 注入 | `src/widget/exec-helpers.ts` | ✅ **已实现** `shapeExec.createExecHelpers`（含 `zoomToFit`，照搬官方 binding props） | ★★ 布局原语 | ✅ B |
| 5 | 代码执行沙箱加固：禁 `fetch/XHR/timer`、10s 超时 | `src/widget/exec-helpers.ts` | ⚠️ **刻意不做**（产品方「不需要限制他」）：全功率运行；仅留 30s 超时防 async 卡死（非能力限制，同步死循环仍会阻塞单线程，已接受） | ★★ 安全前置 | ⛔ 按要求放开 |
| 6 | **箭头 binding**（`createBindings({fromId,toId,terminal})`），挪图时连线跟随 | `exec-helpers.ts` / `to-focused.ts` | ✅ **已实现**：`createImageVersion` 版本箭头改 `createBindings`（start→source / end→new），照搬官方 `createArrowBetweenShapes` 的 binding props | ★★ | ✅ C |
| 7 | **`zoomToFitRequestShapes`**：编辑后自动平移/必要时缩小保持改动可见，绝不放大超过当前级 | `src/widget/snapshot.ts` | ✅ **已实现**：移植为 `shapeOps.zoomToFitShapes`，插入图/建版后调用（防御式，缺相机 API 即 no-op） | ★★ 体验 | ✅ C |
| 8 | `applySnapshot` 稳健恢复：先 asset 后 image shape、binding 去重、`forceAutoSize` 重跑 onBeforeCreate | `src/widget/snapshot.ts` | ✅ **已实现（免手写）**：`load_checkpoint` 用 tldraw 原生 `loadSnapshot(editor.store, snapshot)`，asset 先 shape 后 / binding 去重 / onBeforeCreate 由原生处理，无需移植官方手写 `applySnapshot` | ★ 正确性 | ✅ #8 |
| 9 | checkpoint + `canvasId` fork：`save/read_checkpoint`、`_get_canvas_state`、exec 回传 canvasId | `src/register-tools.ts` | ✅ **已实现**：`save_checkpoint`/`load_checkpoint`/`list_checkpoints`（`getSnapshot`→JSON 落盘，`loadSnapshot` 恢复）。新文件写 IPC `canvas:{save,read,list}-checkpoint`（`attachments:save` 仅收 image/video，故新开）。单编辑器内「命名 checkpoint = fork 点」语义（官方需多 store 仅因其无状态 serverless + Durable Objects） | ★ 多画布/历史 | ✅ #9 |
| 10 | 工具 annotations：`readOnlyHint/destructiveHint/idempotentHint/openWorldHint` | 全部 `registerTool` | ❌ 一个都没设 | ★ 便宜 | 建议（D） |
| 11 | CSP `resourceDomains` 清单：`cdn.tldraw.com`+`fonts.googleapis/gstatic`+`blob:` | `register-tools.ts` L350 | ✅ 已踩坑并修过 | — | 反向印证我们 CSP 修复方向正确 |

## 3. 明确**不抄**

- **`image-guard.tsx`**：官方 demo **屏蔽**图片拖拽/粘贴（它不支持图片）。我们是图片工具，需求相反 —— 要确保粘贴/拖拽**可用**（默认 `<Tldraw>` 不装该 guard，所以用户手动拖入图片**和视频**都可用；Codex 程序化放视频走 `insert_video`，放文字走 `canvas_exec` 建 `text`/`note`）。
- **MCP App resource / widget 分发**（`registerAppResource`、ext-apps、按 ChatGPT/Claude host 注入 HTML + domain 哈希）：那是给外部 host 用的；我们在自有 Electron renderer 内嵌 tldraw，用不上。
- **Cloudflare Worker / dynamic worker loader**（`search` 在隔离 worker 跑代码）：我们没有 Worker 运行时；若做 `search`/`exec`，在 renderer 沙箱里跑即可（见 #5）。

## 4. 落地建议（针对「图片闭环」产品）

不建议全盘改成 exec/search —— 我们的 holder/version/标注修图是明确产品流，固定工具更清晰、更可控。建议**混合**，按性价比优先：

### A. `canvas_snapshot` 升级为 focused 格式 + 借鉴 sora 的 list/fetch 图片对 ✅ 已实现
- **动机**：当前对 image shape 返回 `"meta": {}`，模型拿不到 `assetPath`/尺寸，导致"看得到图却拿不到图文件路径"。这是已暴露的真实痛点。
- **做法（已落地）**：
  - **A1 focused 字段**：`shapeOps.summarizeShape` 对 `image` shape 解析其 backing asset（`editor.getAsset(props.assetId)`，可选链以兼容简单 fake），回传 `assetId`、intrinsic `imageWidth/imageHeight`、`assetUrl`(=asset.props.src)，并在 shape.meta 无 `assetPath` 时从 `asset.meta.assetPath` 兜底。新增到 `types/canvas.ts:ShapeSummary`。
  - **A2 `list_canvas_images`（借自 sora）**：新 `shapeOps.listImageShapes(editor)` → 扁平索引 `{shapeId, assetId, w, h, role, version, title, assetPath, assetUrl, hasFile}`；廉价只读，Codex 先 list 选 `shapeId` 再 fetch。
  - **A3 `get_canvas_image`（借自 sora，按我方 plumbing 改造）**：`canvasBridge.getCanvasImage(shapeId, threadId)` → focused 元数据 + `imagePath`（仅该图、**排除标注**的 on-disk PNG，复用 `exportTargetImageFile`）。与 sora 不同点：sora 返回 inline base64 image content block；我方 MCP `asResult` 仅 JSON，且刻意不回传多 MB base64（token 爆炸），故返回**文件路径**让 Codex 直接打开/喂 `generate_image`。坏 `shapeId` 返回 `{ok:false,error}` 而非抛错。
- **风险**：低。纯读路径，不改写画布。
- **改动面（已落地）**：`shapeOps.{summarizeShape, listImageShapes}` + `canvasBridge.{handle, getCanvasImage}` + `AgentToolExecutor.{call, callCanvas}`（`get_canvas_image` 与 `canvas_snapshot` 一样在 renderer 侧注入活跃 threadId）+ `canvasTools.ts`（注册两工具）+ `types/canvas.ts`（`ShapeSummary` 新字段 + `ImageShapeListItem`）+ `catimation-canvas` first-party skill（list→fetch 指引）。
- **测试**：`__tests__/imageFocusedSnapshot.test.ts`（summarizeShape image 富化 + listImageShapes）；`canvasTools.test.ts` 期望工具表加两项。

### B. `canvas_exec` 逃生舱 + `canvas_search` —— 威力最大 ✅ 已实现
- **动机**：覆盖固定工具够不到的布局操作（移动/对齐/删除/分组/缩放/重排/自定义形状）。
- **做法（已落地）**：
  - **`canvas_exec`**：新 `shapeExec.executeCanvasCode(editor, code)`。用 **AsyncFunction**（renderer CSP `script-src 'unsafe-eval'` 允许，且可直接 jsdom 单测）而非官方的 blob-module import（我们 `script-src` 无 `blob:`）。注入 **raw tldraw `editor`**（未做官方 focused Proxy，模型用真 Editor API）+ helpers（`createShapeId`/`createBindingId`/`createArrowBetweenShapes`/`boxShapes`/`zoomToFit`/`Box`/`Vec`/`Mat`/`clamp`/`getArrowBindings`/`toRichText`，binding props 照搬官方 `exec-helpers`）。返回结构化 `{success,result?,error?}`，**throw 一律 catch**（不冒泡崩 React 树，与 §4.E 一致）。
  - **沙箱：刻意不做**（产品方明确「不需要限制他」）。全功率（不禁 fetch/XHR/timer）。仅保留 30s `Promise.race` 超时兜 async 卡死（**非能力限制**；同步死循环仍阻塞单线程，已知并接受）。`annotations.destructiveHint:true`（任意代码可删形状，给 host 一个确认信号——注解是提示非限制）。
  - **`canvas_search`**：精选静态 `EDITOR_API_SPEC`（members/categories/types.shapeTypes/types.shapes/helpers），模型写 JS 接 `spec` 查询。我们无官方的 TS 反射生成器 + Cloudflare worker，全反射管线过重，精选谱足够喂 exec；read-only，renderer 内跑。
- **改动面（已落地）**：新 `canvas/shapeExec.ts` + `canvasBridge.handle`（`canvas_exec`/`canvas_search` 两 case）+ `AgentToolExecutor`（switch + callCanvas 两分支）+ `canvasTools.ts`（注册两工具）+ `catimation-canvas` skill（free-form 控制章节）。
- **测试**：`__tests__/shapeExec.test.ts`（exec：return 序列化 / 暴露 editor / 注入 helpers / await / throw→结构化 error / 语法错误；helpers：`createArrowBetweenShapes` 双 binding start→from/end→to；search：查 members、shapeTypes/helpers、坏代码结构化 error、谱非空）；`canvasTools.test.ts` 期望表 +`canvas_exec`/`canvas_search`。

### C. 版本箭头用 binding + 插入后 `zoomToFitShapes` ✅ 已实现
- **动机**：连线跟随移动、新版本自动入视口。
- **做法（已落地）**：
  - **C1 binding**：`createImageVersion` 不再造游离箭头，改为先 `createShape(arrow)` 再 `createBindings([{terminal:'start',toId:source},{terminal:'end',toId:newShape}])`，binding props（`isPrecise/isExact:false`、`normalizedAnchor:{0.5,0.5}`）照搬官方 `exec-helpers.createArrowBetweenShapes`。仍在同一 `editor.run` 事务内（与 E1 一致，箭头+绑定要么全成要么回滚）。`buildVersionArrowProps()` 的静态 start/end 只是初值，binding 解析会接管，故无需改它（其防回归测试仍绿）。
  - **C2 framing**：移植 `snapshot.zoomToFitRequestShapes` → `shapeOps.zoomToFitShapes(editor, shapeIds)`：取 `Box.Common` → 已在视口内则跳过 → 否则平移并**只在放不下时缩小**（`Math.min(currentZoom, fitZoom)`，绝不放大超过当前级）→ `setCamera` 带动画。在 `editor.run` **之外**调用（相机非 store 事务）：`insertImageIntoHolder` 框新图、`createImageVersion` 框 source+new。**全程防御式**（缺 `getViewportPageBounds/setCamera` 等即静默 no-op + try/catch），相机失败绝不打断写入。
- **风险**：中 → 实测低。binding 在原子事务内；framing 在事务外且防御式。
- **改动面（已落地）**：`shapeOps.{createImageVersion, insertImageIntoHolder, zoomToFitShapes}` + imports（`Box`/`createBindingId`）。
- **测试**：`__tests__/versionArrowBinding.test.ts`（C1：两条 binding start→source/end→new 同指一个 arrow；C2：off-screen 平移且 zoom≤当前、已在视口内不动、缺相机 API 不抛）；`canvasWriteRobustness.test.ts` 加断言 `bindings@run`（绑定也在事务内）。

### D. 给所有画布工具补 annotations ✅ 已实现
- **动机**：本表 #10。host 据此决定自动批准/危险提示。
- **做法（已落地）**：`canvasTools.ts` 所有 `registerTool` 都加 `annotations`。只读类（`canvas_snapshot`/`list_canvas_images`/`get_canvas_image`/`collect_annotations`/`prepare_annotation_edit`/`get_edit_request`）标 `readOnlyHint:true`；写类（`prepare_image_generation`/`create_image_holder`/`insert_image_into_holder`/`create_image_version`）标 `WRITE`（`destructiveHint:false`——画布写只增形状不删用户数据；`idempotentHint:false`——每次都新增一个形状）；`canvas_open`/`save_snapshot`/`update_edit_request` 标 `idempotentHint:true`；`watch_edit_requests` 默认 claim 会改 registry，标非只读非幂等。
- **风险**：极低。纯元数据。
- **验证**：`@modelcontextprotocol/server@2.0.0-alpha.2` 的 `registerTool` config 支持 `annotations?: ToolAnnotations`（已核 `dist/index.d.mts`）。

### E. 写入鲁棒性：一个坏 shape 不能锁死整块画布 —— 本次事故新增项
- **动机（事故复盘，见 §7）**：我们连续踩了两个 tldraw 校验抛错 —— asset/shape 的 `meta` 含 `undefined`、版本箭头用了已废弃的 `props.text`。每一个都让 `editor.createShape/createAssets` 同步抛错 → 打崩 tldraw 渲染树（"Something went wrong" 错误边界）→ 组件卸载触发 `CanvasSection` 清理里的 `canvasBridge.setEditor(null)` → 之后所有 `requireEditor()` 抛 "Canvas is not open"、`canvas_open` 也回不来。**单个非法字段把整块画布锁死且不可自愈**，这是比单个字段更根本的架构弱点（systematic-debugging Phase 4.5：同型故障反复出现 = 该质疑架构，而非继续补字段）。
- **E1 原子写入 ✅ 已实现**：把 `createImageVersion`/`insertImageIntoHolder` 的多步 `createAssets`+`createShape`(+arrow) 包进 `editor.run(() => {…})`。context7 `/tldraw/tldraw` 官方文档证实：`editor.run` 把多次改动合成**一个事务**，且「**Rollbacks also occur automatically if an error is thrown inside the transaction**」——所以要么全成、要么整体回滚，杜绝"新图进了、箭头崩了"的非原子半残状态（本次 `create_image_version` 正是步骤 2 成功、步骤 3 崩）。
- **E2 写入不崩画布 ✅ 已实现**：`canvasBridge` 新增 `safeWrite(tool, fn)`，包住 `prepare_image_generation`/`create_image_holder`/`insert_image_into_holder`/`create_image_version` 四个写分支。校验失败时**返回结构化错误** `{ ok:false, failed:true, tool, error }` 给 Codex（含失败原因 + 哪个工具），异常绝不冒泡打崩 React 树；**editor 不被 null**（画布保持可用，不再"一坏锁死")。配 E1 原子回滚，捕获时也无半残状态。
- **E3 可恢复 + 对齐 tldraw 字段（部分已实现）**：`canvas_open` **真 `waitForEditor()` 早已在 renderer 侧落地** —— `AgentToolExecutor.callCanvas` 对 `canvas_open` 先 `openCanvasTab()` 再 `await canvasBridge.waitForEditor()` 才返回 `{opened:true}`（`canvasBridge.handle('canvas_open')` 的裸返回只是直接调桥时的兜底，实际打开链路不走它）。**剩余**：严格对齐 tldraw 真实 schema（箭头用 `createArrowBetweenShapes` + `richText`，绝不用 `text`）—— 已有 `buildVersionArrowProps` 作为 §7 即时修复，后续可进一步采纳官方 helper。
- **风险**：低–中。E1/E2 是纯防御性包裹，不改业务语义（已落地、测试覆盖）；E3 的 `canvas_open` 改动触及打开链路，小心。
- **改动面**：`canvasBridge.{handle, safeWrite}` + `shapeOps.{insertImageIntoHolder, createImageVersion}`（已有 `cleanMeta`/`buildVersionArrowProps` 作为 §7 的即时修复）。
- **关联回归测试**：`__tests__/canvasWriteRobustness.test.ts`（E1：断言 asset/image/arrow 创建都发生在 `editor.run` 内；E2：断言写失败返回 `{failed:true}` 且 editor 不被卸载）；`__tests__/cleanMeta.test.ts`、`__tests__/buildVersionArrowProps.test.ts`（复制 tldraw 校验规则做防回归）。

## 5. 建议顺序

~~E（止血）~~ **✅ E1+E2** → ~~A~~ **✅ A1+A2+A3** → ~~D~~ **✅ D** → ~~C~~ **✅ C** → ~~B（exec/search 逃生舱）~~ **✅ B（`canvas_exec` 无限制 + `canvas_search`）**。**A–E 全部落地。** E3 的 `canvas_open` 真 `waitForEditor` ✅ 早已落地，箭头 binding 已对齐官方写法。

**#8/#9 也已落地**：可恢复 checkpoint（`save_checkpoint`/`load_checkpoint`/`list_checkpoints`）走新文件写 IPC `canvas:{save,read,list}-checkpoint`，序列化用 tldraw 原生 `getSnapshot`/`loadSnapshot`（#8 的恢复顺序由原生处理，无需手写 `applySnapshot`）。盘点表 #1–#11 + §4.A–E 全部落地或明确「不抄」。无剩余实现项。

## 6. 待确认

- ~~选哪几项落地（E/A/D/C/B）。~~ **E/A/D/C/B 全部已落地。**
- ~~B 是否同时做 `canvas_search`？~~ **已做**（精选静态 `EDITOR_API_SPEC`，比只在 skill 内联清单更可靠且可单测）。
- ~~`canvas_exec` 沙箱边界？~~ **产品方拍板「不需要限制他」→ 不加沙箱**（仅留 30s 超时兜 async 卡死，非能力限制）。
- **`get_canvas_image` 是否升级为 inline vision（返回 base64 image content block）？** 维持文件路径（产品方未要求改 + 避免 token 爆炸，与 `canvas_snapshot` 一致）。
- ~~**可恢复 checkpoint：**~~ **已做**（产品方「可以都做」）：新增文件写 IPC `canvas:{save,read,list}-checkpoint`（`src/main/file-explorer/canvasCheckpointIpc.ts`，slug-safe id 防穿越 + meta 旁车），renderer `canvasBridge.{saveCheckpoint,loadCheckpoint,listCheckpoints}` 用 `getSnapshot`/`loadSnapshot`。#8 的 asset/shape/binding 顺序由原生 `loadSnapshot` 处理，无需移植手写逻辑。`save_snapshot`（PNG）保留作"分享用扁平图"。

## 7. 事故复盘（2026-06-22，触发本文 §4.E）

两个连续的 tldraw 校验抛错，均在 `create_image_version` 链路，症状都表现为「生图成功但写回画布失败 + 随后 Canvas 卡死」：

| # | 报错 | 根因 | 即时修复 | 防回归 |
|---|---|---|---|---|
| 1 | `At asset(type = image).meta: Expected json serializable value, got object` | asset/shape `meta` 含 `undefined`（如 Codex 不传 `runId` → `sourceRunId: undefined`）。tldraw `isValidJson(undefined)===false`，整个 meta 被拒，报 `typeof meta`=`object` | `shapeOps.cleanMeta()` 剥掉所有 `undefined` 值，应用到全部 meta 字面量 | `cleanMeta.test.ts` |
| 2 | `At shape(type = arrow).props.text: Unexpected property` | tldraw v5 `arrowShapeProps` 无 `text`（`AddRichText` migration 已把 `text`→`richText`）。版本箭头传了 `text:''` | `shapeOps.buildVersionArrowProps()` 去掉 `text`（无标签则不设；要标签用 `richText: toRichText(...)`） | `buildVersionArrowProps.test.ts` |

**关键认知**：两个坏字段都在 `Store.put` 校验阶段抛错（put 之前），所以坏 shape **从未被持久化**（`persistenceKey="catimation-canvas"` 的 IndexedDB 里无残留）。即「画布里留了旧坏箭头」的猜测不成立 —— 重载即恢复。但抛错打崩渲染树导致画布不可自愈，正是 §4.E 要根治的。
