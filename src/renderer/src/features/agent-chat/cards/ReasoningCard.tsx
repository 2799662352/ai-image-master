import { useState } from 'react'
import type { ReasoningItem } from '../../../../../types/agent-timeline'

export function ReasoningCard({ item }: { item: ReasoningItem }) {
  const isRunning = !item.endedAt
  const [expanded, setExpanded] = useState(isRunning)

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-zinc-700/60 bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-300"
      >
        {isRunning ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border border-zinc-500 border-t-cyan-400" />
        ) : (
          <span className="text-cyan-400/70">💭</span>
        )}
        <span>{isRunning ? 'Thinking…' : 'Thought'}</span>
        <span className="ml-1 text-[9px]">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="mt-1 max-h-[300px] overflow-y-auto rounded border border-zinc-800/60 bg-zinc-950/50 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-zinc-400">
          {item.content || '…'}
        </div>
      )}
    </div>
  )
}
