import { describe, expect, it } from 'vitest'
import { codeVerify, routeAfterCodeVerify } from '../DirectorPipeline'

describe('codeVerify', () => {
  const makeState = (overrides: Record<string, unknown> = {}) => ({
    characters: { characters: [
      { name: 'Alice', anchor: 'blonde hair, blue dress' },
      { name: 'Bob', anchor: 'tall man, black suit' },
    ]},
    prompts: [
      { id: 1, prompt: 'Alice in blue dress walking, photorealistic', negativePrompt: 'blurry' },
      { id: 2, prompt: 'Bob in black suit running, photorealistic', negativePrompt: 'blurry' },
      { id: 3, prompt: 'Alice and Bob together, photorealistic', negativePrompt: 'blurry' },
    ],
    layout: { rows: 1, cols: 3, panelCount: 3 },
    template: 'cinematic',
    styleInstructions: 'photorealistic, 8K',
    styleAnchor: { medium: 'photorealistic', palette: [], paletteRatio: '', lightSource: '', shadowDepth: '', texture: '', colorTemperature: '', contrastLevel: '' },
    styleConflicts: [],
    ...overrides,
  })

  it('should return score 10 when all checks pass', () => {
    const result = codeVerify(makeState() as any)
    expect(result.score).toBe(10)
    expect(result.ok).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  it('should deduct points for panel count mismatch', () => {
    const result = codeVerify(makeState({ layout: { rows: 2, cols: 3, panelCount: 6 } }) as any)
    expect(result.score).toBeLessThan(10)
    expect(result.issues.some(i => i.includes('panels'))).toBe(true)
  })

  it('should deduct points for missing character in prompts', () => {
    const result = codeVerify(makeState({
      prompts: [
        { id: 1, prompt: 'a person walking, photorealistic', negativePrompt: 'blurry' },
        { id: 2, prompt: 'another person, photorealistic', negativePrompt: 'blurry' },
        { id: 3, prompt: 'empty scene, photorealistic', negativePrompt: 'blurry' },
      ],
    }) as any)
    expect(result.score).toBeLessThan(10)
    expect(result.issues.some(i => i.includes('Alice'))).toBe(true)
  })

  it('should deduct points for missing style token', () => {
    const result = codeVerify(makeState({
      prompts: [
        { id: 1, prompt: 'Alice in blue dress walking, anime style', negativePrompt: 'blurry' },
        { id: 2, prompt: 'Bob in black suit, anime cel', negativePrompt: 'blurry' },
        { id: 3, prompt: 'Alice and Bob together, anime', negativePrompt: 'blurry' },
      ],
    }) as any)
    expect(result.issues.some(i => i.includes('Style') || i.includes('style'))).toBe(true)
  })

  it('should deduct points for empty prompts', () => {
    const result = codeVerify(makeState({
      prompts: [
        { id: 1, prompt: '', negativePrompt: 'blurry' },
        { id: 2, prompt: 'Bob in black suit', negativePrompt: 'blurry' },
        { id: 3, prompt: 'Alice and Bob', negativePrompt: 'blurry' },
      ],
    }) as any)
    expect(result.score).toBeLessThan(8)
    expect(result.issues.some(i => i.includes('empty'))).toBe(true)
  })

  it('should handle null characters gracefully', () => {
    const result = codeVerify(makeState({ characters: null }) as any)
    expect(result.score).toBeGreaterThanOrEqual(0)
  })

  it('should handle null prompts gracefully', () => {
    const result = codeVerify(makeState({ prompts: null }) as any)
    expect(result.ok).toBe(false)
  })

  it('should not false-positive styleConsistency on hairstyle issues', () => {
    const result = codeVerify({
      characters: { characters: [{ name: 'Alice', anchor: 'blonde hair' }] },
      prompts: [
        { id: 1, prompt: 'Alice walking, photorealistic', negativePrompt: '' },
        { id: 2, prompt: 'Alice running, photorealistic', negativePrompt: '' },
      ],
      layout: { rows: 1, cols: 2, panelCount: 2 },
      template: 'cinematic',
      styleInstructions: 'photorealistic',
      styleAnchor: { medium: 'photorealistic', palette: [], paletteRatio: '', lightSource: '', shadowDepth: '', texture: '', colorTemperature: '', contrastLevel: '' },
      styleConflicts: [],
    } as any)
    expect(result.styleConsistency).toBe(10)
  })

  it('should track style issues separately from character issues', () => {
    const result = codeVerify({
      characters: { characters: [] },
      prompts: [
        { id: 1, prompt: 'Alice walking, anime cel', negativePrompt: '' },
      ],
      layout: { rows: 1, cols: 1, panelCount: 1 },
      template: 'cinematic',
      styleInstructions: 'photorealistic',
      styleAnchor: { medium: 'photorealistic', palette: [], paletteRatio: '', lightSource: '', shadowDepth: '', texture: '', colorTemperature: '', contrastLevel: '' },
      styleConflicts: [],
    } as any)
    expect(result.styleConsistency).toBe(8)
    expect(result.characterConsistency).toBe(true)
  })
})

describe('routeAfterCodeVerify', () => {
  it('should route to generate when code verify passes', () => {
    const state = { report: { score: 8, ok: true, issues: [] }, skipVerify: false, retryCount: 0 }
    expect(routeAfterCodeVerify(state as any)).toBe('generate')
  })

  it('should route to deepVerify when code verify fails and skipVerify is false', () => {
    const state = { report: { score: 4, ok: false, issues: ['problem'] }, skipVerify: false, retryCount: 0 }
    expect(routeAfterCodeVerify(state as any)).toBe('deepVerify')
  })

  it('should route to generate when code verify fails but skipVerify is true', () => {
    const state = { report: { score: 4, ok: false, issues: ['problem'] }, skipVerify: true, retryCount: 0 }
    expect(routeAfterCodeVerify(state as any)).toBe('generate')
  })
})
