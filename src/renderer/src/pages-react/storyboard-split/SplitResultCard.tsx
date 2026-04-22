import { useState, useCallback } from 'react'
import type { SplitHistoryItem } from '../../../../types/storyboardSplit'
import { zipDownload } from './utils/zipDownload'

interface Props {
  item: SplitHistoryItem
  isHighlighted: boolean
  onPreview: (id: string) => void
  onDelete: (id: string) => void
}

export default function SplitResultCard({ item, isHighlighted, onPreview, onDelete }: Props) {
  const [imgError, setImgError] = useState(false)
  const [zipping, setZipping] = useState(false)

  const primaryUrl = item.results[0]?.url
  const hasImage = !!primaryUrl && !imgError
  const count = item.results.length

  const ts = new Date(item.finishedAt).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (window.confirm('确认删除? / 削除しますか?')) {
      onDelete(item.id)
    }
  }, [item.id, onDelete])

  const handleZip = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    setZipping(true)
    try {
      await zipDownload(item.results.map((r) => r.url), item.filename)
    } finally {
      setZipping(false)
    }
  }, [item])

  return (
    <article
      className={`d-neon-frame d-clip-corner-tl group relative flex flex-col cursor-pointer overflow-hidden transition-all duration-300 hover:-translate-y-[2px] ${isHighlighted ? 'ring-2 ring-[color:var(--donor-cyan)] animate-pulse' : ''}`}
      onClick={() => hasImage && onPreview(item.id)}
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-[color:var(--donor-bg-1)]">
        {hasImage ? (
          <>
            <img
              src={primaryUrl}
              alt={item.filename}
              loading="lazy"
              onError={() => setImgError(true)}
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
            />
            {count > 1 && (
              <div className="absolute top-2 right-2 d-mono text-[10px] px-2 py-0.5 bg-[color:var(--donor-bg-0)]/80 text-[color:var(--donor-cyan)] border border-[color:var(--donor-cyan)]">
                ×{count}
              </div>
            )}
          </>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 relative">
            <div
              className="absolute inset-0 opacity-30"
              style={{
                backgroundImage: 'repeating-linear-gradient(45deg, transparent 0 10px, rgba(255,45,74,0.2) 10px 12px)',
              }}
            />
            <div className="relative text-center">
              <div className="d-mono text-[42px] text-[color:var(--donor-red)] leading-none">✕</div>
              <div className="mt-2 d-mono text-[11px] tracking-widest text-[color:var(--donor-red)]">NO_IMAGE_DATA</div>
            </div>
          </div>
        )}

        <div className="absolute left-2 top-2 d-status-tag d-status-tag--ok">
          <span>◆</span>
          <span>完了</span>
          <em className="opacity-80">/DONE</em>
        </div>
      </div>

      <div className="p-3 border-t border-[color:var(--donor-magenta-dim)] flex-1 flex flex-col gap-2 bg-[color:var(--donor-bg-1)]/60">
        <div className="flex items-center justify-between d-mono text-[10px] text-[color:var(--donor-ink-mute)]">
          <span>#{item.id.slice(-6).toUpperCase()}</span>
          <span>{ts}</span>
        </div>
        <p className="text-[12px] leading-[1.5] text-[color:var(--donor-ink)] line-clamp-2 d-mono">
          {item.filename}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="d-mono text-[10px] px-2 py-0.5 border border-[color:var(--donor-cyan-dim)] text-[color:var(--donor-cyan)]">
            {count} 子図
          </span>
          {item.rows && item.cols && (
            <span className="d-mono text-[10px] px-2 py-0.5 text-[color:var(--donor-ink-dim)] border border-[color:var(--donor-ink-mute)]/40">
              {item.rows}×{item.cols}
            </span>
          )}
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 translate-y-full group-hover:translate-y-0 transition-transform duration-150 flex border-t border-[color:var(--donor-magenta)] bg-[color:var(--donor-bg-0)]/95">
        {hasImage && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onPreview(item.id) }}
            className="flex-1 py-2 d-mono text-[11px] tracking-widest uppercase text-[color:var(--donor-cyan)] hover:bg-[color:var(--donor-cyan)] hover:text-[color:var(--donor-bg-0)] transition-colors cursor-pointer"
          >
            [ VIEW ]
          </button>
        )}
        <button
          type="button"
          onClick={handleZip}
          disabled={zipping}
          className="flex-1 py-2 d-mono text-[11px] tracking-widest uppercase text-[color:var(--donor-magenta)] hover:bg-[color:var(--donor-magenta)] hover:text-[color:var(--donor-bg-0)] transition-colors cursor-pointer disabled:opacity-50"
        >
          {zipping ? '[ ZIPPING... ]' : '[ SAVE.ZIP ]'}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          className="flex-1 py-2 d-mono text-[11px] tracking-widest uppercase text-[color:var(--donor-red)] hover:bg-[color:var(--donor-red)] hover:text-[color:var(--donor-bg-0)] transition-colors cursor-pointer"
        >
          [ DELETE ]
        </button>
      </div>
    </article>
  )
}
