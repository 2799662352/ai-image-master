import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { GenerateButton } from '../GenerateButton'
import { useDirectorStore } from '../../stores/useDirectorStore'

/**
 * v4.2.7 — Compact chip layout. The pause/resume/cancel buttons are now
 * icon-only chips identified by aria-label (not visible text). The primary
 * button stays mounted in all states and shows live queue stats.
 */
describe('GenerateButton states (v4.2.7 compact)', () => {
  beforeEach(() => {
    useDirectorStore.getState().reset()
    // Most tests below assume the main button is enabled, which requires
    // at least one reference image.
    useDirectorStore.getState().addReferenceImage({
      data: 'test',
      mimeType: 'image/jpeg',
      name: 'test.jpg',
    })
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

  it('should show "加入队列 (运行中)" main button + pause/cancel chips when running', () => {
    useDirectorStore.getState().setGenerationStatus('running')
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /加入队列 \(运行中\)/ })).toBeDefined()
    expect(screen.getByRole('button', { name: '暂停' })).toBeDefined()
    expect(screen.getByRole('button', { name: '取消当前任务' })).toBeDefined()
  })

  it('should show "加入队列 (已暂停)" main button + resume/cancel chips when paused', () => {
    useDirectorStore.getState().setGenerationStatus('paused')
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /加入队列 \(已暂停\)/ })).toBeDefined()
    expect(screen.getByRole('button', { name: '继续' })).toBeDefined()
    expect(screen.getByRole('button', { name: '取消当前任务' })).toBeDefined()
  })

  it('main button text includes queue count when there are pending jobs (running)', () => {
    useDirectorStore.getState().setGenerationStatus('running')
    useDirectorStore.getState().setPendingCount(3)
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /加入队列 \(运行中 \+ 队列 3\)/ })).toBeDefined()
  })

  it('should call onCancel when cancel chip clicked', () => {
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
    fireEvent.click(screen.getByRole('button', { name: '取消当前任务' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('should call onPause when pause chip clicked', () => {
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
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    expect(onPause).toHaveBeenCalledOnce()
  })

  it('should call onResume when resume chip clicked', () => {
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
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(onResume).toHaveBeenCalledOnce()
  })

  it('main button stays clickable while running (live-queue contract)', () => {
    const onGenerate = vi.fn()
    useDirectorStore.getState().setGenerationStatus('running')
    render(
      <GenerateButton
        onGenerate={onGenerate}
        onCancel={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /加入队列/ }))
    expect(onGenerate).toHaveBeenCalledOnce()
  })
})
