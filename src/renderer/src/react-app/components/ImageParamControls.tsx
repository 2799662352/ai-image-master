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
  /** 组图张数;仅 multipleImages 模型且传了 onCountChange 时渲染数量轴 */
  count?: number
  onCountChange?: (v: number) => void
  /**
   * 反向提示词;仅 `capabilities.negativePrompt` 的模型且传了 onNegativePromptChange
   * 时渲染。不传 = 该页面不接这个字段,控件自己不会凭空冒出来。
   */
  negativePrompt?: string
  onNegativePromptChange?: (v: string) => void
  /**
   * 图层分离(Ark `layer_decomposition`);仅 `capabilities.layerDecomposition` 的模型
   * 且传了 onLayerDecompositionChange 时渲染。开启后不是「出一张新图」而是「把参考图
   * 拆成 1 张底图 + 若干透明图层」,因此比例/数量会被上游忽略 —— 这里同步禁用它们,
   * 免得用户选了 16:9 却拿到一张比例不符的底图还找不到原因。
   */
  layerDecomposition?: boolean
  onLayerDecompositionChange?: (v: boolean) => void
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
  count,
  onCountChange,
  negativePrompt,
  onNegativePromptChange,
  layerDecomposition,
  onLayerDecompositionChange,
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
    supportsNegativePrompt,
    supportsLayerDecomposition,
  } = deriveImageParamControls(modelConfig)

  const showQuality = supportsQuality && typeof quality === 'string' && Boolean(onQualityChange)
  const showCount = supportsCount && typeof count === 'number' && Boolean(onCountChange)
  const showNegativePrompt =
    supportsNegativePrompt && typeof negativePrompt === 'string' && Boolean(onNegativePromptChange)
  const showLayerDecomposition =
    supportsLayerDecomposition &&
    typeof layerDecomposition === 'boolean' &&
    Boolean(onLayerDecompositionChange)
  // 开启拆分后比例/数量由上游按图内容决定,发过去也是被忽略 —— 灰掉而不是留着骗人。
  const splitting = showLayerDecomposition && layerDecomposition === true

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

  // 切到不支持拆分的模型时把开关关掉。留着 true 的话开关本身已经不渲染了,
  // 用户看不到也关不掉,却会一路发到 ApiService 被能力守卫拒掉 —— 表现为
  // 「换个模型就生成不了了」这种查无可查的故障。
  useEffect(() => {
    if (!supportsLayerDecomposition && layerDecomposition) onLayerDecompositionChange?.(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsLayerDecomposition])

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
    2 + (showQuality ? 1 : 0) + (showCount ? 1 : 0) + (showLayerDecomposition ? 1 : 0)
  const colClass =
    colCount >= 4
      ? 'grid-cols-2 sm:grid-cols-4'
      : colCount === 3
        ? 'grid-cols-2 sm:grid-cols-3'
        : 'grid-cols-2'

  return (
    <div className={className ?? `${theme.grid} ${colClass}`}>
      {/* 比例 */}
      <div className={splitting ? theme.cardDisabled : theme.card}>
        {theme.renderLabel('比例', 'fa-crop-alt')}
        {splitting ? (
          <div className={theme.placeholder} aria-label="图层分离时比例由原图决定">
            跟随原图
          </div>
        ) : (
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
        )}
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

      {/* 数量(组图) —— 仅 multipleImages 模型(如万相 wan2.7) */}
      {showCount && (
        <div className={splitting ? theme.cardDisabled : theme.card}>
          {theme.renderLabel('数量', 'fa-images')}
          {splitting ? (
            <div className={theme.placeholder} aria-label="图层分离时张数由图层数决定">
              按图层数
            </div>
          ) : (
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
          )}
        </div>
      )}

      {/* 图层分离 —— 仅 capabilities.layerDecomposition(Seedream 5.0 Pro) */}
      {showLayerDecomposition && (
        <div className={theme.card}>
          {theme.renderLabel('图层分离', 'fa-layer-group')}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={layerDecomposition}
              onChange={(e) => onLayerDecompositionChange?.(e.target.checked)}
              aria-label="图层分离"
            />
            {/* 两个 variant 的卡片都是深色底，文字颜色必须显式给，别指望继承 */}
            <span className="text-xs text-white/80">
              {layerDecomposition ? '拆成透明图层' : '关闭'}
            </span>
          </label>
          <div className="mt-1 text-[11px] text-white/50">
            {layerDecomposition ? '需上传 1 张待拆分的图' : '把参考图拆成底图 + 透明图层'}
          </div>
        </div>
      )}
    </div>
  )
}
