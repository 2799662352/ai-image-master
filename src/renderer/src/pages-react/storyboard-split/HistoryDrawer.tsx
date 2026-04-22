import type { SplitHistoryItem, SplitTask } from '../../../../types/storyboardSplit'

interface HistoryDrawerProps {
  open: boolean
  history: SplitHistoryItem[]
  onClose: () => void
  onReopen: (task: SplitTask) => void
  onDelete: (id: string) => void
}

export function HistoryDrawer({ open, history, onClose, onReopen, onDelete }: HistoryDrawerProps) {
  if (!open) return null

  const handleReopen = (item: SplitHistoryItem) => {
    const task: SplitTask = {
      id: item.id,
      filename: item.filename,
      imageDataUrl: '',
      status: 'finished',
      progress: 100,
      stage: 'done',
      config: item.config,
      results: item.results,
      createdAt: item.createdAt,
      finishedAt: item.finishedAt,
      readonly: true,
    }
    onReopen(task)
  }

  return (
    <div className="fixed inset-y-0 right-0 w-80 bg-zinc-900 border-l border-zinc-700 shadow-2xl z-50 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
        <h3 className="text-sm font-bold text-white uppercase tracking-tight">📜 拆图历史</h3>
        <button onClick={onClose} className="text-zinc-500 hover:text-white text-lg">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {history.length === 0 && (
          <p className="text-xs text-zinc-500 text-center py-8">暂无历史记录</p>
        )}
        {history.map((item) => {
          const allExpired = item.results.every((r) => Date.now() > r.expiresAt)
          const relativeTime = formatRelativeTime(item.finishedAt)

          return (
            <div key={item.id} className="bg-zinc-800/50 rounded-lg p-2.5 space-y-2">
              <div className="flex gap-2">
                {item.thumbnailDataUrl ? (
                  <img
                    src={item.thumbnailDataUrl}
                    alt=""
                    className={`w-10 h-10 rounded object-cover ${allExpired ? 'opacity-30 grayscale' : ''}`}
                  />
                ) : (
                  <div className="w-10 h-10 rounded bg-zinc-700 flex items-center justify-center text-xs text-zinc-500">?</div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-white truncate">{item.filename}</p>
                  <p className="text-xs text-zinc-500">{item.results.length} 张 · {relativeTime}</p>
                  {allExpired && <p className="text-xs text-red-500/70">链接已过期</p>}
                </div>
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={() => handleReopen(item)}
                  className="text-xs px-2 py-0.5 bg-zinc-700 text-zinc-300 rounded hover:bg-zinc-600 transition-colors"
                >
                  打开
                </button>
                <button
                  onClick={() => onDelete(item.id)}
                  className="text-xs px-2 py-0.5 bg-zinc-700 text-zinc-400 rounded hover:bg-red-900/50 hover:text-red-400 transition-colors"
                >
                  删除
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}
