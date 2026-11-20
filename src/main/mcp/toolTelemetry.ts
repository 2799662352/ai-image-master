/**
 * MCP 工具调用埋点。
 *
 * 为什么需要:这一轮把「改几个词」从「重发整板」压成单卡调用,理由是省 decode。
 * 这个推理站得住,但在有数字之前它只是推理。Anthropic 的 Writing effective tools
 * for AI agents 明确建议测四件事 —— 单次调用耗时、调用总数、token 消耗、错误率,
 * 并给了读法:「冗余调用多 → 分页/上限参数要调;参数错误多 → 描述或示例不够清楚」。
 * 前三项里的耗时、次数、错误率都能在我们这一侧测,因为**我们就是那个 MCP server**,
 * `ToolRouter.call` 是每一次调用的必经之路。token 消耗只有 codex 看得到,走它的
 * per-turn usage,不在这里。
 *
 * 字段名照抄 OpenTelemetry GenAI 语义约定的 execute_tool span
 * (`gen_ai.operation.name` / `gen_ai.tool.name` / `gen_ai.tool.call.id` / `error.type`),
 * 这样将来要接真的 OTel 后端时是改传输、不是改字段。这里不引 OTel SDK —— 为了本地
 * 数几个数就往 Electron 主进程塞一套导出器不划算。
 *
 * **不记参数和返回值。** 语义约定把 `gen_ai.tool.call.arguments` / `.result` 标为
 * Opt-In 并注明可能含敏感数据,而我们的参数就是用户的提示词本身。
 */

/** 一条调用记录。键名即 OTel GenAI 语义约定的属性名。 */
export interface ToolCallRecord {
  'event.timestamp': string
  'gen_ai.operation.name': 'execute_tool'
  'gen_ai.tool.name': string
  'gen_ai.tool.type': 'function'
  /** 语义约定的度量是 `gen_ai.client.operation.duration`(秒);行日志里毫秒更好读。 */
  duration_ms: number
  /** 只在失败时出现:异常的类名(低基数)。 */
  'error.type'?: string
  /**
   * 只在失败时出现:错误原因的开头。
   *
   * 截断不只是为了省地方 —— 我们有工具会把**提示词全文**放进错误里(patch_prompt
   * 命中不唯一时就这么做,那是它能自纠的关键)。全文落盘等于把用户内容写进日志。
   * 开头那截是「命中 N 处」这类固定措辞,足够分类,又够不到后面的内容。
   */
  'error.reason'?: string
  /** 可选:我们这侧的会话 id,用来把调用归到某次对话。 */
  'thread.id'?: string
  /**
   * 这次调用是怎么认出所属对话的。只在**不是**最普通的情况(调用方就是该对话当前的
   * codex 线程)时才写,所以绝大多数记录和以前一个字不差。
   *
   * 为什么要记:2026-11 一位用户的日志里 1,512 次出图有 718 次没有 `thread.id`,
   * 而那份日志分不清「调用方没带线程」和「带了但认不出」,更说不出认不出的是子代理、
   * 被分叉换下的旧线程、还是别的 —— 结果只能靠猜。
   */
  'thread.via'?: 'subagent' | 'retired' | 'ancestor' | 'pinned' | 'persisted'
  /**
   * 只在没有 `thread.id` 时出现:
   * - `unresolved` 调用方报了 codex 线程,但没有任何对话认领它(工具结果不会进任何对话);
   * - `anonymous`  调用方什么线程信息都没带(不是 codex 发来的,或主进程内部调用)。
   */
  'thread.attribution'?: 'unresolved' | 'anonymous'
  /**
   * 调用方自己的 codex 线程 id。只在没认出来、或不是按最普通的路认出来时才写 ——
   * 有了它才能回到 codex 的会话库里查这条线程是谁生的。是随机 UUID,不含用户内容。
   */
  'codex.thread.id'?: string
  /** 只在没认出来时出现:调用方报的祖先线程(近的在前)。 */
  'codex.thread.ancestors'?: string[]
}

/** {@link buildToolCallRecord} 的归属入参:认出来了、没认出来、还是压根没人报线程。 */
export type ToolCallAttribution =
  | { kind: 'resolved'; via: 'live' | 'subagent' | 'retired' | 'ancestor' | 'pinned' | 'persisted'; codexThreadId?: string }
  | { kind: 'unresolved'; codexThreadId?: string; ancestorThreadIds: readonly string[] }
  | { kind: 'anonymous' }

/** 错误原因保留的字符数。够分类,够不到被塞进错误里的提示词全文。 */
export const TOOL_ERROR_REASON_MAX = 80

type Sink = (record: ToolCallRecord) => void

let sink: Sink | null = null

/**
 * 装上真正的落盘 sink(主进程入口调用)。不装就是不记 —— 单测与渲染端引用这个
 * 模块时不会碰到 electron,也不会往磁盘写东西。
 */
export function setToolTelemetrySink(next: Sink | null): void {
  sink = next
}

/**
 * 把一次调用整理成记录。纯函数,便于直接断言字段形状。
 *
 * 错误信息的 `<工具名>: ` 前缀会被剥掉 —— 工具名已经单独成字段了,留着只会把
 * 那 80 个字符的额度浪费在重复信息上。
 */
export function buildToolCallRecord(input: {
  name: string
  durationMs: number
  threadId?: string
  /** 不传 = 调用方不关心归属细节(旧调用点、单测),记录形状与以前完全一致。 */
  attribution?: ToolCallAttribution
  error?: unknown
  now?: Date
}): ToolCallRecord {
  const record: ToolCallRecord = {
    'event.timestamp': (input.now ?? new Date()).toISOString(),
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': input.name,
    'gen_ai.tool.type': 'function',
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    ...(input.threadId ? { 'thread.id': input.threadId } : {}),
    ...attributionFields(input.attribution),
  }
  if (input.error === undefined) return record

  const err = input.error
  record['error.type'] = err instanceof Error ? err.constructor.name : typeof err
  const message = err instanceof Error ? err.message : String(err)
  const prefix = `${input.name}: `
  const reason = message.startsWith(prefix) ? message.slice(prefix.length) : message
  record['error.reason'] = reason.slice(0, TOOL_ERROR_REASON_MAX)
  return record
}

function attributionFields(
  attribution: ToolCallAttribution | undefined,
): Partial<ToolCallRecord> {
  if (!attribution) return {}
  if (attribution.kind === 'anonymous') return { 'thread.attribution': 'anonymous' }
  if (attribution.kind === 'unresolved') {
    return {
      'thread.attribution': 'unresolved',
      ...(attribution.codexThreadId ? { 'codex.thread.id': attribution.codexThreadId } : {}),
      ...(attribution.ancestorThreadIds.length > 0
        ? { 'codex.thread.ancestors': [...attribution.ancestorThreadIds] }
        : {}),
    }
  }
  // 最普通的情况不加字段:这是日志里的大多数,保持原样既省体积,也让旧的统计脚本照常工作。
  if (attribution.via === 'live') return {}
  return {
    'thread.via': attribution.via,
    ...(attribution.codexThreadId ? { 'codex.thread.id': attribution.codexThreadId } : {}),
  }
}

/** 记一次调用。埋点永远不能弄坏一次真实调用,所以整体吞异常。 */
export function recordToolCall(input: Parameters<typeof buildToolCallRecord>[0]): void {
  if (!sink) return
  try {
    sink(buildToolCallRecord(input))
  } catch {
    // 落盘失败、磁盘满、流已关闭 —— 都不该影响模型拿到工具结果。
  }
}
