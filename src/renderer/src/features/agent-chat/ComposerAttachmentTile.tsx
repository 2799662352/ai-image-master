import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { AgentAttachmentInput } from '../../../../types/agent'
import { useResolvedMediaSrc } from '../../components/shared/media/useResolvedMediaSrc'
import { toRenderableUri } from '../file-explorer/uri'
import { FileIcon } from './icons'

/**
 * Past this many image tiles the composer falls back to file chips. Keeps a
 * "drop 40 screenshots" gesture from decoding 40 bitmaps at once — the freeze
 * that made an earlier version drop composer thumbnails entirely.
 */
export const MAX_COMPOSER_THUMBNAILS = 12

export function isImageAttachment(att: AgentAttachmentInput): boolean {
  return att.mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(att.name)
}

/** `D:\a\b.png` / `D:/a/b.png` → `local-file:///D:/a/b.png` (drive colon kept, see canvas asset contract). */
export function localFileUri(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.startsWith('local-file://') ? normalized : `local-file:///${normalized.replace(/^\/+/, '')}`
}

/**
 * One preview URI per staged image attachment, keyed by composerId (falls back
 * to name:index). Buffer-backed → `blob:` object URL (created once, revoked when
 * the attachment leaves the strip); path-backed → `local-file:///…`. Owned by
 * the composer so the same URI feeds both the tile and the lightbox sequence.
 */
export function useAttachmentPreviewUris(attachments: ReadonlyArray<AgentAttachmentInput>): Map<string, string> {
  const images = useMemo(() => attachments.filter(isImageAttachment), [attachments])
  const map = useMemo(() => {
    const out = new Map<string, string>()
    images.forEach((att, index) => {
      const key = attachmentKey(att, index)
      if (att.path) out.set(key, localFileUri(att.path))
      else if (att.buffer && typeof URL.createObjectURL === 'function') {
        out.set(key, URL.createObjectURL(new Blob([att.buffer], { type: att.mime || 'image/png' })))
      }
    })
    return out
  }, [images])
  useEffect(() => {
    return () => {
      if (typeof URL.revokeObjectURL !== 'function') return
      for (const uri of map.values()) if (uri.startsWith('blob:')) URL.revokeObjectURL(uri)
    }
  }, [map])
  return map
}

export function attachmentKey(att: AgentAttachmentInput, index: number): string {
  return att.composerId ?? `${att.name}:${index}`
}

interface TileProps {
  attachment: AgentAttachmentInput
  /** blob: or local-file:// uri from {@link useAttachmentPreviewUris}. */
  previewUri?: string
  /** Render a thumbnail (false past the cap → name chip). */
  thumbnail?: boolean
  onOpen: () => void
  onRemove: () => void
}

/**
 * One staged attachment in the composer strip (design D2/D5). Images render as
 * a 56px thumbnail; click = open in the lightbox, hover × = remove. Everything
 * else is a compact file chip with the same two actions.
 */
export function ComposerAttachmentTile({ attachment, previewUri, thumbnail = true, onOpen, onRemove }: TileProps): JSX.Element {
  const image = isImageAttachment(attachment) && thumbnail && !!previewUri
  // blob: URLs are already renderable; local-file uris go through the chat's
  // small-thumb resolver (attachments:read-thumb), never a full-size decode.
  const isBlob = previewUri?.startsWith('blob:') ?? false
  const resolved = useResolvedMediaSrc(image && !isBlob ? toRenderableUri(previewUri as string) : '', 'image')
  const src = image ? (isBlob ? previewUri! : resolved) : null
  const [broken, setBroken] = useState(false)
  const kb = attachment.size >= 1024 ? `${Math.round(attachment.size / 1024)} KB` : `${attachment.size} B`

  if (image && src && !broken) {
    return (
      <span className="group relative inline-flex h-14 w-14 shrink-0 overflow-hidden rounded border border-cyan-400/30 bg-zinc-900/40 transition-colors hover:border-cyan-300/70">
        <button
          type="button"
          aria-label={`预览 ${attachment.name}`}
          title={`${attachment.name} · ${kb} · 点击预览`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onOpen}
          className="block h-full w-full cursor-zoom-in"
        >
          <img src={src} alt={attachment.name} loading="lazy" decoding="async" className="h-full w-full object-cover" onError={() => setBroken(true)} />
        </button>
        <button
          type="button"
          aria-label={`Remove ${attachment.name}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onRemove}
          className="absolute right-0.5 top-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-zinc-950/80 text-[10px] leading-none text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-white"
        >
          ×
        </button>
      </span>
    )
  }

  return (
    <span className="inline-flex max-w-[280px] items-center rounded-md border border-cyan-400/25 bg-cyan-400/10 text-[11px] text-cyan-100">
      <button
        type="button"
        aria-label={`预览 ${attachment.name}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onOpen}
        className="inline-flex min-w-0 items-center gap-1.5 px-2 py-1 hover:text-cyan-50"
        title={`${attachment.mime || 'file'} · ${kb}`}
      >
        <FileIcon className="h-3 w-3 shrink-0 text-cyan-300/70" />
        <span className="truncate">{attachment.name}</span>
      </button>
      <button
        type="button"
        aria-label={`Remove ${attachment.name}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRemove}
        className="border-l border-cyan-400/20 px-1.5 py-1 text-cyan-200/70 hover:text-cyan-50"
      >
        x
      </button>
    </span>
  )
}
