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
  sizeHidden?: boolean
}

function formatOption(opt: RatioOption | ResolutionOption): string {
  const label = opt.label || opt.key
  return opt.description ? `${label} ${opt.description}` : label
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-cyberpunk-yellow/80 mb-1.5">
      {children}
    </div>
  )
}

const SELECT_CLASSES =
  'w-full px-2.5 py-1.5 bg-zinc-800 border-2 border-zinc-700 text-white text-sm font-mono focus:outline-none focus:border-cyberpunk-yellow appearance-none cursor-pointer'

/**
 * BatchConfigGrid - 尺寸 / 清晰度 / 并发 三栏配置
 * 替代 PunkConfigGrid 的 sticker + 倾斜 + 粉红块。
 */
export default function BatchConfigGrid({
  ratio,
  resolution,
  concurrency,
  ratioOptions,
  resolutionOptions,
  supportsResolution,
  onRatioChange,
  onResolutionChange,
  onConcurrencyChange,
  sizeHidden,
}: Props) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {sizeHidden ? (
        <div className="border-2 border-zinc-700 bg-zinc-900/60 p-3 sm:col-span-2">
          <FieldLabel>// SIZE 尺寸</FieldLabel>
          <p className="font-mono text-[11px] text-zinc-400">
            ⚡ 该模型尺寸自适应,如需指定请在提示词中描述(如"横版16:9")
          </p>
        </div>
      ) : (
        <>
          {/* RATIO */}
          <div className="border-2 border-zinc-700 bg-zinc-900/60 p-3">
            <FieldLabel>// RATIO 比例</FieldLabel>
            <select
              value={ratio}
              onChange={(e) => onRatioChange(e.target.value)}
              className={SELECT_CLASSES}
              aria-label="尺寸比例"
            >
              {ratioOptions.map((r) => (
                <option key={r.key} value={r.key}>{formatOption(r)}</option>
              ))}
            </select>
          </div>

          {/* RESOLUTION */}
          <div className="border-2 border-zinc-700 bg-zinc-900/60 p-3">
            <FieldLabel>// RES 清晰度</FieldLabel>
            {supportsResolution ? (
              <select
                value={resolution}
                onChange={(e) => onResolutionChange(e.target.value)}
                className={SELECT_CLASSES}
                aria-label="清晰度"
              >
                {resolutionOptions.map((r) => (
                  <option key={r.key} value={r.key}>{formatOption(r)}</option>
                ))}
              </select>
            ) : (
              <div
                className="px-2.5 py-1.5 bg-zinc-800 border-2 border-zinc-700 text-zinc-500 text-xs font-mono uppercase tracking-wider"
                aria-label="当前模型不支持清晰度切换"
              >
                model default
              </div>
            )}
          </div>
        </>
      )}

      {/* CONCURRENCY */}
      <div className="border-2 border-zinc-700 bg-zinc-900/60 p-3">
        <FieldLabel>// CONC 并发</FieldLabel>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5, 6].map((n) => {
            const active = concurrency === n
            return (
              <button
                key={n}
                type="button"
                onClick={() => onConcurrencyChange(n)}
                aria-pressed={active}
                className={`flex-1 py-1.5 border-2 font-mono text-xs font-bold transition-colors ${
                  active
                    ? 'border-cyberpunk-yellow bg-cyberpunk-yellow text-cyberpunk-black'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-500'
                }`}
              >
                {n}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
