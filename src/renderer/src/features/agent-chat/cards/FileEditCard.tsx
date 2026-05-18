import type { FileChange, FileEditItem } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../file-explorer/store'
import { FileDiffBlock } from './FileDiffBlock'
import { MarkdownDraftCard } from './MarkdownDraftCard'

function isMarkdownPath(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path)
}

function operationLabel(operation: FileChange['operation']): string {
  switch (operation) {
    case 'create':
      return 'Created'
    case 'delete':
      return 'Deleted'
    case 'edit':
      return 'Edited'
  }
}

function markdownContentFromCreateDiff(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++ '))
    .map((line) => line.slice(1))
    .join('\n')
}

export function FileEditCard({ item }: { item: FileEditItem }) {
  const isRunning = !item.endedAt
  const openAiChange = useFileExplorerStore((state) => state.openAiChange)
  const openTab = useFileExplorerStore((state) => state.openTab)

  if (
    item.changes.length === 1 &&
    item.changes[0].operation === 'create' &&
    isMarkdownPath(item.changes[0].path)
  ) {
    const change = item.changes[0]
    return (
      <MarkdownDraftCard
        path={change.path}
        content={markdownContentFromCreateDiff(change.diff)}
        status={isRunning ? 'streaming' : 'created'}
        onOpen={(path) => void openTab(path, 'workspace')}
      />
    )
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-800/80 bg-zinc-950/70">
      <div className="flex items-center gap-2 border-b border-zinc-800/70 px-2.5 py-1.5 text-[11px] text-zinc-300">
        {isRunning && <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-300" />}
        <span className="font-medium text-zinc-100">
          {isRunning ? 'Applying changes...' : `${item.changes.length} file${item.changes.length === 1 ? '' : 's'} changed`}
        </span>
        <span className="ml-auto text-emerald-300">+{item.totalAdded}</span>
        <span className="text-red-300">-{item.totalRemoved}</span>
      </div>

      {item.changes.length > 1 ? (
        <div className="divide-y divide-zinc-800/70">
          {item.changes.map((change) => (
            <button
              key={`${change.operation}:${change.path}`}
              type="button"
              aria-label={`Open diff for ${change.path}`}
              onClick={() => void openAiChange(change)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-zinc-300 transition hover:bg-cyan-500/5"
            >
              <span className="w-14 shrink-0 text-cyan-200/70">{operationLabel(change.operation)}</span>
              <span className="min-w-0 flex-1 truncate font-mono" title={change.path}>
                {change.path}
              </span>
              <span className="text-emerald-300">+{change.added}</span>
              <span className="text-red-300">-{change.removed}</span>
            </button>
          ))}
        </div>
      ) : (
        item.changes.map((change) => (
          <div key={`${change.operation}:${change.path}`} className="p-1.5">
            <button
              type="button"
              aria-label={`Open diff for ${change.path}`}
              onClick={() => void openAiChange(change)}
              className="mb-1 flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11px] text-zinc-300 hover:bg-cyan-500/5"
            >
              <span className="text-cyan-200/70">{operationLabel(change.operation)}</span>
              <span className="min-w-0 flex-1 truncate font-mono" title={change.path}>
                {change.path}
              </span>
              <span className="text-emerald-300">+{change.added}</span>
              <span className="text-red-300">-{change.removed}</span>
            </button>
            <FileDiffBlock change={change} />
          </div>
        ))
      )}
    </div>
  )
}
