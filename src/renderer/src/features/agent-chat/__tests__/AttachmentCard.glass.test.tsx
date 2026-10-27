/**
 * 结果图卡(设计稿 D5):hover 毛玻璃「编辑 / 下载」+ 透明 PNG 深底展示 + ALPHA 徽章 +
 * 棋盘格可选核对。透明探测走 alphaProbe(真机用 canvas),这里按 uri 打桩。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentItem } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../file-explorer/store'
import { useAgentChatStore } from '../store'
import { AttachmentCard } from '../cards/AttachmentCard'

vi.mock('../../../components/shared/media/useResolvedMediaSrc', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../components/shared/media/useResolvedMediaSrc')>()
  return {
    ...actual,
    useResolvedMediaSrc: (src: string) => (typeof src === 'string' && src.length > 0 ? src : null),
  }
})

vi.mock('../cards/alphaProbe', () => ({
  probeImageAlpha: vi.fn(async (src: string) => src.includes('sticker')),
}))

const saveAs = vi.fn(async () => ({ success: true }))

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: { shell: { saveAs } },
    configurable: true,
  })
  saveAs.mockClear()
  useFileExplorerStore.setState({ openReference: vi.fn(async () => undefined) } as never)
  useAgentChatStore.setState({ openPreview: vi.fn() } as never)
})

afterEach(cleanup)

function item(attachments: AttachmentItem['attachments']): AttachmentItem {
  return { type: 'attachment', id: 'att_1', startedAt: 1, attachments }
}

const PHOTO = { id: 'p1', kind: 'image' as const, name: 'night.jpg', mime: 'image/jpeg', size: 1, uri: 'local-file:///D:/r/night.jpg' }
const STICKER = { id: 's1', kind: 'image' as const, name: 'cat.png', mime: 'image/png', size: 1, uri: 'local-file:///D:/r/sticker-cat.png' }

describe('AttachmentCard — glass buttons + transparent PNG (D5)', () => {
  it('renders 编辑 and 下载 glass buttons on every media tile; 编辑 opens the preview', () => {
    render(<AttachmentCard item={item([PHOTO])} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑 night.jpg' }))
    expect(useAgentChatStore.getState().openPreview).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '下载 night.jpg' })).toBeTruthy()
  })

  it('下载 saves the original through shell.saveAs with the file name', async () => {
    render(<AttachmentCard item={item([PHOTO])} />)
    fireEvent.click(screen.getByRole('button', { name: '下载 night.jpg' }))
    await waitFor(() => expect(saveAs).toHaveBeenCalledWith('local-file:///D:/r/night.jpg', 'night.jpg'))
    // 下载不进灯箱
    expect(useAgentChatStore.getState().openPreview).not.toHaveBeenCalled()
  })

  it('an alpha PNG gets the ALPHA badge on a dark base and a checkerboard toggle; a photo does not', async () => {
    render(<AttachmentCard item={item([STICKER, PHOTO])} />)
    const badge = await screen.findByText('alpha')
    expect(badge).toBeTruthy()
    expect(screen.getAllByText('alpha')).toHaveLength(1)

    const tile = screen.getByTestId('media-tile-s1')
    expect(tile.className).not.toContain('checker')
    fireEvent.click(screen.getByRole('button', { name: '棋盘格核对透明度' }))
    expect(screen.getByTestId('media-tile-s1').className).toContain('checker')
    expect(screen.queryByRole('button', { name: '棋盘格核对透明度' })).toBeTruthy()
  })
})
