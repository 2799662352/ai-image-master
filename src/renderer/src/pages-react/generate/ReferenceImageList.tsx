interface ReferenceImageListProps {
  images: string[]
  onRemove: (index: number) => void
  onAdd: () => void
}

export function ReferenceImageList({ images, onRemove, onAdd }: ReferenceImageListProps) {
  return (
    <div>
      <button
        onClick={onAdd}
        className="text-sm text-zinc-400 hover:text-cyberpunk-yellow transition-colors"
      >
        + 添加参考图
      </button>
      {images.length > 0 && (
        <div className="flex gap-2 mt-2 flex-wrap">
          {images.map((img, i) => (
            <div key={i} className="relative w-16 h-16">
              <img src={img} alt="" className="w-full h-full object-cover border border-zinc-700" />
              <button
                onClick={() => onRemove(i)}
                className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
