/**
 * 光感后处理 —— 共享常量 + 色调映射选择(全景图编辑器与 3D 导演台共用)。
 *
 * 「真源」是 PanoramaEditor.renderFrame:中性(曝光≈1 且 辉光≈0)走干净直出
 * (NoToneMapping),一旦拨离中性才接 AgX 让高光胶片级滚降。这里把那套阈值
 * 与选择逻辑抽成纯函数,供导演台 1:1 复用。
 */
import * as THREE from 'three'

/** 中性判定阈值(与全景 renderFrame 完全一致). */
export const LIGHT_FX = {
  /** 曝光默认值(= renderer.toneMappingExposure). */
  DEFAULT_EXPOSURE: 1.0,
  /** 辉光默认强度(= UnrealBloomPass.strength). */
  DEFAULT_BLOOM: 0,
  /** 辉光半径 / 阈值:只对接近高光起辉,避免整体发灰. */
  BLOOM_RADIUS: 0.4,
  BLOOM_THRESHOLD: 0.85,
  /** 调色默认(中性 = 不改变像素). */
  DEFAULT_CONTRAST: 1.0,
  DEFAULT_SATURATION: 1.0,
  DEFAULT_TEMPERATURE: 0.0,
  DEFAULT_VIGNETTE: 0.0,
  DEFAULT_GRAIN: 0.0,
  /** 环境光照(IBL)默认强度. */
  DEFAULT_ENV_INTENSITY: 1.0,
  /** 阈值:小于此值视为「中性/未启用」. */
  EPS: 0.001,
} as const

/** 色调映射模式(对外可选;'auto' = 复刻全景的中性/AgX 自动切换). */
export type ToneMappingMode = 'auto' | 'none' | 'agx' | 'aces' | 'neutral'

/**
 * 光感 / 调色统一参数(全景图编辑器与 3D 导演台共用同一份形状)。
 * 这是「光感 UI 组件 + 序列化」的唯一真源;两端的 state 都用它。
 */
export interface LightFxValue {
  exposure: number
  bloom: number
  contrast: number
  saturation: number
  temperature: number
  vignette: number
  grain: number
  toneMapping: ToneMappingMode
  /** 环境光照(IBL):仅对 PBR 材质有效(导演台模型);全景内壁球为 MeshBasic,无效. */
  envEnabled: boolean
  envIntensity: number
  /** 景深(Bokeh):基于场景深度做虚化. */
  dofEnabled: boolean
  dofFocus: number
  dofAperture: number
  dofMaxBlur: number
}

/** 统一默认值(中性 = 逐像素不变,与干净直出一致). */
export const LIGHT_FX_VALUE_DEFAULTS: LightFxValue = {
  exposure: LIGHT_FX.DEFAULT_EXPOSURE,
  bloom: LIGHT_FX.DEFAULT_BLOOM,
  contrast: LIGHT_FX.DEFAULT_CONTRAST,
  saturation: LIGHT_FX.DEFAULT_SATURATION,
  temperature: LIGHT_FX.DEFAULT_TEMPERATURE,
  vignette: LIGHT_FX.DEFAULT_VIGNETTE,
  grain: LIGHT_FX.DEFAULT_GRAIN,
  toneMapping: 'auto',
  envEnabled: false,
  envIntensity: LIGHT_FX.DEFAULT_ENV_INTENSITY,
  dofEnabled: false,
  dofFocus: 10,
  dofAperture: 0.0002,
  dofMaxBlur: 0.006,
}

const TONE_MAP: Record<Exclude<ToneMappingMode, 'auto'>, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  neutral: THREE.NeutralToneMapping,
}

/**
 * 与全景 renderFrame 同构:曝光≠1 或 辉光>0(或任意调色启用)→ AgX,否则干净直出。
 * `mode!=='auto'` 时直接用指定模式。
 */
export function resolveToneMapping(
  mode: ToneMappingMode,
  exposure: number,
  bloom: number,
  gradeActive: boolean,
): THREE.ToneMapping {
  if (mode !== 'auto') return TONE_MAP[mode]
  const hasExposure = Math.abs(exposure - 1) > LIGHT_FX.EPS
  const hasBloom = bloom > LIGHT_FX.EPS
  return hasExposure || hasBloom || gradeActive
    ? THREE.AgXToneMapping
    : THREE.NoToneMapping
}
