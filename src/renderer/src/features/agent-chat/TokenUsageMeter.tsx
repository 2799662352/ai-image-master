import { useEffect, useRef, useState } from 'react'
import type { AgentTokenUsage } from '../../../../types/agent'
import { ContextPopover } from './ContextPopover'

/**
 * Compact donut + counter shown in the chat panel header. Clicking it opens a
 * `ContextPopover` with a 4-segment breakdown of where the context budget is
 * going. The donut itself still mirrors `usage.contextUsage / contextWindow`
 * — the popover is purely additive.
 */
export function TokenUsageMeter({ usage }: { usage?: AgentTokenUsage }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // When the active thread switches we may briefly transition usage→undefined
  // and then back. Without this reset, `open` would leak across threads and
  // the popover would auto-reappear on the new thread's first usage event.
  useEffect(() => {
    if (!usage) setOpen(false)
  }, [usage])

  if (!usage) return null

  const used = usage.contextUsage ?? usage.inputTokens + usage.outputTokens
  const window = usage.contextWindow
  const ratio = window != null && window > 0 ? Math.min(1, Math.max(0, used / window)) : null
  const pct = ratio != null ? Math.round(ratio * 100) : null

  const radius = 8
  const stroke = 2
  const circ = 2 * Math.PI * radius
  const dash = ratio != null ? circ * ratio : 0

  const tone = pickTone(ratio)
  const label = formatTokens(used)
  const ariaLabel =
    ratio != null
      ? `Context: ${used} / ${window} tokens (${pct}%)`
      : `Tokens used: in=${usage.inputTokens} out=${usage.outputTokens}`

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={
          ratio != null
            ? `Context: ${used} / ${window} tokens (${pct}%) — Codex compacts when full`
            : `Tokens used: in=${usage.inputTokens} out=${usage.outputTokens}${
                usage.cachedInputTokens != null ? ` cached=${usage.cachedInputTokens}` : ''
              }`
        }
        className="flex items-center gap-1.5 rounded-full border border-zinc-700/80 bg-zinc-900/60 px-2 py-0.5 text-[10px] text-zinc-300 transition hover:border-cyan-300/60 hover:text-cyan-100"
      >
        {ratio != null ? (
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r={radius} fill="none" stroke="rgba(63,63,70,0.6)" strokeWidth={stroke} />
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
        <span className={`font-mono ${tone.text}`}>{pct != null ? `${pct}%` : label}</span>
      </button>
      {open ? (
        <ContextPopover usage={usage} onClose={() => setOpen(false)} triggerRef={triggerRef} />
      ) : null}
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
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
