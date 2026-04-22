import type { BatchMode } from '../../stores/useBatchStore'

interface Props {
  mode: BatchMode
  onChange: (m: BatchMode) => void
}

/**
 * PunkModeSwitcher - 抽卡 / 多提示词 模式切换 (拼贴 tab 风格)
 */
export default function PunkModeSwitcher({ mode, onChange }: Props) {
  return (
    <div
      role="tablist"
      aria-label="批量生成模式"
      style={{ display: 'flex', gap: 14, marginBottom: 18, flexWrap: 'wrap' }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'card'}
        onClick={() => onChange('card')}
        className={`p-tab ${mode === 'card' ? 'p-tab--active p-tilt-l-2' : 'p-tilt-r-2'}`}
      >
        <span className="p-jp" style={{ fontSize: 18 }}>抽卡</span>
        <span className="p-mono" style={{ fontSize: 11, opacity: 0.85 }}>// GACHA</span>
        {mode === 'card' && <span className="p-heart">♥</span>}
      </button>

      <button
        type="button"
        role="tab"
        aria-selected={mode === 'multi'}
        onClick={() => onChange('multi')}
        className={`p-tab ${mode === 'multi' ? 'p-tab--active p-tilt-r-2' : 'p-tilt-l-2'}`}
      >
        <span className="p-jp" style={{ fontSize: 18 }}>多提示</span>
        <span className="p-mono" style={{ fontSize: 11, opacity: 0.85 }}>// MULTI</span>
        {mode === 'multi' && <span className="p-star">★</span>}
      </button>

      {/* 右侧装饰: 速度计数小贴纸 */}
      <span
        className="p-hazard-tape p-tilt-r-3"
        style={{
          marginLeft: 'auto',
          alignSelf: 'center',
          background: 'var(--punk-cream)',
          color: 'var(--punk-black)',
        }}
      >
        MODE / {mode === 'card' ? '01' : '02'}
      </span>
    </div>
  )
}
