# 回合完成系统通知 + 用户消息发送状态 UI(批次 3-A)

日期:2026-07-19 · 状态:实施中

## 调研结论(依据)

### Codex 官方侧
- app-server 回合结束发 `turn/completed`,`turn.status ∈ completed | interrupted | failed`
  (developers.openai.com/codex/app-server)。我们协议层已消费该事件并转发为
  `AgentStreamEvent { type: 'turn_completed', threadId }`(AgentManager 重写为 DB id)。
- 官方桌面 App 的通知**不走** `notify` hook / `tui.notifications`(两者为 CLI/TUI 专用),
  而是客户端自带通知机制 + 设置面板开关(openai/codex#13019 维护者答复)。
  我们采用同款路线:客户端监听终态事件自弹系统通知,零 codex 配置改动。
- 官方已知坑(openai/codex#20930):通知只应在窗口失焦时弹;聚焦时不打扰。

### Cursor 侧(发送状态 UX)
- 用户消息乐观上屏 → 下方即时出现工作状态("Planning next moves" 流光)→ 完成后
  折叠为 "Worked for Xs" + 时间戳 + hover 操作按钮。
- 反面教材:Cursor 论坛大量「消息卡队列无任何失败提示」投诉(forum #151759、#138539,
  官方确认为 bug)——请求根本没到服务器但 UI 无反馈。我们要做的正是把
  发送中/已送达/失败三态显式化。

### 本仓现状(代码调研)
- `store.send()`:乐观上屏(无状态字段);IPC 在 turn 被 backend 接纳后、完成前 resolve;
  失败时整条消息 `slice(0,-1)` 消失 + 文字退回输入框 + panel error——正是要改的行为。
- 主进程零通知代码;`app.setAppUserModelId` 未调(electron-builder appId =
  `com.catimation.cyberpunk-master`);窗口引用 `AgentManager.win`。
- 齿轮面板 = `CodexPermissionsPanel`(会话设置,diff-apply + 保存为默认),
  持久化 = `SessionConfigStore`(diff-only JSON,PERSISTABLE_KEYS 白名单)。

## 设计

### A. 回合完成系统通知(主进程)
1. `CodexSessionConfig.notifyOnTurnComplete: boolean`(默认 **true**;纯客户端键,
   thread/start overlay 与 launch args 逐键读取,天然不下发 codex)。
   贯通:类型 + DEFAULT + resolveCodexSessionConfig + validation + PERSISTABLE_KEYS +
   CodexSessionStatus(可选字段)+ 齿轮面板开关(中文)。
2. `src/main/agent/TurnNotifier.ts`:依赖注入小类
   `{ isEnabled, isWindowFocused, notify }`;`handleEvent(event)` 对
   `turn_completed` / `error(!willRetry)` 且窗口失焦时弹通知;`cancelled` 不弹
   (用户自己点的停止)。生产注入用 Electron `Notification`,点击 → `win.show()+focus()`。
3. AUMID:`src/main/index.ts` 启动早期
   `app.setAppUserModelId(isPackaged ? 'com.catimation.cyberpunk-master' : process.execPath)`
   (Windows toast 前置条件)。
4. 挂点:`AgentManager.emitEvent`(所有转发渲染层的事件都经此,threadId 已是 DB id)。

### B. 发送状态 UI(渲染层)
1. `Message.sendState?: 'sending' | 'sent' | 'failed'`(渲染层字段;DB 载入的历史消息
   无此字段 = 视为已送达,不落库)。
2. `send()` 改造:乐观消息带 `sending`;IPC resolve → `sent`(顺带原有 canonical items
   替换);**失败不再删消息**——标 `failed` 留在时间线,快照 `{content, attachments,
   references, canvasContext}` 存 `failedSendSnapshots[messageId]`,输入框不回填。
3. `retryFailedMessage(messageId)`:移除 failed 消息 → 快照回填 input/attachments/
   references → 复用完整 `send()` 管线(skills/mentions 解析等零重复)。
4. `MessageBubble` 用户气泡头部(时间戳旁):`sending` 转圈「发送中」/ `sent` 对勾
   「已送达」(仅本会话新消息显示)/ `failed` 红字「发送失败」+ 重试按钮。

## 验收
- 新增测试:TurnNotifier 单测(开关/聚焦抑制/事件筛选)、sessionConfigValidation、
  SessionConfigStore 持久化含新键、面板开关渲染+patch、store 发送失败保留+重试。
- 回归:agent-chat + main/agent 相关套件、`build:vite`、零新增 lint。
