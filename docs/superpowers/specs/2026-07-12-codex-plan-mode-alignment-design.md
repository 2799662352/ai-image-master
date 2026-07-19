# Codex Plan 模式完整对齐与 UX/UI 设计

日期：2026-07-12  
状态：已获用户批准  
目标版本：OpenAI Codex `rust-v0.144.1`，并兼容 2026-07-12 的 GitHub `main`

## 背景

应用已经接通 Codex experimental collaboration mode 的基础链路：

- `initialize.capabilities.experimentalApi = true`
- `collaborationMode/list`
- `turn/start.collaborationMode`
- renderer 按线程记忆 `default | plan`
- Plan preset 从官方 mask 读取 `reasoning_effort`

但当前实现把 `default` 当成“不发送字段”。Codex 的 turn/thread settings
override 是持久线程设置；线程进入 Plan 后，后续省略 `collaborationMode`
不会表达“切回 Default”。因此 UI 可能显示 Default，而 Codex 线程仍保持 Plan。

当前 `CollabModeToggle` 还是一个二态按钮，没有暴露官方的
Plan 专属 reasoning effort，也没有消费服务端线程设置回执。

## 官方事实基线

以下行为以 Codex 官方 README、protocol 类型和 TUI 源码为准：

1. `collaborationMode/list` 是 experimental、无分页，返回有序 preset masks。
2. preset 是部分设置：
   - 字段省略：保留当前值；
   - 字段为 `null`：清除当前值；
   - 字段为具体值：覆盖当前值。
3. 内置 preset 不选择模型；Plan 当前默认 `reasoning_effort = medium`。
4. `settings.developer_instructions = null` 表示使用所选模式的内置指令。
5. collaboration mode 属于持久线程设置；切换模式需要显式提交目标模式。
6. 官方 TUI 切换模式时立即提交线程设置更新，并在后续 user turn 继续携带
   当前有效模式。
7. 官方 TUI 在 turn 运行中拒绝切换 collaboration mode。
8. `plan_mode_reasoning_effort` 与普通模式 effort 分离：
   - 未设置时使用 Plan preset 默认值；
   - 显式值只覆盖 Plan；
   - 重置后重新跟随 preset。
9. 服务端线程设置通知是 UI 同步的权威来源。

官方没有规定 Web/Electron 必须使用某一种视觉控件。本设计的分体按钮是
对官方行为语义的本地 UX 适配，不宣称复刻官方 TUI 外观。

## 目标

- 修复 Plan → Default 后端状态未切换的问题。
- 让服务端确认的线程模式成为 renderer 的权威状态。
- 模式切换即时生效，不必等待下一条消息。
- 每个新 turn 显式携带当前有效模式，防止恢复和兼容路径漂移。
- 提供 Plan 专属 reasoning effort，并与 Default effort 隔离。
- 用紧凑、可访问、可回滚的分体控件替换简单 Toggle。
- 对不支持即时设置 RPC 的旧 binary 保留安全降级。
- 通过协议、主进程、store、组件、集成和真实 binary 冒烟验证。

## 非目标

- 不做任意自定义 collaboration mode 编辑器。
- 不提前暴露官方当前未标记为 TUI-visible 的 mode。
- 不重构 ModelPicker、ImageChannelPicker 或整个 composer。
- 不改变模型供应商、审批策略、sandbox 或权限体系。
- 不把 experimental API 失败升级为聊天不可用。
- 不复刻终端 TUI 的像素外观。

## 方案选择

采用“协议优先的分体控件”。

未采用的方案：

- **只修 Default 载荷**：能修 bug，但继续缺少服务端回执、即时切换和 Plan effort。
- **通用 collaboration mode 框架**：可扩展性更强，但当前公开可见模式只有
  Default/Plan，属于过度设计。

## 状态模型

```ts
type CollaborationModeKind = 'default' | 'plan'
type PlanReasoningEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh'

interface ThreadCollaborationState {
  confirmed: CollaborationModeKind
  pending?: CollaborationModeKind
  requestVersion: number
  compatibility: 'immediate' | 'next-turn'
}
```

状态所有权：

- `confirmed`：来自服务端线程设置快照/通知；有线程时是唯一权威值。
- `pending`：用户已请求但服务端尚未确认的目标模式，只用于交互反馈。
- 新线程尚无 `threadId` 时，composer 持有一个预选 mode；首次 `turn/start`
  将其提交并绑定到新线程。
- Plan reasoning effort 为全局用户偏好，独立持久化。
- Default reasoning effort 继续由当前 ModelPicker 选择解析，不受 Plan 偏好影响。
- 线程切换只恢复目标线程的 confirmed/pending；迟到回执通过 threadId 和
  requestVersion 隔离。

## 协议与主进程

### 读取 preset

继续复用 `collaborationMode/list`：

- 缓存本次 Codex 进程返回的 preset masks；
- Codex 重启后缓存失效；
- `auto` 从 Plan mask 解析当前默认 effort；
- RPC 失败时本次降级为 `medium`，下次允许重试；
- 不用本地静态 model 覆盖 preset 的 `model: null` 语义。

### 即时线程设置

新增 Codex protocol client 的线程设置更新方法，优先使用官方
`thread/settings/update` 语义：

- 参数包含 `threadId` 和完整有效 `collaborationMode`；
- `developer_instructions: null` 请求内置模式指令；
- Plan effort 使用 Auto 解析值或用户显式覆盖值；
- Default effort 使用当前模型选择的普通 effort；
- model 始终使用当前解析后的 canonical model。

主进程把确认通知归一化为内部 `thread_settings_updated` 事件，并携带：

- `threadId`
- `mode`
- `model`
- `effort`
- 可选 request correlation/version

如果 bundled binary 不支持即时设置方法：

- 识别 method-not-found/unsupported；
- 将该 Codex 进程标记为 `next-turn` compatibility；
- 不反复弹相同错误；
- renderer 保留预选目标；
- 下一次 `turn/start` 显式提交目标模式。

权限、认证或普通 RPC 错误不进入兼容模式，而是回滚并展示错误。

### 每回合显式模式

`AgentSendMessagePayload.collaborationModeKind` 不再把 Default 当成省略：

- renderer 每次 send 都发送当前目标 kind；
- AgentManager 为 Default 和 Plan 都构造完整 `CodexCollaborationMode`；
- `turn/start` 始终携带完整当前模式；
- 只有调用方完全没有 collaboration mode 能力时才省略字段。

Plan 和 Default 的 effort 分别计算，禁止复用同一缓存值。

## Renderer 数据流

### 已存在线程切换模式

1. 用户点击主按钮。
2. 若当前 turn 正在运行，操作被禁用，不产生本地状态变化。
3. store 为该 thread 写入 pending 和递增 requestVersion。
4. IPC 请求主进程更新线程 collaboration mode。
5. 服务端确认通知到达后，按 threadId/version 写 confirmed 并清 pending。
6. 若 RPC/通知失败，清 pending，保留旧 confirmed，显示行内错误。
7. 若用户已切换到别的线程，回执只更新原线程 slice。

### 新线程预选

1. 没有 threadId 时，点击按钮只更新 composer 预选值。
2. 首次发送时 payload 显式携带预选 kind。
3. `turn/start` 创建线程并应用完整模式。
4. thread 创建/设置回执把预选转成该线程 confirmed。

### Plan effort

1. 用户在箭头面板选择 Auto 或显式 effort。
2. 偏好写入版本化本地存储，作用域为全局。
3. 当前线程是 Plan 且不在运行时，立即提交新的有效 Plan mode。
4. 当前线程是 Default 时，只更新偏好；下次进入 Plan 时生效。
5. 当前模型不支持已选 effort 时回到 Auto，并发出一次轻量 notice。

### ModelPicker 交互

当前 Plan 下，如果 ModelPicker 对同一 canonical model 选择不同 effort，
这是一个作用域有歧义的操作。对齐官方语义时提供两项轻量选择：

- 仅 Plan：更新 Plan effort；
- 所有模式：更新普通 effort，并清除 Plan 专属覆盖回到 Auto。

切换到不同 model 仍按普通模型选择流程执行；Plan preset 本身不选择 model。

## UX/UI

### 分体按钮

位置保持在 composer footer 的 ModelPicker 右侧。

主按钮：

- Default：中性深色背景、灰/青边框；
- Plan · Auto / Plan · High：fuchsia 激活态；
- 点击在 Default/Plan 间切换；
- pending 时显示小型进度反馈并禁用重复操作；
- turn 运行中 disabled，tooltip 说明“当前回合结束后可切换”。

箭头按钮：

- 打开向上的 Plan 设置面板；
- 使用独立 aria label；
- 面板关闭后焦点返回箭头。

### Plan 设置面板

内容顺序：

1. 标题“Plan 模式”
2. 一句说明“先调研并形成计划，不直接执行”
3. Auto（副文案显示当前官方值，例如 medium）
4. 当前模型支持的 Low / Medium / High / Extra high
5. 当前项勾选
6. 高强度用量提示
7. 底部说明“仅影响 Plan；Default 保持模型原推理强度”

不支持的 effort 不显示。模型目录尚未就绪时只显示 Auto。

### 响应式与可访问性

- 窄窗口隐藏 effort 后缀，只保留当前模式名；完整信息放入 tooltip。
- 面板沿用 ModelPicker/ImageChannelPicker 的深色玻璃、边框和阴影。
- 不引入新的全局设计 token 或第三方 UI 依赖。
- 主按钮支持 Enter/Space。
- listbox 支持 ArrowUp/ArrowDown、Home/End、Enter、Escape。
- 使用 `aria-expanded`、`aria-controls`、`aria-selected`。
- pending、成功和失败通过克制的 `aria-live` 文本反馈。
- 点击外部或 Escape 关闭面板。

## 组件边界

- `CollabModeControl.tsx`
  - 只负责分体按钮、popover、焦点和可访问性；
  - 不直接构造 Codex wire payload。
- `collaborationMode.ts`
  - 纯函数：preset 合并、Auto 解析、effort 支持过滤、mode payload 构造。
- agent chat store
  - 管理 confirmed/pending/new-thread draft/global effort/thread slices。
- protocol/client/backend
  - 实现 list/update/notification wire contract。
- AgentManager
  - 解析 model/effort，构造有效 mode，处理 RPC 信封和兼容降级。
- `MentionInput.tsx`
  - 只把旧 `CollabModeToggle` 替换为新控件，不继续堆业务逻辑。

## 错误与并发

- 请求发送前不覆盖 confirmed。
- 请求失败时不会把 UI 留在目标模式假象中。
- 服务端通知优先于本地缓存。
- requestVersion 防止快速点击造成旧回执覆盖新选择。
- threadId 防止后台线程回执污染当前视图。
- Codex 重启后清空 preset/compatibility 缓存，并从线程设置重新同步。
- experimental preset 查询失败不阻断 Default 聊天。
- Plan effort Auto 解析失败时使用 medium，但 UI 标注为 fallback，不伪装成已读取官方值。

## TDD 与验证

### Renderer/store

- Default 首次发送也携带 `collaborationModeKind: 'default'`。
- Plan → Default 显式提交 Default。
- 新线程预选转为线程 confirmed。
- 每线程 mode 与全局 Plan effort 的作用域正确。
- thread 切换、后台回执和 requestVersion 隔离。
- unsupported effort 回到 Auto。

### UI

- 主按钮切换、箭头独立开面板。
- active/default/pending/error/disabled 视觉状态。
- 运行中无法切换且有解释。
- Auto 显示官方当前值。
- 只显示模型支持的 effort。
- 键盘导航、Escape、焦点恢复和 ARIA。
- 高 effort 用量提示。

### 主进程与协议

- `collaborationMode/list` mask 三态解析。
- `thread/settings/update` 请求 wire shape。
- `thread/settings/updated` 通知归一化。
- Default/Plan 完整 payload。
- Plan effort 不污染 Default effort。
- method-not-found 只触发一次 compatibility 降级。
- 普通错误不误判为兼容问题。

### 集成与真实 binary

- Plan → Default → Plan。
- 切换线程后服务端状态与 UI 一致。
- Codex 重启/线程恢复后状态一致。
- bundled `0.144.1`：
  - initialize experimental capability；
  - collaboration mode list；
  - thread settings update 或可识别 fallback；
  - turn/start collaboration mode 解析。

最后运行：

- Plan 相关定向测试；
- agent-chat 与 main/agent 相关回归；
- typecheck；
- changed-file lint；
- `npm run build:vite`；
- 工作区 diff/生成物检查。

## 验收标准

- 从 Plan 切到 Default 后，服务端线程状态确认是 Default。
- UI 永远不把未确认模式显示为已生效。
- 每个 user turn 都携带与 UI 一致的有效模式。
- Plan Auto 跟随官方 preset；显式 effort 只影响 Plan。
- 运行中不能切换，失败可理解且可恢复。
- thread 切换、重启和旧 binary 降级不产生模式漂移。
- 控件在鼠标、键盘和窄窗口下均可完整操作。
- 无新增依赖，无无关重构，无已知新增 lint/typecheck/test 失败。

## 官方参考

- <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- <https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md>
- <https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs>
- <https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/settings.rs>
- <https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/model_popups.rs>
- <https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/input_submission.rs>
