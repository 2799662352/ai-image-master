import { z } from 'zod'

export const StyleAnchorSchema = z.object({
  medium: z.string().describe('Rendering medium: photorealistic, anime cel, 3D CGI, watercolor, etc.'),
  palette: z.array(z.string()).describe('Dominant color hex codes, 2-5 colors'),
  paletteRatio: z.string().describe('Color ratio, e.g. "7:2:1"'),
  lightSource: z.string().describe('Light type + angle + intensity, e.g. "rim light, 45° top-left, 70%"'),
  shadowDepth: z.string().describe('% of frame in shadow, e.g. "30%"'),
  texture: z.string().describe('Surface quality: film grain, cel shading, painterly strokes, etc.'),
  colorTemperature: z.string().describe('Warm/cool + Kelvin estimate, e.g. "warm, ~3500K"'),
  contrastLevel: z.string().describe('Contrast: high / medium / low'),
})

export type StyleAnchor = z.infer<typeof StyleAnchorSchema>

export const StyleConflictSchema = z.object({
  field: z.string(),
  userWants: z.string(),
  imageShows: z.string(),
})

export type StyleConflict = z.infer<typeof StyleConflictSchema>
