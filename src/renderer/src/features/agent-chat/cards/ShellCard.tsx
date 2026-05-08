import { useState } from 'react'
import type { ShellItem } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../file-explorer/store'
import { primaryReferenceFromTimelineItem } from '../references/referenceUtils'

export function ShellCard({ item }: { item: ShellItem }) {
  const isRunning = !item.endedAt
  const [expanded, setExpanded] = useState(isRunning)
  const failed = item.exitCode != null && item.exitCode !== 0
  const openReference = useFileExplorerStore((state) => state.openReference)
  const reference = primaryReferenceFromTimelineItem(item)

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={[
          'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition',
          failed
            ? 'border-red-500/40 bg-red-500/10 text-red-300'
            : 'border-zinc-700/60 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300',
        ].join(' ')}
      >
        {isRunning ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border border-zinc-500 border-t-cyan-400" />
        ) : (
          <span>{failed ? '✕' : '⚡'}</span>
        )}
        <code className="max-w-[260px] truncate">{item.command}</code>
        {item.exitCode != null && (
          <span className="ml-auto text-[9px] opacity-70">exit {item.exitCode}</span>
        )}
        <span className="text-[9px]">{expanded ? '▾' : '▸'}</span>
      </button>
      {reference ? (
        <div className="mt-1 flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => void openReference(reference)}
            className="rounded border border-cyan-500/30 px-2 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-500/10"
          >
            Open output
          </button>
        </div>
      ) : null}
      {expanded && (
        <div className="mt-1 max-h-[400px] overflow-y-auto rounded border border-zinc-800/60 bg-zinc-950/50 p-2 font-mono text-[11px] leading-relaxed">
          {item.stdout && <pre className="text-zinc-300 whitespace-pre-wrap">{item.stdout}</pre>}
          {item.stderr && <pre className="text-red-300/80 whitespace-pre-wrap">{item.stderr}</pre>}
          {!item.stdout && !item.stderr && <span className="text-zinc-600 italic">No output</span>}
        </div>
      )}
    </div>
  )
}
