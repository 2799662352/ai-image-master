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
  /**
   * 出图张数;仅 multipleImages / nativeBatch 模型且传了 onCountChange 时渲染数量轴。
   * nativeBatch(官转 gpt-image-2 / 2.5、腾讯 image2 fast)的标题是「数量(原生支持)」,
   * 下面挂一行「按张数倍数计费」提示 —— 官转按 token 计费,选 4 张就是 4 份钱,不提醒
   * 的话用户只看见一个「4」。
   */
  count?: number
  onCountChange?: (v: number) => void
  /**
   * 反向提示词;仅 `capabilities.negativePrompt` 的模型且传了 onNegativePromptChange
   * 时渲染。不传 = 该页面不接这个字段,控件自己不会凭空冒出来。
   */
  negativePrompt?: string
  onNegativePromptChange?: (v: string) => void
  /**
   * 透明背景(`background=transparent`,直接出带 alpha 的 PNG);仅
   * `capabilities.transparentBackgroundControl` 的模型(2.5 flare / sunburst)且传了
   * onTransparentBackgroundChange 时渲染。切到不支持的模型会自动回 false ——
   * 透明底是特殊出图模式,忘了关会让后面每张图都带透明底。
   */
  transparentBackground?: boolean
  onTransparentBackgroundChange?: (v: boolean) => void
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
  /** 控件下方的一行小字提示(如原生多图的倍数计费) */
  hint: string
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
    hint: 'mt-2 text-xs text-yellow-300/80 leading-snug',
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
    hint: 'mt-1.5 font-mono text-[10px] leading-snug text-yellow-300/80',
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
  count,
  onCountChange,
  negativePrompt,
  onNegativePromptChange,
  transparentBackground,
  onTransparentBackgroundChange,
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
    supportsCount,
    maxCount,
    nativeBatch,
    supportsNegativePrompt,
    supportsTransparentBackground,
  } = deriveImageParamControls(modelConfig)

  const showQuality = supportsQuality && typeof quality === 'string' && Boolean(onQualityChange)
  const showCount = supportsCount && typeof count === 'number' && Boolean(onCountChange)
  const showNegativePrompt =
    supportsNegativePrompt && typeof negativePrompt === 'string' && Boolean(onNegativePromptChange)
  const showTransparentBackground =
    supportsTransparentBackground &&
    typeof transparentBackground === 'boolean' &&
    Boolean(onTransparentBackgroundChange)

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

  // 模型切换后收敛组图张数: 不支持组图回 1, 超过上限收敛到上限
  useEffect(() => {
    if (typeof count !== 'number' || !onCountChange) return
    if (!supportsCount && count !== 1) {
      onCountChange(1)
    } else if (supportsCount && count > maxCount) {
      onCountChange(maxCount)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsCount, maxCount])

  // 切到不支持透明底的模型时复位:开关消失了但状态还挂着 true,再切回来会「带着上次的
  // 透明底」出图;apiyi 生图页对这个开关的处理也是不持久化 + 切模型复位。
  useEffect(() => {
    if (typeof transparentBackground !== 'boolean' || !onTransparentBackgroundChange) return
    if (!supportsTransparentBackground && transparentBackground) onTransparentBackgroundChange(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsTransparentBackground])

  if (sizeHidden) {
    return (
      <div className={className ?? ''}>
        <div className={theme.notice}>
          ⚡ 该模型尺寸自适应，如需指定请在提示词中描述（如“横版16:9”）
        </div>
      </div>
    )
  }

  const colCount =
    2 + (showQuality ? 1 : 0) + (showCount ? 1 : 0) + (showTransparentBackground ? 1 : 0)
  const colClass =
    colCount >= 5
      ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5'
      : colCount === 4
        ? 'grid-cols-2 sm:grid-cols-4'
        : colCount === 3
          ? 'grid-cols-2 sm:grid-cols-3'
          : 'grid-cols-2'

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

      {/* 清晰度 quality(auto/low/medium/high, 2.5 为 low…max 五档) */}
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

      {/* 数量 —— multipleImages 模型(万相组图 / 千问变体);nativeBatch(官转 gpt-image-2 / 2.5、
          腾讯 image2 fast)标「原生支持」:一次请求按 OpenAI n 回 N 张独立变体,按张数倍数计费 */}
      {showCount && (
        <div className={theme.card}>
          {theme.renderLabel(nativeBatch ? '数量（原生支持）' : '数量', 'fa-images')}
          <select
            value={count}
            onChange={(e) => onCountChange?.(Number(e.target.value))}
            className={theme.select}
            aria-label="数量"
          >
            {Array.from({ length: maxCount }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {`${n} 张`}
              </option>
            ))}
          </select>
          {nativeBatch && (
            <p className={theme.hint} data-testid="native-batch-billing-note">
              {(count as number) > 1
                ? `⚠️ 原生多图：本次约按 ${count} 张倍数计费（${count} 个独立变体）`
                : `一次请求可出 1-${maxCount} 张，按张数倍数计费`}
            </p>
          )}
        </div>
      )}

      {/* 透明背景 background=transparent —— 仅 2.5 flare / sunburst;模型原生出 alpha PNG,不是事后抠图 */}
      {showTransparentBackground && (
        <div className={theme.card}>
          {theme.renderLabel('透明背景', 'fa-chess-board')}
          <select
            value={transparentBackground ? 'on' : 'off'}
            onChange={(e) => onTransparentBackgroundChange?.(e.target.value === 'on')}
            className={theme.select}
            aria-label="透明背景"
          >
            <option value="off">否 默认</option>
            <option value="on">是 带 alpha 通道</option>
          </select>
        </div>
      )}
    </div>
  )
}
