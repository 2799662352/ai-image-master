import type { SplitTask } from '../../../../types/storyboardSplit'

interface TaskCardProps {
  task: SplitTask
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onRemove: (id: string) => void
}

const STATUS_LABELS: Record<string, string> = {
  pending: '等待中',
  queued: '排队中',
  uploading: '上传 COS',
  submitted: '提交 MPS',
  processing: '处理中',
  finished: '完成',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'text-zinc-400',
  queued: 'text-blue-400',
  uploading: 'text-blue-400',
  submitted: 'text-blue-400',
  processing: 'text-cyberpunk-yellow',
  finished: 'text-green-400',
  failed: 'text-red-400',
  cancelled: 'text-zinc-500',
}

export function TaskCard({ task, onCancel, onRetry, onRemove }: TaskCardProps) {
  const isActive = ['pending', 'queued', 'uploading', 'submitted', 'processing'].includes(task.status)
  const isDone = task.status === 'finished'
  const isFailed = task.status === 'failed' || task.status === 'cancelled'

  return (
    <div className="bg-zinc-900/70 border border-zinc-700 rounded-lg overflow-hidden">
      <div className="p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-white font-medium truncate max-w-[60%]">{task.filename}</span>
          <span className={`text-xs font-mono ${STATUS_COLORS[task.status]}`}>
            {STATUS_LABELS[task.status]}
          </span>
        </div>

        {isActive && (
          <div className="w-full bg-zinc-800 rounded-full h-1.5 mb-2">
            <div
              className="bg-cyberpunk-yellow h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${task.progress}%` }}
            />
          </div>
        )}

        {task.error && (
          <p className="text-xs text-red-400 mb-2 break-words">
            {task.error}
            {task.errorCode && <span className="text-red-500/60 ml-1">({task.errorCode})</span>}
          </p>
        )}

        {isDone && task.results && task.results.length > 0 && (
          <div className="grid grid-cols-3 gap-1 mb-2">
            {task.results.map((r) => {
              const expired = Date.now() > r.expiresAt
              return (
                <div key={r.index} className="relative aspect-square bg-zinc-800 rounded overflow-hidden">
                  {expired ? (
                    <div className="w-full h-full flex items-center justify-center text-xs text-zinc-500">
                      已过期
                    </div>
                  ) : (
                    <img src={r.url} alt={`子图 ${r.index + 1}`} className="w-full h-full object-cover" loading="lazy" />
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="flex gap-2">
          {isActive && !task.readonly && (
            <button
              onClick={() => onCancel(task.id)}
              className="text-xs px-2 py-1 bg-red-900/30 text-red-400 border border-red-700/50 rounded hover:bg-red-900/50 transition-colors"
            >
              ❌ 取消
            </button>
          )}
          {isFailed && !task.readonly && (
            <button
              onClick={() => onRetry(task.id)}
              className="text-xs px-2 py-1 bg-blue-900/30 text-blue-400 border border-blue-700/50 rounded hover:bg-blue-900/50 transition-colors"
            >
              🔁 重试
            </button>
          )}
          {(isDone || isFailed) && (
            <button
              onClick={() => onRemove(task.id)}
              className="text-xs px-2 py-1 bg-zinc-800 text-zinc-400 border border-zinc-700 rounded hover:bg-zinc-700 transition-colors"
            >
              🗑️ 移除
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
