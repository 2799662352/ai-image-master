export interface RatioOption {
  key: string
  label?: string
  description?: string
}

export interface ResolutionOption {
  key: string
  label?: string
  description?: string
}

interface Props {
  ratio: string
  resolution: string
  concurrency: number
  ratioOptions: RatioOption[]
  resolutionOptions: ResolutionOption[]
  supportsResolution: boolean
  onRatioChange: (s: string) => void
  onResolutionChange: (s: string) => void
  onConcurrencyChange: (n: number) => void
}

function formatOption(opt: RatioOption | ResolutionOption): string {
  const label = opt.label || opt.key
  return opt.description ? `${label} ${opt.description}` : label
}

/**
 * PunkConfigGrid - 尺寸 / 清晰度 / 并发 三栏配置
 * ratio / resolution 选项随当前模型动态变化
 */
export default function PunkConfigGrid({
  ratio,
  resolution,
  concurrency,
  ratioOptions,
  resolutionOptions,
  supportsResolution,
  onRatioChange,
  onResolutionChange,
  onConcurrencyChange,
}: Props) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 14,
        marginBottom: 20,
      }}
    >
      {/* RATIO */}
      <div
        className="p-sticker"
        style={{ background: 'var(--punk-cream)', padding: '0.8rem 1rem' }}
      >
        <div className="p-display" style={{ fontSize: 12, marginBottom: 6, opacity: 0.85 }}>
          // RATIO 比例
        </div>
        <select
          value={ratio}
          onChange={(e) => onRatioChange(e.target.value)}
          className="p-select"
          aria-label="尺寸比例"
        >
          {ratioOptions.map((r) => (
            <option key={r.key} value={r.key}>{formatOption(r)}</option>
          ))}
        </select>
      </div>

      {/* RESOLUTION */}
      <div
        className="p-sticker p-tilt-r-2"
        style={{ background: 'var(--punk-cream)', padding: '0.8rem 1rem' }}
      >
        <div className="p-display" style={{ fontSize: 12, marginBottom: 6, opacity: 0.85 }}>
          // RES 清晰度
        </div>
        {supportsResolution ? (
          <select
            value={resolution}
            onChange={(e) => onResolutionChange(e.target.value)}
            className="p-select"
            aria-label="清晰度"
          >
            {resolutionOptions.map((r) => (
              <option key={r.key} value={r.key}>{formatOption(r)}</option>
            ))}
          </select>
        ) : (
          <div
            className="p-mono"
            style={{
              padding: '0.5rem 0.6rem',
              background: 'var(--punk-black)',
              color: 'var(--punk-cream)',
              fontSize: 11,
              fontWeight: 900,
              border: '2px solid var(--punk-black)',
              opacity: 0.85,
            }}
            aria-label="当前模型不支持清晰度切换"
          >
            // MODEL DEFAULT (该模型不支持切换)
          </div>
        )}
      </div>

      {/* CONCURRENCY */}
      <div
        className="p-sticker p-tilt-l-2"
        style={{
          background: 'var(--punk-pink)',
          color: 'var(--punk-cream)',
          padding: '0.8rem 1rem',
        }}
      >
        <div className="p-display" style={{ fontSize: 12, marginBottom: 6 }}>
          // CONC 并发
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onConcurrencyChange(n)}
              className="p-mono"
              aria-pressed={concurrency === n}
              style={{
                flex: 1,
                padding: '0.4rem 0',
                background: concurrency === n ? 'var(--punk-black)' : 'var(--punk-cream)',
                color: concurrency === n ? 'var(--punk-pink)' : 'var(--punk-black)',
                border: '2px solid var(--punk-black)',
                fontWeight: 900,
                fontSize: 13,
                cursor: 'pointer',
                transform: concurrency === n ? 'translate(-1px, -1px)' : 'none',
                boxShadow: concurrency === n ? '2px 2px 0 var(--punk-cream)' : 'none',
              }}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
