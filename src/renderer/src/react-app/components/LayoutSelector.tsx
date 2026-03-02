import { useDirectorStore, type LayoutType } from '../stores/useDirectorStore'

const LAYOUT_OPTIONS: { value: LayoutType; label: string; dims: string; cols: number; rows: number }[] = [
  { value: '2closeup', label: '特写', dims: '1×2', cols: 1, rows: 2 },
  { value: '4grid', label: '四宫格', dims: '2×2', cols: 2, rows: 2 },
  { value: '6grid', label: '六宫格', dims: '2×3', cols: 2, rows: 3 },
  { value: '9grid', label: '九宫格', dims: '3×3', cols: 3, rows: 3 },
]

function GridPreview({ cols, rows }: { cols: number; rows: number }) {
  return (
    <div
      className="grid gap-0.5 w-8 h-8 mx-auto mb-1"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
    >
      {Array.from({ length: cols * rows }).map((_, i) => (
        <div key={i} className="bg-white opacity-30 rounded-sm" />
      ))}
    </div>
  )
}

export function LayoutSelector() {
  const currentLayout = useDirectorStore((s) => s.currentLayout)
  const setLayout = useDirectorStore((s) => s.setLayout)

  return (
    <div className="bg-[#27272A] rounded-none p-4">
      <h3 className="text-white font-semibold flex items-center mb-3">
        <i className="fas fa-th mr-2 text-blue-400" />
        布局选择
      </h3>
      <div className="grid grid-cols-4 gap-2">
        {LAYOUT_OPTIONS.map((opt) => {
          const selected = currentLayout === opt.value
          return (
            <button
              key={opt.value}
              onClick={() => setLayout(opt.value)}
              className={`p-3 rounded-none text-center transition-all ${
                selected
                  ? 'bg-blue-500 bg-opacity-30 ring-2 ring-blue-400'
                  : 'bg-[#09090B] border border-[#3F3F46] hover:border-white hover:border-opacity-30'
              }`}
            >
              <GridPreview cols={opt.cols} rows={opt.rows} />
              <div className="text-xs text-white opacity-50">{opt.dims}</div>
              <div className="text-xs text-white font-medium">{opt.label}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
