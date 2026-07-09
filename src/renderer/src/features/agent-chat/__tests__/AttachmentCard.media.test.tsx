/**
 * v4.4.x — 媒体略缩图 + 单击双效 回归测试
 *
 * 覆盖:
 *  1) image attachment 渲染为 <img> 略缩图
 *  2) video attachment 渲染为 <video data-media-kind="video"> 略缩图
 *  3) 单击图片缩略图 同时调用 openPreview AND openReference
 *  4) 单击视频缩略图 同样触发两个回调
 *  5) 类型扩展兜底:旧数据 kind='file' 但 mime='image/png' 也能渲略缩图
 *  6) 非媒体附件(text/plain)显示文件 chip 按钮,点击只 reveal
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentItem } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../file-explorer/store'
import { useAgentChatStore } from '../store'
import { AttachmentCard } from '../cards/AttachmentCard'

// jsdom has no electronAPI, so the real useResolvedMediaSrc (which reads file
// bytes over IPC and returns a blob: URL) resolves to null and MediaThumbnail
// never renders its inner <img>/<video>. Pass the src through — these tests
// assert kind classification and click behaviour, not the IPC byte plumbing.
vi.mock('../../../components/shared/media/useResolvedMediaSrc', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../components/shared/media/useResolvedMediaSrc')>()
  return {
    ...actual,
    useResolvedMediaSrc: (src: string) =>
      typeof src === 'string' && src.length > 0 ? src : null,
  }
})

afterEach(() => {
  cleanup()
})

const openReference = vi.fn(async () => undefined)
const openPreview = vi.fn()

function attachmentItem(
  attachments: AttachmentItem['attachments'],
): AttachmentItem {
  return {
    type: 'attachment',
    id: 'att_msg_1',
    startedAt: 1,
    attachments,
  }
}

describe('AttachmentCard — media thumbnail single-click双效', () => {
  beforeEach(() => {
    openReference.mockClear()
    openPreview.mockClear()
    useFileExplorerStore.setState({ openReference } as never)
    useAgentChatStore.setState({ openPreview } as never)
  })

  it('renders an image attachment as <img> thumbnail', () => {
    render(
      <AttachmentCard
        item={attachmentItem([
          {
            id: 'img_1',
            kind: 'image',
            name: 'hero.png',
            mime: 'image/png',
            size: 100,
            uri: 'local-file:///D:/r/hero.png',
          },
        ])}
      />,
    )
    const thumb = screen.getByRole('button', { name: 'hero.png' })
    expect(thumb.getAttribute('data-media-kind')).toBe('image')
    expect(thumb.querySelector('img')).toBeTruthy()
  })

  it('renders a video attachment as <video data-media-kind=video> thumbnail', () => {
    render(
      <AttachmentCard
        item={attachmentItem([
          {
            id: 'vid_1',
            kind: 'video',
            name: 'clip.mp4',
            mime: 'video/mp4',
            size: 100,
            uri: 'local-file:///D:/r/clip.mp4',
          },
        ])}
      />,
    )
    const thumb = screen.getByRole('button', { name: 'clip.mp4' })
    expect(thumb.getAttribute('data-media-kind')).toBe('video')
    expect(thumb.querySelector('video')).toBeTruthy()
    // SVG play badge layered on top
    expect(thumb.querySelector('svg')).toBeTruthy()
  })

  it('single-click on image thumbnail opens Lightbox AND reveals in file panel', () => {
    render(
      <AttachmentCard
        item={attachmentItem([
          {
            id: 'img_1',
            kind: 'image',
            name: 'hero.png',
            mime: 'image/png',
            size: 100,
            uri: 'local-file:///D:/r/hero.png',
          },
        ])}
      />,
    )
    const thumb = screen.getByRole('button', { name: 'hero.png' })
    fireEvent.click(thumb)
    expect(openPreview).toHaveBeenCalledTimes(1)
    expect(openReference).toHaveBeenCalledTimes(1)
    // Reveal carries a localPath reference
    const calls = openReference.mock.calls as unknown as Array<Array<{ source: { kind: string; path: string } }>>
    const ref = calls[0]?.[0]
    expect(ref?.source.kind).toBe('localPath')
    expect(ref?.source.path).toBe('D:/r/hero.png')
  })

  it('single-click on video thumbnail also opens both Lightbox AND reveal', () => {
    render(
      <AttachmentCard
        item={attachmentItem([
          {
            id: 'vid_1',
            kind: 'video',
            name: 'clip.mp4',
            mime: 'video/mp4',
            size: 100,
            uri: 'local-file:///D:/r/clip.mp4',
          },
        ])}
      />,
    )
    const thumb = screen.getByRole('button', { name: 'clip.mp4' })
    fireEvent.click(thumb)
    expect(openPreview).toHaveBeenCalledTimes(1)
    expect(openReference).toHaveBeenCalledTimes(1)
    const previewCalls = openPreview.mock.calls as unknown as Array<[Array<{ kind: string }>, number]>
    const [previewItems, startIndex] = previewCalls[0]
    expect(startIndex).toBe(0)
    expect(previewItems[0].kind).toBe('video')
  })

  it('legacy data: kind="file" with mime="image/*" still renders as image thumbnail', () => {
    render(
      <AttachmentCard
        item={attachmentItem([
          {
            id: 'legacy_1',
            kind: 'file',
            name: 'legacy.jpg',
            mime: 'image/jpeg',
            size: 100,
            uri: 'local-file:///D:/r/legacy.jpg',
          },
        ])}
      />,
    )
    const thumb = screen.getByRole('button', { name: 'legacy.jpg' })
    expect(thumb.getAttribute('data-media-kind')).toBe('image')
  })

  it('non-media attachment renders as file chip — click only reveals, never previews', () => {
    render(
      <AttachmentCard
        item={attachmentItem([
          {
            id: 'doc_1',
            kind: 'file',
            name: 'notes.txt',
            mime: 'text/plain',
            size: 100,
            uri: 'local-file:///D:/r/notes.txt',
          },
        ])}
      />,
    )
    const chip = screen.getByRole('button', { name: /notes\.txt/ })
    fireEvent.click(chip)
    expect(openReference).toHaveBeenCalledTimes(1)
    expect(openPreview).not.toHaveBeenCalled()
  })
})
