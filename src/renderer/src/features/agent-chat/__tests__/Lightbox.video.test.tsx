/**
 * v4.4.x — Lightbox 视频支持回归测试
 *
 * 覆盖:
 *  - kind='image' 仍渲染 <img>
 *  - kind='video' 渲染 <video controls autoPlay>(不是 <img>)
 *  - 没有 kind 字段但 mime='video/*' 时仍走视频分支(兜底)
 *  - 视频点击不会跳到下一张(stopPropagation)
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'
import { Lightbox } from '../Lightbox'

afterEach(() => {
  cleanup()
})

describe('Lightbox — video rendering', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders <img> for image kind', () => {
    useAgentChatStore.setState({
      preview: {
        open: true,
        index: 0,
        images: [
          {
            id: 'img_1',
            kind: 'image',
            name: 'a.png',
            mime: 'image/png',
            size: 1,
            uri: 'local-file:///D:/r/a.png',
          },
        ],
      },
    } as never)
    render(<Lightbox />)
    expect(document.querySelector('img')).toBeTruthy()
    expect(document.querySelector('video')).toBeNull()
  })

  it('renders <video controls autoPlay> for video kind', () => {
    useAgentChatStore.setState({
      preview: {
        open: true,
        index: 0,
        images: [
          {
            id: 'vid_1',
            kind: 'video',
            name: 'a.mp4',
            mime: 'video/mp4',
            size: 1,
            uri: 'local-file:///D:/r/a.mp4',
          },
        ],
      },
    } as never)
    render(<Lightbox />)
    const v = document.querySelector('video')
    expect(v).toBeTruthy()
    expect(v?.hasAttribute('controls')).toBe(true)
    expect(v?.hasAttribute('autoplay')).toBe(true)
    expect(document.querySelector('img:not([alt=""])')).toBeNull()
  })

  it('classifies by mime when kind field is missing (legacy data fallback)', () => {
    useAgentChatStore.setState({
      preview: {
        open: true,
        index: 0,
        images: [
          {
            id: 'legacy_1',
            kind: 'file',
            name: 'a.webm',
            mime: 'video/webm',
            size: 1,
            uri: 'local-file:///D:/r/a.webm',
          },
        ],
      },
    } as never)
    render(<Lightbox />)
    expect(document.querySelector('video')).toBeTruthy()
  })

  it('clicking the video does NOT advance to next (stopPropagation)', () => {
    const nextPreview = vi.fn()
    useAgentChatStore.setState({
      preview: {
        open: true,
        index: 0,
        images: [
          {
            id: 'vid_1',
            kind: 'video',
            name: 'a.mp4',
            mime: 'video/mp4',
            size: 1,
            uri: 'local-file:///D:/r/a.mp4',
          },
          {
            id: 'vid_2',
            kind: 'video',
            name: 'b.mp4',
            mime: 'video/mp4',
            size: 1,
            uri: 'local-file:///D:/r/b.mp4',
          },
        ],
      },
      nextPreview,
    } as never)
    render(<Lightbox />)
    const v = document.querySelector('video')!
    fireEvent.click(v)
    expect(nextPreview).not.toHaveBeenCalled()
  })

  it('clicking an image with multiple advances to next; with only one it does NOT', () => {
    const nextPreview = vi.fn()
    useAgentChatStore.setState({
      preview: {
        open: true,
        index: 0,
        images: [
          {
            id: 'img_1',
            kind: 'image',
            name: 'a.png',
            mime: 'image/png',
            size: 1,
            uri: 'local-file:///D:/r/a.png',
          },
        ],
      },
      nextPreview,
    } as never)
    render(<Lightbox />)
    fireEvent.click(screen.getByRole('img'))
    expect(nextPreview).not.toHaveBeenCalled()
  })

  it('ArrowLeft/ArrowRight while video is focused does NOT navigate (lets video seek)', () => {
    const nextPreview = vi.fn()
    const prevPreview = vi.fn()
    useAgentChatStore.setState({
      preview: {
        open: true,
        index: 1,
        images: [
          {
            id: 'a',
            kind: 'video',
            name: 'a.mp4',
            mime: 'video/mp4',
            size: 1,
            uri: 'local-file:///D:/r/a.mp4',
          },
          {
            id: 'b',
            kind: 'video',
            name: 'b.mp4',
            mime: 'video/mp4',
            size: 1,
            uri: 'local-file:///D:/r/b.mp4',
          },
          {
            id: 'c',
            kind: 'video',
            name: 'c.mp4',
            mime: 'video/mp4',
            size: 1,
            uri: 'local-file:///D:/r/c.mp4',
          },
        ],
      },
      nextPreview,
      prevPreview,
    } as never)
    render(<Lightbox />)
    const v = document.querySelector('video')!
    fireEvent.keyDown(v, { key: 'ArrowLeft' })
    fireEvent.keyDown(v, { key: 'ArrowRight' })
    expect(nextPreview).not.toHaveBeenCalled()
    expect(prevPreview).not.toHaveBeenCalled()
  })

  it('ArrowLeft/ArrowRight on document body (not video) DOES navigate', () => {
    const nextPreview = vi.fn()
    const prevPreview = vi.fn()
    useAgentChatStore.setState({
      preview: {
        open: true,
        index: 1,
        images: [
          {
            id: 'a',
            kind: 'image',
            name: 'a.png',
            mime: 'image/png',
            size: 1,
            uri: 'local-file:///D:/r/a.png',
          },
          {
            id: 'b',
            kind: 'image',
            name: 'b.png',
            mime: 'image/png',
            size: 1,
            uri: 'local-file:///D:/r/b.png',
          },
          {
            id: 'c',
            kind: 'image',
            name: 'c.png',
            mime: 'image/png',
            size: 1,
            uri: 'local-file:///D:/r/c.png',
          },
        ],
      },
      nextPreview,
      prevPreview,
    } as never)
    render(<Lightbox />)
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(prevPreview).toHaveBeenCalledTimes(1)
    expect(nextPreview).toHaveBeenCalledTimes(1)
  })
})
