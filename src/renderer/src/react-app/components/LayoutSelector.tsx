import { useShallow } from 'zustand/react/shallow'
import { useDirectorStore, type LayoutOrientation, type LayoutType } from '../stores/useDirectorStore'

const LAYOUT_OPTIONS: { value: LayoutType; label: string }[] = [
  { value: '2closeup', label: '特写' },
  { value: '4grid', label: '四宫格' },
  { value: '6grid', label: '六宫格' },
  { value: '9grid', label: '九宫格' },
  { value: '16grid', label: '十六宫格' },
  { value: '25grid', label: '二十五宫格' },
]

const ORIENTATION_OPTIONS: { value: LayoutOrientation; label: string; icon: string }[] = [
  { value: 'landscape', label: '横屏', icon: 'fas fa-arrows-alt-h' },
  { value: 'portrait', label: '竖屏', icon: 'fas fa-arrows-alt-v' },
]

const SQUARE_LAYOUTS: LayoutType[] = ['4grid', '9grid', '16grid', '25grid']

function getLayoutShape(layout: LayoutType, orientation: LayoutOrientation): { cols: number; rows: number } {
  const isPortrait = orientation === 'portrait'
  switch (layout) {
    case '2closeup':
      return isPortrait ? { cols: 1, rows: 2 } : { cols: 2, rows: 1 }
    case '4grid':
      return { cols: 2, rows: 2 }
    case '6grid':
      return isPortrait ? { cols: 2, rows: 3 } : { cols: 3, rows: 2 }
    case '9grid':
      return { cols: 3, rows: 3 }
    case '16grid':
      return { cols: 4, rows: 4 }
    case '25grid':
      return { cols: 5, rows: 5 }
    default:
      return isPortrait ? { cols: 2, rows: 3 } : { cols: 3, rows: 2 }
  }
}

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
  const {
    currentLayout,
    currentRatio,
    currentLayoutOrientation,
    isLayoutOrientationAuto,
    setLayout,
    setLayoutOrientation,
    setLayoutOrientationAuto,
    setSemanticOrientation,
    setSemanticOrientationAuto,
  } = useDirectorStore(useShallow((s) => ({
    currentLayout: s.currentLayout,
    currentRatio: s.currentRatio,
    currentLayoutOrientation: s.currentLayoutOrientation,
    isLayoutOrientationAuto: s.isLayoutOrientationAuto,
    setLayout: s.setLayout,
    setLayoutOrientation: s.setLayoutOrientation,
    setLayoutOrientationAuto: s.setLayoutOrientationAuto,
    setSemanticOrientation: s.setSemanticOrientation,
    setSemanticOrientationAuto: s.setSemanticOrientationAuto,
  })))

  const isSquare = SQUARE_LAYOUTS.includes(currentLayout)

  const handleOrientationClick = (val: LayoutOrientation) => {
    setLayoutOrientation(val)
    setSemanticOrientation(val)
  }

  const handleRestoreAuto = () => {
    setLayoutOrientationAuto(true)
    setSemanticOrientationAuto(true)
  }

  return (
    <div className="bg-[#27272A] rounded-none p-4">
      <h3 className="text-white font-semibold flex items-center mb-3">
        <i className="fas fa-th mr-2 text-blue-400" />
        布局选择
      </h3>
      <div className="mb-3">
        <div className="grid grid-cols-2 gap-2">
          {ORIENTATION_OPTIONS.map((opt) => {
            const selected = currentLayoutOrientation === opt.value
            return (
              <button
                key={opt.value}
                onClick={() => handleOrientationClick(opt.value)}
                className={`px-3 py-2 text-sm rounded-none border transition-all ${
                  selected
                    ? 'bg-blue-500/30 ring-2 ring-blue-400 border-blue-300'
                    : 'bg-[#09090B] border-[#3F3F46] text-white hover:border-white/30'
                }`}
              >
                <i className={`${opt.icon} mr-2`} />
                {opt.label}
              </button>
            )
          })}
        </div>
        <div className="mt-2 text-xs text-white/60 flex items-center justify-between">
          <span>
            {isLayoutOrientationAuto
              ? (currentRatio === 'auto'
                  ? '跟随比例：auto（保持当前方向）'
                  : `跟随比例：${currentRatio}`)
              : '手动覆盖方向中'}
          </span>
          {!isLayoutOrientationAuto && (
            <button
              onClick={handleRestoreAuto}
              className="text-blue-300 hover:text-blue-200 transition-colors"
            >
              恢复跟随比例
            </button>
          )}
        </div>
        {isSquare && !isLayoutOrientationAuto && (
          <div className="mt-1 text-xs text-yellow-400/80">
            方向强制已应用（拓扑不变，语义约束生效）
          </div>
        )}
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {LAYOUT_OPTIONS.map((opt) => {
          const shape = getLayoutShape(opt.value, currentLayoutOrientation)
          const selected = currentLayout === opt.value
          return (
            <button
              key={opt.value}
              onClick={() => setLayout(opt.value)}
              className={`p-3 rounded-none text-center transition-all ${
                selected
                  ? 'bg-blue-500/30 ring-2 ring-blue-400'
                  : 'bg-[#09090B] border border-[#3F3F46] hover:border-white/30'
              }`}
            >
              <GridPreview cols={shape.cols} rows={shape.rows} />
              <div className="text-xs text-white opacity-50">{shape.cols}×{shape.rows}</div>
              <div className="text-xs text-white font-medium">{opt.label}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
