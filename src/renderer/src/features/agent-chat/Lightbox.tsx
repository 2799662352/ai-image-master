import { useEffect, useCallback } from 'react'
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
      switch (e.key) {
        case 'Escape':
          closePreview()
          break
        case 'ArrowLeft':
          prevPreview()
          break
        case 'ArrowRight':
          nextPreview()
          break
      }
    },
    [preview.open, closePreview, nextPreview, prevPreview],
  )

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  if (!preview.open || preview.images.length === 0) return null

  const current = preview.images[preview.index]
  if (!current) return null
  // Defensive: AttachmentCard already filters non-renderable images out of
  // `preview.images`, but if a malformed entry slips in we'd otherwise
  // render `<img src="">` and trigger React's empty-src warning.
  if (typeof current.uri !== 'string' || current.uri.length === 0) return null

  return (
    <div
      className="fixed inset-0 z-[50000] flex items-center justify-center bg-black/92"
      onClick={closePreview}
    >
      <div className="absolute left-4 right-4 top-4 flex items-center justify-between text-sm text-zinc-300">
        <span>
          {preview.index + 1} / {preview.images.length} · {current.name}
        </span>
        <button
          type="button"
          onClick={closePreview}
          className="text-zinc-400 hover:text-white text-xl"
        >
          ✕
        </button>
      </div>
      <img
        src={toRenderableUri(current.uri)}
        alt={current.name}
        className="max-h-[80vh] max-w-[90vw] object-contain"
        onClick={(e) => {
          e.stopPropagation()
          nextPreview()
        }}
      />
      {preview.index > 0 && (
        <button
          type="button"
          className="absolute left-4 top-1/2 -translate-y-1/2 text-3xl text-zinc-400 hover:text-white"
          onClick={(e) => {
            e.stopPropagation()
            prevPreview()
          }}
        >
          ‹
        </button>
      )}
      {preview.index < preview.images.length - 1 && (
        <button
          type="button"
          className="absolute right-4 top-1/2 -translate-y-1/2 text-3xl text-zinc-400 hover:text-white"
          onClick={(e) => {
            e.stopPropagation()
            nextPreview()
          }}
        >
          ›
        </button>
      )}
    </div>
  )
}
