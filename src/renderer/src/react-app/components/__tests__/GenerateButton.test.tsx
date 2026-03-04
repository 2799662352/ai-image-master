import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { GenerateButton } from '../GenerateButton'
import { useDirectorStore } from '../../stores/useDirectorStore'

describe('GenerateButton states', () => {
  beforeEach(() => {
    useDirectorStore.getState().reset()
  })

  afterEach(() => {
    cleanup()
  })

  it('should show generate text when idle', () => {
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
      />
    )
    expect(screen.getByText('一键生成漫画分镜')).toBeDefined()
  })

  it('should show cancel and pause buttons when running', () => {
    useDirectorStore.getState().setGenerationStatus('running')
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
      />
    )
    expect(screen.getByText('取消')).toBeDefined()
    expect(screen.getByText('暂停')).toBeDefined()
  })

  it('should show resume and cancel buttons when paused', () => {
    useDirectorStore.getState().setGenerationStatus('paused')
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
      />
    )
    expect(screen.getByText('继续')).toBeDefined()
    expect(screen.getByText('取消')).toBeDefined()
  })

  it('should call onCancel when cancel button clicked', () => {
    const onCancel = vi.fn()
    useDirectorStore.getState().setGenerationStatus('running')
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={onCancel}
        onPause={vi.fn()}
        onResume={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('should call onPause when pause button clicked', () => {
    const onPause = vi.fn()
    useDirectorStore.getState().setGenerationStatus('running')
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={vi.fn()}
        onPause={onPause}
        onResume={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('暂停'))
    expect(onPause).toHaveBeenCalledOnce()
  })

  it('should call onResume when resume button clicked', () => {
    const onResume = vi.fn()
    useDirectorStore.getState().setGenerationStatus('paused')
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={vi.fn()}
        onPause={vi.fn()}
        onResume={onResume}
      />
    )
    fireEvent.click(screen.getByText('继续'))
    expect(onResume).toHaveBeenCalledOnce()
  })
})
