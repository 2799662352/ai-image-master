import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { SplitHistoryItem } from '../../../../types/storyboardSplit'
import { useSplitSessionStore } from '../../stores'
import { useDisplaySrc } from '../../hooks/useDisplaySrc'
import { zipDownload } from './utils/zipDownload'

/**
 * 单格图 —— 把 `<img>` 抽出来让 useDisplaySrc 能在 .map() 里安全使用。
 * Storyboard 切片结果常是 dataURL, 走 blob: 异步解码避免卡。
 */
function SplitImage({
  src,
  alt,
  className,
}: {
  src: string
  alt: string
  className: string
}) {
  const imgSrc = useDisplaySrc(src)
  return <img src={imgSrc} alt={alt} className={className} loading="lazy" decoding="async" />
}

const GRID_PREVIEW_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
  5: 'grid-cols-5',
  6: 'grid-cols-6',
  7: 'grid-cols-7',
  8: 'grid-cols-8',
  9: 'grid-cols-9',
  10: 'grid-cols-10',
  11: 'grid-cols-11',
  12: 'grid-cols-12',
}

interface Props {
  item: SplitHistoryItem
  onClose: () => void
}

export default function SplitPreview({ item, onClose }: Props) {
  const mode = useSplitSessionStore((s) => s.previewMode)
  const idx = useSplitSessionStore((s) => s.previewIndex)
  const setMode = useSplitSessionStore((s) => s.setPreviewMode)
  const setIdx = useSplitSessionStore((s) => s.setPreviewIndex)

  const urls = item.results.map((r) => r.url)
  const total = urls.length

  const next = useCallback(() => setIdx((idx + 1) % total), [idx, total, setIdx])
  const prev = useCallback(() => setIdx((idx - 1 + total) % total), [idx, total, setIdx])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && mode === 'single') next()
      else if (e.key === 'ArrowLeft' && mode === 'single') prev()
      else if (e.key.toLowerCase() === 'g') setMode(mode === 'single' ? 'grid' : 'single')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, next, prev, mode, setMode])

  const url = urls[idx]

  const handleSaveImg = async () => {
    if (!url) return
    const filename = `${item.filename}-${idx + 1}.jpg`
    try {
      const res = await fetch(url, { mode: 'cors' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const objUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objUrl
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
    } catch {
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.target = '_blank'
      a.rel = 'noreferrer'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
  }

  const handleSaveZip = () => {
    zipDownload(urls, item.filename)
  }

  const gridCols = item.cols || Math.ceil(Math.sqrt(total))

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        backgroundColor: 'rgba(10, 5, 16, 0.92)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        className="donor-theme d-neon-frame d-clip-corner-br relative max-w-[92vw] max-h-[92vh] w-full md:w-auto flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[color:var(--donor-magenta-dim)] d-mono text-[11px]">
          <div className="flex items-center gap-3">
            <span className="d-neon-text-c">● PREVIEW</span>
            <span className="text-[color:var(--donor-ink-dim)]">#{item.id.slice(-6).toUpperCase()}</span>
            {mode === 'single' && total > 1 && (
              <span className="d-hud-digit">
                {(idx + 1).toString().padStart(2, '0')}/{total.toString().padStart(2, '0')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode('single')}
              className={`px-2 py-0.5 tracking-widest uppercase ${mode === 'single' ? 'text-[color:var(--donor-cyan)] border border-[color:var(--donor-cyan)]' : 'text-[color:var(--donor-ink-mute)] d-hover-invert-cyan'}`}
            >
              SINGLE
            </button>
            <button
              type="button"
              onClick={() => setMode('grid')}
              className={`px-2 py-0.5 tracking-widest uppercase ${mode === 'grid' ? 'text-[color:var(--donor-cyan)] border border-[color:var(--donor-cyan)]' : 'text-[color:var(--donor-ink-mute)] d-hover-invert-cyan'}`}
            >
              GRID
            </button>
            <button
              type="button"
              onClick={onClose}
              className="d-hover-invert px-3 py-1 tracking-widest uppercase"
            >
              [ ESC ]
            </button>
          </div>
        </div>

        {/* 图片区 */}
        {mode === 'single' ? (
          <div className="relative bg-[color:var(--donor-bg-0)] flex items-center justify-center p-4" style={{ minHeight: '40vh' }}>
            {url ? (
              <SplitImage src={url} alt={`${item.filename} #${idx + 1}`} className="max-w-full max-h-[65vh] object-contain" />
            ) : (
              <div className="py-20 text-center text-[color:var(--donor-red)] d-mono">NO_DATA</div>
            )}
            {total > 1 && (
              <>
                <button
                  type="button"
                  onClick={prev}
                  className="absolute left-2 top-1/2 -translate-y-1/2 d-hover-invert-cyan px-3 py-2 d-mono text-[14px]"
                >
                  ◀
                </button>
                <button
                  type="button"
                  onClick={next}
                  className="absolute right-2 top-1/2 -translate-y-1/2 d-hover-invert-cyan px-3 py-2 d-mono text-[14px]"
                >
                  ▶
                </button>
              </>
            )}
          </div>
        ) : (
          <div
            className={`bg-[color:var(--donor-bg-0)] p-4 grid ${GRID_PREVIEW_COLS[gridCols] || ''} gap-2 max-h-[70vh] overflow-y-auto`}
            style={GRID_PREVIEW_COLS[gridCols] ? undefined : { gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}
          >
            {urls.map((u, i) => (
              <button
                key={i}
                type="button"
                onClick={() => { setIdx(i); setMode('single') }}
                className="aspect-square overflow-hidden bg-[color:var(--donor-bg-1)] border border-transparent hover:border-[color:var(--donor-cyan)] transition-colors"
              >
                <SplitImage src={u} alt={`#${i + 1}`} className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        )}

        {/* 缩略图轨道 (SINGLE 模式) */}
        {mode === 'single' && total > 1 && (
          <div className="flex gap-1 px-4 py-2 overflow-x-auto bg-[color:var(--donor-bg-1)]/50 border-t border-[color:var(--donor-magenta-dim)]">
            {urls.map((u, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIdx(i)}
                className={`flex-shrink-0 w-12 h-12 overflow-hidden border-2 transition-colors ${i === idx ? 'border-[color:var(--donor-cyan)]' : 'border-transparent hover:border-[color:var(--donor-magenta-dim)]'}`}
              >
                <SplitImage src={u} alt={`thumb ${i + 1}`} className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        )}

        {/* 操作区 */}
        <div className="px-4 py-3 border-t border-[color:var(--donor-magenta-dim)] bg-[color:var(--donor-bg-1)]/70 flex items-center gap-2 flex-wrap">
          <span className="d-mono text-[10px] text-[color:var(--donor-ink-mute)] mr-auto">
            {item.filename} · {total} 子图
          </span>
          {url && mode === 'single' && (
            <button
              type="button"
              onClick={handleSaveImg}
              className="d-hover-invert px-3 py-1 d-mono text-[11px] tracking-widest uppercase"
            >
              [ SAVE.IMG ]
            </button>
          )}
          <button
            type="button"
            onClick={handleSaveZip}
            className="d-hover-invert-cyan px-3 py-1 d-mono text-[11px] tracking-widest uppercase"
          >
            [ SAVE.ZIP ]
          </button>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="d-hover-invert px-3 py-1 d-mono text-[11px] tracking-widest uppercase no-underline"
            >
              [ OPEN.URL ]
            </a>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
