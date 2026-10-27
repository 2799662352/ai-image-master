# Codex 聊天抽屉 UI/UX 落地计划（D1–D6）

> 日期：2026-09-14 · 设计稿：superdesign 项目 `11bfa209`（D1–D6 全部本地产出、`import-design-draft` 导入，0 credits）
> 依据：设计稿 + 上游 openai/codex 文档/源码/issues 核实（见 §0）。用户拍板：「完全按推荐来；模型选择那里要稍微有个聚类」。

## 0. 上游核实（决定我们怎么接，而不是凭印象）

| 事项 | 上游事实 | 对我们的影响 |
|---|---|---|
| 图片输入 | app-server v2 `UserInput::{Text{text,text_elements}, Image{url,detail}, LocalImage{path,detail}, Audio, LocalAudio, Skill, Mention}`（`codex-rs/app-server-protocol/src/protocol/v2/turn.rs`）。`ImageDetail::{Auto,Low,High,Original}`，默认 High；Original 受 `ORIGINAL_IMAGE_MAX_PATCHES = 10_000`（32px patch，≈3.2MP）约束，超出由 history 插入路径自行缩放。 | 草图 / 标注后的图 = 落盘 PNG → 既有附件通路 `localImage`（`<userData>/agent/uploads`，已在 allowedRoots 白名单）。不需要新协议字段。1024² 草图远低于上限，不做客户端缩放。 |
| 线程置顶 | PR [#34840](https://github.com/openai/codex/pull/34840)（2026-07-22 合入）：`thread/metadata/update { threadId, isPinned }`、thread 响应带 `isPinned`、`thread/list` 支持 `isPinned` 过滤。我们 bundled `codex-cli 0.152.1` 已包含。 | 与 `memoryMode` 同一模式：**DB 列 `pinnedAt` 是权威**（离线、首条消息前、无 codex id 的线程都能置顶），有 codex thread id 时 best-effort 镜像 `thread/metadata/update`。`thread/list` 的 `isPinned`/`searchTerm` 可用于「Codex Sessions」区，不改变 DB 权威。 |
| 线程列表 | `thread/list` 支持 `archived` / `searchTerm` / `sortKey`；Desktop 侧栏有分页 bug（#27843、#27159：`useStateDbOnly` + limit≥50 返回空）。 | 我们的侧栏读自本地 DB，不受影响；「Codex Sessions」区继续走 `listThreads` 默认分页，不传 `useStateDbOnly`。 |
| 图片标注 / 草图 | Codex App 仅对**浏览器截图**有 annotation 模式（截图 + 评论文字随任务发送）。图片预览标注是 open issue [#28291](https://github.com/openai/codex/issues/28291)（重复 #27593「上传图内置编辑工具」）；「聊天框旁的草图板」是社区 feature request，官方「无时间表」。 | 我们先于上游本地实现。**同构上游的注释模式**：评论/标注 → 打包成文字「附加指令」+ 标注后的图片一起进 `turn/start`，Codex 侧零改动。 |
| 图片编辑 | Codex 自带 `imagegen` skill（`gpt-image-1.5 edit --image --prompt --input-fidelity`）；我们已用 `skills.config` 关掉它，改走 catimation MCP `generate_image`（支持 2.5 flare/sunburst、`transparentBackground`、`count`）。 | 移除背景 / 调整尺寸走既有 MCP；**擦除（inpainting）需要 `mask` 通路**，`ApiService` 目前没有 → P3c。 |

## 1. 分期

| 期 | 稿 | 内容 | 状态 |
|---|---|---|---|
| **P0** | D6 | 顶栏按钮系统：**44px** 同高（36 → 40 → 44，用户反馈「太小、太窄」）、单行标签、三组分区、顶栏 / 跑马灯到头、`Update` 带英文标签；模型选择器 = 「厂商小标签 + 模型名」触发器 + **厂商→模型两栏面板**（`VendorModelPanel.ts`，照 apiyi） | ✅ 2026-09-14 |
| **P0** | D1 | 线程侧栏：置顶（DB `pinnedAt` + 镜像 `thread/metadata/update`）、Pinned 分组、搜索、Agent 工作台入口、副行「N 条消息 · 相对时间」、分组折叠 | ✅ 2026-09-14 |
| P1 | D2 | 输入区「+」菜单取代虚线 Add references（添加照片和文件 / 绘图 / 生成图片；人像库 / 画布两项待有消费者再加） | ✅ 2026-09-14 |
| P1 | D5 | 结果图卡毛玻璃「编辑 / 下载」（`MediaTile.tsx`：编辑 → 灯箱工具条，下载 → `shell.saveAs`）+ 透明 PNG 像素探测（`alphaProbe.ts`，24×24 离屏 canvas，按 src 缓存）→ 深底 + ALPHA 徽章 + 棋盘格可选核对 | ✅ 2026-09-14 |
| P2 | D3 | 草图板（tldraw 栈，抽屉青色方言）→ `editor.toImage` PNG → 附件 | ✅ 2026-09-14 |
| P3a | D4 | 灯箱工具条：标注 / 评论 / 擦除笔迹 → 合成标注副本 + 「[图片反馈]」附加指令随下一条消息发送 | ✅ 2026-09-14 |
| P3b | D4 | 移除背景 / 调整尺寸：目前作为**一键指令**（文字里点名 `transparentBackground=true` / 目标尺寸）交给 Codex 走既有 `generate_image`；不直接调工具 | ✅ 指令版 |
| P3c | D4 | 擦除真 inpainting：`ApiService.generateImage({ maskImage })` → `/v1/images/edits` 的 `mask` multipart 字段（带 alpha 的 PNG，alpha=0 = 重绘，只作用于 image[0]，尺寸同原图；-all / 腾讯 早失败）；MCP `generate_image` 加 `maskImage`（经 `AgentToolExecutor` 与参考图同一条解析路）；灯箱「擦除」用 `destination-out` 从红色笔迹导出原图分辨率的 `<name>.mask.png` 并随指令附上；**绑定 GPT Image 2.5**（sunburst 改图优先 / flare 求快）；`catimation-image` SKILL.md 文档化 + `skills:gen` 重生成 | ✅ 2026-09-14 |
| 追加 | D2/D5 | 输入区待发送附件：图片改为 56px 缩略图 tile（buffer → object URL 零 IPC；路径 → 聊天同款小图解析器），上限 `MAX_COMPOSER_THUMBNAILS = 12` 后降级为名字 chip；粘贴 / 草图 / 遮罩这些 buffer 附件此前在输入区根本不可见，现在可见可删；**点 tile 开灯箱**（`useAttachmentPreviewUris` 一份 blob:/local-file uri 同时喂 tile 与灯箱序列，‹ › 可翻，D4 工具条直接可用） | ✅ 2026-09-14 |
| 改版 | D2 | 用户反馈两轮：「+ 太小」→ 曾改 32px `+ 添加` 胶囊挤进 pill 排（模型名被挤到换行）→ **改回整宽虚线「一横」**（`ComposerAttachBar.tsx`，位于输入框与 pill 排之间）：条内直接排 添加照片和文件 / 绘图 / 生成图片 + 右端 `n/20`，最左 28px 青色「+」仍弹同一份三项菜单（加号功能不丢，Esc 关） | ✅ 2026-09-14 |
| 改版 | D4 | 标注可选色：`ANNOTATION_COLORS` 7 色（青默认 / 黄 / 绿 / 紫 / 粉 / 白 / 黑，**不含红**——红是擦除专属语义），标注模式下工具条内嵌 radiogroup 调色板，颜色钉在每条笔迹上（换色不改已画的圈），SVG 预览 / 合成副本 / 指令文字 / 侧栏小结全部按实际用到的颜色点名（`strokeColor` / `summarizeStrokes`，"青色 / 黄色圈注 = 需要修改的区域"） | ✅ 2026-09-14 |
| 改版 | D3 | 草图板：笔宽四点列 → **竖向滑块** `StrokeSlider.tsx`（拖 / 点 / ↑↓，吸附 tldraw s/m/l/xl 四档，停点按真实像素 3/4.5/6/11 画，拇指即笔宽预览；不用 shape `scale` 做连续宽度——其 toSvg 会连几何一起缩，导出会走样）；**形状改为 split button**：左半激活记住的形状、右侧 ▾ 弹 3×3 flyout（矩形/椭圆/三角/菱形/星/云/心 + 箭头/直线工具，`applySketchShape` 走 tldraw 自家 `setStyleForNextShapes(GeoShapeGeoStyle)` 路），Esc 先关 flyout 再关板 | ✅ 2026-09-14 |

### 落地记录（2026-09-14）

- **置顶「不生效」根因**：Prisma `DateTime` 经 IPC structured clone 到渲染层是 **`Date` 对象**而不是 ISO 字符串；`isThreadPinned` 用 `typeof === 'string'` 判定、`formatRelativeTime` 用 `Number.isFinite(Date)`（恒 false）→ 置顶只在乐观更新那一瞬显示，列表刷新后又消失；同一根因让旧侧栏每行时间都显示「—」。修法：`toEpochMs()` 统一接 `Date | string | number`，`pinnedAt` 类型改为 `string | Date | null`。测试先红后绿（`relativeTime.test.ts`）。
- 顶栏跑马灯「只到七成宽」：`.full-bleed` 被后加载的 `animations.css .marquee-container { width:100% }` 压掉 → 改 `.marquee-container.full-bleed`；`html, body { overflow-x: clip }` 防 100vw 含滚动条宽度出横向滚动条。
- 模型选择器：桌面端不再用 Choices.js（做不出两栏），`VendorModelPanel` 复用隐藏 `<select>` 作真源、对象表面兼容 Choices（`setChoiceByValue` 等），manager 的 change 监听一条不改；移动端仍是 Choices。
- 新增测试：`AgentManager.pin.test.ts`(7)、`VendorModelPanel.test.ts`(9)、`imageTools.test.ts`(9)、`Lightbox.tools.test.tsx`(7)、`MentionInput.plusMenu.test.tsx`(5)、`sketchExport.test.ts`(4)、`AttachmentCard.glass.test.tsx`(3)；扩展 `ThreadSidebar` / `relativeTime` / `ipc` / `ThreadStore` / `ModelSelectorManager.vendorGrouping`。`agent-chat` 120 文件 1112 用例 + 触及的 main/model-selector/account 套件全绿；tsc 7 错全为预存基线；`build:vite` 通过。
- **P3c mask 依据**：OpenAI `image_edit_params`（`mask`：fully transparent = editable，PNG，<4MB，same dimensions，applies to first image）、apiyi `gpt-image-2/mask-editing`（alpha 通道决定可编辑区、不是黑白像素；勿传 `input_fidelity`；transparent 区域宁大勿小）、Codex 自带 imagegen skill `references/cli.md`（`--mask` 仅 edit；prompt-guided，提示词要写不变项）。测试：`ApiService.gptImage25.test.ts` +4、`imageTools.test.ts`(MCP) +1、`imageTools.test.ts`(lightbox) +3、`Lightbox.tools.test.tsx` +1、`MentionInput.attachmentTiles.test.tsx`(3)、`MentionInput.reference.test.tsx` 缩略图契约改写（不再禁 `<img>`，改为「一张轻量 tile + 上限」）。124 文件 1230 用例全绿；tsc 7 = 基线；`build:vite` 通过。
- 剩余：「+」菜单的「从人像库 / 从画布添加」两项等有明确消费者再加；tab「AGENT」→「Agent 工作台」改名涉及 4 语种 i18n，另起 PR。

## 2. P0 · D6 顶栏按钮系统

**改动文件**
- `src/renderer/index.html`（真实渲染入口，不是仓库根 `index.html`）nav 区块：字标两行小号（`CATIMATION` + `CYBERPUNK MASTER`）；所有控件统一 `nav-ctl` 类族；三组用 `nav-divider` 分隔；标签用 `nav-ctl__label`（<1200px 隐藏，只留图标）。
- `src/renderer/public/css/components.css`：新增 `.nav-ctl` 系列（36px、1px 边、直角、Exo 2 13px/700/大写）、`.nav-ctl--primary/--cyan/--magenta/--icon`、`.nav-ctl__dot`（红=活动、绿=有更新）、`.nav-divider`、`.nav-wordmark`；改 `.model-selector-wrapper .choices__inner` 为 36px 单行黄描边 + 10% 黄底，固定 220px。
- `src/renderer/src/features/model-selector/ModelSelectorManager.ts`：`item` 模板（选中态）前置厂商小标签（读 `window.aiImageAPI.models[key].vendor` → `MODEL_VENDORS[vendor].name`）；下拉分组抬头（`choiceGroup`）已存在（optgroup 聚类），保持。
- `src/renderer/src/features/account/AccountBadge.tsx`：`CHROME_BUTTON` → `nav-ctl`，登录态/余额态同高。
- `src/renderer/src/features/updater/UpdateNotification.ts`：`updater:update-available` 时点亮 `#checkUpdateBtnNav` 上的绿点（`update-not-available`/`update-downloaded` 时熄灭）。

**验收**：1024 / 1440 宽下顶栏所有控件同高 36px、无折字；模型选择器单行显示「腾讯 · Image 2」，下拉抬头按厂商聚类（Seedream / 腾讯 / Google / 阿里 / OpenAI / Flux）；`ModelSelectorManager.vendorGrouping.test.ts` 与 `AccountBadge.test.tsx` 通过；`build:vite` 通过。

**不做**：不改 tab 名（「AGENT」→「Agent 工作台」是建议，i18n key 涉及 4 语种，另起 PR）。

## 3. P0 · D1 线程侧栏

**数据 / 协议**
- `prisma/schema.prisma` `AgentThread.pinnedAt DateTime?`；`src/main/agent/ensureSchema.ts` INIT_SQL + `ALIGN_SCHEMA_SQL` 加 `ADD COLUMN IF NOT EXISTS "pinnedAt" TIMESTAMP(3)`；`prisma generate`。
- `src/types/agent.ts` `AgentThreadSummary.pinnedAt?: string | null`；`src/types/agentApi.ts` `setThreadPinned(threadId, pinned): Promise<void>`。
- `ThreadStore.setThreadPinned` → `AgentManager.setThreadPinned`（DB 写入后 best-effort `backend.updateThreadMetadata?.(codexThreadId, { isPinned })`，失败只 warn）→ `ipc.ts` `agent:set-thread-pinned`（校验 threadId string / pinned boolean）→ `preload` `IPC_CHANNELS.AGENT.SET_THREAD_PINNED` + `setThreadPinned`。
- `CodexProtocolClient.updateThreadMetadata(threadId, { isPinned })` = `thread/metadata/update`；`IAgentBackend.updateThreadMetadata?` 可选，`CodexLocalBackend` 透传。旧 binary 不认该方法 → RPC 报错被吞，DB 状态不受影响。

**渲染层**
- `relativeTime.ts`：`groupThreadsByRecency` 先吐 `Pinned` 组（按 `pinnedAt` 降序），其余分组排除已置顶。
- `store.ts`：`setThreadPinned(threadId, pinned)` 乐观更新 `threadList` → API → `refreshThreadList()`。
- `ThreadSidebar.tsx`：头部 = 搜索框（本地按标题过滤）+ 收起钮；「New chat」行；「Agent 工作台」行（`useTabStore.switchTab('agentWorkspace')` + 关抽屉，与头部 Open Agent Workspace 同一动作）；分组 Pinned / Today / Yesterday / Last 7 days / Older，每组 >6 条折叠为「更多 +N」；行 = 状态图标（运行中 spinner / 已完成）+ 标题 + 副行（运行中 / 相对时间），hover 出 📌 与 ⋯；菜单第一项「置顶 / 取消置顶」。保留全部既有契约（双击重命名、⋯ 菜单、记忆开关、删除确认、指针盾、拖拽调宽、运行点 `aria-label="Running"`）。

**测试（先红后绿）**：`relativeTime.test.ts`（Pinned 分组）、`ipc.test.ts`（新通道转发）、`ThreadSidebar.test.tsx`（置顶按钮 → API + Pinned 组置前；搜索过滤；Agent 工作台行切 tab；更多折叠）、`ThreadStore`/`AgentManager` 现有套件回归。

## 4. P1 · D2「+」菜单 + D5 结果图卡

- `MentionInput.tsx`：底部 pill 排最左加 `+`（`h-7 w-7 rounded-md` 青描边），向上弹菜单（复用 slash 弹层样式）：添加照片和文件（现有文件选择）/ 从人像库添加（现有 `@` 人像库入口）/ 从画布添加（`canvasAssetStore` 选中项）/ 绘图（P2 之前先 disabled + 「即将推出」）/ 生成图片（往输入框插入 `$catimation-image ` 触发词）。虚线「Add references or files」行移除，`0/20` 计数移到菜单底部。
- `AttachmentCard.tsx` / `MediaThumbnail.tsx`：结果图 hover 出 `glassbtn` 编辑（打开灯箱）/ 下载（现有下载通路）；带 alpha 的 PNG（`mime === image/png` 且解码探测有透明像素，或生成参数 `transparentBackground`）走深底 + `ALPHA` 徽章 + 棋盘格切换；多图 64px 网格。

## 5. P2 · D3 草图板

- 新 `features/agent-chat/sketch/SketchPad.tsx`：抽屉内模态 560×560，`@tldraw/tldraw` `Tldraw` 组件 `hideUi` + 自绘胶囊工具条（选择 / 画笔 / 文字 / 形状 / 橡皮）、楔形笔宽、14 色点、✓ 确认。确认 → `editor.toImage(shapes, { format: 'png', background: true })` → Blob → 走 `AttachmentService` 落盘 uploads → 生成 64px chip（与拖放/Ctrl+V 贴图同一 pending 附件通路）。
- 复用 `canvas/` 已有 tldraw 依赖与 `VITE_TLDRAW_LICENSE_KEY`（**注意 2026-12-19 trial 到期闸**）。

## 6. P3 · D4 灯箱工具条

- P3a 标注 / 评论：`Lightbox.tsx` 顶部胶囊工具条；标注层用 tldraw 或轻量 canvas 画椭圆/箭头；评论钉 + 右侧列表；「发送给 Codex」= 合成标注图（原图 + 标注层 → PNG 落盘）作 `localImage` + 评论文本「附加指令」块（`[图片评论] 1. … 2. …`）拼进下一条消息 → 与上游浏览器注释模式同构。
- P3b 移除背景 / 调整尺寸：调用 MCP `generate_image`（`referenceImages: [当前图]`，`transparentBackground: true` / 目标 `size`），或本地 `imagemagick-win`（纯缩放不耗额度）。
- P3c 擦除：先在 `ApiService.makeGptImage2FormDataRequest` 加 `mask`（透明区域 = 要重绘），MCP `generate_image` 加 `maskImage`，灯箱橡皮笔迹导出 mask PNG。需要用户拍板是否走网关计费。

## 7. 风险与不做

- 顶栏改为 1px 边 + 36px 后，`BatchPage`/`ComparePage` 等页内按钮仍是旧 `border-2` 风格，属页面级，不在本次范围。
- 置顶镜像到 codex 只是 best-effort，不做双向同步（codex 侧手工 pin 不回流），避免两处权威。
- 不做「归档」（`thread/archive`）——用户没有要求，删除已够用；如需再加菜单项即可，协议已在。
