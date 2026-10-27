/**
 * Composer attach bar (design D2, revised 2026-09-14 after user feedback):
 * the full-width dashed row is back (the pill row stays uncluttered), but the
 * 「+」menu's functions survive — the row itself carries 添加照片和文件 / 绘图 /
 * 生成图片 inline, and the leading「+」still pops the same three-item menu.
 * 绘图 opens the tldraw sketch pad (D3); the pad is mocked here — its export
 * path has its own tests.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'

vi.mock('../sketch/SketchPad', () => ({
  SketchPad: ({ onConfirm, onCancel }: { onConfirm: (b: Blob) => void; onCancel: () => void }) => (
    <div data-testid="sketch-pad">
      <button type="button" onClick={() => onConfirm(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))}>
        mock-confirm
      </button>
      <button type="button" onClick={onCancel}>mock-cancel</button>
    </div>
  ),
}))

afterEach(cleanup)

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: {
      agent: { sendMessage: vi.fn(), cancel: vi.fn() },
      fs: { stat: vi.fn() },
    },
    configurable: true,
  })
  useAgentChatStore.setState({
    input: '',
    attachments: [],
    pendingReferences: [],
    availableSkills: [],
    availablePluginMentions: [],
  } as never)
})

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('MentionInput attach bar', () => {
  it('renders a full-width dashed bar between textarea and pill row with the three actions inline + quota', () => {
    render(<MentionInput />)
    expect(screen.queryByText('Add references or files')).toBeNull()
    const bar = screen.getByRole('toolbar', { name: '添加内容' })
    expect(bar.className).toMatch(/border-dashed/)
    for (const label of ['添加照片和文件', '绘图', '生成图片']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
    expect(screen.getByText('0/20')).toBeTruthy()
    // The bar sits above the pill row (Agent badge / model picker), not inside it.
    const pillRow = screen.getByText('Agent').parentElement as HTMLElement
    expect(pillRow.contains(bar)).toBe(false)
    expect(bar.compareDocumentPosition(pillRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the「+」: it opens the same three-item menu and Escape closes it', () => {
    render(<MentionInput />)
    const plus = screen.getByRole('button', { name: '更多添加方式' })
    expect(plus.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(plus)
    expect(plus.getAttribute('aria-expanded')).toBe('true')
    for (const label of ['添加照片和文件', '绘图', '生成图片']) {
      expect(screen.getByRole('menuitem', { name: new RegExp(label) })).toBeTruthy()
    }
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(plus.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menuitem', { name: /绘图/ })).toBeNull()
  })

  it('inline 生成图片 inserts the image skill trigger into the composer', () => {
    render(<MentionInput />)
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }))
    expect(useAgentChatStore.getState().input).toBe('$catimation-image ')
  })

  it('menu 生成图片 does the same and closes the menu', () => {
    render(<MentionInput />)
    fireEvent.click(screen.getByRole('button', { name: '更多添加方式' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /生成图片/ }))
    expect(useAgentChatStore.getState().input).toBe('$catimation-image ')
    expect(screen.queryByRole('menuitem', { name: /生成图片/ })).toBeNull()
  })

  it('inline 绘图 opens the sketch pad; confirming stages the sketch PNG as an attachment', async () => {
    render(<MentionInput />)
    fireEvent.click(screen.getByRole('button', { name: '绘图' }))
    expect(screen.getByTestId('sketch-pad')).toBeTruthy()

    fireEvent.click(screen.getByText('mock-confirm'))
    await flush()

    const attachments = useAgentChatStore.getState().attachments
    expect(attachments).toHaveLength(1)
    expect(attachments[0].mime).toBe('image/png')
    expect(attachments[0].name).toMatch(/^草图-.*\.png$/)
    expect(screen.queryByTestId('sketch-pad')).toBeNull()
  })

  it('cancelling the sketch pad leaves no attachment', () => {
    render(<MentionInput />)
    fireEvent.click(screen.getByRole('button', { name: '绘图' }))
    fireEvent.click(screen.getByText('mock-cancel'))
    expect(useAgentChatStore.getState().attachments).toHaveLength(0)
    expect(screen.queryByTestId('sketch-pad')).toBeNull()
  })

  it('disables 添加照片和文件 (inline and in the menu) once the attachment quota is full', () => {
    useAgentChatStore.setState({
      attachments: Array.from({ length: 20 }, (_, i) => ({ name: `f${i}.txt`, mime: 'text/plain', size: 1, buffer: new ArrayBuffer(1) })),
    } as never)
    render(<MentionInput />)
    expect((screen.getByRole('button', { name: '添加照片和文件' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('20/20')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '更多添加方式' }))
    expect((screen.getByRole('menuitem', { name: /添加照片和文件/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
