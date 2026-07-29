# 视频工作台：任意位置插卡

- 日期：2026-07-29
- 状态：已定稿，待实施
- 范围：四刀重构中的**第 2 刀**（第 1 刀已在设计阶段自行消解，见下）

## 背景

用户提了四件事：① 两卡之间随时插入新卡；② 重新生成不再覆盖旧视频，改为版本切换；
③ MCP 适配；④ 卡片可选中、可拖进 codex 聊天栏，并让 agent 知道选中态与位置。

这是四个独立子系统，合成一份 spec 会互相拖累，因此拆为四刀依次做。本文只覆盖第 2 刀。
③ 不单独成刀——每刀各自把自己的 MCP 契约改到位，否则会留下「UI 能做但 agent 不知道」的半成品。

## 贯穿约定（四刀共用，来自调研结论）

这一节是四刀共同的地基，后续每刀都受它约束。

**身份是 `cardId`，位置不是身份。** OpenAI Apps SDK 明确要求：引用 UI 条目要用「稳定的、应用自定义的
标识符，而不是依赖易变的 UI 状态」，并把权威业务数据（带稳定 id）与纯 UI 状态（选中、滚动位置）
分层，后者需要同步给模型时走单独的上下文通道。

**人眼辨认靠内容，不靠编号。** 卡片可自由拖拽重排，因此屏幕上的 `#NN` 对人和模型一样不可靠。
给人看的文字应以**提示词开头几个字**指代卡片（缩略图同理），位置只回答「往下滚多少能看到」，
是定位器不是标识符，不值得为它新建任何持久字段。

**这条约定的直接后果**：批次完成摘要（`batchCompletion.summarize`）现在甩裸 UUID，应改为提示词摘要
指代、`cardId` 留在结构化数据里。该项随第 3/4 刀顺手完成，不单列。

**位置一律用锚点 `cardId` 表达，不用下标。** 下标是易变状态，agent 手里的下标可能已不指向它以为的
那张卡；锚点 id 不会漂。

**编号记法不得二义。** 美标剧本里 `47A` 已表示「第 47 场的 A 机位」，所以插入的场次必须写成 `A47`。
同理，第 3 刀的版本记法不得写成 `11-2`——它既可读作「11 号卡的第 2 版」，也可读作「11 号后插入的
第 2 张卡」。版本记法与位置记法必须在视觉上分开。

## 本刀目标

在任意两张卡之间新建一张卡，后续卡片顺延；agent 亦可指定位置插卡。

## 现状

- 页面上三处「＋」（顶栏 / 空态 / 列表末尾）**都是同一行 `addCards([{}])`**：追加到当前页末尾、
  全部默认规格、硬编码 `activeBoardId`。
- `order` 是每页密集 `0..n-1` 的显式字段，任何变更后由 `reorderBoard` 压实；数组顺序与 `order` 保持一致。
- `moveCard(id, toIndex)` 是唯一的定位原语，其「页内下标 → 扁平数组槽位」的运算可直接复用。
- 拖拽排序已是原生 HTML5（MIME `application/x-vw-card`），缝隙已被 `.vw-drop-above` /
  `.vw-drop-below` 插入指示线占用。
- `VideoWorkbenchPage.tsx` 向每张卡传了 `onDragStateChange`，但传的是 `NOOP_DRAG_STATE`——
  **卡片如实汇报拖拽状态，页面却丢弃了**。这根预埋管线本刀正好接上。
- IR（`video_workbench_apply`）中**数组下标即顺序**，塞一个无 `id` 的卡进数组中间即可创建，
  所以 agent 今天已能插入，只是必须走 export→splice→apply 三步。
- 上限 `WORKBENCH_MAX_CARDS = 200`。

## 设计

### 1. store：扩展 `addCards`，不新开动作

签名 `addCards(inputs)` → `addCards(inputs, anchor?)`，`anchor` 为 `{ afterCardId }` 或
`{ beforeCardId }`（二选一）。

**不另起 `insertCards`**：现有 `addCards` 串着 `buildCard` → `persistNow` → `startTransfersForCard`
→ `evict` 四件事，复制一份出来迟早漏掉后两件，而素材转存和容量淘汰漏掉都是静默失败。

语义：

| anchor | 行为 |
| --- | --- |
| 不传 | 追加到 `activeBoardId` 末尾（**与今天完全一致**） |
| `{ afterCardId }` | 插到该卡之后，**落在该卡所在的页**（不是 activeBoardId） |
| `{ beforeCardId }` | 插到该卡之前，同上 |
| 锚点 id 不存在 | 抛错，零写入 |
| 插入会超出 200 张上限 | 抛错，零写入（与 apply 的整份拒绝同款，不做部分插入） |

锚点决定落在哪一页是必须的：现有实现硬编码 `activeBoardId`，在非活动页插卡会跑到别的页去。

锚点不存在时**绝不退化成追加**——调用方明确要求了位置，静默追加是给它一个错误的成功。

实现复用 `moveCard` 的套路：在扁平数组中锚点槽位处 splice 进新卡，再 `reorderBoard(cards, boardId)`
压实。后续兄弟卡的 `order` 变了需一并重新落库（`removeCard` 今天已这么做，照抄）。

计数器：`revision` 与 `structureRevision` 都要 bump（卡片集合与页内位置同时变了）。

上限：受 `WORKBENCH_MAX_CARDS` 约束，与 apply 一致，超出则整批拒绝不做部分插入。

### 2. UI：缝隙里的「＋」条

新建 `src/renderer/src/pages-react/video-workbench/CardGap.tsx`，渲染在 `VideoWorkbenchPage.tsx`
的 `cards.map` 相邻项之间；**不塞进 `WorkbenchCard`**（该文件已 926 行）。

- 第一张卡上方也要有一道缝，否则无法插到最前面。
- 悬停时才显形，点击插入**一张**默认卡：`addCards([{}], { beforeCardId: 下方那张卡的 id })`。
- **拖拽进行中整条隐身**：把页面的 `NOOP_DRAG_STATE` 换成真实 state，避让已有的插入指示线，
  否则同一道缝里两种视觉反馈会打架。

### 3. MCP：`video_workbench_add_tasks` 增加锚点

新增两个互斥可选入参 `afterCardId?: string` / `beforeCardId?: string`，zod 层校验互斥。
两者都不传 = 追加，**与今天一致**，因此现有契约测试无需改动。

不采用「`afterCardId: null` 表示插到最前」：「不传」与「传 null」的区别模型经常搞错，
而搞错的后果是卡插错位置。两个对称的稳定 id 入参没有这个歧义。

工具描述需说明：位置由锚点卡 id 表达；不接受下标。

## 明确不做

- **不引入分数索引**（Figma/Linear 那套 `getIndexBetween`，`@tldraw/utils` 里现成）。
  它的主要论据是多端并发插入冲突，本应用是单用户本地；次要收益是省 IndexedDB 写，
  200 卡上限下不痛。且它**并不能**让 agent 的 IR 令牌更稳——IR 用数组下标表达位置，
  插卡本身就是「位置变了」，该失效还是失效。除非将来要做多端同步，否则引入它是
  because-Figma-does-it。
- **新卡不继承邻居任何字段**，与现有「＋」一致，全部默认规格。
- **不动 `structureRevision` 语义**：插卡属于「卡片集合与位置变了」，理应让 agent 手里的 IR 令牌
  失效。这是现有教条，后来者不要当 bug 修。
- 不新增持久化字段，不改 `order` 的密集整数方案。

## 测试

- 中间插入：顺序压实正确，兄弟卡 `order` 变更已重新落库。
- 插到最前（`beforeCardId` 指向首卡）。
- 锚点在非活动页：新卡落在锚点那一页，不是 activeBoardId。
- 锚点 id 不存在：抛错且零写入。
- `revision` 与 `structureRevision` 均 bump。
- 撤销能还原插入前的排布。
- 触达 200 张上限时拒绝。
- MCP 回归守卫：`add_tasks` 不传锚点时行为与今天逐字一致。
- UI：缝隙「＋」出现在相邻卡之间且首卡上方有一道；拖拽进行中隐身。

## 触及文件

- `src/renderer/src/features/video-workbench/store.ts`
- `src/renderer/src/pages-react/VideoWorkbenchPage.tsx`
- 新增缝隙组件（`src/renderer/src/pages-react/video-workbench/` 下）
- `src/main/mcp/tools/videoWorkbenchTools.ts`
- `src/renderer/src/features/agent-chat/AgentToolExecutor.ts`
- 对应测试

## 调研依据

- 影视场次编号惯例（锁定后绝不重排，插入编 `A11`/`10A`，删除标 OMITTED）：
  [Shooting script](https://en.wikipedia.org/wiki/Shooting_script)、
  [Storiara](https://storiara.com/blog/how-to-number-a-film-script-for-production)、
  [ScreenWeaver](https://www.screenweaver.ai/blog/managing-scene-numbers-locked-revisions-pre-production)、
  [Final Draft](https://kb.finaldraft.com/hc/en-us/articles/27810301418132-How-do-I-number-scenes)
- `47A` 的二义性与 `A47` 记法：[John August](https://johnaugust.com/2004/a-scenes-and-b-scenes)
- 稳定标识符 / UI 状态分层：[OpenAI Apps SDK](https://developers.openai.com/apps-sdk/build/mcp-server)
- 分数索引（已评估否掉）：[Figma](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/)

## 后续刀次

- **第 3 刀**：重生不覆盖旧视频 + 版本切换。已知约束：`startCards` 会在提交前显式清空
  `localPath`/`remoteUrl`/`taskId`/`actualSeed` 并立即落库；磁盘 mp4 文件名嵌 `taskId` 故各轮不互相
  覆盖，字节仍在；但 `AttachmentService.cleanup()` 会扫掉 7 天前的 uploads 且**只扫聊天记录**判断引用，
  工作台卡片对它隐形，故老版本应以 COS `remoteUrl` 为耐久源。版本记法须避开 `11-2`。
- **第 4 刀**：卡片选中 + 拖进聊天栏 + agent 感知。已知约束：发送侧白名单只放行 `allowedRoots` 与
  `<userData>/agent/uploads`，卡片 mp4 多在白名单外；且 `.mp4` 既非图片也非音频，走 URL 引用会
  产生空结果。方向按贯穿约定：不序列化状态，推一次性提示 + 工具按需回读（画布同款）。
