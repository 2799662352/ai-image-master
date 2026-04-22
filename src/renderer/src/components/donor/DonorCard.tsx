import { useState, useCallback } from 'react'
import type { DonorItemView } from '../../hooks/useHistoryData'

interface Props {
  item: DonorItemView
  onDelete: (id: number | string) => void
  onPreview: (item: DonorItemView, urlIndex: number) => void
}

const STATUS_META: Record<
  DonorItemView['status'],
  { label: string; labelJp: string; className: string; icon: string }
> = {
  'ok-cloud': { label: 'CLOUD', labelJp: '雲', className: 'd-status-tag--ok', icon: '◆' },
  'ok-local': { label: 'LOCAL', labelJp: '本地', className: 'd-status-tag--local', icon: '◇' },
  uploading: { label: 'UPLOADING', labelJp: '送信中', className: 'd-status-tag--pending', icon: '◐' },
  failed: { label: 'FAILED', labelJp: '失敗', className: 'd-status-tag--fail', icon: '✕' },
}

export default function DonorCard({ item, onDelete, onPreview }: Props) {
  const [imgError, setImgError] = useState<Set<number>>(new Set())
  const meta = STATUS_META[item.status]

  const setBroken = useCallback((idx: number) => {
    setImgError((prev) => {
      const next = new Set(prev)
      next.add(idx)
      return next
    })
  }, [])

  const timestamp = item.timestamp ? new Date(item.timestamp) : null
  const ts = timestamp
    ? timestamp.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    : '---'

  const urls = item.displayUrls
  const primaryUrl = urls[0]
  const hasImage = !!primaryUrl && !imgError.has(0)
  const isBroken = item.isBroken

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (window.confirm('确认删除这条记录吗? / 削除しますか?')) {
      onDelete(item.id)
    }
  }

  return (
    <article
      className="d-neon-frame d-clip-corner-tl group relative flex flex-col cursor-pointer transition-transform duration-150 hover:-translate-y-[2px]"
      onClick={() => hasImage && onPreview(item, 0)}
    >
      {/* ===== 图像区 (或占位) ===== */}
      <div className="relative aspect-[4/3] overflow-hidden bg-[color:var(--donor-bg-1)]">
        {hasImage ? (
          <>
            <img
              src={primaryUrl}
              alt={item.prompt || 'history'}
              loading="lazy"
              onError={() => setBroken(0)}
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
            />
            {/* 多图指示器 */}
            {urls.length > 1 && (
              <div className="absolute top-2 right-2 d-mono text-[10px] px-2 py-0.5 bg-[color:var(--donor-bg-0)]/80 text-[color:var(--donor-cyan)] border border-[color:var(--donor-cyan)]">
                ×{urls.length}
              </div>
            )}
            {/* 上传中扫描光带 */}
            {item.status === 'uploading' && <div className="absolute inset-0 d-scan-bar pointer-events-none" />}
          </>
        ) : (
          /* 失败/损坏占位 */
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 relative">
            <div
              className="absolute inset-0 opacity-30"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(45deg, transparent 0 10px, rgba(255,45,74,0.2) 10px 12px)',
              }}
            />
            <div className="relative text-center">
              <div className="d-mono text-[42px] text-[color:var(--donor-red)] leading-none d-glitch">✕</div>
              <div className="mt-2 d-mono text-[11px] tracking-widest text-[color:var(--donor-red)]">
                NO_IMAGE_DATA
              </div>
              <div className="mt-0.5 d-mono text-[10px] text-[color:var(--donor-ink-mute)]">
                404 // 画像なし
              </div>
            </div>
          </div>
        )}

        {/* 状态角标 */}
        <div className={`absolute left-2 top-2 d-status-tag ${meta.className}`}>
          <span>{meta.icon}</span>
          <span>{meta.labelJp}</span>
          <em className="opacity-80">/{meta.label}</em>
        </div>
      </div>

      {/* ===== 信息区 ===== */}
      <div className="p-3 border-t border-[color:var(--donor-magenta-dim)] flex-1 flex flex-col gap-2 bg-[color:var(--donor-bg-1)]/60">
        {/* ID + 时间 */}
        <div className="flex items-center justify-between d-mono text-[10px] text-[color:var(--donor-ink-mute)]">
          <span>#{String(item.id).slice(-6).toUpperCase()}</span>
          <span>{ts}</span>
        </div>

        {/* Prompt */}
        <p
          className="text-[12px] leading-[1.5] text-[color:var(--donor-ink)] line-clamp-3"
          style={{ fontFamily: 'var(--donor-font-jp)' }}
          title={item.prompt}
        >
          {item.prompt || <span className="italic text-[color:var(--donor-ink-mute)]">(無し / empty prompt)</span>}
        </p>

        {/* 模型标签 */}
        <div className="flex items-center gap-2 flex-wrap">
          {item.model && (
            <span className="d-mono text-[10px] px-2 py-0.5 bg-transparent border border-[color:var(--donor-cyan-dim)] text-[color:var(--donor-cyan)]">
              {item.model}
            </span>
          )}
          {item.ratio && (
            <span className="d-mono text-[10px] px-2 py-0.5 text-[color:var(--donor-ink-dim)] border border-[color:var(--donor-ink-mute)]/40">
              {item.ratio}
            </span>
          )}
          {isBroken && item.status === 'failed' && (
            <span className="d-mono text-[10px] text-[color:var(--donor-red)] tracking-widest">// RETRY?</span>
          )}
        </div>
      </div>

      {/* ===== Hover 操作栏 ===== */}
      <div className="absolute inset-x-0 bottom-0 translate-y-full group-hover:translate-y-0 transition-transform duration-150 flex border-t border-[color:var(--donor-magenta)] bg-[color:var(--donor-bg-0)]/95">
        {hasImage && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onPreview(item, 0)
            }}
            className="flex-1 py-2 d-mono text-[11px] tracking-widest uppercase text-[color:var(--donor-cyan)] hover:bg-[color:var(--donor-cyan)] hover:text-[color:var(--donor-bg-0)] transition-colors cursor-pointer"
          >
            [ VIEW ]
          </button>
        )}
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
