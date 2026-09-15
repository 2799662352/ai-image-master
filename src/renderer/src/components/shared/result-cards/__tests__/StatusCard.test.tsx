import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatusCard } from '../StatusCard'
import { parseExpectedSeconds } from '../useElapsedSeconds'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('StatusCard', () => {
  it('renders the #NNN index, the state badge and the prompt for every state', () => {
    const { rerender } = render(<StatusCard index={0} status="pending" prompt="a cat" queueLabel="QUEUE #2" />)
    expect(screen.getByText('#001')).toBeTruthy()
    expect(screen.getByText('WAIT')).toBeTruthy()
    expect(screen.getByText('等待')).toBeTruthy()
    expect(screen.getByText('QUEUE #2')).toBeTruthy()

    rerender(<StatusCard index={41} status="running" prompt="a cat" startedAt={Date.now()} />)
    expect(screen.getByText('#042')).toBeTruthy()
    expect(screen.getByText('RUN')).toBeTruthy()
    expect(screen.getByText('生成中')).toBeTruthy()

    rerender(<StatusCard index={2} status="done" prompt="a cat" media={<img alt="thumb" src="blob:x" />} meta="og-v2.5-s · 1:1 · 2K · 24.9s" />)
    expect(screen.getByText('OK')).toBeTruthy()
    expect(screen.getByAltText('thumb')).toBeTruthy()
    expect(screen.getByText('og-v2.5-s · 1:1 · 2K · 24.9s')).toBeTruthy()

    rerender(<StatusCard index={3} status="error" prompt="a cat" error="HTTP 400 · mask missing alpha" />)
    expect(screen.getByText('ERR')).toBeTruthy()
    expect(screen.getByText('HTTP 400 · mask missing alpha')).toBeTruthy()
  })

  it('ticks the elapsed seconds while running and shows the expected time', () => {
    vi.useFakeTimers()
    const start = Date.now()
    render(<StatusCard index={0} status="running" prompt="p" startedAt={start} expectedSeconds={40} />)
    expect(screen.getByTestId('status-card-elapsed').textContent).toBe('0s / ~40s')
    act(() => {
      vi.advanceTimersByTime(18_000)
    })
    expect(screen.getByTestId('status-card-elapsed').textContent).toBe('18s / ~40s')
  })

  it('exposes retry / copy-error on failed cards and edit / download / remove without bubbling into onOpen', () => {
    const onRetry = vi.fn()
    const onCopyError = vi.fn()
    const onRemove = vi.fn()
    const onEdit = vi.fn()
    render(<StatusCard index={0} status="error" prompt="p" error="boom" onRetry={onRetry} onCopyError={onCopyError} onRemove={onRemove} onEdit={onEdit} />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    fireEvent.click(screen.getByRole('button', { name: '复制错误' }))
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    fireEvent.click(screen.getByRole('button', { name: /重编辑/ }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onCopyError).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledTimes(1)
    // Download only exists on done cards.
    expect(screen.queryByRole('button', { name: '下载图片' })).toBeNull()
  })

  it('opens the lightbox from the image area only when done, and action buttons do not trigger it', () => {
    const onOpen = vi.fn()
    const onDownload = vi.fn()
    const { container } = render(
      <StatusCard index={0} status="done" prompt="p" media={<img alt="t" src="blob:x" />} onOpen={onOpen} onDownload={onDownload} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '下载图片' }))
    expect(onDownload).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(container.querySelector('.cursor-zoom-in')!)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('does not make a running card clickable even if onOpen is passed', () => {
    const onOpen = vi.fn()
    const { container } = render(<StatusCard index={0} status="running" prompt="p" startedAt={Date.now()} onOpen={onOpen} />)
    expect(container.querySelector('.cursor-zoom-in')).toBeNull()
  })
})

describe('parseExpectedSeconds', () => {
  it('reads the model catalog time strings', () => {
    expect(parseExpectedSeconds('20s')).toBe(20)
    expect(parseExpectedSeconds('~40s')).toBe(40)
    expect(parseExpectedSeconds('1m')).toBe(60)
    expect(parseExpectedSeconds('90')).toBe(90)
    expect(parseExpectedSeconds(35)).toBe(35)
    expect(parseExpectedSeconds(undefined)).toBeUndefined()
    expect(parseExpectedSeconds('fast')).toBeUndefined()
  })
})
