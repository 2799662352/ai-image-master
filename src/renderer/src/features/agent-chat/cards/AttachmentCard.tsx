import type { AttachmentItem, AttachmentRef } from '../../../../../types/agent-timeline'
import { useAgentChatStore } from '../store'

function isRenderableImage(ref: AttachmentRef): boolean {
  if (ref.kind !== 'image') return false
  const uri = ref.thumbnailUri ?? ref.uri
  return typeof uri === 'string' && uri.length > 0
}

export function AttachmentCard({ item }: { item: AttachmentItem }) {
  const openPreview = useAgentChatStore((s) => s.openPreview)
  const images = item.attachments.filter(isRenderableImage)

  const handleDoubleClick = (id: string): void => {
    const startIndex = images.findIndex((ref) => ref.id === id)
    if (startIndex < 0) return
    openPreview(images, startIndex)
  }

  return (
    <div className="my-1 flex flex-wrap gap-2">
      {item.attachments.map((ref) =>
        isRenderableImage(ref) ? (
          <img
            key={ref.id}
            src={ref.thumbnailUri ?? ref.uri}
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
            📄 <span className="max-w-[100px] truncate">{ref.name}</span>
          </div>
        ),
      )}
    </div>
  )
}
