/**
 * Composer attachment strip: every staged attachment is visible, images as a
 * 56px thumbnail tile (design D2/D5「草图 chip」), everything else as a file chip.
 * Buffer-backed images (paste / sketch / mask) get an object URL — no IPC; path-
 * backed ones ride the same small-thumb resolver the chat uses.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'
import { makeFileReference } from '../references/referenceUtils'

vi.mock('../../../components/shared/media/useResolvedMediaSrc', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../components/shared/media/useResolvedMediaSrc')>()
  return {
    ...actual,
    useResolvedMediaSrc: (src: string) => (typeof src === 'string' && src.length > 0 ? src : null),
  }
})

afterEach(cleanup)

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: { agent: { sendMessage: vi.fn(), cancel: vi.fn() }, fs: { stat: vi.fn() } },
    configurable: true,
  })
  ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:mock-thumb')
  ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn()
  useAgentChatStore.setState({
    input: '',
    attachments: [],
    pendingReferences: [],
    availableSkills: [],
    availablePluginMentions: [],
  } as never)
})

const png = new Uint8Array([137, 80, 78, 71]).buffer

describe('MentionInput attachment strip', () => {
  it('shows a buffer-backed image (paste / sketch) as a thumbnail tile with a remove button', () => {
    useAgentChatStore.getState().addAttachment({ name: '草图-1.png', mime: 'image/png', size: 4, buffer: png })
    render(<MentionInput />)
    const img = screen.getByRole('img', { name: '草图-1.png' }) as HTMLImageElement
    expect(img.getAttribute('src')).toBe('blob:mock-thumb')
    fireEvent.click(screen.getByRole('button', { name: 'Remove 草图-1.png' }))
    expect(useAgentChatStore.getState().attachments).toHaveLength(0)
  })

  it('renders a path-backed image once — as a tile, not also as a reference chip', () => {
    useAgentChatStore.getState().addAttachment({ name: 'hero.png', mime: 'image/png', size: 9, path: 'D:/r/hero.png' })
    useAgentChatStore.getState().addPendingReference(makeFileReference({ path: 'D:/r/hero.png', name: 'hero.png', mime: 'image/png' }))
    render(<MentionInput />)
    expect(screen.getAllByRole('img', { name: 'hero.png' })).toHaveLength(1)
    // The reference chip (text label) is suppressed — the tile already represents it.
    expect(screen.queryByText('hero.png')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Remove hero.png' })).toHaveLength(1)
  })

  // Restored drafts / edit-resend can carry the reference under a different path
  // form (seen live: tile + duplicate name chip). Same-name image references are
  // treated as the tile's own reference.
  it('suppresses a same-name image reference chip even when its path form differs', () => {
    useAgentChatStore.getState().addAttachment({ name: 'hero.png', mime: 'image/png', size: 9, path: 'D:/r/hero.png' })
    useAgentChatStore
      .getState()
      .addPendingReference(makeFileReference({ path: 'C:/Users/x/AppData/agent/uploads/abc.png', name: 'hero.png', mime: 'image/png' }))
    render(<MentionInput />)
    expect(screen.getAllByRole('img', { name: 'hero.png' })).toHaveLength(1)
    expect(screen.queryByText('hero.png')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Remove hero.png' })).toHaveLength(1)
  })

  // 用户反馈「略缩图不能点击」:点 tile 必须能看大图。buffer 附件用 object URL,路径附件用
  // local-file uri,全部图片附件进同一个灯箱序列,‹ › 可翻。
  it('clicking a tile opens the lightbox on that image with every staged image in the sequence', () => {
    const store = useAgentChatStore.getState()
    store.addAttachment({ name: 'a.png', mime: 'image/png', size: 4, buffer: png })
    store.addAttachment({ name: 'b.png', mime: 'image/png', size: 9, path: 'D:/r/b.png' })
    render(<MentionInput />)
    fireEvent.click(screen.getByRole('button', { name: '预览 b.png' }))
    const preview = useAgentChatStore.getState().preview
    expect(preview.open).toBe(true)
    expect(preview.index).toBe(1)
    expect(preview.images.map((i) => i.name)).toEqual(['a.png', 'b.png'])
    expect(preview.images[0].uri).toBe('blob:mock-thumb')
    expect(preview.images[1].uri).toBe('local-file:///D:/r/b.png')
    expect(preview.images.every((i) => i.kind === 'image')).toBe(true)
  })

  it('never renders an <img> for a non-image attachment (those keep the reference-chip contract)', () => {
    useAgentChatStore.getState().addAttachment({ name: 'notes.txt', mime: 'text/plain', size: 4, buffer: png })
    render(<MentionInput />)
    expect(screen.queryByRole('img', { name: 'notes.txt' })).toBeNull()
    expect(document.querySelectorAll('img')).toHaveLength(0)
  })
})
