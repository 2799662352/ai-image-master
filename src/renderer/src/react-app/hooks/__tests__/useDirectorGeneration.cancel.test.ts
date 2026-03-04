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
})
