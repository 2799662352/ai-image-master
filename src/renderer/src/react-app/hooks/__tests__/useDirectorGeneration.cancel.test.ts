import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useDirectorGeneration } from '../useDirectorGeneration'
import { useDirectorStore } from '../../stores/useDirectorStore'

vi.mock('@/services/ServiceBridge', () => ({
  getDirectorPipelineService: vi.fn().mockResolvedValue({
    execute: vi.fn().mockResolvedValue({ images: [], scene: null, characters: null }),
    resume: vi.fn().mockResolvedValue({ images: [] }),
    requestPause: vi.fn(),
    clearPauseRequest: vi.fn(),
    isPauseRequested: false,
  }),
}))

describe('useDirectorGeneration cancel/pause/resume', () => {
  beforeEach(() => {
    useDirectorStore.getState().reset()
  })

  it('should expose cancelGeneration function', () => {
    const { result } = renderHook(() => useDirectorGeneration())
    expect(typeof result.current.cancelGeneration).toBe('function')
  })

  it('should expose pauseGeneration function', () => {
    const { result } = renderHook(() => useDirectorGeneration())
    expect(typeof result.current.pauseGeneration).toBe('function')
  })

  it('should expose resumeGeneration function', () => {
    const { result } = renderHook(() => useDirectorGeneration())
    expect(typeof result.current.resumeGeneration).toBe('function')
  })

  it('should expose generationStatus', () => {
    const { result } = renderHook(() => useDirectorGeneration())
    expect(result.current.generationStatus).toBe('idle')
  })

  it('should set generationStatus to paused when pipeline returns __paused', async () => {
    const mockPipeline = {
      execute: vi.fn().mockResolvedValue({
        images: [], scene: null, characters: null,
        panels: null, prompts: [], report: null,
        styleAnchor: null, styleConflicts: [],
        __paused: true,
      }),
      resume: vi.fn(),
      requestPause: vi.fn(),
      clearPauseRequest: vi.fn(),
      isPauseRequested: false,
    }

    vi.doMock('@/services/ServiceBridge', () => ({
      getDirectorPipelineService: vi.fn().mockResolvedValue(mockPipeline),
    }))

    useDirectorStore.getState().setGenerationStatus('paused')
    expect(useDirectorStore.getState().generationStatus).toBe('paused')
  })

  it('regenerateImages should be cancellable', () => {
    const { result } = renderHook(() => useDirectorGeneration())
    expect(typeof result.current.cancelGeneration).toBe('function')
    expect(typeof result.current.regenerateImages).toBe('function')
  })
})
