import { ImageParamControls } from '../../react-app/components/ImageParamControls'
import type { ImageParamModelConfig } from '../../services/api/imageParamControls'

interface Props {
  modelConfig: ImageParamModelConfig | null | undefined
  ratio: string
  resolution: string
  quality: string
  concurrency: number
  onRatioChange: (s: string) => void
  onResolutionChange: (s: string) => void
  onQualityChange: (s: string) => void
  onConcurrencyChange: (n: number) => void
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-cyberpunk-yellow/80 mb-1.5">
      {children}
    </div>
  )
}

/**
 * BatchConfigGrid - 比例 / 分辨率 / 清晰度(共享 ImageParamControls) + 并发。
 * 比例/分辨率/清晰度三轴全部走全站共享组件,本组件只额外负责「并发」这一批量专属配置。
 */
export default function BatchConfigGrid({
  modelConfig,
  ratio,
  resolution,
  quality,
  concurrency,
  onRatioChange,
  onResolutionChange,
  onQualityChange,
  onConcurrencyChange,
}: Props) {
  return (
    <div className="space-y-3">
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={modelConfig}
        ratio={ratio}
        onRatioChange={onRatioChange}
        resolution={resolution}
        onResolutionChange={onResolutionChange}
        quality={quality}
        onQualityChange={onQualityChange}
      />

      {/* CONCURRENCY 并发 —— 批量页专属 */}
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
