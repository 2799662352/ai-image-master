import { makeToken } from '../media-tokens/types'

const AZIMUTH_MAP: Record<number, string> = {
  0: 'from the front',
  45: 'from the front-right at a 45-degree angle',
  90: 'from the right side',
  135: 'from the back-right at a 135-degree angle',
  180: 'from the back',
  225: 'from the back-left at a 225-degree angle',
  270: 'from the left side',
  315: 'from the front-left at a 315-degree angle',
}

const ELEVATION_MAP: Record<string, string> = {
  '-30': 'looking up from a low angle',
  '0': 'at eye level',
  '30': 'from a slightly elevated angle looking down',
  '60': 'from a high overhead angle looking down',
}

const DISTANCE_MAP: Record<string, string> = {
  '0.6': 'as a close-up shot',
  '1': 'at a medium distance',
  '1.4': 'as a wide shot from further away',
}

function snapToNearest(value: number, options: number[]): number {
  return options.reduce((prev, curr) =>
    Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev,
  )
}

export function buildCameraPrompt(
  horizontal: number,
  vertical: number,
  distance: number,
): string {
  const azSnap = snapToNearest(horizontal, Object.keys(AZIMUTH_MAP).map(Number))
  const elSnap = snapToNearest(vertical, [-30, 0, 30, 60])
  const distSnap = snapToNearest(distance, [0.6, 1.0, 1.4])

  const azName = AZIMUTH_MAP[azSnap]
  const elName = ELEVATION_MAP[String(elSnap)]
  const distKey = distSnap === 1 ? '1' : distSnap.toFixed(1)
  const distName = DISTANCE_MAP[distKey]

  return `Rotate the camera to view this subject ${azName}, ${elName}, ${distName}. Keep the same subject, style, lighting, and background. Only change the camera angle and distance.`
}

const LIGHT_DIR_MAP: Record<string, string> = {
  left: 'from the left side',
  top: 'from above',
  right: 'from the right side',
  front: 'from the front',
  bottom: 'from below',
  back: 'from behind',
}

/** 8-way horizontal label from azimuth (0=front, 90=right, 180=back, 270=left). */
function azimuthLabel(az: number): string {
  const a = ((az % 360) + 360) % 360
  const zones: { max: number; label: string }[] = [
    { max: 22.5, label: 'front' },
    { max: 67.5, label: 'front-right' },
    { max: 112.5, label: 'right' },
    { max: 157.5, label: 'back-right' },
    { max: 202.5, label: 'back' },
    { max: 247.5, label: 'back-left' },
    { max: 292.5, label: 'left' },
    { max: 337.5, label: 'front-left' },
    { max: 360, label: 'front' },
  ]
  return zones.find((z) => a <= z.max)!.label
}

/**
 * Build a natural-language direction phrase from a free (azimuth, elevation).
 * Poles (|el| > 70) render without horizontal qualifier; moderate elevations
 * combine 'upper/lower' with the 8-way horizontal label.
 */
function freeAngleDesc(az: number, el: number): string {
  if (el > 70) return 'from directly overhead'
  if (el < -70) return 'from directly below'

  const horiz = azimuthLabel(az)
  const vert =
    el >= 30 ? 'upper'
    : el <= -30 ? 'lower'
    : ''

  // "front" + vert 'upper' → "from the upper-front" reads awkwardly; prefer
  // "from above and in front" style for cardinal horizontals with a vert modifier.
  if (vert && (horiz === 'front' || horiz === 'back' || horiz === 'left' || horiz === 'right')) {
    const side =
      horiz === 'front' ? 'in front'
      : horiz === 'back' ? 'behind'
      : `to the ${horiz}`
    return vert === 'upper' ? `from above and ${side}` : `from below and ${side}`
  }
  if (vert) {
    return `from the ${vert}-${horiz}`
  }
  // Level, no vertical modifier
  if (horiz === 'front') return 'from the front'
  if (horiz === 'back') return 'from behind'
  return `from the ${horiz}`
}

export type LightingInput = string | { az: number; el: number }

/**
 * 把 [0,360) 的方位角转成 [-180,180] 有符号显示, 与编辑器滑块的视觉约定一致.
 * 例: 355° -> -5°, 10° -> 10°, 200° -> -160°.
 */
function signedAz(az: number): number {
  const a = ((az % 360) + 360) % 360
  return a > 180 ? a - 360 : a
}

export function buildLightingPrompt(
  input: LightingInput,
  brightness: number,
  color: string,
  rimLight: boolean,
): string {
  let dirDesc: string
  if (typeof input === 'string') {
    // 预设路径: 纯预设标签, 无数字后缀 —— 磁吸开且 onUp 落回预设时走这里.
    dirDesc = LIGHT_DIR_MAP[input] || `from the ${input}`
  } else {
    // 自由角度路径: 描述短语 + 显式度数后缀. 度数让用户视觉上一眼能区分
    // "真正的自由拖拽结果" 和 "吸回预设的结果", 避免 az≈0 时 prompt 与 'front'
    // 预设完全同字, 造成"磁吸没关"的错觉.
    const az = Math.round(signedAz(input.az))
    const el = Math.round(input.el)
    dirDesc = `${freeAngleDesc(input.az, input.el)} (azimuth ${az}°, elevation ${el}°)`
  }

  const intensityPct = Math.round(brightness * 25)
  const parts = [
    `Relight this image with a ${color} light source ${dirDesc} at ${intensityPct}% intensity.`,
  ]
  if (rimLight) parts.push('Add a subtle rim light to separate the subject from the background.')
  parts.push('Keep the same subject, composition, and background. Only change the lighting.')
  return parts.join(' ')
}

/* ============================ 全景图生成 ============================ */

/**
 * 360° equirectangular 全景图生成约束块。
 * 逆向自 RunningHub「全景图」节点模板(见 docs/全景图节点-逆向设计文档.md §3),
 * 作用:把模型从默认的「单视角好看图」强拉回「可环视的等距柱状底图」。
 */
const PANORAMA_CONSTRAINTS = `技术要求:
- 画面必须为标准的 360° equirectangular(等距柱状)全景格式。
- 画面需支持完整的 360° 水平方向视野,并包含上方与下方的完整空间信息,形成可环视的沉浸式全景效果。
- 视点应基于单一固定观察点展开,保证整个场景围绕观察者连续展开,而不是普通广角图、鱼眼图、拼接感很强的图,或多个画面拼合的分镜图。

画面要求:
- 场景的前、后、左、右、上、下必须在空间逻辑上完整闭合,环绕关系自然,过渡连贯。
- 所有元素应符合统一的透视关系、比例关系、光影关系和空间结构,确保整体真实可信。
- 保持画面首尾衔接自然,避免左右边缘在拼接处出现断裂、错位、重复、结构冲突或明显接缝。
- 画面需具有沉浸感、空间延展感和真实环境包裹感。
- 细节应丰富、清晰,主体信息明确,整体构图适合在 360 全景查看器中观看。
- 不要生成普通单视角构图,不要生成平面海报式画面,不要生成多镜头拼贴效果。

输出目标:
- 最终结果应是一张高质量、完整、连续、可环视的 360° 全景图(建议宽高比 2:1)。
- 严格遵循下述内容、氛围、风格、材质、光线、色彩与关键元素要求。`

export type PanoramaMode = 'txt' | 'img'

export interface PanoramaPromptInput {
  /** 艺术风格,如「写实风格」「日式动画」 */
  style?: string
  /** 具体内容描述,如「现代客厅,温馨的灯光」 */
  desc?: string
  /** 图生图补充描述(可空) */
  supplement?: string
}

/**
 * 构造 360° 全景图生成提示词。
 * - `txt` 文生图:按 风格 + 描述 生成。
 * - `img` 图生图:基于参考图生成,并强调保持参考图元素不变;补充描述可选。
 *   (参考图指代前缀由 withRefPrefix 在外层按需追加。)
 */
export function buildPanoramaPrompt(mode: PanoramaMode, input: PanoramaPromptInput = {}): string {
  const style = (input.style || '').trim()
  const desc = (input.desc || '').trim()
  const supplement = (input.supplement || '').trim()

  if (mode === 'img') {
    const head =
      '请根据参考图,生成一张真正可用于 360 度观看的全景图,确保参考图中的元素保持不变。'
    const tail = supplement ? `\n\n补充描述:\n${supplement}` : ''
    return `${head}\n\n${PANORAMA_CONSTRAINTS}${tail}`
  }

  const head = '请根据后续提供的详细描述,生成一张真正可用于 360 度观看的全景图。'
  const detail = `\n\n以下是详细描述:\n艺术风格:${style || '写实风格'}\n描述:${desc || '(请填写场景内容)'}`
  return `${head}\n\n${PANORAMA_CONSTRAINTS}${detail}`
}

/**
 * 在 prompt 前加上参考图指代前缀.
 * 约定: `【@图片N】` 是给下游模型看的视觉标记, 后端不解析.
 * @param prompt 编辑器生成的裸 prompt
 * @param refIndex 1-based, refImages 数组里的绝对位置
 */
export function withRefPrefix(prompt: string, refIndex: number): string {
  const n = refIndex > 0 ? refIndex : 1
  return `Based on reference image ${makeToken(n)} ${prompt}`
}
