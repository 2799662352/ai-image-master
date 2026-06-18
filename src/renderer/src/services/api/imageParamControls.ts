/**
 * 图像参数控制 —— 单一事实来源。
 *
 * 比例(ratio) / 清晰度档位(resolution: 1K/2K/4K) / 质量(quality: auto/low/medium/high)
 * 三个独立轴的「可选项 + 能力位 + 兜底列表」全部在这里派生。
 *
 * 所有页面(Director / Batch / Generate)通过 <ImageParamControls> 共享这套逻辑,
 * 改一处即可影响全部页面。详见 ImageParamControls.tsx。
 */

export interface ParamOption {
  key: string
  label?: string
  description?: string
}

/** getCurrentModel() 返回的模型配置快照里与图像参数相关的子集 */
export interface ImageParamModelConfig {
  ratios?: ParamOption[]
  resolutions?: ParamOption[]
  qualities?: ParamOption[]
  defaultResolution?: string
  defaultQuality?: string
  sizeStrategy?: string
  capabilities?: {
    resolutionControl?: boolean
    qualityControl?: boolean
    /** 是否支持一次出多张(组图) */
    multipleImages?: boolean
    /** 单次最大出图张数(组图上限) */
    maxOutputs?: number
  }
}

export interface ImageParamControlsState {
  ratioOptions: ParamOption[]
  resolutionOptions: ParamOption[]
  qualityOptions: ParamOption[]
  supportsResolution: boolean
  supportsQuality: boolean
  /** 该模型尺寸完全由提示词决定(prompt 策略), 隐藏比例/清晰度控件 */
  sizeHidden: boolean
  defaultResolution: string
  defaultQuality: string
  /** 是否支持组图(一次多张) */
  supportsCount: boolean
  /** 组图上限(>=2 才有意义); 不支持时为 1 */
  maxCount: number
}

export const FALLBACK_RATIO_OPTIONS: ParamOption[] = [
  { key: 'auto', label: '自适应', description: '智能' },
  { key: '1:1', label: '方形 1:1', description: '常用' },
  { key: '16:9', label: '横版 16:9', description: '宽屏' },
  { key: '9:16', label: '竖版 9:16', description: '竖屏' },
  { key: '4:3', label: '横版 4:3', description: '标准' },
  { key: '3:4', label: '竖版 3:4', description: '标准' },
  { key: '3:2', label: '横版 3:2', description: '经典' },
  { key: '2:3', label: '竖版 2:3', description: '经典' },
  { key: '21:9', label: '影院 21:9', description: '超宽屏' },
  { key: '5:4', label: '横版 5:4', description: '传统' },
  { key: '4:5', label: '竖版 4:5', description: '社媒' },
]

export const FALLBACK_RESOLUTION_OPTIONS: ParamOption[] = [
  { key: '2K', label: '2K 高清', description: '标准' },
  { key: '4K', label: '4K 超清', description: '细节' },
]

/**
 * 根据模型配置派生三轴控件状态。输入为 getCurrentModel() 快照(可为 null)。
 */
export function deriveImageParamControls(
  modelConfig: ImageParamModelConfig | null | undefined,
): ImageParamControlsState {
  const cfg = modelConfig || {}

  const ratioOptions =
    Array.isArray(cfg.ratios) && cfg.ratios.length ? cfg.ratios : FALLBACK_RATIO_OPTIONS

  const supportsResolution = Boolean(
    cfg.capabilities?.resolutionControl && cfg.resolutions?.length,
  )
  const resolutionOptions =
    supportsResolution && cfg.resolutions ? cfg.resolutions : FALLBACK_RESOLUTION_OPTIONS

  const supportsQuality = Boolean(cfg.capabilities?.qualityControl && cfg.qualities?.length)
  const qualityOptions = supportsQuality && cfg.qualities ? cfg.qualities : []

  const sizeHidden = cfg.sizeStrategy === 'prompt'

  const maxCount = Math.max(1, cfg.capabilities?.maxOutputs ?? 1)
  const supportsCount = Boolean(cfg.capabilities?.multipleImages) && maxCount > 1

  return {
    ratioOptions,
    resolutionOptions,
    qualityOptions,
    supportsResolution,
    supportsQuality,
    sizeHidden,
    defaultResolution: cfg.defaultResolution || '2K',
    defaultQuality: cfg.defaultQuality || 'auto',
    supportsCount,
    maxCount,
  }
}

/**
 * 自动归位: 当前值不在选项内时, 优先用 prefer, 否则回退到第一个选项。
 * 选项为空则原样返回当前值。
 */
export function normalizeOption(
  current: string,
  options: ParamOption[],
  prefer?: string,
): string {
  if (!options.length) return current
  if (options.some((o) => o.key === current)) return current
  if (prefer && options.some((o) => o.key === prefer)) return prefer
  return options[0].key
}
