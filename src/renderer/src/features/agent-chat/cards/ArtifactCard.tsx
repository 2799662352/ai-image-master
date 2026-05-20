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

export function ArtifactCard({ item }: { item: ArtifactItem }) {
  const openPreview = useAgentChatStore((s) => s.openPreview)
  const openReference = useFileExplorerStore((state) => state.openReference)
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
    <div className="my-1 flex flex-wrap gap-2">
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
  )
}
