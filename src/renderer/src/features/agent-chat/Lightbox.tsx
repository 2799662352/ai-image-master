import { useEffect, useCallback } from 'react'
import { classifyMediaKind } from '../../components/shared/media/MediaThumbnail'
import { useResolvedMediaSrc } from '../../components/shared/media/useResolvedMediaSrc'
import { toRenderableUri } from '../file-explorer/uri'
import { useAgentChatStore } from './store'

export function Lightbox() {
  const preview = useAgentChatStore((s) => s.preview)
  const closePreview = useAgentChatStore((s) => s.closePreview)
  const nextPreview = useAgentChatStore((s) => s.nextPreview)
  const prevPreview = useAgentChatStore((s) => s.prevPreview)

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!preview.open) return
      // 视频聚焦时,把方向键留给视频自身的 seek/音量控制 —— 否则会出现
      // "ArrowLeft 同时倒退 5s + 切到上一张" 的双触发。Escape 仍由我们处理。
      const target = e.target as HTMLElement | null
      const targetIsVideo = target?.tagName === 'VIDEO'
      switch (e.key) {
        case 'Escape':
          closePreview()
          break
        case 'ArrowLeft':
          if (!targetIsVideo) prevPreview()
          break
        case 'ArrowRight':
          if (!targetIsVideo) nextPreview()
          break
      }
    },
    [preview.open, closePreview, nextPreview, prevPreview],
  )

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  // hook 必须 unconditional 在所有 early-return 之前 —— 用 ?? '' 让 hook 接受
  // 空 src 时优雅返回 null;empty/closed preview 走下面的 early return 不渲染。
  const currentMaybe = preview.images[preview.index]
  const currentUri = currentMaybe?.uri ?? ''
  const rawSrc = currentUri.length > 0 ? toRenderableUri(currentUri) : ''
  const kindHint = (() => {
    if (!currentMaybe) return 'auto' as const
    const k = classifyMediaKind({
      kind: currentMaybe.kind,
      mime: currentMaybe.mime,
      name: currentMaybe.name,
    })
    return k ?? 'auto'
  })()
  // Same hook as MediaThumbnail — resolves local-file:// to a blob URL via
  // dedicated IPC (attachments:read-thumb), passes through everything else.
  // Without this the renderer fires GETs with the Windows drive letter
  // stripped (electron/electron#49073) and the protocol handler returns 500.
  //
  // `fullFidelity: true` skips the small-JPEG `media:thumb` hot path (which
  // is for chat thumbnails) and loads the original bytes. A 256px JPEG
  // would look obviously blurry at lightbox dimensions. See PR-A of
  // fix-codex-chat-image-attachment-lag for the routing contract.
  const resolvedSrc = useResolvedMediaSrc(rawSrc, kindHint, { fullFidelity: true })

  if (!preview.open || preview.images.length === 0) return null

  const current = currentMaybe
  if (!current) return null
  // Defensive: AttachmentCard already filters non-renderable items, but
  // a malformed entry would otherwise render <img src=""> which triggers
  // React's empty-src warning and breaks the layout.
  if (typeof current.uri !== 'string' || current.uri.length === 0) return null

  const kind = classifyMediaKind({ kind: current.kind, mime: current.mime, name: current.name })
  const totalCount = preview.images.length
  const hasMultiple = totalCount > 1

  return (
    <div
      className="fixed inset-0 z-[50000] flex items-center justify-center bg-black/92"
      onClick={closePreview}
    >
      <div className="absolute left-4 right-4 top-4 flex items-center justify-between text-sm text-zinc-300">
        <span>
          {preview.index + 1} / {totalCount} · {current.name}
        </span>
        <button
          type="button"
          onClick={closePreview}
          className="text-zinc-400 hover:text-white text-xl"
          aria-label="Close preview"
        >
          ✕
        </button>
      </div>
      {resolvedSrc == null ? (
        <div className="text-zinc-400 text-sm">Loading…</div>
      ) : kind === 'video' ? (
        <video
          src={resolvedSrc}
          controls
          autoPlay
          // 视频里点击 = 暂停/播放(浏览器原生行为),不走"下一张",
          // 否则用户连续点击播放区会变成翻页,违反直觉。
          // hasMultiple 时让用户用方向键 / 左右箭头切换。
          className="max-h-[80vh] max-w-[90vw] object-contain bg-black"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <img
          src={resolvedSrc}
          alt={current.name}
          className="max-h-[80vh] max-w-[90vw] object-contain"
          onClick={(e) => {
            e.stopPropagation()
            if (hasMultiple) nextPreview()
          }}
        />
      )}
      {hasMultiple && preview.index > 0 && (
        <button
          type="button"
          className="absolute left-4 top-1/2 -translate-y-1/2 text-3xl text-zinc-400 hover:text-white"
          onClick={(e) => {
            e.stopPropagation()
            prevPreview()
          }}
          aria-label="Previous"
        >
          ‹
        </button>
      )}
      {hasMultiple && preview.index < totalCount - 1 && (
        <button
          type="button"
          className="absolute right-4 top-1/2 -translate-y-1/2 text-3xl text-zinc-400 hover:text-white"
          onClick={(e) => {
            e.stopPropagation()
            nextPreview()
          }}
          aria-label="Next"
        >
          ›
        </button>
      )}
    </div>
  )
}
