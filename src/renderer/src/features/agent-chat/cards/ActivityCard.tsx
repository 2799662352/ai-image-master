import { useState } from 'react'
import type { ActivityItem } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../file-explorer/store'
import { referencesFromTimelineItem } from '../references/referenceUtils'

/**
 * Catch-all card rendered for any Codex `item.type` we don't yet have a
 * dedicated renderer for. Without this, MCP tool calls, web searches, file
 * reads, plan updates, and context compactions used to be invisible — the
 * agent looked frozen between "Thinking…" and the final reply.
 *
 * The card stays small (single-line pill) by default and expands when there
 * is a `detail` payload worth showing. It draws an icon per `kind`, a label,
 * and a status dot that flips from spinner → ✓ → ⚠ as the lifecycle moves
 * from running → success / error.
 */
export function ActivityCard({ item }: { item: ActivityItem }) {
  const status = item.endedAt ? item.status ?? 'success' : item.status ?? 'running'
  const isRunning = status === 'running'
  const hasDetail = typeof item.detail === 'string' && item.detail.length > 0
  const [expanded, setExpanded] = useState(false)
  const openReference = useFileExplorerStore((state) => state.openReference)
  const references = referencesFromTimelineItem(item)

  const icon = pickIcon(item.kind)
  const accent = pickAccent(status)
  const label = item.label ?? item.kind

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={[
          'flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition',
          accent.border,
          accent.bg,
          accent.text,
          hasDetail ? 'hover:brightness-125' : 'cursor-default',
        ].join(' ')}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        {isRunning ? (
          <span className={`inline-block h-3 w-3 animate-spin rounded-full border ${accent.spinner}`} />
        ) : (
          <span className="text-xs leading-none">{accent.glyph}</span>
        )}
        <span className="text-[10px] uppercase tracking-[0.18em] opacity-70">{icon}</span>
        <span className="truncate font-medium">{label}</span>
        {hasDetail ? <span className="ml-1 text-[9px] opacity-60">{expanded ? '▾' : '▸'}</span> : null}
      </button>
      {expanded && hasDetail ? (
        <div className="mt-1 max-h-[200px] overflow-y-auto rounded border border-zinc-800/60 bg-zinc-950/50 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-zinc-400 whitespace-pre-wrap break-all">
          {item.detail}
        </div>
      ) : null}
      {references.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {references.map((reference) => (
            <button
              key={reference.id}
              type="button"
              onClick={() => void openReference(reference)}
              className="rounded border border-cyan-500/30 px-2 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-500/10"
            >
              Open details
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function pickIcon(kind: string): string {
  switch (kind) {
    case 'mcpToolCall':
      return 'mcp'
    case 'webSearch':
      return 'web'
    case 'dynamicToolCall':
    case 'collabToolCall':
      return 'tool'
    case 'imageView':
      return 'img'
    case 'plan':
      return 'plan'
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return 'review'
    case 'contextCompaction':
      return 'ctx'
    default:
      return 'act'
  }
}

function pickAccent(status: NonNullable<ActivityItem['status']>): {
  border: string
  bg: string
  text: string
  spinner: string
  glyph: string
} {
  switch (status) {
    case 'running':
      return {
        border: 'border-cyan-500/40',
        bg: 'bg-cyan-500/10',
        text: 'text-cyan-200',
        spinner: 'border-cyan-700 border-t-cyan-300',
        glyph: '·',
      }
    case 'success':
      return {
        border: 'border-emerald-500/30',
        bg: 'bg-emerald-500/5',
        text: 'text-emerald-200/90',
        spinner: 'border-emerald-700 border-t-emerald-300',
        glyph: '✓',
      }
    case 'error':
      return {
        border: 'border-red-500/40',
        bg: 'bg-red-500/10',
        text: 'text-red-200',
        spinner: 'border-red-700 border-t-red-300',
        glyph: '!',
      }
    case 'cancelled':
      return {
        border: 'border-amber-500/30',
        bg: 'bg-amber-500/5',
        text: 'text-amber-200/90',
        spinner: 'border-amber-700 border-t-amber-300',
        glyph: '⊘',
      }
  }
}
