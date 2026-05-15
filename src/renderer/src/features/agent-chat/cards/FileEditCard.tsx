import { useState } from 'react'
import type { FileEditItem } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../file-explorer/store'
import { referencesFromTimelineItem } from '../references/referenceUtils'
import { FileDiffBlock } from './FileDiffBlock'

export function FileEditCard({ item }: { item: FileEditItem }) {
  const isRunning = !item.endedAt
  const [expanded, setExpanded] = useState(false)
  const openReference = useFileExplorerStore((state) => state.openReference)
  const references = referencesFromTimelineItem(item)

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
      {references.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {references.map((reference) => (
            <button
              key={reference.id}
              type="button"
              onClick={() => void openReference(reference)}
              className="rounded border border-cyan-500/30 px-2 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-500/10"
            >
              Open diff
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
