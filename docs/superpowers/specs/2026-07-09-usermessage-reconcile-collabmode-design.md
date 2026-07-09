# userMessage 读取侧对账 + collaborationMode(Plan 模式) 设计

日期: 2026-07-09
状态: 已获用户批准（方向 1）
前置: 同日已发「官方轻量对齐三件套」（cleanup 引用感知 / clientUserMessageId 写入侧 / text_elements 写入侧）

## 背景

- 写入侧已让 rollout 携带 `clientUserMessageId`（= 我方 AgentMessage 行 id）与
  `text_elements`（@mention 字节区间），但**读取侧无人消费**：
  `codexNotificationRouter` 对 `userMessage` 的 `item/started`/`item/completed`
  直接 drop（防止重复渲染 "ACT userMessage" 药丸，见 router L731/933 注释）。
- 官方 README：`userMessage` item 为 `{id, clientId, content}`，`clientId` 即
  `turn/start`/`turn/steer` 传入的 `clientUserMessageId`；`content` 是 user input
  列表（text 含 text_elements、image、localImage）。
- `collaborationMode/list` + `turn/start.collaborationMode`（experimental）
  提供 Plan/Code 预设；`settings.developer_instructions: null` = 用官方内置指令。
  部分 experimental API 需 `initialize` 时开 `capabilities.experimentalApi`；
  我们现在传 `capabilities: null`。

## Part A: userMessage 读取侧对账

### 数据流

1. **路由层** `codexNotificationRouter`：`item/completed` 且 `item.type === 'userMessage'`
   时不再直接 drop——解析 `{id, clientId, content}` 产出内部事件
   `{ type: 'user_message_reconciled', threadId, turnId?, codexItemId, clientId?, content }`。
   `item/started` 的 userMessage 仍然 drop（对账只需 completed 的最终形态）。
   仍然**不**产生任何渲染层可见的消息（防重复渲染不变）。
2. **AgentManager.forwardEvents**：收到 `user_message_reconciled` 且 `clientId` 非空时，
   按 `clientId` 定位我方 AgentMessage 行，把 codex 规范数据合并进该行 items JSON 的
   元数据块：`{ type: 'codexReconcile', codexItemId, localImages, textElements }`
   （追加一个 timeline item，不改动既有 text/attachment items——DB 仍是权威，
   rollout 数据做校验与补全）。找不到行 / clientId 缺失 / store 不可用 → 静默跳过
   （对账是增强，不是关键路径）。
3. **该事件不透传给渲染层**（emitEvent 白名单外），避免 UI 无谓刷新。

### 消费场景（本期只落数据 + 一个兜底）

- 「编辑重发」chip 恢复：优先走 DB 附件行；行缺失时兜底读消息行里
  `codexReconcile.localImages` 的路径（stale-reference 优雅降级从常态退回兜底）。
  本期先把数据落上；渲染层兜底消费不动 UI 大改。

### 测试

- router: userMessage completed → `user_message_reconciled`（含 clientId/content），
  不产生可见 timeline 消息；started 仍 drop；无 clientId 时事件仍产出（manager 侧跳过）。
- AgentManager: clientId 命中 → updateMessage 追加 codexReconcile 块；
  未命中/缺 clientId/无 store → 不写不抛。

## Part B: collaborationMode（依赖冒烟）

### 第 0 步冒烟（结果决定做不做）

`scripts/smoke-codex-start.ts` 同款方式对 bundled 0.143 实跑：
1. `initialize` 带 `capabilities: { experimentalApi: true }` 是否被接受；
2. `collaborationMode/list` 返回形状（presets 数组、字段名）；
3. `turn/start` 带 `collaborationMode` 是否被接受（离线无 key，只验参数不验生成）。

### 协议层（冒烟通过后）

- `CodexProtocolClient.listCollaborationModes()` RPC；
- `AgentInput.collaborationMode?` → `turn/start` spread-omit 透传
  （不传=行为不变，与 clientUserMessageId 同款安全模式）；
- `initialize` capabilities 按需开 experimentalApi（若冒烟证明必需）。

### 渲染层

- composer 加模式切换（默认无模式；Plan 模式传
  `{ mode: 'plan', settings: { developer_instructions: null } }` 用官方内置指令），
  按线程记忆选择（store threadSlices）。

### 降级

冒烟不过 → Part B 收缩为「协议类型留档 + 项目记忆记录 gating 原因」，不硬上。

## 风险

- 全部 additive；不动 launch 关键路径。
- Part A 只改主进程与路由层；Part B 渲染层仅加一个选择器。
- experimentalApi 开关若引起 initialize 行为变化，冒烟会先暴露。
