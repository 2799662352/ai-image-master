import { memo, useState, useCallback } from 'react'
import type { DonorItemView } from '../../hooks/useHistoryData'
import { useDisplaySrc } from '../../hooks/useDisplaySrc'

interface Props {
  item: DonorItemView
  onDelete: (id: number | string) => void
  onPreview: (item: DonorItemView, urlIndex: number) => void
  /** 重新编辑: 把 item 的 prompt/ratio/refs 回灌到 GeneratePage 表单。
   *  父组件不传也行 — 按钮自动隐藏, 保持向后兼容。 */
  onEdit?: (item: DonorItemView) => void
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

function DonorCardImpl({ item, onDelete, onPreview, onEdit }: Props) {
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
  // 历史卡片缩略图是 HistoryPage 一屏最多的元素 (几十张甚至上百张)。
  // 老条目的 displayUrl 是 data:image/png;base64,... — 同步解码会卡主线程,
  // 用 useDisplaySrc 转成 blob: 让浏览器后台异步解码; http(cos)/blob 透传无开销。
  const primaryImgSrc = useDisplaySrc(primaryUrl)
  const hasImage = !!primaryUrl && !imgError.has(0)
  const isBroken = item.isBroken

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (window.confirm('确认删除这条记录吗? / 削除しますか?')) {
      onDelete(item.id)
    }
  }

  // 任一可恢复字段(prompt / refs / ratio)存在就允许 EDIT。完全空的脏数据才隐藏。
  const canEdit = !!(
    onEdit &&
    (item.prompt ||
      (Array.isArray(item.referenceImages) && item.referenceImages.length > 0) ||
      item.ratio)
  )
  // 路由提示: type 以 batch 开头时按钮上标记 →BATCH, 否则 →GEN
  const editTargetTag =
    typeof item.type === 'string' && item.type.startsWith('batch') ? 'BATCH' : 'GEN'

  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onEdit?.(item)
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
            {item.isVideo ? (
              <>
                <video
                  // 首帧缩略图:metadata 加载后命令式 seek 到 ~0.1s 强制解码绘制首帧。
                  // 与聊天栏 MediaThumbnail 一致 —— 单靠 #t=0.1 媒体片段在部分源下只黑屏。
                  src={primaryUrl}
                  muted
                  playsInline
                  preload="metadata"
                  controls={false}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget
                    try {
                      v.currentTime = Math.min(0.1, (v.duration || 1) * 0.1)
                    } catch {
                      /* seek 失败退化为黑屏占位 */
                    }
                  }}
                  onError={() => setBroken(0)}
                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                />
                {/* 播放角标 */}
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--donor-bg-0)]/70 backdrop-blur-sm">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" className="ml-[1px] text-[color:var(--donor-cyan)]" aria-hidden="true">
                      <path d="M4 2.5v11l9-5.5z" />
                    </svg>
                  </span>
                </span>
              </>
            ) : (
              <img
                src={primaryImgSrc}
                alt={item.prompt || 'history'}
                loading="lazy"
                decoding="async"
                onError={() => setBroken(0)}
                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
              />
            )}
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

        {/* 常驻 EDIT 按钮(右上角)— 解决 hover bar 在某些屏幕 / 触控环境点不到的问题。
            zIndex 拉高确保不被状态角标 / 多图指示器盖住; stopPropagation 防止
            冒泡到 article 的 onClick (那会打开 preview, 不是用户想要的)。 */}
        {canEdit && (
          <button
            type="button"
            onClick={handleEditClick}
            title={`重新编辑 → ${editTargetTag} 页 / Restore params to ${editTargetTag}`}
            className="absolute right-2 top-2 z-10 px-2 py-1 d-mono text-[10px] font-bold tracking-widest uppercase bg-[color:var(--donor-bg-0)]/90 text-[color:var(--donor-yellow)] border border-[color:var(--donor-yellow)]/70 hover:bg-[color:var(--donor-yellow)] hover:text-[color:var(--donor-bg-0)] transition-colors cursor-pointer"
          >
            ↺ {editTargetTag}
          </button>
        )}
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

      {/* ===== Hover 操作栏 (VIEW + DELETE) =====
          注: EDIT 按钮已移到图像区右上角常驻显示, 不再放这里 ——
          因为 hover bar 在触控屏 / 高 DPI 屏 / 慢手势下容易点不到。 */}
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

export default memo(DonorCardImpl)
