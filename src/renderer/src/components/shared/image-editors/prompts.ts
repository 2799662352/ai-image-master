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

const HEX_TO_NAME: Record<string, string> = {
  '#ffe4c4': 'warm golden',
  '#fff8e7': 'natural daylight',
  '#ffffff': 'neutral white',
  '#d4e4ff': 'cool white',
  '#b4c7ff': 'cool blue',
  '#ffd6e8': 'soft pink',
}

function colorName(hex: string): string {
  const known = HEX_TO_NAME[hex.toLowerCase()]
  if (known) return known
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 510
  if (max === min) return l > 0.85 ? 'bright white' : 'neutral gray'
  let h = 0
  const d = max - min
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  if (h < 30) return 'warm red'
  if (h < 60) return 'warm orange'
  if (h < 90) return 'warm yellow'
  if (h < 150) return 'green'
  if (h < 210) return 'cyan'
  if (h < 270) return 'blue'
  if (h < 330) return 'purple'
  return 'warm red'
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
    `Relight this image with a ${colorName(color)} light source ${dirDesc} at ${intensityPct}% intensity.`,
  ]
  if (rimLight) parts.push('Add a subtle rim light to separate the subject from the background.')
  parts.push('Keep the same subject, composition, and background. Only change the lighting.')
  return parts.join(' ')
}
