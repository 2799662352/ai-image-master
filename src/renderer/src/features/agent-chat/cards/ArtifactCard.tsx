import type { ArtifactItem, AttachmentRef } from '../../../../../types/agent-timeline'
import type { AgentReference } from '../../../../../types/agent-reference'
import {
  MediaThumbnail,
  classifyMediaKind,
} from '../../../components/shared/media/MediaThumbnail'
import { toRenderableUri } from '../../file-explorer/uri'
import { useFileExplorerStore } from '../../file-explorer/store'
import { FileIcon, OpenInPanelIcon } from '../icons'
import { referencesFromTimelineItem } from '../references/referenceUtils'
import { useAgentChatStore } from '../store'

type MediaKind = 'image' | 'video'

function mediaKindOf(ref: AttachmentRef): MediaKind | null {
  return classifyMediaKind({ kind: ref.kind, mime: ref.mime, name: ref.name })
}

function isRenderableMedia(ref: AttachmentRef): boolean {
  if (mediaKindOf(ref) == null) return false
  const uri = ref.thumbnailUri ?? ref.uri
  return typeof uri === 'string' && uri.length > 0
}

/**
 * Standalone save-status banner rendered under the generated thumbnails as its
 * own eye-catching bubble (NOT plain text inside the grid). Three states:
 * pending (amber, pulsing), saved (emerald, shows the folder), failed (red,
 * but explicitly says the image itself is fine).
 */
function SaveStatusBanner({
  save,
  count,
  isVideo,
}: {
  save: NonNullable<ArtifactItem['save']>
  count: number
  isVideo: boolean
}) {
  const unitLabel = isVideo ? `${count} 个视频` : `${count} 张图`
  const mediaLabel = isVideo ? '视频' : '图片'
  if (save.status === 'pending') {
    return (
      <div
        data-testid="artifact-save-banner"
        className="mt-2 flex items-center gap-2.5 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 shadow-[0_0_12px_rgba(251,191,36,0.15)]"
      >
        <span
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-amber-400/25 border-t-amber-300"
        />
        <span className="font-mono text-[12px] font-semibold text-amber-200">
          ✅ 已生成 {unitLabel} · 文件仍在后台保存中…
        </span>
      </div>
    )
  }

  if (save.status === 'failed') {
    return (
      <div
        data-testid="artifact-save-banner"
        className="mt-2 flex items-center gap-2.5 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2"
      >
        <span aria-hidden className="text-[13px] leading-none">⚠️</span>
        <span className="font-mono text-[12px] text-red-200">
          {mediaLabel}已生成（可正常查看），但本地保存失败
        </span>
      </div>
    )
  }

  return (
    <div
      data-testid="artifact-save-banner"
      className="mt-2 flex items-center gap-2.5 rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 shadow-[0_0_12px_rgba(52,211,153,0.15)]"
    >
      <span aria-hidden className="text-[13px] leading-none">✅</span>
      <div className="flex min-w-0 flex-col">
        <span className="font-mono text-[12px] font-semibold text-emerald-200">
          已生成 {unitLabel} · 已保存
        </span>
        {save.dir ? (
          <span className="max-w-[300px] truncate text-[11px] text-emerald-300/70" title={save.dir}>
            📁 {save.dir}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function ArtifactCard({ item }: { item: ArtifactItem }) {
  const openPreview = useAgentChatStore((s) => s.openPreview)
  const openReference = useFileExplorerStore((state) => state.openReference)

  // In-app generation lifecycle (codex `generate_image`): show a live spinner
  // while the request is in flight, and an error card on failure. Plain
  // attachment artifacts have no `status` and fall through to the grid below.
  if (item.status === 'generating') {
    const fallback = item.mediaKind === 'video' ? '正在生成视频…' : '正在生成图片…'
    return (
      <div className="my-1 flex items-center gap-3 rounded border border-cyan-400/30 bg-cyan-400/5 px-3 py-2.5">
        <span
          aria-hidden
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-cyan-400/25 border-t-cyan-300"
        />
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-[12px] text-cyan-100">{item.progressText ?? fallback}</span>
          {item.prompt ? (
            <span className="max-w-[240px] truncate text-[11px] text-cyan-300/60" title={item.prompt}>
              {item.prompt}
            </span>
          ) : null}
        </div>
      </div>
    )
  }

  if (item.status === 'error') {
    return (
      <div className="my-1 flex items-start gap-2 rounded border border-red-400/40 bg-red-500/10 px-3 py-2.5">
        <span aria-hidden className="text-[13px] leading-none text-red-300">⚠</span>
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-[12px] text-red-200">
            {item.mediaKind === 'video' ? '视频生成失败' : '图片生成失败'}
          </span>
          {item.error ? (
            <span className="max-w-[260px] break-words text-[11px] text-red-300/70">{item.error}</span>
          ) : null}
        </div>
      </div>
    )
  }

  const references = referencesFromTimelineItem(item)
  const mediaItems = item.artifacts.filter(isRenderableMedia)

  const referenceByAttachmentId = new Map<string, AgentReference>()
  for (const ref of references) {
    const colon = ref.id.indexOf(':')
    if (colon > 0) referenceByAttachmentId.set(ref.id.slice(colon + 1), ref)
  }

  const handleClick = (clicked: AttachmentRef): void => {
    const previewable = mediaItems.map((ref) => ({
      ...ref,
      uri: toRenderableUri(ref.uri),
      thumbnailUri: ref.thumbnailUri ? toRenderableUri(ref.thumbnailUri) : undefined,
    }))
    const startIndex = mediaItems.findIndex((m) => m.id === clicked.id)
    if (startIndex >= 0) openPreview(previewable, startIndex)

    const reference = referenceByAttachmentId.get(clicked.id)
    if (reference) void openReference(reference)
  }

  return (
    <div className="my-1">
      <div className="flex flex-wrap gap-2">
        {item.artifacts.map((ref) => {
        const kind = mediaKindOf(ref)
        if (kind != null && isRenderableMedia(ref)) {
          return (
            <MediaThumbnail
              key={ref.id}
              src={toRenderableUri(ref.thumbnailUri ?? ref.uri)}
              kind={kind}
              name={ref.name}
              posterSrc={ref.thumbnailUri ? toRenderableUri(ref.thumbnailUri) : undefined}
              onClick={() => handleClick(ref)}
              className="h-20 w-20 border-cyan-400/25 hover:border-cyan-300/50"
            />
          )
        }
        const reference = referenceByAttachmentId.get(ref.id)
        const clickable = reference != null
        return (
          <button
            key={ref.id}
            type="button"
            onClick={() => {
              if (reference) void openReference(reference)
            }}
            className={
              'group flex h-16 items-center gap-2 rounded border bg-cyan-400/5 px-2.5 text-[11px] text-cyan-200 transition-colors ' +
              (clickable
                ? 'border-cyan-400/30 hover:border-cyan-300/60 hover:bg-cyan-500/15 hover:text-cyan-50 cursor-pointer'
                : 'border-cyan-400/10 opacity-60 cursor-not-allowed')
            }
            title={clickable ? `打开 ${ref.name}` : ref.name}
            disabled={!clickable}
            aria-label={clickable ? `Open ${ref.name} in file panel` : ref.name}
          >
            <FileIcon className={clickable ? 'text-cyan-300/80 group-hover:text-cyan-100' : 'text-cyan-300/40'} />
            <span className="max-w-[120px] truncate font-mono">{ref.name}</span>
            {clickable && (
              <OpenInPanelIcon
                className="ml-1 h-3 w-3 text-cyan-300/50 opacity-0 transition-opacity group-hover:opacity-100"
              />
            )}
          </button>
        )
        })}
      </div>
      {item.save ? (
        <SaveStatusBanner
          save={item.save}
          count={item.artifacts.length}
          isVideo={
            item.mediaKind === 'video' || item.artifacts.some((a) => mediaKindOf(a) === 'video')
          }
        />
      ) : null}
    </div>
  )
}
