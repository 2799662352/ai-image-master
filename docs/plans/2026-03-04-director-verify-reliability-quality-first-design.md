# Director Verify Reliability (Quality-First) Design

## 背景

当前 `DirectorPipeline` 在 Pass4 (`verifyConsistency`) 遇到网络异常（如 `ERR_CONNECTION_CLOSED` / `Failed to fetch`）时，会进入 `catch` 并返回 `report: null`。后续 `routeVerify` 会直接走 `generate`，导致：

- 一致性校验失败被“静默放行”
- 失败原因不可观测（仅日志可见，状态不可追踪）
- 用户误以为“通过了校验”，实际并未校验

这与“质量优先”的目标冲突。

## 目标

在不引入规则兜底评分（坚持 LLM-only 评分口径）的前提下，实现：

1. Pass4 失败可重试、可分类、可观测  
2. 严格模式下，Pass4 失败不允许静默进入生图成功路径  
3. 非严格模式下允许继续，但必须有高风险标记

## 非目标

- 不改模型能力或供应商协议
- 不引入第二套规则评分器替代 LLM
- 不改 Pass1/2/3 的业务语义

## 设计原则

1. **单一评分口径**：一致性评分只来自 Pass4 LLM 结构化输出  
2. **失败显式化**：网络失败写入状态，不使用 `null` 隐式表示  
3. **路由可审计**：每次失败都能追踪“失败类型→重试次数→最终决策”  
4. **局部修复优先**：仅在 Pass4 成功且低分时触发“低分项 + 受影响面板”重试

## 架构与控制流

### 1) Pass4 节点双层重试

- **LangGraph 节点级重试**：`addNode('verifyConsistency', verifyConsistencyFn, { retryPolicy })`
- **模型调用级重试**：在 LLM 调用层使用 `retryOn` 与指数退避，仅重试网络/超时/5xx/429

### 2) Pass4 失败状态结构化

在 `DirectorState` 增加：

- `verifyStatus: 'ok' | 'error'`
- `verifyErrorType?: 'network' | 'timeout' | 'rate_limit' | 'server' | 'unknown'`
- `verifyErrorMessage?: string`
- `verifyAttempts: number`
- `strictVerify: boolean`（默认 `true`）
- `verifyRiskLevel?: 'none' | 'high'`

### 3) 路由策略（质量优先）

- `verifyStatus='ok'`：走既有评分阈值逻辑（总分 + 分项阈值）
- `verifyStatus='error' && strictVerify=true`：终止（或进入显式失败节点）
- `verifyStatus='error' && strictVerify=false`：允许继续生图，但标记 `verifyRiskLevel='high'`

## 数据流

1. Pass4 成功：`report` 有值，`verifyStatus='ok'`
2. Pass4 失败：`report=null`，但 `verifyStatus='error'` + `verifyErrorType` + `verifyErrorMessage`
3. `routeVerify` 不再通过 `report === null` 隐式放行，而是以 `verifyStatus` 显式决策
4. `prepareRetry` 只在 `verifyStatus='ok'` 且低分时触发

## 错误处理策略

### 错误分类（最小集）

- `network`: 连接关闭、DNS、socket、fetch failed
- `timeout`: 超时、AbortError
- `rate_limit`: 429
- `server`: 5xx
- `unknown`: 其他

### 失败后行为

- 严格模式：中止并在 UI/历史记录展示“校验失败类型”
- 非严格模式：继续生图并展示“高风险（未完成一致性校验）”

## 测试策略（TDD）

新增测试文件：`src/renderer/src/services/pipeline/__tests__/director-verify-network-failure.test.ts`

覆盖场景：

1. `verifyConsistency` 网络失败后，状态字段正确写入  
2. `strictVerify=true` 时失败不进入正常生图路径  
3. `strictVerify=false` 时可继续且有 `verifyRiskLevel='high'`  
4. `verifyStatus='ok'` 时既有阈值逻辑不回归

## 验收标准

1. 网络抖动下不再“静默放行”  
2. 每次 Pass4 失败都可看到：失败类型、重试次数、路由决策  
3. 严格模式下，Pass4 失败不会被标记为正常通过  
4. 低分局部修复策略保持有效（只改低分项/受影响面板）

## 风险与缓解

- 风险：严格模式会降低成功出图率  
  - 缓解：提供 `strictVerify=false` 开关
- 风险：错误分类误判  
  - 缓解：分类兜底到 `unknown`，并保留原始错误消息

## 与官方最佳实践对齐

- **LangChain**：采用可配置重试与失败处理（retry/backoff/onFailure）  
- **LangGraph**：节点级重试 + 条件分流，不把异常吞掉  
- **DeepAgents/Skills**：提示词精简分层，减少无效调用与上下文噪声

