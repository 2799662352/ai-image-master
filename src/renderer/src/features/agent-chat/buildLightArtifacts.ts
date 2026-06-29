import type { AttachmentRef } from '../../../../types/agent-timeline'

/**
 * Build lightweight artifact refs for a settled generation bubble.
 *
 * Each source is either a local saved file path (the common case right after
 * `attachments:save` — COS upload is usually still `pending:*`) or an already
 * durable http(s)/COS URL. Either way the ref carries only a short string `uri`,
 * NEVER the multi-MB `data:` base64 — that is the whole point: swapping the
 * bubble onto these refs lets the inline base64 be garbage-collected instead of
 * lingering in the chat store for the rest of the session.
 *
 * Rendering then routes automatically:
 *   - local path  → `toRenderableUri` → `local-file://` → `media:thumb` (512px)
 *                   for the bubble; lightbox reads full-fidelity bytes.
 *   - COS URL     → `ArtifactCard` derives a 数据万象 thumbnail for the bubble
 *                   (`appendCosThumb`); lightbox keeps the bare original URL.
 *
 * Pure + side-effect free so it can be unit-tested without the service layer.
 */
export function buildLightArtifacts(
  sources: string[],
  kind: 'image' | 'video' = 'image',
  idBase: string = `codex-light-${Date.now()}`,
): AttachmentRef[] {
  const isVideo = kind === 'video'
  const refs: AttachmentRef[] = []
  for (const raw of sources) {
    if (typeof raw !== 'string') continue
    const uri = raw.trim()
    if (uri.length === 0) continue
    const i = refs.length
    refs.push({
      id: `${idBase}-${i}`,
      kind: isVideo ? 'video' : 'image',
      name: isVideo ? `codex-video-${i + 1}.mp4` : `codex-image-${i + 1}.png`,
      mime: isVideo ? 'video/mp4' : 'image/png',
      size: 0,
      uri,
    })
  }
  return refs
}
