import { useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { DonorItemView } from '../../hooks/useHistoryData'

interface Props {
  item: DonorItemView
  startIndex: number
  onClose: () => void
}

export default function DonorPreview({ item, startIndex, onClose }: Props) {
  const [idx, setIdx] = useState(startIndex)
  const urls = item.displayUrls
  const total = urls.length

  const next = useCallback(() => setIdx((i) => (i + 1) % total), [total])
  const prev = useCallback(() => setIdx((i) => (i - 1 + total) % total), [total])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, next, prev])

  const url = urls[idx]

  const copyPrompt = async () => {
    if (item.prompt) {
      try {
        await navigator.clipboard.writeText(item.prompt)
      } catch {
        /* noop */
      }
    }
  }

  const handleSave = () => {
    if (!url) return
    const shortId = String(item.id).slice(-6).toLowerCase()
    const filename = `donor-${shortId}-${idx + 1}.png`
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

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
            <span className="text-[color:var(--donor-ink-dim)]">#{String(item.id).slice(-6).toUpperCase()}</span>
            {total > 1 && (
              <span className="d-hud-digit">
                {(idx + 1).toString().padStart(2, '0')}/{total.toString().padStart(2, '0')}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="d-hover-invert px-3 py-1 text-[11px] tracking-widest uppercase"
          >
            [ ESC ]
          </button>
        </div>

        {/* 图片区 */}
        <div className="relative bg-[color:var(--donor-bg-0)] flex items-center justify-center p-4" style={{ minHeight: '40vh' }}>
          {url ? (
            <img src={url} alt={item.prompt || 'preview'} className="max-w-full max-h-[65vh] object-contain" />
          ) : (
            <div className="py-20 text-center text-[color:var(--donor-red)] d-mono">NO_DATA</div>
          )}
          {total > 1 && (
            <>
              <button
                type="button"
                onClick={prev}
                className="absolute left-2 top-1/2 -translate-y-1/2 d-hover-invert-cyan px-3 py-2 d-mono text-[14px]"
                aria-label="Previous"
              >
                ◀
              </button>
              <button
                type="button"
                onClick={next}
                className="absolute right-2 top-1/2 -translate-y-1/2 d-hover-invert-cyan px-3 py-2 d-mono text-[14px]"
                aria-label="Next"
              >
                ▶
              </button>
            </>
          )}
        </div>

        {/* 信息+操作 */}
        <div className="px-4 py-3 border-t border-[color:var(--donor-magenta-dim)] bg-[color:var(--donor-bg-1)]/70">
          <div className="d-mono text-[10px] text-[color:var(--donor-cyan)] mb-2 tracking-widest">
            PROMPT // プロンプト
          </div>
          <p
            className="text-[13px] leading-[1.6] text-[color:var(--donor-ink)] max-h-[12vh] overflow-y-auto"
            style={{ fontFamily: 'var(--donor-font-jp)' }}
          >
            {item.prompt || <span className="italic text-[color:var(--donor-ink-mute)]">(empty)</span>}
          </p>
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            {item.model && (
              <span className="d-mono text-[10px] px-2 py-0.5 border border-[color:var(--donor-cyan-dim)] text-[color:var(--donor-cyan)]">
                {item.model}
              </span>
            )}
            {item.ratio && (
              <span className="d-mono text-[10px] px-2 py-0.5 border border-[color:var(--donor-ink-mute)]/40 text-[color:var(--donor-ink-dim)]">
                {item.ratio}
              </span>
            )}
            <button
              type="button"
              onClick={copyPrompt}
              className="ml-auto d-hover-invert-cyan px-3 py-1 d-mono text-[11px] tracking-widest uppercase"
            >
              [ COPY.PROMPT ]
            </button>
            {url && (
              <button
                type="button"
                onClick={handleSave}
                className="d-hover-invert px-3 py-1 d-mono text-[11px] tracking-widest uppercase"
              >
                [ SAVE.IMG ]
              </button>
            )}
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
      </div>
    </div>,
    document.body
  )
}
