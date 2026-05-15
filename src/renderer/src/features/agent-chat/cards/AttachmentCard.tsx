import type { AttachmentItem, AttachmentRef } from '../../../../../types/agent-timeline'
import { toRenderableUri } from '../../file-explorer/uri'
import { useFileExplorerStore } from '../../file-explorer/store'
import { referencesFromTimelineItem } from '../references/referenceUtils'
import { useAgentChatStore } from '../store'

function isRenderableImage(ref: AttachmentRef): boolean {
  if (ref.kind !== 'image') return false
  const uri = ref.thumbnailUri ?? ref.uri
  return typeof uri === 'string' && uri.length > 0
}

export function AttachmentCard({ item }: { item: AttachmentItem }) {
  const openPreview = useAgentChatStore((s) => s.openPreview)
  const openReference = useFileExplorerStore((state) => state.openReference)
  const references = referencesFromTimelineItem(item)
  const images = item.attachments.filter(isRenderableImage)

  const handleDoubleClick = (id: string): void => {
    const startIndex = images.findIndex((ref) => ref.id === id)
    if (startIndex < 0) return
    openPreview(
      images.map((ref) => ({
        ...ref,
        uri: toRenderableUri(ref.uri),
        thumbnailUri: ref.thumbnailUri ? toRenderableUri(ref.thumbnailUri) : undefined,
      })),
      startIndex,
    )
  }

  return (
    <div className="my-1">
      <div className="flex flex-wrap gap-2">
        {item.attachments.map((ref) =>
          isRenderableImage(ref) ? (
            <img
              key={ref.id}
              src={toRenderableUri(ref.thumbnailUri ?? ref.uri)}
              alt={ref.name}
              onDoubleClick={() => handleDoubleClick(ref.id)}
              className="h-16 w-16 rounded border border-zinc-700/50 object-cover cursor-pointer hover:border-cyan-400/50"
              title={ref.name}
            />
          ) : (
            <div
              key={ref.id}
              className="flex h-16 items-center gap-1.5 rounded border border-zinc-700/50 bg-zinc-900/50 px-2 text-[10px] text-zinc-300"
              title={ref.name}
            >
              <span>file</span>
              <span className="max-w-[100px] truncate">{ref.name}</span>
            </div>
          ),
        )}
      </div>
      {references.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {references.map((reference) => (
            <button
              key={reference.id}
              type="button"
              onClick={() => void openReference(reference)}
              className="rounded border border-cyan-500/30 px-2 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-500/10"
            >
              {reference.type === 'image' ? 'Open image' : 'Open file'}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
