import type { FileTab } from './types'
import { DiffMergeView } from './DiffMergeView'

function operationLabel(operation: string): string {
  switch (operation) {
    case 'create':
      return 'Created'
    case 'delete':
      return 'Deleted'
    default:
      return 'Edited'
  }
}

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'text-cyan-300/60'
  if (line.startsWith('+')) return 'bg-emerald-500/10 text-emerald-200'
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-200'
  return 'text-zinc-400'
}

export function AiChangeViewer({ tab }: { tab: FileTab }) {
  const meta = tab.aiChange
  if (!meta) return null

  const { change } = meta
  const canSplit = meta.beforeContent != null && meta.afterContent != null

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex shrink-0 items-center gap-2 border-b border-cyan-500/10 px-3 py-2 text-[11px] text-zinc-300">
        <span className="rounded border border-cyan-400/20 bg-cyan-500/10 px-1.5 py-0.5 text-cyan-100">
          {operationLabel(change.operation)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono" title={change.path}>
          {change.path}
        </span>
        <span className="text-emerald-300">+{change.added}</span>
        <span className="text-red-300">-{change.removed}</span>
      </div>

      <div className="min-h-0 flex-1">
        {canSplit ? (
          <DiffMergeView disk={meta.beforeContent ?? ''} mine={meta.afterContent ?? ''} />
        ) : (
          <div className="h-full overflow-auto p-3">
            {meta.parseError && (
              <div className="mb-2 rounded border border-amber-400/20 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-100">
                Could not reconstruct split diff: {meta.parseError}. Showing unified diff.
              </div>
            )}
            <pre className="m-0 overflow-x-auto rounded border border-zinc-800/70 bg-zinc-950/80 p-2 font-mono text-[11px] leading-[1.55]">
              {change.diff.split('\n').map((line, index) => (
                <div key={index} className={lineClass(line)}>
                  {line || ' '}
                </div>
              ))}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
