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
        <div key={i} className="bg-zinc-500 rounded-sm" />
      ))}
    </div>
  )
}

export function LayoutSelector() {
  const currentLayout = useDirectorStore((s) => s.currentLayout)
  const setLayout = useDirectorStore((s) => s.setLayout)

  return (
    <div>
      <label className="text-sm font-medium text-zinc-300 mb-2 block">
        <i className="fas fa-th mr-2 text-blue-400" />
        布局选择
      </label>
      <div className="grid grid-cols-4 gap-2">
        {LAYOUT_OPTIONS.map((opt) => {
          const selected = currentLayout === opt.value
          return (
            <button
              key={opt.value}
              onClick={() => setLayout(opt.value)}
              className={`p-3 rounded-lg text-center transition-all ${
                selected
                  ? 'ring-2 ring-blue-400 bg-blue-400/10'
                  : 'bg-zinc-800 border border-zinc-700 hover:border-zinc-500'
              }`}
            >
              <GridPreview cols={opt.cols} rows={opt.rows} />
              <div className="text-xs text-zinc-400">{opt.dims}</div>
              <div className="text-xs text-zinc-300 font-medium">{opt.label}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
