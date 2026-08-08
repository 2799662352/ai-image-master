// MCP `ToolAnnotations` 的共享档位。
//
// 四个 hint 的**缺省值是最保守的一组**（规范 2025-11-25 / 2026-07-28 一致）：
//   readOnlyHint    默认 false  → 被当成会改环境
//   destructiveHint 默认 true   → 被当成破坏性
//   idempotentHint  默认 false  → 被当成不可重试
//   openWorldHint   默认 true   → 被当成会碰外部世界
//
// 也就是说**不写等于全都往最坏里说**。官方 tool-annotations 说明写明前三个 hint 回答的
// 是「调用前要不要先问用户」——所以一个纯读的 `video_workbench_status` 不声明，就可能和
// `remove_tasks` 一样被拦下来要确认，白白多一轮往返；反过来真该谨慎的删除类工具也失去了
// 与只读工具的区分度。canvasTools / directorTools 早就按这套标了，这里把档位抽出来共用，
// 免得每个文件各写一份再漂移。
//
// 注意这些是**提示不是权限**：规范明确说客户端必须把它们当作不可信输入，真正的边界仍在
// 我们自己的校验里（validateSeedanceRequest、白名单、rev 并发闸等）。

/** 纯读：不改任何状态，重复调结果一致，只碰本机 / 本应用。 */
export const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const

/** 纯读，但要出网（上游模型、联网检索）。 */
export const READ_ONLY_REMOTE = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const

/** 增改型写入：会改状态但只增不删，重复调会重复产生效果（多一张卡、多一条记录）。 */
export const WRITE_ADDITIVE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

/** 增改型写入 + 出网：生成类工具（每次调用都真花钱、真产生新素材）。 */
export const WRITE_ADDITIVE_REMOTE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const

/** 幂等写入：重复调不会叠加效果（就地改同一张卡 / 打开同一个面板）。 */
export const WRITE_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

/** 破坏性：会删除用户数据或整体替换。这类**应当**触发确认。 */
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const
