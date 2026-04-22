import { useEffect } from 'react'
import type { SplitHistoryItem } from '../../../../types/storyboardSplit'

interface Props {
  open: boolean
  history: SplitHistoryItem[]
  onClose: () => void
  onPreview: (id: string) => void
  onDelete: (id: string) => void
}

export function HistoryDrawer({ open, history, onClose, onPreview, onDelete }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
    <div
      className="fixed inset-0 z-40 bg-black/40"
      onClick={onClose}
    />
    <div className="donor-theme fixed inset-y-0 right-0 w-80 bg-[color:var(--donor-bg-0)] border-l border-[color:var(--donor-magenta)] shadow-2xl z-50 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[color:var(--donor-magenta-dim)]">
        <h3 className="d-mono text-[11px] tracking-widest uppercase">
          <span className="d-neon-text-m">● HISTORY</span>
          <span className="text-[color:var(--donor-ink-mute)] ml-2">// 拆図履歴</span>
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="d-hover-invert px-2 py-0.5 d-mono text-[11px] tracking-widest"
        >
          [ ✕ ]
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {history.length === 0 && (
          <div className="py-12 text-center d-mono text-[11px] text-[color:var(--donor-ink-mute)] tracking-widest">
            NO_RECORDS // 履歴なし
          </div>
        )}
        {history.map((item) => {
          const allExpired = item.results.every((r) => Date.now() > r.expiresAt)
          const ts = formatRelativeTime(item.finishedAt)
          const primaryUrl = item.results[0]?.url

          return (
            <div
              key={item.id}
              className="d-neon-frame p-2.5 space-y-2 cursor-pointer hover:border-[color:var(--donor-cyan)] transition-colors"
              onClick={() => !allExpired && onPreview(item.id)}
            >
              <div className="flex gap-2">
                {item.thumbnailDataUrl ? (
                  <img
                    src={item.thumbnailDataUrl}
                    alt=""
                    className={`w-10 h-10 object-cover ${allExpired ? 'opacity-30 grayscale' : ''}`}
                  />
                ) : primaryUrl && !allExpired ? (
                  <img
                    src={primaryUrl}
                    alt=""
                    className="w-10 h-10 object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-10 h-10 bg-[color:var(--donor-bg-1)] flex items-center justify-center d-mono text-[10px] text-[color:var(--donor-ink-mute)]">?</div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="d-mono text-[11px] text-[color:var(--donor-ink)] truncate">{item.filename}</p>
                  <p className="d-mono text-[10px] text-[color:var(--donor-ink-mute)]">
                    {item.results.length} 子図 · {ts}
                  </p>
                  {allExpired && (
                    <p className="d-mono text-[10px] text-[color:var(--donor-red)] tracking-widest">// EXPIRED</p>
                  )}
                </div>
              </div>
              <div className="flex gap-1.5">
                {!allExpired && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onPreview(item.id) }}
                    className="d-mono text-[10px] px-2 py-0.5 text-[color:var(--donor-cyan)] border border-[color:var(--donor-cyan-dim)] hover:bg-[color:var(--donor-cyan)] hover:text-[color:var(--donor-bg-0)] transition-colors"
                  >
                    VIEW
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (window.confirm('確認削除?')) onDelete(item.id)
                  }}
                  className="d-mono text-[10px] px-2 py-0.5 text-[color:var(--donor-red)] border border-[color:var(--donor-red)]/30 hover:bg-[color:var(--donor-red)] hover:text-[color:var(--donor-bg-0)] transition-colors"
                >
                  DELETE
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <footer className="px-4 py-2 border-t border-[color:var(--donor-magenta-dim)] d-mono text-[10px] text-[color:var(--donor-ink-mute)] flex justify-between">
        <span>// SPLIT_ARCHIVE</span>
        <span className="d-neon-text-c">[ {history.length.toString().padStart(3, '0')} ]</span>
      </footer>
    </div>
    </>
  )
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}時間前`
  const days = Math.floor(hours / 24)
  return `${days}日前`
}
