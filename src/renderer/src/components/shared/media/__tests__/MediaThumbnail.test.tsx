/**
 * v4.4.x — MediaThumbnail 单元测试(共享原语)
 *
 * 测的是装饰用 / 交互态 / kind 分支 / classifyMediaKind 推断,
 * 不依赖 chat store 或 file-explorer store —— 是真正的 pure component。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaThumbnail, classifyMediaKind } from '../MediaThumbnail'

afterEach(() => {
  cleanup()
})

describe('MediaThumbnail', () => {
  it('renders <img> for kind=image with object-cover sizing', () => {
    const { container } = render(
      <MediaThumbnail src="https://x.test/a.png" kind="image" name="a.png" />,
    )
    const wrap = container.querySelector('[data-media-kind="image"]')
    expect(wrap).toBeTruthy()
    expect(wrap?.querySelector('img')).toBeTruthy()
  })

  it('renders <video preload=metadata muted playsInline> for kind=video', () => {
    const { container } = render(
      <MediaThumbnail src="https://x.test/a.mp4" kind="video" name="a.mp4" />,
    )
    const wrap = container.querySelector('[data-media-kind="video"]')
    expect(wrap).toBeTruthy()
    if (!wrap) return
    const v = wrap.querySelector('video')
    expect(v).toBeTruthy()
    expect(v?.getAttribute('preload')).toBe('metadata')
    expect(v?.hasAttribute('muted') || v?.muted).toBeTruthy()
    expect(v?.hasAttribute('playsinline')).toBe(true)
    expect(wrap.querySelector('svg')).toBeTruthy()
  })

  it('attaches role=button + tabIndex=0 when onClick is provided', () => {
    const onClick = vi.fn()
    render(<MediaThumbnail src="https://x.test/a.png" kind="image" onClick={onClick} />)
    const btn = screen.getByRole('button')
    expect(btn.getAttribute('tabindex')).toBe('0')
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('Enter / Space triggers onClick via keyboard', () => {
    const onClick = vi.fn()
    render(<MediaThumbnail src="https://x.test/a.mp4" kind="video" onClick={onClick} />)
    const btn = screen.getByRole('button')
    fireEvent.keyDown(btn, { key: 'Enter' })
    fireEvent.keyDown(btn, { key: ' ' })
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('returns null for empty src (guards against React empty-src warning)', () => {
    const { container } = render(<MediaThumbnail src="" kind="image" />)
    expect(container.firstChild).toBeNull()
  })
})

describe('classifyMediaKind', () => {
  it('honors explicit kind first', () => {
    expect(classifyMediaKind({ kind: 'image' })).toBe('image')
    expect(classifyMediaKind({ kind: 'video' })).toBe('video')
  })

  it('falls back to mime when kind is missing or "file"', () => {
    expect(classifyMediaKind({ kind: 'file', mime: 'image/png' })).toBe('image')
    expect(classifyMediaKind({ kind: 'file', mime: 'video/mp4' })).toBe('video')
    expect(classifyMediaKind({ mime: 'image/jpeg' })).toBe('image')
    expect(classifyMediaKind({ mime: 'video/webm' })).toBe('video')
  })

  it('falls back to extension when mime is missing', () => {
    expect(classifyMediaKind({ name: 'photo.jpeg' })).toBe('image')
    expect(classifyMediaKind({ name: 'reel.mp4' })).toBe('video')
    expect(classifyMediaKind({ name: 'archive.zip' })).toBe(null)
    expect(classifyMediaKind({ name: 'notes.txt' })).toBe(null)
  })

  it('returns null for clearly non-media inputs', () => {
    expect(classifyMediaKind({ kind: 'file', mime: 'text/plain', name: 'a.txt' })).toBe(null)
    expect(classifyMediaKind({})).toBe(null)
  })
})
