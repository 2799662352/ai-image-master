import { useState, useMemo } from 'react'
import { useEraseSessionStore } from '../../stores/useEraseSessionStore'
import { useErasePersistStore } from '../../stores/useErasePersistStore'
import { useToastStore } from '../../stores'

/**
 * Renders the currently selected history item's processed video. Defaults to
 * single-pane; when `originalFilePath` is present, a "对比 / COMPARE" toggle
 * shows the local original alongside.
 *
 * The local original is loaded with `file://` — Electron's main process CSP
 * already allows `media-src 'self' data: blob: https:`, but `file://` is
 * served by Electron's protocol handler in renderer context, so a `<video>`
 * pointing at it works without further CSP relaxation. If the file has been
 * moved/deleted since processing, `<video>` fires `onError` and we silently
 * fall back to "原视频不可用".
 */
export function EraseResultPanel() {
  const selectedId = useEraseSessionStore((s) => s.selectedHistoryId)
  const recentlyFinished = useEraseSessionStore((s) => s.recentlyFinished)
  const setSelectedHistoryId = useEraseSessionStore((s) => s.setSelectedHistoryId)
  const history = useErasePersistStore((s) => s.history)
  const removeHistory = useErasePersistStore((s) => s.removeHistory)
  const addToast = useToastStore((s) => s.addToast)

  const [compareOpen, setCompareOpen] = useState(false)
  const [originalErrored, setOriginalErrored] = useState(false)

  // If nothing selected, show the most-recently-finished item if any.
  const itemId = selectedId ?? recentlyFinished
  const item = useMemo(
    () => history.find((h) => h.id === itemId),
    [history, itemId],
  )

  if (!item) return null

  const expired = item.videoExpiresAt > 0 && item.videoExpiresAt < Date.now()
  const canCompare = !!item.originalFilePath && !originalErrored

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(item.videoUrl)
      addToast({ message: 'URL 已复制', type: 'success' })
    } catch {
      addToast({ message: '复制失败', type: 'error' })
    }
  }

  const handleDownload = () => {
    const a = document.createElement('a')
    a.href = item.videoUrl
    a.download = item.filename.replace(/\.[^.]+$/, '') + '_erased.mp4'
    a.target = '_blank'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const handleRemove = () => {
    removeHistory(item.id)
    setSelectedHistoryId(null)
  }

  const ringClass =
    item.id === recentlyFinished
      ? 'ring-2 ring-[color:var(--donor-green)] ring-offset-2 ring-offset-[color:var(--donor-bg-0)]'
      : ''

  return (
    <div className={`d-neon-frame p-4 space-y-3 ${ringClass}`}>
      <div className="flex items-center gap-3 flex-wrap">
        <span className="d-mono text-[12px] tracking-widest text-[color:var(--donor-cyan)]">
          ⊳ {item.filename}
        </span>
        <span className="d-mono text-[10px] tracking-widest text-[color:var(--donor-ink-mute)]">
          {formatDuration(item.durationSeconds)} · {formatBytes(item.fileSize)}
        </span>
        {expired && (
          <span className="d-mono text-[10px] tracking-widest text-[color:var(--donor-red)]">
            // URL 已过期
          </span>
        )}
      </div>

      <div className={`grid gap-3 ${compareOpen && canCompare ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {compareOpen && canCompare && (
          <div className="space-y-1">
            <div className="d-mono text-[10px] tracking-widest text-[color:var(--donor-ink-mute)]">
              // ORIGINAL
            </div>
            <video
              key={`orig-${item.id}`}
              src={`file:///${item.originalFilePath.replace(/\\/g, '/')}`}
              controls
              className="w-full bg-black"
              onError={() => setOriginalErrored(true)}
            />
          </div>
        )}
        <div className="space-y-1">
          {compareOpen && canCompare && (
            <div className="d-mono text-[10px] tracking-widest text-[color:var(--donor-green)]">
              // ERASED
            </div>
          )}
          <video
            key={`out-${item.id}`}
            src={item.videoUrl}
            poster={item.posterDataUrl || undefined}
            controls
            className="w-full bg-black"
          />
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {canCompare && (
          <button
            type="button"
            onClick={() => setCompareOpen((v) => !v)}
            className="d-mono text-[10px] tracking-widest px-3 py-1.5 border border-[color:var(--donor-cyan)] text-[color:var(--donor-cyan)] hover:bg-[color:var(--donor-cyan)]/10"
          >
            {compareOpen ? '[ 关闭对比 ]' : '[ 对比原视频 ]'}
          </button>
        )}
        <button
          type="button"
          onClick={handleDownload}
          disabled={expired}
          className="d-mono text-[10px] tracking-widest px-3 py-1.5 border border-[color:var(--donor-green)] text-[color:var(--donor-green)] hover:bg-[color:var(--donor-green)]/10 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          [ 下载 ]
        </button>
        <button
          type="button"
          onClick={handleCopyUrl}
          disabled={expired}
          className="d-mono text-[10px] tracking-widest px-3 py-1.5 border border-[color:var(--donor-ink)] text-[color:var(--donor-ink)] hover:bg-[color:var(--donor-ink)]/10 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          [ 复制 URL ]
        </button>
        <button
          type="button"
          onClick={handleRemove}
          className="d-mono text-[10px] tracking-widest px-3 py-1.5 border border-[color:var(--donor-red)]/60 text-[color:var(--donor-red)]/80 hover:bg-[color:var(--donor-red)]/10 ml-auto"
        >
          [ 移除历史 ]
        </button>
      </div>
    </div>
  )
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
