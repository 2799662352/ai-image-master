import { describe, expect, it } from 'vitest'
import { resolveStylePrefix, buildAdaptiveNegativePrompt, buildReferenceImageRoleRules, extractVarsForContactSheet } from '../DirectorPipeline'

describe('resolveStylePrefix', () => {
  it('should return styleAnchor medium when available', () => {
    const anchor = {
      medium: 'photorealistic',
      palette: ['#000'], paletteRatio: '1', lightSource: '', shadowDepth: '',
      texture: '', colorTemperature: '', contrastLevel: '',
    }
    expect(resolveStylePrefix(anchor, 'cinematic', '')).toBe('photorealistic')
  })

  it('should fallback to template medium map when no styleAnchor', () => {
    expect(resolveStylePrefix(null, 'cinematic', '')).toBe('photorealistic, cinematic photography')
  })

  it('should fallback to template medium map for anime', () => {
    expect(resolveStylePrefix(null, 'anime', '')).toBe('anime screencap, TV anime')
  })

  it('should return empty string for unknown template without styleAnchor', () => {
    expect(resolveStylePrefix(null, 'unknown-template', '')).toBe('')
  })

  it('should return empty string when no template and no anchor', () => {
    expect(resolveStylePrefix(null, '', '')).toBe('')
  })
})

describe('buildAdaptiveNegativePrompt', () => {
  it('should add anime exclusions for cinematic template', () => {
    const result = buildAdaptiveNegativePrompt('blurry, lowres', 'cinematic', null)
    expect(result).toContain('anime')
    expect(result).toContain('cartoon')
    expect(result).toContain('cel shading')
    expect(result).toContain('blurry')
  })

  it('should add photorealistic exclusions for anime template', () => {
    const result = buildAdaptiveNegativePrompt('blurry, lowres', 'anime', null)
    expect(result).toContain('photorealistic')
    expect(result).toContain('real person')
    expect(result).not.toContain('anime')
  })

  it('should not duplicate existing terms', () => {
    const result = buildAdaptiveNegativePrompt('blurry, anime, cartoon', 'cinematic', null)
    const parts = result.split(',').map(s => s.trim().toLowerCase())
    const animeCount = parts.filter(p => p === 'anime').length
    expect(animeCount).toBe(1)
  })

  it('should return base unchanged for unknown template', () => {
    const base = 'blurry, lowres'
    expect(buildAdaptiveNegativePrompt(base, 'unknown', null)).toBe(base)
  })

  it('should return base unchanged for empty template', () => {
    const base = 'blurry, lowres'
    expect(buildAdaptiveNegativePrompt(base, '', null)).toBe(base)
  })
})

describe('buildReferenceImageRoleRules', () => {
  it('should return strict rules when template is set', () => {
    const result = buildReferenceImageRoleRules('cinematic', true)
    expect(result).toContain('DO NOT extract')
    expect(result).toContain('TEXT WINS')
    expect(result).toContain('Character identity')
  })

  it('should return relaxed rules when no template', () => {
    const result = buildReferenceImageRoleRules('', false)
    expect(result).toContain('reference images')
    expect(result).not.toContain('TEXT WINS')
  })

  it('should return relaxed rules for default template', () => {
    const result = buildReferenceImageRoleRules('default', false)
    expect(result).not.toContain('TEXT WINS')
  })
})

describe('extractVarsForContactSheet conflict resolution vars', () => {
  const makeState = (overrides: Record<string, unknown> = {}) => ({
    scene: { env: 'test city', subjects: [], style: '', story: '' },
    characters: { characters: [] },
    sceneDescription: '',
    styleInstructions: 'photorealistic, 8K, cinematic',
    layout: { rows: 2, cols: 3, panelCount: 6 },
    prompts: [{ id: 1, prompt: 'a person walking', negativePrompt: 'blurry' }],
    ratio: '16:9',
    semanticOrientation: 'landscape',
    inputImages: [],
    template: 'cinematic',
    styleAnchor: null,
    styleConflicts: [],
    ...overrides,
  })

  it('should include reference_image_role_rules with strict rules when template is set', () => {
    const vars = extractVarsForContactSheet(makeState() as any)
    expect(vars.reference_image_role_rules).toContain('TEXT WINS')
  })

  it('should include relaxed rules when no template', () => {
    const vars = extractVarsForContactSheet(makeState({ template: '', styleInstructions: '' }) as any)
    expect(vars.reference_image_role_rules).not.toContain('TEXT WINS')
  })

  it('should include enhanced_panel_descriptions with style prefix', () => {
    const state = makeState({
      prompts: [
        { id: 1, prompt: 'a person walking in rain', negativePrompt: 'blurry' },
        { id: 2, prompt: 'close-up of face', negativePrompt: 'blurry' },
      ],
    })
    const vars = extractVarsForContactSheet(state as any)
    expect(vars.enhanced_panel_descriptions).toContain('photorealistic, cinematic photography')
  })

  it('should include adaptive_negative_prompt', () => {
    const vars = extractVarsForContactSheet(makeState() as any)
    expect(vars.adaptive_negative_prompt).toContain('anime')
    expect(vars.adaptive_negative_prompt).toContain('cartoon')
  })
})
