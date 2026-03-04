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

describe('generationStatus state machine', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useDirectorStore.getState().reset()
  })

  it('should default to idle', () => {
    const store = useDirectorStore.getState()
    expect(store.generationStatus).toBe('idle')
  })

  it('should transition to running', () => {
    useDirectorStore.getState().setGenerationStatus('running')
    const store = useDirectorStore.getState()
    expect(store.generationStatus).toBe('running')
    expect(store.isGenerating).toBe(true)
  })

  it('should transition to paused', () => {
    useDirectorStore.getState().setGenerationStatus('paused')
    const store = useDirectorStore.getState()
    expect(store.generationStatus).toBe('paused')
    expect(store.isGenerating).toBe(false)
  })

  it('isGenerating should be true only when running', () => {
    const store = useDirectorStore.getState()

    store.setGenerationStatus('idle')
    expect(useDirectorStore.getState().isGenerating).toBe(false)

    store.setGenerationStatus('running')
    expect(useDirectorStore.getState().isGenerating).toBe(true)

    store.setGenerationStatus('paused')
    expect(useDirectorStore.getState().isGenerating).toBe(false)
  })

  it('setIsGenerating(true) should set status to running', () => {
    useDirectorStore.getState().setIsGenerating(true)
    expect(useDirectorStore.getState().generationStatus).toBe('running')
  })

  it('setIsGenerating(false) should set status to idle', () => {
    useDirectorStore.getState().setIsGenerating(false)
    expect(useDirectorStore.getState().generationStatus).toBe('idle')
  })
})
