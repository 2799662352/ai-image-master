import { describe, expect, it } from 'vitest'
import { StyleAnchorSchema, StyleConflictSchema } from '../schemas/style-anchor-schema'

describe('StyleAnchorSchema', () => {
  it('should parse a valid style anchor', () => {
    const result = StyleAnchorSchema.safeParse({
      medium: 'photorealistic',
      palette: ['#1a1a2e', '#16213e', '#e94560'],
      paletteRatio: '7:2:1',
      lightSource: 'rim light, 45° top-left, 70%',
      shadowDepth: '30%',
      texture: 'film grain, subtle noise',
      colorTemperature: 'warm, ~3500K',
      contrastLevel: 'high',
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing required fields', () => {
    const result = StyleAnchorSchema.safeParse({ medium: 'anime' })
    expect(result.success).toBe(false)
  })
})

describe('StyleConflictSchema', () => {
  it('should parse a valid conflict entry', () => {
    const result = StyleConflictSchema.safeParse({
      field: 'medium',
      userWants: 'photorealistic',
      imageShows: 'anime cel',
    })
    expect(result.success).toBe(true)
  })
})
