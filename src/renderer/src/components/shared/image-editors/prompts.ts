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

export function buildLightingPrompt(
  direction: string,
  brightness: number,
  color: string,
  rimLight: boolean,
): string {
  const dirDesc = LIGHT_DIR_MAP[direction] || `from the ${direction}`
  const intensityPct = Math.round(brightness * 25)
  const parts = [
    `Relight this image with a ${color} light source ${dirDesc} at ${intensityPct}% intensity.`,
  ]
  if (rimLight) parts.push('Add a subtle rim light to separate the subject from the background.')
  parts.push('Keep the same subject, composition, and background. Only change the lighting.')
  return parts.join(' ')
}

/**
 * 在 prompt 前加上参考图指代前缀.
 * 约定: `【@图片N】` 是给下游模型看的视觉标记, 后端不解析.
 * @param prompt 编辑器生成的裸 prompt
 * @param refIndex 1-based, refImages 数组里的绝对位置
 */
export function withRefPrefix(prompt: string, refIndex: number): string {
  const n = refIndex > 0 ? refIndex : 1
  return `Based on reference image 【@图片${n}】 ${prompt}`
}
