import type { AgentTokenUsage } from '../../../../types/agent'

/**
 * Compact donut + counter shown in the chat panel header. Mirrors the
 * "圈圈展示上下文压缩进度" the user explicitly asked for: a circular gauge
 * that fills as the prompt approaches the model's context window so it is
 * obvious _when_ Codex will compact.
 *
 * Codex's `thread/tokenUsage/updated` notification carries cumulative counts
 * for the active turn. We prefer the explicit `contextUsage` / `contextWindow`
 * pair when the gateway provides it; otherwise we infer from
 * `inputTokens + outputTokens`. When neither a context window nor a usage
 * count is available, the donut hides itself rather than guessing — silence
 * is better than a misleading gauge.
 */
export function TokenUsageMeter({ usage }: { usage?: AgentTokenUsage }) {
  if (!usage) return null

  const used = usage.contextUsage ?? usage.inputTokens + usage.outputTokens
  const window = usage.contextWindow
  const ratio = window != null && window > 0 ? Math.min(1, Math.max(0, used / window)) : null
  const pct = ratio != null ? Math.round(ratio * 100) : null

  // Donut geometry: radius=8, stroke=2, viewBox 0..20 → circumference ≈ 50.27.
  const radius = 8
  const stroke = 2
  const circ = 2 * Math.PI * radius
  const dash = ratio != null ? circ * ratio : 0

  const tone = pickTone(ratio)
  const label = formatTokens(used)

  return (
    <div
      className="flex items-center gap-1.5 rounded-full border border-zinc-700/80 bg-zinc-900/60 px-2 py-0.5 text-[10px] text-zinc-300"
      title={
        ratio != null
          ? `Context: ${used} / ${window} tokens (${pct}%) — Codex compacts when full`
          : `Tokens used: in=${usage.inputTokens} out=${usage.outputTokens}${
              usage.cachedInputTokens != null ? ` cached=${usage.cachedInputTokens}` : ''
            }`
      }
    >
      {ratio != null ? (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <circle
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            stroke="rgba(63,63,70,0.6)"
            strokeWidth={stroke}
          />
          <circle
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            stroke={tone.stroke}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ}`}
            transform="rotate(-90 10 10)"
          />
        </svg>
      ) : (
        <span className="inline-block h-3 w-3 rounded-full border border-zinc-600 bg-zinc-800/50" />
      )}
      <span className={`font-mono ${tone.text}`}>
        {pct != null ? `${pct}%` : label}
      </span>
    </div>
  )
}

function pickTone(ratio: number | null): { stroke: string; text: string } {
  if (ratio == null) return { stroke: '#71717a', text: 'text-zinc-400' }
  if (ratio >= 0.9) return { stroke: '#ef4444', text: 'text-red-300' }
  if (ratio >= 0.7) return { stroke: '#f59e0b', text: 'text-amber-300' }
  return { stroke: '#22d3ee', text: 'text-cyan-200' }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
