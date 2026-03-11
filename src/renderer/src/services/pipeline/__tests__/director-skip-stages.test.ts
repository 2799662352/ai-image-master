import { describe, expect, it } from 'vitest'
import { shouldRetryAnalysis, extractVarsForDesignAndAssemble, extractVarsForContactSheet, buildStyleAuthorityPrompt, pickLowItems } from '../DirectorPipeline'

describe('DirectorPipeline skip stages', () => {
  describe('shouldRetryAnalysis with skip flags', () => {
    it('should continue when scene is user-skipped even if data is null', () => {
      expect(shouldRetryAnalysis({
        scene: null,
        characters: null,
        analysisRetryCount: 0,
        skipAnalyzeScene: true,
        skipCharacterAnchors: false,
      })).toBe('continue')
    })

    it('should continue when characters is user-skipped even if data is null', () => {
      expect(shouldRetryAnalysis({
        scene: null,
        characters: null,
        analysisRetryCount: 0,
        skipAnalyzeScene: false,
        skipCharacterAnchors: true,
      })).toBe('continue')
    })

    it('should continue when both are user-skipped', () => {
      expect(shouldRetryAnalysis({
        scene: null,
        characters: null,
        analysisRetryCount: 0,
        skipAnalyzeScene: true,
        skipCharacterAnchors: true,
      })).toBe('continue')
    })

    it('should still retry when both fail without skip flags', () => {
      expect(shouldRetryAnalysis({
        scene: null,
        characters: null,
        analysisRetryCount: 0,
        skipAnalyzeScene: false,
        skipCharacterAnchors: false,
      })).toBe('retry')
    })

    it('should abort when retries exhausted and nothing skipped', () => {
      expect(shouldRetryAnalysis({
        scene: null,
        characters: null,
        analysisRetryCount: 2,
        skipAnalyzeScene: false,
        skipCharacterAnchors: false,
      })).toBe('abort')
    })
  })
})

describe('style anchor in extractVarsForDesignAndAssemble', () => {
  it('should include style_authority_chain when styleAnchor is present', () => {
    const state = {
      scene: { env: 'test', subjects: [], style: '', story: '' },
      characters: { characters: [] },
      sceneDescription: '',
      styleInstructions: '',
      layout: { rows: 2, cols: 3, panelCount: 6 },
      retryFeedback: '',
      prompts: null,
      styleAnchor: {
        medium: 'photorealistic',
        palette: ['#000', '#fff'],
        paletteRatio: '1:1',
        lightSource: 'key light, front, 80%',
        shadowDepth: '20%',
        texture: 'film grain',
        colorTemperature: 'neutral, ~5500K',
        contrastLevel: 'medium',
      },
      styleConflicts: [],
    }
    const vars = extractVarsForDesignAndAssemble(state as any)
    expect(vars.style_authority_chain).toContain('photorealistic')
    expect(vars.style_authority_chain).toContain('film grain')
  })

  it('should return empty style_authority_chain when styleAnchor is null', () => {
    const state = {
      scene: { env: 'test', subjects: [], style: '', story: '' },
      characters: { characters: [] },
      sceneDescription: '',
      styleInstructions: '',
      layout: { rows: 2, cols: 3, panelCount: 6 },
      retryFeedback: '',
      prompts: null,
      styleAnchor: null,
      styleConflicts: [],
    }
    const vars = extractVarsForDesignAndAssemble(state as any)
    expect(vars.style_authority_chain).toBe('')
  })
})

describe('style anchor in extractVarsForContactSheet', () => {
  it('should include style_anchor_section when styleAnchor is present', () => {
    const state = {
      scene: { env: 'test', subjects: [], style: '', story: '' },
      characters: { characters: [] },
      sceneDescription: '',
      styleInstructions: '',
      layout: { rows: 2, cols: 3, panelCount: 6 },
      prompts: [],
      ratio: '16:9',
      semanticOrientation: 'landscape',
      inputImages: [],
      styleAnchor: {
        medium: 'anime cel',
        palette: ['#ff0000'],
        paletteRatio: '1',
        lightSource: 'fill, even, 50%',
        shadowDepth: '10%',
        texture: 'cel shading',
        colorTemperature: 'cool, ~7000K',
        contrastLevel: 'low',
      },
      styleConflicts: [],
    }
    const vars = extractVarsForContactSheet(state as any)
    expect(vars.style_anchor_section).toContain('anime cel')
    expect(vars.style_anchor_section).toContain('cel shading')
  })
})

describe('buildStyleAuthorityPrompt', () => {
  it('should produce a prompt with user template priority when template is set', () => {
    const result = buildStyleAuthorityPrompt(
      'cinematic',
      'Cinematic Contact Sheet, award-winning...',
      'cyberpunk rain chase scene',
    )
    expect(result).toContain('cinematic')
    expect(result).toContain('USER FORCED STYLE')
  })

  it('should return director authority text when no template and no scene hints', () => {
    const result = buildStyleAuthorityPrompt('default', '', '')
    expect(result).toContain('director has full authority over art style')
  })

  it('should include narrative style hints from description', () => {
    const result = buildStyleAuthorityPrompt('default', '', 'a noir cyberpunk scene in rain')
    expect(result).toContain('noir')
    expect(result).toContain('cyberpunk')
  })
})

describe('pickLowItems includes styleConsistency', () => {
  it('should detect low styleConsistency', () => {
    const report = {
      score: 5,
      faceConsistency: 8,
      outfitConsistency: 7,
      weaponConsistency: 9,
      styleContinuity: 8,
      styleConsistency: 3,
    }
    const low = pickLowItems(report as any, 6)
    expect(low).toContain('style consistency')
  })

  it('should not flag styleConsistency when it is above threshold', () => {
    const report = {
      score: 8,
      faceConsistency: 8,
      outfitConsistency: 7,
      weaponConsistency: 9,
      styleContinuity: 8,
      styleConsistency: 7,
    }
    const low = pickLowItems(report as any, 6)
    expect(low).not.toContain('style consistency')
  })
})
