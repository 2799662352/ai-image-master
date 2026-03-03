import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
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
    window.localStorage.setItem('current_model', 'gemini-3.1-flash-image-preview')
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

  it('should return canGenerate=false when isGenerating', () => {
    useDirectorStore.getState().addReferenceImage({
      data: 'test', mimeType: 'image/jpeg', name: 'test.jpg'
    })
    useDirectorStore.getState().setIsGenerating(true)
    const { result } = renderHook(() => useDirectorGeneration())
    expect(result.current.canGenerate).toBe(false)
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
    await result.current.startGeneration()

    expect(executeMock).toHaveBeenCalled()
    const firstCallInput = executeMock.mock.calls[0]?.[0]
    expect(firstCallInput?.semanticOrientation).toBe('portrait')
  })
})
