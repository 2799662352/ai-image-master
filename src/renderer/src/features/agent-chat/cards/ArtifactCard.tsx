import type { ArtifactItem, AttachmentRef } from '../../../../../types/agent-timeline'
import { useAgentChatStore } from '../store'

function isRenderableImage(ref: AttachmentRef): boolean {
  if (ref.kind !== 'image') return false
  const uri = ref.thumbnailUri ?? ref.uri
  return typeof uri === 'string' && uri.length > 0
}

export function ArtifactCard({ item }: { item: ArtifactItem }) {
  const openPreview = useAgentChatStore((s) => s.openPreview)
  const images = item.artifacts.filter(isRenderableImage)

  const handleDoubleClick = (id: string): void => {
    const startIndex = images.findIndex((ref) => ref.id === id)
    if (startIndex < 0) return
    openPreview(images, startIndex)
  }

  return (
    <div className="my-1 flex flex-wrap gap-2">
      {item.artifacts.map((ref) =>
        isRenderableImage(ref) ? (
          <img
            key={ref.id}
            src={ref.thumbnailUri ?? ref.uri}
            alt={ref.name}
            onDoubleClick={() => handleDoubleClick(ref.id)}
            className="h-20 w-20 rounded border border-cyan-400/25 object-cover cursor-pointer hover:border-cyan-300/50"
            title={ref.name}
          />
        ) : (
          <div
            key={ref.id}
            className="flex h-16 items-center gap-1.5 rounded border border-cyan-400/20 bg-cyan-400/5 px-2 text-[10px] text-cyan-200"
            title={ref.name}
          >
            📦 <span className="max-w-[100px] truncate">{ref.name}</span>
          </div>
        ),
      )}
    </div>
  )
}
