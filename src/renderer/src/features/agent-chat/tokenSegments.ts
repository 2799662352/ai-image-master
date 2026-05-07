import type { AgentTokenUsage } from '../../../../types/agent'

export type SegmentKey = 'cached' | 'conversation' | 'reasoning' | 'output'

export interface Segment {
  key: SegmentKey
  /** Human-facing label rendered in the legend. */
  label: string
  /** Hex color used both for the bar fill and the legend dot. */
  color: string
  /** Token count for this segment (>= 0, clamped). */
  tokens: number
}

export interface ContextSegments {
  /** Always 4 segments, in fixed order: cached → conversation → reasoning → output. */
  segments: Segment[]
  /** Sum of all segment tokens after clamping. Used as the bar's width basis. */
  total: number
  /** Hard context window from `usage.contextWindow`, when present. */
  windowTokens?: number
  /** Rounded percent of `windowTokens` consumed. Undefined if window is missing. */
  pctFull?: number
}

/**
 * Map an `AgentTokenUsage` onto the four segments rendered in the popover.
 *
 * Why these four (and only these four): Codex's `thread/tokenUsage/updated`
 * notification reports cumulative `inputTokens` (with an optional
 * `cachedInputTokens` subset) and cumulative `outputTokens` (with an optional
 * `reasoningTokens` subset). It does NOT break inputTokens further into
 * "system prompt vs tools vs MCP vs custom skills vs message history". Splitting
 * those would require wire-level changes Codex hasn't shipped. Until it does,
 * we render only what the wire actually reports.
 *
 * Clamping rationale: gateways occasionally report `cached > input` or
 * `reasoning > output` (off-by-ones, rounding). Without clamping the bar would
 * paint a negative region and totals would lie. We clamp non-negatively so
 * `total === sum(segments)` always holds.
 */
export interface BuildContextSegmentsOptions {
  /**
   * Used as the percent-full denominator when `usage.contextWindow` is
   * not reported by the gateway. Pass `DEFAULT_MODEL_CONTEXT_WINDOW`
   * from `contextWindowDefaults.ts`. Optional — when omitted, `pctFull`
   * stays undefined unless `usage.contextWindow` is set, preserving the
   * old behaviour for callers that don't care about the fallback.
   */
  fallbackContextWindow?: number
}

export function buildContextSegments(
  usage: AgentTokenUsage,
  options: BuildContextSegmentsOptions = {},
): ContextSegments {
  const input = Math.max(0, usage.inputTokens ?? 0)
  const output = Math.max(0, usage.outputTokens ?? 0)
  const cachedRaw = Math.max(0, usage.cachedInputTokens ?? 0)
  const reasoningRaw = Math.max(0, usage.reasoningTokens ?? 0)

  const cached = Math.min(cachedRaw, input)
  const conversation = Math.max(input - cached, 0)
  const reasoning = Math.min(reasoningRaw, output)
  const visibleOutput = Math.max(output - reasoning, 0)

  const segments: Segment[] = [
    { key: 'cached', label: 'Cached prompt', color: '#10b981', tokens: cached },
    { key: 'conversation', label: 'Conversation', color: '#f59e0b', tokens: conversation },
    { key: 'reasoning', label: 'Reasoning', color: '#a855f7', tokens: reasoning },
    { key: 'output', label: 'Output', color: '#22d3ee', tokens: visibleOutput },
  ]
  const total = segments.reduce((acc, s) => acc + s.tokens, 0)

  const reportedWindow =
    typeof usage.contextWindow === 'number' && usage.contextWindow > 0 ? usage.contextWindow : undefined
  const fallbackWindow =
    typeof options.fallbackContextWindow === 'number' && options.fallbackContextWindow > 0
      ? options.fallbackContextWindow
      : undefined
  const windowTokens = reportedWindow ?? fallbackWindow
  const pctFull = windowTokens != null ? Math.round((100 * total) / windowTokens) : undefined

  return { segments, total, windowTokens, pctFull }
}
