import { useEffect, type ReactNode } from 'react'
import {
  deriveImageParamControls,
  normalizeOption,
  type ImageParamModelConfig,
  type ParamOption,
} from '../../services/api/imageParamControls'

/**
 * ImageParamControls —— 全站共享的「比例 / 分辨率 / 清晰度」三轴受控组件。
 *
 * 单一事实来源: 选项与能力位来自 deriveImageParamControls(), 自动归位用 normalizeOption()。
 * 在这里改一次 markup / 轴, Director / Batch / Generate 全部跟着变。
 *
 * 状态不在组件内部持有(遵循 React「共享逻辑而非状态」): 由各页面的 store 通过
 * value/onChange 受控传入。视觉差异通过 variant 切换主题, 各页面保留自己的风格。
 */

export type ImageParamVariant = 'director' | 'cyberpunk'

interface ImageParamControlsProps {
  variant: ImageParamVariant
  modelConfig: ImageParamModelConfig | null | undefined
  ratio: string
  onRatioChange: (v: string) => void
  resolution: string
  onResolutionChange: (v: string) => void
  /** 仅 gpt-image-2 等支持 quality 的模型需要;不传则不渲染清晰度轴 */
  quality?: string
  onQualityChange?: (v: string) => void
  /** 比例自动归位时优先选中的 key(默认 auto) */
  preferRatio?: string
  className?: string
}

interface VariantTheme {
  grid: string
  card: string
  cardDisabled: string
  select: string
  placeholder: string
  notice: string
  renderLabel: (title: string, icon: string) => ReactNode
}

const THEMES: Record<ImageParamVariant, VariantTheme> = {
  director: {
    grid: 'grid gap-4',
    card: 'bg-[#27272A] rounded-none p-4',
    cardDisabled: 'bg-[#27272A] rounded-none p-4 opacity-60',
    select:
      'w-full px-3 py-2 bg-white/90 border border-white/30 rounded-none text-gray-800 font-medium focus:outline-none focus:ring-2 focus:ring-purple-400',
    placeholder: 'w-full px-3 py-2 bg-white/10 border border-white/20 text-white/70 text-sm',
    notice:
      'bg-[#27272A] rounded-none p-4 text-white/70 text-sm border border-white/10',
    renderLabel: (title, icon) => (
      <h3 className="text-white font-semibold flex items-center mb-3">
        <i className={`fas ${icon} text-yellow-400 mr-2`} />
        {title}
      </h3>
    ),
  },
  cyberpunk: {
    grid: 'grid gap-3',
    card: 'border-2 border-zinc-700 bg-zinc-900/60 p-3',
    cardDisabled: 'border-2 border-zinc-700 bg-zinc-900/60 p-3',
    select:
      'w-full px-2.5 py-1.5 bg-zinc-800 border-2 border-zinc-700 text-white text-sm font-mono focus:outline-none focus:border-cyberpunk-yellow appearance-none cursor-pointer',
    placeholder:
      'px-2.5 py-1.5 bg-zinc-800 border-2 border-zinc-700 text-zinc-500 text-xs font-mono uppercase tracking-wider',
    notice:
      'border-2 border-zinc-700 bg-zinc-900/60 p-3 font-mono text-[11px] text-zinc-400',
    renderLabel: (title) => (
      <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-cyberpunk-yellow/80 mb-1.5">
        {`// ${title}`}
      </div>
    ),
  },
}

function formatOption(opt: ParamOption): string {
  const label = opt.label || opt.key
  return opt.description ? `${label} ${opt.description}` : label
}

export function ImageParamControls({
  variant,
  modelConfig,
  ratio,
  onRatioChange,
  resolution,
  onResolutionChange,
  quality,
  onQualityChange,
  preferRatio = 'auto',
  className,
}: ImageParamControlsProps) {
  const theme = THEMES[variant]
  const {
    ratioOptions,
    resolutionOptions,
    qualityOptions,
    supportsResolution,
    supportsQuality,
    sizeHidden,
    defaultResolution,
    defaultQuality,
  } = deriveImageParamControls(modelConfig)

  const showQuality = supportsQuality && typeof quality === 'string' && Boolean(onQualityChange)

  // 模型切换后自动归位(当前值不在新选项内时)
  useEffect(() => {
    const next = normalizeOption(ratio, ratioOptions, preferRatio)
    if (next !== ratio) onRatioChange(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratioOptions])

  useEffect(() => {
    if (!supportsResolution) return
    const next = normalizeOption(resolution, resolutionOptions, defaultResolution)
    if (next !== resolution) onResolutionChange(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolutionOptions, supportsResolution])

  useEffect(() => {
    if (!showQuality) return
    const next = normalizeOption(quality as string, qualityOptions, defaultQuality)
    if (next !== quality) onQualityChange?.(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qualityOptions, showQuality])

  if (sizeHidden) {
    return (
      <div className={className ?? ''}>
        <div className={theme.notice}>
          ⚡ 该模型尺寸自适应，如需指定请在提示词中描述（如“横版16:9”）
        </div>
      </div>
    )
  }

  const colCount = 2 + (showQuality ? 1 : 0)
  const colClass = colCount === 3 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2'

  return (
    <div className={className ?? `${theme.grid} ${colClass}`}>
      {/* 比例 */}
      <div className={theme.card}>
        {theme.renderLabel('比例', 'fa-crop-alt')}
        <select
          value={ratio}
          onChange={(e) => onRatioChange(e.target.value)}
          className={theme.select}
          aria-label="比例"
        >
          {ratioOptions.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {formatOption(opt)}
            </option>
          ))}
        </select>
      </div>

      {/* 分辨率 1K/2K/4K */}
      <div className={supportsResolution ? theme.card : theme.cardDisabled}>
        {theme.renderLabel('分辨率', 'fa-expand-arrows-alt')}
        {supportsResolution ? (
          <select
            value={resolution}
            onChange={(e) => onResolutionChange(e.target.value)}
            className={theme.select}
            aria-label="分辨率"
          >
            {resolutionOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {formatOption(opt)}
              </option>
            ))}
          </select>
        ) : (
          <div className={theme.placeholder} aria-label="当前模型不支持分辨率切换">
            按模型默认
          </div>
        )}
      </div>

      {/* 清晰度 quality(auto/low/medium/high) —— 仅 gpt-image-2 等 */}
      {showQuality && (
        <div className={theme.card}>
          {theme.renderLabel('清晰度', 'fa-gem')}
          <select
            value={quality}
            onChange={(e) => onQualityChange?.(e.target.value)}
            className={theme.select}
            aria-label="清晰度"
          >
            {qualityOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {formatOption(opt)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
