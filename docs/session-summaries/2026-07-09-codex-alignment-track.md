# Codex 对齐轨道总结:从一条报错到 userMessage 对账、Plan 模式与 MentionsV2

日期: 2026-07-09
状态: 本轮完成,全部 additive、未提交(见文末验收)
关联设计文档:
- `docs/superpowers/specs/2026-07-09-reference-roots-gate-design.md`(方案 B)
- `docs/superpowers/specs/2026-07-09-usermessage-reconcile-collabmode-design.md`(方向 1)

---

## 1. 背景:一条报错引出的轨道

用户在聊天点 Send 报错:

```
Error invoking remote method 'agent:send-message':
Error: Reference path is outside allowed roots:
C:\Users\zhihang\AppData\Roaming\catimation-cyberpunk-master\agent\uploads\8ef44e...
```

调研(Context7 `/openai/codex` app-server README + developers.openai.com/codex/app-server
+ GitHub issues/PR)确认:**这不是上游 codex 抛的**。官方 `localImage` 接受任意本地绝对
路径,无 roots 校验;这道闸是本 app 在 `codexUserInput.ts` 自建的隐私边界,且与 fs IPC
闸的白名单不对称(fs 闸放行 uploads 缓存目录,send 闸没有)。修这条报错的过程顺带做了
一次「我们 vs Codex 官方」的全面对齐盘点,发现 4 个明确差距,由此展开整条轨道:

1. 文件引用的持久化方式与官方完全不同(官方用 rollout 的 `text_elements` + `local_images`
   回传重建 chip;我们全存自己的 Prisma DB)——正是这次 bug 的深层根源;
2. 协议 `UserInput` 联合只实现了 3/5(缺 `skill` / `mention`,V19 Connectors 装完插件
   在聊天里 @ 不到);
3. `clientUserMessageId` 全库 0 处使用(乐观消息与服务端持久化消息无法对账);
4. uploads 缓存 + 路径入 prompt 的做法与上游演进方向一致(PR #25944),这块**不用改**。

## 2. 全景:五个批次

| 批次 | 内容 | 状态 |
|------|------|------|
| B1 | 方案 B:白名单补齐 + 陈旧引用跳过降级 | ✅ |
| B2 | 轻量对齐三件套 + `mention`/`skill` 输入变体 | ✅ |
| B3 | 方向 1:userMessage 读取侧对账 + collaborationMode(Plan) | ✅ |
| B4 | 方向 A:Plan 预设 mask 消费;方向 B:MentionsV2 统一 @ 入口 | ✅ |
| B5 | 预存基线清理(16 测试 + 3 tsc)+ reconcile 消费端(chip 双源恢复) | ✅ |

---

## 3. 批次详情

### B1 — 方案 B:白名单补齐 + 陈旧引用降级

修复 send 闸的两个缺陷(`src/main/agent/codexUserInput.ts` + `AgentManager.assembleTurnInput`):

- **白名单补齐**:`mapReferencesToInputItems` 的 roots 加入
  `<userData>/agent/uploads`,与 `fsIpc.resolveAllowedRoots()` 口径对齐。
  从 ATTACHMENTS 树拖文件、引用历史消息里的上传附件不再被拒。
- **陈旧引用降级**:`ReferenceInputMapping` 增加 `skippedReferences: string[]`。
  `fs.realpath` 失败(文件不存在/不可读)→ 跳过该引用、label 记入列表、**消息照发**;
  路径**存在**但解析后在 roots 外 → **仍硬 throw**(防「任意本地文件 → 模型视觉输入」
  的安全边界不动)。
- **用户可见提示**:`assembleTurnInput` 经现有 `notice` 通道发
  `kind: 'attachmentSkipped'` / `level: 'warning'`,renderer 零改动通用渲染。

### B2 — 轻量对齐三件套 + mention/skill 变体

- **`mention`/`skill` 输入变体**:`CodexUserInput` 联合补齐到 5/5;
  `AgentSendMessagePayload.mentions` → `AgentManager` 去重后映射为
  `{ type: 'mention', name, path }`(`plugin://<name>@<marketplace>` / `app://<id>`)。
  V19 Connectors 面板装的插件从此可以在聊天里 @ 到——消费端接通。
- **`clientUserMessageId` 写入侧**:`turn/start`/`turn/steer` 带上我方 AgentMessage
  行 id(spread-omit,不传 = 行为不变),服务端在 `userMessage` item 以 `clientId` 回显。
- **`text_elements` 写入侧**:`mentionTextElements()` 把文本里每个对应已解析 mention 的
  `@token` 标成 `{ byteRange, placeholder }`。**字节偏移用 UTF-8**(服务端是 Rust,按字节
  索引;用 UTF-16 code unit 会在 CJK/emoji 后错位)。词边界规则与 renderer 的
  `extractMentionTokens` 一致(行首或空白后的 `@`,不匹配邮箱/词中 `@`)。
- **`AttachmentService.cleanup()` 引用感知**:清理前扫描消息引用 haystack,仍被消息引用
  的上传文件不删;扫描失败时**跳过本轮清理**(fail safe),不再盲删。

### B3 — 方向 1:userMessage 读取侧对账 + collaborationMode

**Part A: userMessage 对账**(数据流三层):

1. `codexNotificationRouter`:`item/completed` 且 `type === 'userMessage'` 不再直接
   drop,解析出内部事件 `{ type: 'user_message_reconciled', threadId, codexItemId,
   clientId?, content }`;`item/started` 的 userMessage 仍 drop(对账只要最终形态)。
   仍然不产生任何渲染层可见消息(防重复渲染不变)。
2. `AgentManager.forwardEvents`:`clientId` 非空时按其定位我方 AgentMessage 行,把
   `{ type: 'codexReconcile', codexItemId, localImages, textElements }` 追加进该行
   items JSON(`ThreadStore.attachCodexReconcile`)。找不到行/缺 clientId/store 不可用
   → 静默跳过(对账是增强,不是关键路径)。
3. 该事件不透传渲染层(emitEvent 白名单外)。

**Part B: collaborationMode(Plan 模式)**:

- 冒烟先行:`scripts/smoke-collaboration-mode.ts` 对 bundled binary 实跑,确认
  `initialize` 带 `capabilities.experimentalApi` 被接受、`collaborationMode/list`
  返回 Plan/Default 两预设、`turn/start.collaborationMode` 被接受。
- 协议层:`CodexProtocolClient.listCollaborationModes()` RPC;
  `AgentInput.collaborationMode?` spread-omit 透传(不传 = 行为不变)。
- 渲染层:store 增加 `collabModeKind`('plan' | 'default')+ `collabModeByThread`
  按线程记忆,切线程时恢复。

### B4 — 方向 A/B

**方向 A: Plan 预设 mask 正确消费**

- `AgentManager` 缓存 `collabModePresets`(`collaborationMode/list` 返回的
  `CodexCollaborationModeMask[]`);Plan turn 组装时 `reasoning_effort` 从官方 Plan
  预设 mask 读(medium),`developer_instructions: null` 用官方内置计划指令,
  model 带用户显式选择(预设永不降级用户的模型选择)。fetch 失败不缓存
  (下个 Plan turn 重试),降级为 `reasoning_effort: null`。
- `CollabModeToggle.tsx`:composer 底栏 Plan 药丸,`aria-pressed` + 每线程记忆。

**方向 B: MentionsV2 统一 @ 入口**

对齐上游 MentionsV2(#27499 已升默认):`@` 弹层统一搜文件 + 插件 + skills:

- store 增加 `availablePluginMentions` / `loadAvailablePluginMentions()`
  (拍扁 `plugin/installed` 响应为 `PluginMentionCandidate`);
- `MentionInput.tsx`:`filteredPlugins` 参与统一弹层过滤,`commitPluginMention()`
  把 `@插件名` 写入文本并登记 mention(`plugin://<name>@<marketplace>`),
  发送时经 payload `mentions` 走 B2 的通路;
- 兼容保留:文件 mention、skill mention 的既有语义不变。

### B5 — 预存基线清理 + reconcile 消费端

**基线清理**(16 个测试失败 + 3 个 tsc 错误,过程中顺手清了同目录预存 tsc):

- `AgentManager.ts`:`emitEvent` 用 `'threadId' in event` 条件展开(部分
  `AgentStreamEvent` 变体无 threadId);`createItemFromStarted` 补 `choiceRequest`
  case(throw,本地 ask() 生成、不走 agent 事件)+ `never` 兜底。
- `CodexProtocolClient.ts`:新增
  `TurnScopedStreamEvent = Extract<AgentStreamEvent, AgentStreamEventBase>`;
  `handleNotification` 对 `skills_changed`/`notice`(无 threadId)提前 return,
  不塞 per-turn 队列。
- `MentionInput.tsx`:删不可达 `case 'goal'`(前置 if 已窄化)+ `never` 兜底;
  React 19 需 `import type { JSX } from 'react'`(`CodexApprovalPrompt` /
  `NoticesBanner` 同修)。
- `useAutosizeTextarea.ts`:ref 参数放宽为 `RefObject<HTMLTextAreaElement | null>`
  (React 19 `useRef(null)` 语义)。
- 渲染层测试:jsdom 缺 Electron IPC → mock `useResolvedMediaSrc` 等;
  `window.electronAPI.agent` 断言统一 type-cast 模式;补写了
  `parseUnifiedDiff` / `openAiChange` 两个空测试文件;重写
  `storyboard-image-tool.test.ts` 覆盖现行实现。

**reconcile 消费端(TDD)** —— B3 Part A 只做了「存」,这步做「用」:

「编辑重发」的 chip 恢复(`store.ts` `attachmentsFromMessage`)改为双源合并:

1. DB `attachment` 行优先(name/mime/size 元数据全),先加;
2. `codexReconcile.localImages`(rollout 回传、`attachCodexReconcile` 落库的
   canonical echo)兜底补缺——只补 DB 行没覆盖的路径,元数据从文件名推断
   (`inferImageMime`),归一化路径去重(反斜杠归一 + `normalizeReferencePath`)。

价值:上传文件被 cleanup 清掉/DB 行缺失时,chip 仍能从 rollout 数据恢复;
stale-reference 优雅降级从「常态」退回「罕见兜底」,与官方 TUI 的
rollout-rehydration 思路同构。

**注意**:`textElements` 目前**只落库、未消费**(全仓仅测试引用)。chip 恢复不需要它
(消息正文本身含 mention 标签);将来做「历史消息里把 `@文件` 渲染成富文本 chip」
时才需要,属后续增量。

---

## 4. 架构立场:哪里刻意不同于官方

- **DB 仍是权威,rollout 做校验与补全**——官方 TUI 是无状态 client(历史全靠 rollout
  重建),我们是有状态 client(Prisma DB 存消息/附件)。持久化方式不同是架构选择而非
  缺陷;对齐的方式是「双源合并」而不是推翻自建存储。
- **localImage 的 allowed-roots 闸保留**——官方无此校验,但生态惯例
  (codex-control-plane-mcp)同样自建;这是「任意本地文件 → 模型视觉输入」的隐私边界。
  修的是白名单不对称与陈旧引用绑架,不是拆闸。
- **catimation MCP 不迁移到插件 `.mcp.json`**——桥需注入每会话动态 TCP 端口 + token,
  全局 `-c` 注入最干净,且工具应全线程可用(见 2026-06-22 记忆)。

## 5. 关键文件清单

**主进程**

| 文件 | 变更 |
|------|------|
| `src/main/agent/codexUserInput.ts` | text_elements 写入侧(UTF-8 字节偏移)、mention/skill 变体、skippedReferences 降级 |
| `src/main/agent/codexProtocol.ts` | `CodexTextElement` / `CodexCollaborationMode(Mask)` / userMessage content 类型 |
| `src/main/agent/codexNotificationRouter.ts` | userMessage completed → `user_message_reconciled` |
| `src/main/agent/AgentManager.ts` | uploads 白名单、mentions 组装、reconcile 落库、Plan mask 消费、emitEvent/createItemFromStarted 修复 |
| `src/main/agent/CodexProtocolClient.ts` | clientUserMessageId/collaborationMode 透传、listCollaborationModes RPC、TurnScopedStreamEvent |
| `src/main/agent/ThreadStore.ts` | `attachCodexReconcile` |
| `src/main/agent/AttachmentService.ts` | cleanup 引用感知(fail-safe 跳过) |
| `src/main/agent/CodexLocalBackend.ts` / `types.ts` | passthrough + 类型 |

**渲染层**

| 文件 | 变更 |
|------|------|
| `src/renderer/src/features/agent-chat/store.ts` | collabModeKind(+按线程记忆)、pluginMentions 读层、attachmentsFromMessage 双源合并 |
| `src/renderer/src/features/agent-chat/MentionInput.tsx` | 统一 @ 弹层(文件+插件+skills)、commitPluginMention、tsc 修复 |
| `src/renderer/src/features/agent-chat/CollabModeToggle.tsx` | 新增:Plan 药丸 |
| `src/renderer/src/hooks/useAutosizeTextarea.ts` | React 19 ref 类型 |

**测试(新增)**:`codexUserInput.textElements` / `codexNotificationRouter.userMessage` /
`AgentManager.{clientUserMessageId,collaborationMode,mentions,userMessageReconcile}` /
`CodexProtocolClient.{clientUserMessageId,collaborationMode}` / `AttachmentService.cleanup` /
`MentionInput.{pluginMention,unifiedMentions}` / `store.{collabMode,mentions}` +
`store.editAndResend` 补 2 用例。冒烟:`scripts/smoke-collaboration-mode.ts`。

## 6. 验收记录

- `npm run build:vite` 19.6s 通过,零编译错误;
- 触及的 4 套件复跑 123/123 绿(store.editAndResend / AgentManager.sessionConfig /
  cinematographyKbMcpTools / codexNotificationRouter);
- targeted tsc 清零(AgentManager×2、CodexProtocolClient×3、MentionInput 系 9+、
  agent-chat 预存 4)。

**已知问题(非本轮引入)**:

- `src/main/mcp/__tests__/bridge.test.ts` 的「2026-06-12 hang」路由测试在**干净 HEAD
  worktree 上同样失败**(generate_image 任务路由超时),属预存基线问题,待单独排查;
- 若干 pipeline 测试(runWithConcurrency / director-cancel/pause/resume / ensureSchema /
  v3-pipeline / v3-integration)在全量并行跑时偶发超时,单独跑全过——资源型 flake,
  非逻辑问题。
- 环境事故与修复:排查 bridge.test 时清理临时 worktree 误伤主仓 `node_modules`
  (pnpm 硬链接结构),`Remove-Item node_modules` + `pnpm install` 全新重装恢复
  (含 `@electron/rebuild` native 依赖)。源码树经 `git status` 核对无损。

## 7. 剩余未做(Codex 对齐轨道)

| # | 事项 | 立场 |
|---|------|------|
| 1 | `thread/items/list` 读层 | 已解锁但无「深历史页」UI 需求,刻意不接,避免库存代码 |
| 2 | collaborationMode 动态 picker | UI 硬编码 Plan 药丸;上游加新预设(Code/Review)时换成读 list 的动态 picker |
| 3 | MentionsV2 增强项 | 搜索模式切换(All/Filesystem/Plugins)、`app://` connectors 进弹层、type tag 配色/固定 8 行等视觉细节;核心插入语义已对齐 |
| 4 | permissions profile 迁移 | `turn/start.sandboxPolicy` 已标 legacy 但可用;等真废弃再动 |
| 5 | V19 Connectors 两遗留 | `plugin/share/*` 自建发布流;「按线程激活插件 MCP」(`selectedCapabilityRoots` + 插件 ship `.mcp.json`)——无消费者,待拍板 |
| 6 | `textElements` 渲染消费 | 历史消息富文本 chip 渲染时才需要,后续增量 |
