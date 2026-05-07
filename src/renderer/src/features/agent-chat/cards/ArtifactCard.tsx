import type { ArtifactItem } from '../../../../../types/agent-timeline'

export function ArtifactCard({
  item,
  onImageDoubleClick,
}: {
  item: ArtifactItem
  onImageDoubleClick?: (artifactId: string) => void
}) {
  return (
    <div className="my-1 flex flex-wrap gap-2">
      {item.artifacts.map((ref) =>
        ref.kind === 'image' ? (
          <img
            key={ref.id}
            src={ref.thumbnailUri ?? ref.uri}
            alt={ref.name}
            onDoubleClick={() => onImageDoubleClick?.(ref.id)}
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
