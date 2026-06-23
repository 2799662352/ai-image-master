import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useDirectorGeneration } from '../useDirectorGeneration'
import { useDirectorStore } from '../../stores/useDirectorStore'

const executeMock = vi.fn()

vi.mock('@/services/ServiceBridge', () => ({
  getDirectorPipelineService: vi.fn(async () => ({
    execute: executeMock,
  })),
}))

describe('useDirectorGeneration', () => {
  beforeEach(() => {
    executeMock.mockReset()
    executeMock.mockResolvedValue({
      images: [],
      prompts: [],
      panels: [],
      scene: null,
      characters: null,
      report: null,
    })
    window.localStorage.clear()
    window.localStorage.setItem('current_model', 'gemini-3.1-flash-image')
    useDirectorStore.getState().reset()
    useDirectorStore.getState().setVisionModel('gemini-3-flash-preview')
  })

  it('should return canGenerate=false when no reference images', () => {
    const { result } = renderHook(() => useDirectorGeneration())
    expect(result.current.canGenerate).toBe(false)
  })

  it('should return canGenerate=true when images exist and not generating', () => {
    useDirectorStore.getState().addReferenceImage({
      data: 'test', mimeType: 'image/jpeg', name: 'test.jpg'
    })
    const { result } = renderHook(() => useDirectorGeneration())
    expect(result.current.canGenerate).toBe(true)
  })

  it('keeps canGenerate=true while running so new jobs can be enqueued (v4.2.7 live-queue contract)', () => {
    useDirectorStore.getState().addReferenceImage({
      data: 'test', mimeType: 'image/jpeg', name: 'test.jpg'
    })
    useDirectorStore.getState().setIsGenerating(true)
    useDirectorStore.getState().setGenerationStatus('running')
    const { result } = renderHook(() => useDirectorGeneration())
    expect(result.current.canGenerate).toBe(true)
  })

  it('should provide getLayoutConfig for all layout types', () => {
    const { result } = renderHook(() => useDirectorGeneration())
    expect(result.current.getLayoutConfig('6grid')).toEqual({ rows: 2, cols: 3, panelCount: 6 })
    expect(result.current.getLayoutConfig('4grid')).toEqual({ rows: 2, cols: 2, panelCount: 4 })
    expect(result.current.getLayoutConfig('2closeup')).toEqual({ rows: 1, cols: 2, panelCount: 2 })
    expect(result.current.getLayoutConfig('9grid')).toEqual({ rows: 3, cols: 3, panelCount: 9 })
  })

  it('should default to 6grid layout when unknown layout given', () => {
    const { result } = renderHook(() => useDirectorGeneration())
    expect(result.current.getLayoutConfig('unknown')).toEqual({ rows: 2, cols: 3, panelCount: 6 })
  })

  it('should use portrait layout map when orientation is manually set to portrait', () => {
    useDirectorStore.getState().setLayoutOrientation('portrait')
    const { result } = renderHook(() => useDirectorGeneration())
    expect(result.current.getLayoutConfig('6grid')).toEqual({ rows: 3, cols: 2, panelCount: 6 })
    expect(result.current.getLayoutConfig('2closeup')).toEqual({ rows: 2, cols: 1, panelCount: 2 })
  })

  it('should keep portrait mapping when ratio becomes auto in auto mode', () => {
    useDirectorStore.getState().setRatio('9:16')
    useDirectorStore.getState().setRatio('auto')
    const { result } = renderHook(() => useDirectorGeneration())
    expect(result.current.getLayoutConfig('6grid')).toEqual({ rows: 3, cols: 2, panelCount: 6 })
  })

  it('should pass semantic orientation into pipeline input', async () => {
    const store = useDirectorStore.getState()
    store.addReferenceImage({ data: 'test', mimeType: 'image/jpeg', name: 'test.jpg' })
    store.setSemanticOrientation('portrait')

    const { result } = renderHook(() => useDirectorGeneration())
    // v4.2.7: startGeneration is now a back-compat alias for enqueueGeneration
    // (fire-and-forget). Wait for the queue drainer to actually invoke the
    // pipeline before asserting on call args.
    await act(async () => {
      void result.current.startGeneration()
    })
    await waitFor(() => expect(executeMock).toHaveBeenCalled())

    const firstCallInput = executeMock.mock.calls[0]?.[0]
    expect(firstCallInput?.semanticOrientation).toBe('portrait')
  })

  it('should pass per-pass vision detail settings into pipeline input', async () => {
    const store = useDirectorStore.getState()
    store.addReferenceImage({ data: 'test', mimeType: 'image/jpeg', name: 'test.jpg' })
    store.setVisionDetailAnalyzeScene('low')
    store.setVisionDetailCharacterAnchors('auto')
    store.setVisionDetailDesignAssemble('high')
    store.setVisionDetailVerifyConsistency('high')

    const { result } = renderHook(() => useDirectorGeneration())
    await act(async () => {
      void result.current.startGeneration()
    })
    await waitFor(() => expect(executeMock).toHaveBeenCalled())

    const firstCallInput = executeMock.mock.calls[0]?.[0]
    expect(firstCallInput?.visionDetailAnalyzeScene).toBe('low')
    expect(firstCallInput?.visionDetailCharacterAnchors).toBe('auto')
    expect(firstCallInput?.visionDetailDesignAssemble).toBe('high')
    expect(firstCallInput?.visionDetailVerifyConsistency).toBe('high')
  })
})
