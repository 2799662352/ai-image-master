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

      {/*
        单文件和多文件走同一条路径。改造前这里是分叉的:1 个文件摊开成一面
        3500px 的墙,2 个以上反而一条 diff 都不给,只能跳去右侧并排视图 ——
        同一张卡按数量长成两个样子,是它最刺眼的地方。
        现在一律是「每个文件一行,默认收起,想看哪个点哪个」。
      */}
      {/*
        写的时候摊开、写完收起。默认收起是给**读历史**的人省地方的;正在写的
        那一刻恰恰相反 —— 那是这一屏唯一值得盯着看的东西,却要用户手动点开
        才看得见,而等他点开时往往已经写完了。
      */}
      <div className="p-1.5">
        {item.changes.map((change) => (
          <FileDiffBlock
            key={`${change.operation}:${change.path}`}
            change={change}
            defaultExpanded={isRunning}
            followTail={isRunning}
            onOpen={() => void openAiChange(change)}
          />
        ))}
      </div>
    </div>
  )
}
