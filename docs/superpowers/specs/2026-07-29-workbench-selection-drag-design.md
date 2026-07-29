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

### 改动（2026-07-29 修订：不另造投放协议）

卡片拖拽手柄的 `onDragStart` 增加第二个 `setData`——但写的是**既有的
`application/x-catimation-file-paths`**（复用 `serializeFileDrag`），载荷就是产物的
`localPath` 数组。`effectAllowed` 改 `'copyMove'`（`FileTreeNode.tsx:198` 同款双目标先例）。
页内排序继续读旧 MIME，行为不变。

**于是聊天栏一行都不用改。** 它既有的 Tier 2 分支已经会把这个 MIME 变成
`addAttachment` + `addPendingReference`（引用 chip）。两道门都已放行卡片产物目录：
`fsIpc.resolveAllowedRoots()` 显式 push `<userData>/agent/uploads`（`fs:stat` 过），
`AgentManager` 发送时也补同一段（引用不会死在 outside allowed roots）。

**拖动一张已选中的卡 = 拖动全部选中项；拖动未选中的卡先把选区换成它**——
后半句照抄 `FileTreeNode.onDragStart`（"拖动未选中的节点 → 替换选区为该节点，
保证拖出的就是用户看到的"）。这条不只是 UX 对齐，它还消掉了「cardId 怎么送给模型」
这个问题：**拖出去的恒等于选中的**，而选中态本身会随每一次工作台工具调用带给 agent
（见下一节），所以 `cardId` 不必塞进拖拽载荷。

#### 被推翻的第一版设计

第一版给卡片单开了 `application/x-catimation-workbench-cards` + `VideoWorkbenchCardDragItem`
描述符 + 聊天栏专用 drop handler + 一行可见文本（含 `cardId` 与提示词摘录）。**已作废。**
它在「引用 chip」之外立了第三条投放管线，而本仓库与 tldraw 的既有教条是一致的：
拖拽载荷只带**真实来源**（文件树带路径、画布 asset 带 `meta.assetPath`），
「这是什么、属于谁」的认领工作交给消费侧或按需回读，而不是发明协议随载荷携带。

#### 刻意接受的空缺

还没出片的卡（草稿/渲染中）拖进聊天栏**什么都不会发生**——`serializeFileDrag` 收到空数组
直接 return，不写任何 MIME。不为它造「信息行」或报错：没有产物就是没有东西可递。
选区仍然跟着拖动走，所以 agent 下次调工具时照样看得见这几张卡。

聊天栏也不补投放悬停高亮：它接的是既有 MIME，反馈缺失是**它自己那条既有链路**的问题
（从文件树拖文件进来同样没有高亮），要补该单独一刀补，不算进这一刀。

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
- 拖一张已选中的卡 = 递出全部选中项的路径；拖未选中的卡 → 选区换成它且只递它自己。
- 拖拽写的是 `application/x-catimation-file-paths`，值为 `localPath` 数组（**核心守卫**：
  该目录在 `fsIpc.resolveAllowedRoots` 与 `AgentManager` 发送侧都放行，chip 不会死在
  outside allowed roots）。
- 还没出片的卡不写路径 MIME；选中里混着未出片的卡时只递有产物的那些。
- 页内排序仍读旧 MIME，拖拽排序行为无回归。
- `snapshotWorkbench` 带出 `selectedCardIds`。

## 触及文件

- `src/renderer/src/features/video-workbench/store.ts`（选中态 + `startCards` 无参语义 + `snapshotWorkbench`）
- `src/renderer/src/pages-react/video-workbench/WorkbenchCard.tsx`（头部命中区 + 拖拽载荷）
- `src/renderer/src/pages-react/VideoWorkbenchPage.tsx`（⚡ 文案）
- ~~`src/renderer/src/features/file-explorer/dragHelpers.ts`~~（修订后不需要：复用既有 `serializeFileDrag`）
- ~~`src/renderer/src/features/agent-chat/MentionInput.tsx`~~（修订后不需要：既有 Tier 2 已经接住）
- `src/main/mcp/tools/videoWorkbenchTools.ts`（summary schema）
- 对应测试
