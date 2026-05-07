import { useState } from 'react'
import type { FileEditItem } from '../../../../../types/agent-timeline'
import { FileDiffBlock } from './FileDiffBlock'

export function FileEditCard({ item }: { item: FileEditItem }) {
  const isRunning = !item.endedAt
  const [expanded, setExpanded] = useState(false)

  const summary =
    item.changes.length === 1
      ? `📝 ${item.changes[0].path} +${item.totalAdded} −${item.totalRemoved}`
      : `📝 ${item.changes.length} files changed +${item.totalAdded} −${item.totalRemoved}`

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-zinc-700/60 bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-600"
      >
        {isRunning ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border border-zinc-500 border-t-cyan-400" />
        ) : null}
        <span>{isRunning ? '📝 applying patch…' : summary}</span>
        <span className="ml-1 text-[9px]">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="mt-1 rounded border border-zinc-800/50 bg-zinc-950/40 p-1">
          {item.changes.map((change) => (
            <FileDiffBlock key={change.path} change={change} />
          ))}
        </div>
      )}
    </div>
  )
}
