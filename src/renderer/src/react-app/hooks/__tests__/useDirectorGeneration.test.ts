import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useDirectorGeneration } from '../useDirectorGeneration'
import { useDirectorStore } from '../../stores/useDirectorStore'

describe('useDirectorGeneration', () => {
  beforeEach(() => {
    useDirectorStore.getState().reset()
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
})
