import type { BatchMode } from '../../stores/useBatchStore'
import { useUIPrefsStore } from '../../stores/useUIPrefsStore'

interface Props {
  mode: BatchMode
  onChange: (m: BatchMode) => void
  onOpenEditor?: (type: 'angle' | 'light') => void
}

export default function PunkModeSwitcher({ mode, onChange, onOpenEditor }: Props) {
  const toolbarEnabled = useUIPrefsStore((s) => s.imageEditorToolbar.enabled)

  return (
    <div
      role="tablist"
      aria-label="批量生成模式"
      style={{ display: 'flex', gap: 14, marginBottom: 18, flexWrap: 'wrap', alignItems: 'center' }}
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

      {toolbarEnabled && onOpenEditor && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span
            className="p-mono"
            style={{ fontSize: 9, opacity: 0.5, marginRight: 2, letterSpacing: '0.05em' }}
          >
            //
          </span>
          <button
            type="button"
            className="p-sticker"
            onClick={() => onOpenEditor('angle')}
            style={{
              padding: '3px 10px',
              fontSize: 11,
              fontWeight: 900,
              cursor: 'pointer',
              background: 'var(--punk-cyan)',
              color: 'var(--punk-black)',
              border: '2px solid var(--punk-black)',
            }}
          >
            多角度
          </button>
          <button
            type="button"
            className="p-sticker"
            onClick={() => onOpenEditor('light')}
            style={{
              padding: '3px 10px',
              fontSize: 11,
              fontWeight: 900,
              cursor: 'pointer',
              background: 'var(--punk-pink)',
              color: 'var(--punk-black)',
              border: '2px solid var(--punk-black)',
            }}
          >
            打光
          </button>
        </div>
      )}

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
