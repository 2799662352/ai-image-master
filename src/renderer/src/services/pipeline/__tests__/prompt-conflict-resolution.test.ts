import { describe, expect, it } from 'vitest'
import { resolveStylePrefix, buildAdaptiveNegativePrompt, buildReferenceImageRoleRules } from '../DirectorPipeline'

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
