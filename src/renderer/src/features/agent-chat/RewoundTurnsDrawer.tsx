import { useState } from 'react'
import { useAgentChatStore } from './store'

// ↶ glyph (matches the per-message rewind button so users connect drawer
// rows to where they came from).
function RewindIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7.5h7a3 3 0 010 6H8" />
      <path d="M5.5 5L3 7.5L5.5 10" />
    </svg>
  )
}

function ChevronIcon({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      className={`${className} transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}

function MAX_PREVIEW_CHARS(): number {
  return 60
}

/**
 * Floating drawer of rewound turns ("回收的问答"). Renders nothing when
 * the queue is empty so it doesn't reserve real estate. Otherwise it sits
 * just above the bottom composer with a sticky header showing the count
 * and bulk actions; the body lazily expands on click.
 */
export function RewoundTurnsDrawer() {
  const turns = useAgentChatStore((s) => s.rewoundTurns)
  const restoreRewoundTurn = useAgentChatStore((s) => s.restoreRewoundTurn)
  const clearRewoundTurns = useAgentChatStore((s) => s.clearRewoundTurns)
  const restoreAllRewoundTurns = useAgentChatStore((s) => s.restoreAllRewoundTurns)

  // Default expanded so the most-recent rewind is visible right after
  // the user clicks ↶. The user can collapse if the list grows long.
  const [open, setOpen] = useState(true)

  if (turns.length === 0) return null

  const maxChars = MAX_PREVIEW_CHARS()

  return (
    <section
      aria-label="Rewound turns"
      className="mb-2 overflow-hidden rounded-lg border border-amber-400/25 bg-zinc-900/80 shadow-lg shadow-black/20 backdrop-blur"
    >
      {/* Header — clickable to toggle, plus inline bulk actions. The label
          is its own button (semantic) but the whole row also toggles. */}
      <header className="flex items-center gap-2 border-b border-amber-400/15 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="rewound-turns-list"
          className="flex flex-1 cursor-pointer items-center gap-1.5 rounded text-left text-[11px] font-medium uppercase tracking-[0.18em] text-amber-200/90 transition-colors hover:text-amber-100"
        >
          <RewindIcon className="h-3 w-3" />
          <span>Rewound · {turns.length}</span>
          <ChevronIcon open={open} className="ml-auto h-3 w-3 text-amber-200/70" />
        </button>
        <button
          type="button"
          onClick={() => restoreAllRewoundTurns()}
          title="Restore every rewound turn"
          className="cursor-pointer rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-zinc-400 transition-colors hover:bg-cyan-400/10 hover:text-cyan-200 focus-visible:ring-1 focus-visible:ring-cyan-300/40"
        >
          Restore all
        </button>
        <button
          type="button"
          onClick={() => clearRewoundTurns()}
          title="Permanently discard rewound turns"
          className="cursor-pointer rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-200 focus-visible:ring-1 focus-visible:ring-red-400/40"
        >
          Clear
        </button>
      </header>

      {/* List body — auto-collapses, fixed max-h so a long history scrolls
          inside the drawer instead of pushing the composer offscreen. */}
      {open ? (
        <ul id="rewound-turns-list" className="max-h-48 overflow-y-auto py-0.5">
          {turns.map((turn) => {
            const truncated =
              turn.preview.length > maxChars
                ? `${turn.preview.slice(0, maxChars).trimEnd()}…`
                : turn.preview
            const assistantCount = turn.messages.filter((m) => m.role === 'assistant').length
            return (
              <li key={turn.id}>
                <button
                  type="button"
                  onClick={() => restoreRewoundTurn(turn.id)}
                  title={`Click to restore — ${turn.messages.length} message${turn.messages.length === 1 ? '' : 's'}`}
                  className="group/row flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-zinc-300 transition-colors hover:bg-cyan-400/10 hover:text-cyan-100 focus-visible:bg-cyan-400/10 focus-visible:outline-none"
                >
                  <RewindIcon className="h-3 w-3 shrink-0 text-amber-300/70 transition-colors group-hover/row:text-cyan-300" />
                  <span className="flex-1 truncate">{truncated}</span>
                  {assistantCount > 0 ? (
                    <span className="shrink-0 rounded border border-zinc-700/60 bg-zinc-900/60 px-1 text-[9px] uppercase tracking-[0.12em] text-zinc-500">
                      +{assistantCount}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-cyan-300/0 transition-colors group-hover/row:text-cyan-300">
                    Restore
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
