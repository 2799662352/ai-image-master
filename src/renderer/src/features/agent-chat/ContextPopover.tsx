import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { AgentTokenUsage, AgentTokenUsageDelta } from '../../../../types/agent'
import type { ContextSegments, Segment } from './tokenSegments'
import { buildContextSegments } from './tokenSegments'

interface ContextPopoverProps {
  usage: AgentTokenUsage
  onClose: () => void
  /**
   * Optional ref to the element that opened this popover. When mousedown lands
   * on the trigger, we treat it as "inside" so a click on the trigger doesn't
   * race the trigger's onClick: mousedown would otherwise fire `onClose()`
   * (setting open=false) and then click would toggle it back to true,
   * leaving the popover stuck open.
   */
  triggerRef?: RefObject<HTMLElement | null>
  /**
   * Used as the percent-full denominator when `usage.contextWindow` is
   * not reported by Codex. Forwarded to `buildContextSegments` so the
   * popover's `% Full` line stays meaningful even on early turns. When
   * omitted, the popover preserves its previous "no window → no pctFull"
   * behaviour.
   */
  fallbackContextWindow?: number
}

/**
 * Click-to-open breakdown of where the context budget is going. Anchored to
 * the right edge of the chat panel header, immediately below the
 * `TokenUsageMeter` pill. The popover is intentionally honest about Codex's
 * data limits — we render only the four segments Codex reports, and call out
 * what's NOT broken down (Tools / Rules / MCP) in the footnote.
 *
 * Closes on Escape, on outside mousedown, or on the explicit close button.
 * The Tab key is unbound — focus management piggybacks on the parent panel's
 * existing keyboard model (no focus trap; the popover is read-only).
 */
export function ContextPopover({ usage, onClose, triggerRef, fallbackContextWindow }: ContextPopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const ctx = buildContextSegments(usage, { fallbackContextWindow })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onMouseDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node)) return
      if (ref.current?.contains(e.target)) return
      if (triggerRef?.current?.contains(e.target)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [onClose, triggerRef])

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Context usage"
      className="absolute right-0 top-[calc(100%+6px)] z-[60000] w-[280px] rounded-lg border border-zinc-700/80 bg-zinc-950/95 p-3 text-zinc-200 shadow-2xl backdrop-blur"
    >
      <header className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.24em] text-zinc-400">Context</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        >
          ×
        </button>
      </header>

      {ctx.total === 0 ? (
        <p className="py-2 text-center text-[11px] text-zinc-500">No usage data yet</p>
      ) : (
        <>
          <PctFullDisplay ctx={ctx} />
          <StackedBar ctx={ctx} />
          <SegmentLegend segments={ctx.segments} />
          <LastTurnLine last={usage.last} />
          <p className="mt-2 text-[9px] leading-relaxed text-zinc-500">
            Codex doesn&apos;t break input into Tools / Rules / MCP — those tokens are inside Cached prompt / Conversation.
          </p>
        </>
      )}
    </div>
  )
}

function PctFullDisplay({ ctx }: { ctx: ContextSegments }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      {ctx.pctFull != null ? (
        <span className="text-lg font-semibold text-zinc-100">{ctx.pctFull}% Full</span>
      ) : null}
      <span className="font-mono text-[10px] text-zinc-500">
        ~{formatTokens(ctx.total)}
        {ctx.windowTokens != null ? ` / ${formatTokens(ctx.windowTokens)}` : ''} Tokens
      </span>
    </div>
  )
}

function StackedBar({ ctx }: { ctx: ContextSegments }) {
  // Bar is sized to the WINDOW when known (so empty space at the right shows
  // remaining headroom); otherwise sized to total (popover with no window
  // info still renders proportions across the full width).
  const denom = ctx.windowTokens ?? ctx.total
  return (
    <div className="mb-2 flex h-[6px] w-full overflow-hidden rounded-full bg-zinc-800">
      {ctx.segments.map((s) => {
        const pct = denom > 0 ? (100 * s.tokens) / denom : 0
        if (pct === 0) return null
        return (
          <div
            key={s.key}
            data-segment={s.key}
            style={{ width: `${pct}%`, backgroundColor: s.color }}
            className="h-full"
          />
        )
      })}
    </div>
  )
}

function SegmentLegend({ segments }: { segments: Segment[] }) {
  return (
    <ul className="space-y-1">
      {segments.map((s) => (
        <li key={s.key} className="flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
            <span>{s.label}</span>
          </span>
          <span className="font-mono text-zinc-400">{formatTokens(s.tokens)}</span>
        </li>
      ))}
    </ul>
  )
}

function LastTurnLine({ last }: { last?: AgentTokenUsageDelta }) {
  if (!last) return null
  return (
    <p className="mt-2 border-t border-zinc-800 pt-2 font-mono text-[10px] text-zinc-500">
      Last turn:{' '}
      <span className="text-zinc-300">+{formatTokens(last.inputTokens)}</span> input
      {' • '}
      <span className="text-zinc-300">+{formatTokens(last.outputTokens)}</span> output
    </p>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
