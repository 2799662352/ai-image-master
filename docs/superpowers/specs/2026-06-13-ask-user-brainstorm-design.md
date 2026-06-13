# ask_user 交互选项 + catimation-brainstorm skill 设计

日期：2026-06-13
状态：已确认，进入实现

## 目标

让 agent 能在聊天里弹出**真正可点击的交互选项卡片**（像 Cursor / Codex
的选项栏），用户点选后结果回传给 agent。并新增一个通用
`catimation-brainstorm` skill（仿 Superpowers `brainstorming`），在开放式 /
高价值任务或用户明确要求时，引导用户做选择，再继续创作（视频、图片皆可）。

## 关键决策（用户拍板）

- 交互选项作为**独立卡片消息**渲染（干净、可只读化、可持久化），不塞进
  assistant 文本气泡。
- 头脑风暴是**软触发**：开放式 / 高价值任务或用户明确要求时才走，不对每个
  创作动作强制 hard-gate。
- 支持：单选、多选、自由文本、跳过/默认。

## 架构

复用现有 renderer-routed MCP 工具机制（与 `generate_image` 同一条链路）：

```
agent → MCP server (askTools) → ToolRouter.call('ask_user')
      → 无 main handler → callRenderer → IPC 'agent:tool-request'
      → AgentToolExecutor.ask_user → store.ask() 推一张卡片 + 返回 Promise
      → 用户点选 → AskUserCard → store.settleChoiceRequest()
      → resolve Promise → sendToolResponse → ToolRouter resolve
      → MCP 返回答案给 agent
```

阻塞由 `ToolRouter` 的 `RENDERER_TOOL_TIMEOUT_MS`（~2000s）兜底；无人应答则
工具报错，agent 可重试或走默认。

## 数据模型（agent-timeline.ts）

新增 `ChoiceRequestItem`（加入 `TimelineItem` 联合）：

```ts
interface ChoiceOption { id: string; label: string; description?: string }
interface ChoiceAnswer { answered: boolean; skipped: boolean; freeText?: string; selected: ChoiceOption[] }
interface ChoiceRequestItem extends BaseItem {
  type: 'choiceRequest'
  requestId: string
  question: string
  options: ChoiceOption[]
  mode: 'single' | 'multi'
  allowFreeText: boolean
  allowSkip: boolean
  status: 'pending' | 'answered'
  answer?: ChoiceAnswer
}
```

## store（agent-chat/store.ts）

- 模块级 `choiceResolvers = new Map<requestId, (a: ChoiceAnswer)=>void>()`
  （resolver 是函数，不进 zustand 可序列化 state）。
- `ask(params, threadId?) : Promise<ChoiceAnswer>`：生成 requestId、推一条
  仅含 `choiceRequest` item 的 assistant 卡片消息（用 `patchThreadMessages`
  路由到请求 chat）、把 resolve 存进 map、返回 Promise。
- `settleChoiceRequest(requestId, answer)`：就地把 item 标记 `answered` +
  写入 `answer`（新增 `mapChoiceItem` 帮手），pop resolver 并调用。
- AskUserCard 点击 → `useAgentChatStore.getState().settleChoiceRequest(...)`。

## renderer 工具（AgentToolExecutor.ts）

`case 'ask_user'`：解析参数 → `store.ask(params, threadId)` → 返回
`ChoiceAnswer`（含选项 id + label，方便 agent 读懂）。

## main MCP 工具（src/main/mcp/tools/askTools.ts）

`registerAskTools(server, router)`：zod schema = `{ question, options[],
mode, allowFreeText, allowSkip }`；handler `await router.call('ask_user',
params)` → 包成 `{ content:[{type:'text', text: JSON }] }`。在 tools/index.ts
注册。

## UI（cards/AskUserCard.tsx + TimelineItemRenderer + evidenceModel）

- 单选：选项按钮，点击即 settle。
- 多选：复选 + 确认按钮。
- allowFreeText：输入框 + 提交。
- allowSkip：跳过按钮（answered=false, skipped=true）。
- 已应答后只读显示所选，禁用控件。
- `isEvidenceItem(choiceRequest) = false`（独立卡片，不进 evidence stack）；
  `getEvidenceSummary` 补 case 满足穷尽 switch。

## skill（firstPartySkills.ts）

新增 `catimation-brainstorm`（加入 `FIRST_PARTY_SKILLS`）：仿 Superpowers
brainstorming，软触发；用 `ask_user` 工具一次问一个问题、给 2–3 个带取舍的
方向、推荐其一；定稿后再创作。`catimation-video` / `catimation-image` 各加一
行指向它。description ≤ ~500 字符。

## 测试

- askTools：注册 + 透传 router 结果。
- store：ask 推卡片 + settleChoiceRequest resolve + 标记 answered。
- AskUserCard：单选/多选/自由文本/跳过交互。
- firstPartySkills：brainstorm frontmatter + description 长度。
