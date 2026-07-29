# 视频工作台：卡片选中 + 拖进聊天栏 + agent 感知

- 日期：2026-07-29
- 状态：已定稿，待实施
- 范围：四刀重构中的**第 4 刀**
- 前置：贯穿约定见 `2026-07-29-workbench-insert-card-design.md`「贯穿约定」一节

## 目标

卡片可多选；把卡片拖进 codex 聊天栏即可让模型拿到那段视频；agent 能知道当前选中了哪些卡。

## 一个被推翻的前置判断

初次勘察推测「卡片的 mp4 在发送白名单之外，做成引用会在发送时抛 outside allowed roots」。
**这是错的，已验证。**

`persistVideo` 走 `AttachmentService.ingest`，而 `ingest` 落盘目录是
`path.join(app.getPath('userData'), 'agent', 'uploads')`（`AttachmentService.ts:67`）；
`AgentManager` 的发送白名单恰好显式放行该目录。所以**卡片视频天然在白名单内**，
可以直接做成引用 chip，无需任何搬运或提权。

## 选中

store 新增 `selectedCardIds: string[]`。**不持久化**——它是纯 UI 状态，按贯穿约定与 OpenAI Apps SDK
的分层要求（业务数据带稳定 id，选中/滚动位置这类 UI 状态留在本地）都不该落库。切换页时清空。

**命中区必须限定在卡片头部那一行**（`#NN` 徽章与拖拽手柄所在行），不能整卡点击选中。
`WorkbenchCard.tsx` 有 926 行，卡片主体密布提示词输入、规格药丸、素材栈等交互控件，
整卡点选会和它们持续打架。头部行本来就是「卡片外壳」语义，天然适合。

- 单击：选中该卡，清掉其它。
- Ctrl/Cmd + 单击：切换该卡。
- Shift + 单击：从上一个锚点到该卡的区间选中。

选中态用边框高亮表达，不遮挡内容。

## 批量操作作用于选中项

`startCards()` 无参今天等于「整页全生成」。改为：**有选中则作用于选中项，无选中则维持整页**。

这是行为变更，必须在 UI 上可见，否则用户会误触整页生成而烧掉一批额度。因此
⚡ 按钮的文案随选中态动态变化（「生成选中 3 张」/「全部生成」）。删除同理。

MCP 侧的 `video_workbench_start` **不受影响**：它显式传 `cardIds`，不走无参分支。
agent 不应该因为用户碰巧选了几张卡就改变行为——那正是「依赖易变 UI 状态」的反面教材。

## 拖进聊天栏

### 现有管线

聊天栏 `MentionInput` 的 `onDrop` 按 MIME 分三层：`application/x-catimation-quote` → 纯文本插入；
`application/x-catimation-file-paths` → 附件 + 引用 chip；OS 文件 → 仅附件不带引用。
MIME 词表集中在 `file-explorer/dragHelpers.ts`。卡片拖拽今天用的是
`application/x-vw-card`，载荷仅一个裸 id、`effectAllowed = 'move'`，仅供页内排序。

### 改动

卡片拖拽手柄的 `onDragStart` 增加第二个 `setData`：新 MIME + JSON 卡片描述符，
并把 `effectAllowed` 改为 `'copyMove'`（`FileTreeNode.tsx:198` 已有同款双目标先例）。
页内排序继续读旧 MIME，行为不变。

**拖动一张已选中的卡 = 拖动全部选中项**，与文件树的多选拖拽语义一致。

聊天栏 `onDrop` 增加一个分支，落进去的是：

1. **视频引用 chip** —— 指向该版本的 `localPath`（已验证在白名单内），走既有的
   `addAttachment` + `addPendingReference` 通路。
2. **一行卡片信息** —— 提示词摘要 + `cardId`，让模型知道这是工作台的哪张卡、可以拿 `cardId`
   去调工具。这一行是可见文本，不是隐藏前缀：用户看得见自己递过去了什么。

降级：`localPath` 被 7 天清理扫掉时退到 `remoteUrl`。注意 **`.mp4` 既不算图片也不算音频**，
URL 引用在 `mapReferencesToInputItems` 里会产出空结果，所以此时只能作为文本提及送达，
UI 需如实提示「仅传了链接，未附视频」。尚无结果的卡片（草稿/渲染中）只送卡片信息行。

聊天栏目前**没有任何拖拽悬停反馈**（`onDragOver` 只调了 `preventDefault`），需要补一个投放高亮，
否则用户不知道能往哪儿放。

## agent 如何知道选中态

按画布先例与 OpenAI Apps SDK 指引：**按需回读，不主动推送。**

`snapshotWorkbench` 已经在向 agent 暴露 `activeBoardId`，在同一处增加 `selectedCardIds` 即可——
任何一次工作台工具调用都会顺带带出当前选中。

**不为「选中变化」推送任何通知。** 选中是高频操作，推送等于刷屏；而且画布的先例是只在
「用户主动打开画布」这种明确交接手势时推一次一次性提示。本刀对应的交接手势是**拖卡进聊天栏**，
而那已经带了一行可见文本，无需再加隐藏前缀。

## 明确不做

- 选中态不持久化、不进 IR、不进撤销栈。
- 不为选中变化推送通知（避免刷屏，且违背按需回读原则）。
- `video_workbench_start` 的显式 `cardIds` 语义不变，agent 行为不受用户选中影响。
- 不复用 `mention` 输入变体表达卡片：该通道属于 codex 的插件注册表
  （`plugin://` / `app://`），塞自定义 scheme 进去语义错误，且 `text_elements`
  的字节区间计算不认识未知 scheme。

## 测试

- 单击 / Ctrl 加选 / Shift 区间选；切页清空选中。
- 点击卡片主体的输入框与药丸**不**改变选中（防误选守卫）。
- 有选中时 ⚡ 只生成选中项且文案随之变化；无选中时维持整页。
- MCP `video_workbench_start` 带显式 `cardIds` 时不受选中影响。
- 拖一张已选中的卡 = 拖全部选中项。
- 投放到聊天栏产生引用 chip + 可见信息行；chip 指向的路径能通过发送侧白名单（**核心守卫**）。
- 无 localPath 时退到 remoteUrl 并提示「仅传了链接」。
- 草稿卡拖入只产生信息行，不产生 chip。
- 页内排序仍读旧 MIME，拖拽排序行为无回归。
- `snapshotWorkbench` 带出 `selectedCardIds`。

## 触及文件

- `src/renderer/src/features/video-workbench/store.ts`（选中态 + `startCards` 无参语义 + `snapshotWorkbench`）
- `src/renderer/src/pages-react/video-workbench/WorkbenchCard.tsx`（头部命中区 + 拖拽载荷）
- `src/renderer/src/pages-react/VideoWorkbenchPage.tsx`（⚡ 文案）
- `src/renderer/src/features/file-explorer/dragHelpers.ts`（新 MIME 词表）
- `src/renderer/src/features/agent-chat/MentionInput.tsx`（投放分支 + 悬停反馈）
- `src/main/mcp/tools/videoWorkbenchTools.ts`（summary schema）
- 对应测试
