import type { EraseHistoryItem } from '../../../../types/smartErase'
import { useEraseSessionStore } from '../../stores/useEraseSessionStore'

export function EraseResultCard({
  item,
  highlight,
}: {
  item: EraseHistoryItem
  highlight?: boolean
}) {
  const setModalItemId = useEraseSessionStore((s) => s.setModalItemId)

  const expired = item.videoExpiresAt > 0 && item.videoExpiresAt < Date.now()
  const expiryMs = item.videoExpiresAt - Date.now()
  const expiryBadge = expired
    ? { text: '已过期', color: 'var(--donor-red)' }
    : expiryMs < 24 * 60 * 60 * 1000
      ? { text: `${Math.ceil(expiryMs / 3_600_000)}h`, color: 'var(--donor-yellow)' }
      : { text: `${Math.ceil(expiryMs / 86_400_000)}d`, color: 'var(--donor-ink-mute)' }

  const ts = item.finishedAt ?? item.createdAt
  const dateStr = new Date(ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
  const timeStr = new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

  return (
    <button
      type="button"
      onClick={() => setModalItemId(item.id)}
      aria-label={`查看 ${item.filename} 处理结果`}
      className={`
        w-[180px] h-[160px] flex-shrink-0 flex flex-col
        border border-[color:var(--donor-ink-mute)]/40 cursor-pointer
        hover:ring-1 hover:ring-[color:var(--donor-cyan)]
        transition-shadow duration-200
        ${highlight ? 'ring-2 ring-[color:var(--donor-green)] ring-offset-2 ring-offset-[color:var(--donor-bg-0)]' : ''}
      `}
    >
      <div className="flex items-center justify-between px-2 py-1">
        <span className="d-mono text-[9px] tracking-widest px-1.5 py-0.5 border border-[color:var(--donor-green)]/60 text-[color:var(--donor-green)]">
          DONE
        </span>
        <span
          className="d-mono text-[9px] tracking-widest px-1.5 py-0.5 border"
          style={{ borderColor: expiryBadge.color, color: expiryBadge.color }}
        >
          {expiryBadge.text}
        </span>
      </div>

      <div className="flex-1 bg-black overflow-hidden">
        {item.posterDataUrl ? (
          <img src={item.posterDataUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="d-mono text-[color:var(--donor-ink-mute)] text-lg">▶</span>
          </div>
        )}
      </div>

      <div className="px-2 py-1 space-y-0.5">
        <div className="d-mono text-[11px] truncate text-[color:var(--donor-ink)] text-left">
          {item.filename}
        </div>
        <div className="d-mono text-[10px] text-[color:var(--donor-ink-mute)] text-left truncate">
          {dateStr} {timeStr}
          ·{formatDuration(item.durationSeconds)}
          ·{formatBytes(item.fileSize)}
          {item.mpsTaskId ? `·#${item.mpsTaskId.slice(-6)}` : ''}
        </div>
      </div>
    </button>
  )
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`
}
