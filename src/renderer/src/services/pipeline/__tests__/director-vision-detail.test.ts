import { describe, expect, it } from 'vitest'
import { resolveVisionDetailByPass } from '../DirectorPipeline'

describe('DirectorPipeline vision detail controls', () => {
  it('should keep current default quality per pass', () => {
    expect(resolveVisionDetailByPass({}, 'analyzeScene')).toBe('high')
    expect(resolveVisionDetailByPass({}, 'extractCharacterAnchors')).toBe('high')
    expect(resolveVisionDetailByPass({}, 'designAndAssemble')).toBe('low')
    expect(resolveVisionDetailByPass({}, 'verifyConsistency')).toBe('low')
  })

  it('should allow overriding each pass independently', () => {
    const state = {
      visionDetailAnalyzeScene: 'low',
      visionDetailCharacterAnchors: 'auto',
      visionDetailDesignAssemble: 'high',
      visionDetailVerifyConsistency: 'high',
    }

    expect(resolveVisionDetailByPass(state, 'analyzeScene')).toBe('low')
    expect(resolveVisionDetailByPass(state, 'extractCharacterAnchors')).toBe('auto')
    expect(resolveVisionDetailByPass(state, 'designAndAssemble')).toBe('high')
    expect(resolveVisionDetailByPass(state, 'verifyConsistency')).toBe('high')
  })
})
