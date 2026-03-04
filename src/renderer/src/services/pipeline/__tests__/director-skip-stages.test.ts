import { describe, expect, it } from 'vitest'
import { shouldRetryAnalysis } from '../DirectorPipeline'

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
