# Codex 模型设置对齐设计

日期：2026-07-12  
状态：已获用户批准，待书面审阅  
基线：Codex CLI / app-server 0.144.1，应用版本分支 `release/v4.3.94`

## 目标

把当前模型选择器升级为能力驱动的模型设置面板，并准确区分：

- 普通回合的模型与 Reasoning；
- Plan 模式独立的 Reasoning；
- 模型官方上下文与用户主动强制的实验性 1M；
- Codex 目录能力、Provider 实际能力和 UI 展示能力。

完成后：

1. 一个规范模型只显示一行，不再把 `gpt-5.4-high` 等本地选项伪装成独立模型。
2. 模型设置面板包含 Context 与 Reasoning。
3. 普通 Reasoning 与 Plan Reasoning 相互独立。
4. GPT-5.6 Sol 在 Right Code 下可使用 `max`；`ultra` 不显示。
5. GPT-5.6 官方默认上下文显示为 372K，GPT-5.5/5.4 显示为 272K。
6. 所有模型都允许用户选择 `1M（实验性）`，但 UI 不声称 Provider 官方支持。
7. Context 变化会真实修改 Codex 启动配置、重启后台并恢复当前线程。

## 已验证事实

### Codex 0.144.1

- `model/list` 返回 `supportedReasoningEfforts`、`defaultReasoningEffort`、
  `serviceTiers` 等字段，但不返回 `contextWindow` 或 `maxContextWindow`。
- 内置模型目录声明：
  - GPT-5.6 Sol/Terra/Luna：`context_window=372000`，
    `max_context_window=372000`；
  - GPT-5.5：272K；
  - GPT-5.4：默认 272K，目录最大值 1M。
- GPT-5.6 Sol 的目录含 `low/medium/high/xhigh/max/ultra`。

### Right Code 实测

- GPT-5.6 Sol 接受 `max` 并在响应中回显 `max`。
- GPT-5.6 Sol 拒绝 `ultra`，错误列出的有效等级为
  `low/medium/high/xhigh/max`。
- GPT-5.5 拒绝 `max`。
- `service_tier` 不被严格校验，无法证明 Fast 实际生效。
- `/models` 不提供上下文上限元数据，文档也未承诺 1M。

因此能力需要两层合并：

1. Codex `model/list` 提供运行时 Reasoning 候选；
2. 应用的版本化 Provider 策略做安全交集与上下文补充。

## 非目标

- 不在本期开放 Fast。应用使用 API Key Provider，Right Code 未证明 Fast 生效。
- 不显示 `ultra`。Codex 目录虽有该值，但当前目标 Provider 已实测拒绝。
- 不通过发送近 1M token 的探测请求验证网关上限；这会产生不可控费用和延迟。
- 不改变 Plan 模式“只规划、不直接执行”的语义。
- 不修复现有 Electron 全量 E2E 基线失败。

## 架构

### 1. 模型能力

新增共享模型设置能力层，职责单一：

```ts
type ModelReasoningEffort =
  | 'auto'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

interface ModelSettingsCapabilities {
  model: string
  defaultContextWindow: number
  contextOptions: Array<{
    value: number
    experimental: boolean
  }>
  defaultReasoningEffort?: string
  supportedReasoningEfforts: Exclude<ModelReasoningEffort, 'auto'>[]
  provider: string
}
```

能力合并规则：

1. `model/list` 是模型可见性、默认 Reasoning 和 Reasoning 候选的权威来源。
2. Provider 策略与候选取交集：
   - Right Code 的 GPT-5.6 Sol 保留到 `max`；
   - GPT-5.5 不保留 `max`；
   - 所有 Right Code 模型过滤 `ultra`；
   - API Key Provider 不暴露 Fast。
3. Context 使用 0.144.1 版本化表：
   - `gpt-5.6-*`：372K；
   - `gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`：272K；
   - 未知模型：保守回退 200K。
4. 所有模型额外加入 1M 实验选项。该选项表示客户端强制配置，不表示服务端能力声明。
5. `model/list` 不可用时使用当前静态目录作为降级；降级状态必须在 UI 标明，
   不能把猜测显示成已确认能力。

### 2. 状态模型

渲染层保存：

```ts
selectedModelId: string // 规范模型 slug
modelReasoningEffortByModel: Record<string, ModelReasoningEffort>
modelContextWindowByModel: Record<string, number>
modelSettingsPending?: {
  model: string
  targetContextWindow: number
}
modelSettingsError?: string
```

Plan 继续使用独立的：

```ts
planReasoningEffort: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
```

规则：

- 普通 Reasoning 不改 Plan 偏好。
- Plan Reasoning 不改普通偏好。
- `auto` 在发送时省略普通 `turn/start.effort`，让 Codex 使用模型默认值。
- Plan 的 `auto` 继续解析 Codex Plan preset。
- 每个模型分别记忆 Reasoning 与 Context。

### 3. 旧设置迁移

启动时将旧 picker id 迁移一次：

- `gpt-5.4-low` → model `gpt-5.4` + effort `low`
- `gpt-5.4-medium` → model `gpt-5.4` + effort `medium`
- `gpt-5.4-high` → model `gpt-5.4` + effort `high`
- `gpt-5.4-xhigh` → model `gpt-5.4` + effort `xhigh`
- `gpt-5.5-xhigh` → model `gpt-5.5` + effort `xhigh`

迁移成功后只写新键；保留读取旧键的一个版本兼容窗口。未知旧值原样当作规范 slug，
Reasoning 使用 `auto`。

## UI

### 模型列表

- 左侧保留搜索与模型列表。
- 一个规范模型只显示一行。
- 当前模型行显示设置入口。
- 底部模型按钮摘要为“模型名 · Reasoning”；Context 不塞进底栏，避免拥挤。

### 模型设置面板

右侧设置面板包含：

#### Context

- GPT-5.6：`372K`、`1M · 实验性`
- GPT-5.5/5.4：`272K`、`1M · 实验性`
- 未知模型：`200K · 保守默认`、`1M · 实验性`

实验性说明必须明确：

> 强制客户端按 1M 管理上下文；Provider 可能拒绝、返回 HTTP 413、增加费用或延迟。

#### Reasoning

- 始终显示 `Auto`。
- 其余只显示能力合并后的选项：
  `Low / Medium / High / Extra High / Max`。
- `Extra High` 的 wire value 为 `xhigh`。
- `Max` 的 wire value 为 `max`。
- 不支持的值不渲染，不显示不可点击的假选项。

### Plan 控件

- 保留独立的 Plan/Default 切换按钮与 Plan 设置入口。
- Plan Reasoning 同样按能力动态过滤，并支持 `max`。
- 面板明确提示“仅影响 Plan；Default 保持普通模型 Reasoning”。

### 可访问性与交互

- 使用原生按钮与 listbox/option 语义。
- 支持方向键、Home/End、Enter、Escape、Tab 与焦点恢复。
- 当前回合运行中禁用模型、Reasoning 和 Context 修改。
- Context 重启流程中显示“正在应用并恢复线程”，所有相关控件禁用，防止重复请求。
- 错误在设置面板内联显示，同时保留可供读屏读取的 `aria-live` 状态。

## 数据流

### 普通 Reasoning

1. 用户选择 Reasoning。
2. store 保存到当前模型的偏好并持久化。
3. 下一次新 turn 发送规范模型 slug。
4. effort 为 `auto` 时完全省略字段；否则透传
   `low/medium/high/xhigh/max`。
5. 不重启 Codex，不修改 Plan 偏好。

### Plan Reasoning

沿用现有 collaboration mode 管线：

1. 能力由 `collaborationMode/list` 与 `model/list` 合并。
2. `normaliseSupportedPlanEfforts` 扩展到 `max`。
3. Right Code Provider 策略过滤 `ultra`。
4. 已加载线程通过 `thread/settings/update` 应用；
   新线程通过 `turn/start.collaborationMode` 应用。

### Context 事务

Context 是进程级设置，不能伪装成普通 turn 参数。
当前 `codexLaunch.ts` 的 `-c model_auto_compact_token_limit=220000` 优先级高于
用户 `config.toml`，因此实现必须先把这条硬编码改为读取应用持久化的活动
Context 配置；不能只写 `config.toml` 后声称已生效。每次启动仍通过 `-c` 显式传入
两项最终值，确保应用状态是单一真源。

1. 检查当前无运行中 turn。
2. 记录旧 Context、旧压缩阈值、当前 DB thread id 与 Codex thread id。
3. 原子写入应用持久化的目标启动配置：
   - `model_context_window = target`
   - `model_auto_compact_token_limit = floor(target * 0.9)`
4. 重启本地 Codex backend。
5. 恢复当前线程；无当前线程时保持新对话状态。
6. 重新加载模型与 Plan 能力。
7. 全部成功后确认 UI 状态并持久化该模型的 Context。

切换模型时，如果目标模型保存的 Context 与当前进程配置不同，也执行同一事务。
Reasoning 单独变化不触发重启。

### 1M 的真实含义

配置与重启成功只证明客户端已按 1M 启动，不证明 Provider 接受接近 1M 的请求。
Provider 可能直到历史增长后才报错。应用不得在重启成功时显示“Provider 已支持 1M”。

## 错误处理与回滚

Context 事务任一步失败：

1. 保留原始错误；
2. 恢复旧 Context 与旧压缩阈值；
3. 再次重启 backend；
4. 尝试恢复原线程；
5. UI 回到旧确认值并显示原始错误。

如果回滚也失败：

- 不显示成功；
- 保留新旧配置与两个错误的诊断摘要；
- 提示用户手动重启 Agent Workspace；
- 禁止自动无限重试。

Provider 在后续大上下文 turn 中报 413/上下文超限时：

- 按现有 turn error 展示；
- 附加建议“切回模型官方 Context 并重试”；
- 不自动丢弃消息，不静默缩回 220K。

## TDD 计划

### 共享能力与迁移

先写失败测试：

- GPT-5.6 Sol 保留 `max`、过滤 `ultra`。
- GPT-5.5 过滤 `max`。
- `xhigh` 显示为 Extra High，wire value 不变。
- 所有模型有实验性 1M。
- GPT-5.6 默认 372K，GPT-5.5/5.4 默认 272K，未知模型默认 200K。
- 旧 effort 后缀 id 迁移为规范模型 + effort。

### 渲染层

先写失败测试：

- 模型列表不再出现重复 effort 变体。
- 设置面板显示正确 Context 与 Reasoning。
- GPT-5.6 Sol 显示 Max；GPT-5.5 不显示 Max；所有模型不显示 Ultra/Fast。
- 普通 Reasoning 与 Plan Reasoning 独立持久化。
- 1M 警告文案存在。
- 键盘、焦点、pending 与错误状态符合可访问性契约。

### 主进程与协议

先写失败测试：

- 普通 `max` 正确透传到 `turn/start.effort`。
- Context 写入两个配置键，压缩阈值为 90%。
- 成功顺序为“写配置→重启→恢复→刷新→确认”。
- 任一步失败触发旧配置回滚。
- 回滚失败不会伪造成功或无限重试。
- 仅 Reasoning 变化不重启。
- 模型切换且 Context 不变不重启。

## 验收

1. GPT-5.6 Sol 普通与 Plan Reasoning 均可选择 Max，并实际发送 `max`。
2. GPT-5.5 不显示 Max。
3. GPT-5.6 默认 Context 显示 372K。
4. 所有模型可主动选择 1M，并看到实验性风险说明。
5. 1M 会真实改变 Context 和 90% 压缩阈值，而不是停留在 220K。
6. Context 改动后 backend 自动重启并恢复当前线程。
7. 失败可回滚，UI 不留永久 pending。
8. Fast 与 Ultra 不出现在当前 API Key Provider UI。
9. 旧模型选择偏好迁移后不丢失。
10. 相关 Vitest、agent-chat/main-agent 回归、lint、typecheck 与 `build:vite`
    使用新鲜命令验证；Electron E2E 的已知基线失败单独报告。

## 风险

- 强制 1M 可能在长对话后才暴露 Provider 限制，无法通过启动时验证消除。
- Context 变更触及 backend 生命周期，必须串行并有回滚；不可用纯 optimistic UI。
- 从 effort 变体模型迁移为规范模型会改变本地存储结构，需要保留兼容读取。
- 移除固定 220K 安全阈值会提高 API 中转请求体；这是用户明确接受的实验性风险，
  必须通过文案与错误恢复控制，而不是隐藏。
