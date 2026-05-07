import type { AttachmentItem } from '../../../../../types/agent-timeline'

export function AttachmentCard({
  item,
  onImageDoubleClick,
}: {
  item: AttachmentItem
  onImageDoubleClick?: (attachmentId: string) => void
}) {
  return (
    <div className="my-1 flex flex-wrap gap-2">
      {item.attachments.map((ref) =>
        ref.kind === 'image' ? (
          <img
            key={ref.id}
            src={ref.thumbnailUri ?? ref.uri}
            alt={ref.name}
            onDoubleClick={() => onImageDoubleClick?.(ref.id)}
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
