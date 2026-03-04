import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useDirectorStore } from '../useDirectorStore'

describe('useDirectorStore skip flags', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useDirectorStore.getState().reset()
  })

  it('should have skipAnalyzeScene and skipCharacterAnchors defaulting to false', () => {
    const state = useDirectorStore.getState()
    expect(state.skipAnalyzeScene).toBe(false)
    expect(state.skipCharacterAnchors).toBe(false)
  })

  it('should set skipAnalyzeScene and persist to localStorage', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    useDirectorStore.getState().setSkipAnalyzeScene(true)
    expect(useDirectorStore.getState().skipAnalyzeScene).toBe(true)
    expect(setItemSpy).toHaveBeenCalledWith('director.skip-analyze-scene.v1', 'true')
    setItemSpy.mockRestore()
  })

  it('should set skipCharacterAnchors and persist to localStorage', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    useDirectorStore.getState().setSkipCharacterAnchors(true)
    expect(useDirectorStore.getState().skipCharacterAnchors).toBe(true)
    expect(setItemSpy).toHaveBeenCalledWith('director.skip-character-anchors.v1', 'true')
    setItemSpy.mockRestore()
  })

  it('should restore skipAnalyzeScene from localStorage on reset', () => {
    window.localStorage.setItem('director.skip-analyze-scene.v1', 'true')
    useDirectorStore.getState().reset()
    expect(useDirectorStore.getState().skipAnalyzeScene).toBe(true)
  })
})
