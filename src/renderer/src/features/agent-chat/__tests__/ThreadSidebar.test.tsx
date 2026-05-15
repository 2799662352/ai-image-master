import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadSidebar } from '../ThreadSidebar'
import { useAgentChatStore } from '../store'

const fakeAgent = {
  listThreads: vi.fn(),
  listCodexThreads: vi.fn(),
  forkCodexThread: vi.fn(),
  openThread: vi.fn(),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  sendMessage: vi.fn(),
  cancel: vi.fn(),
  loadThread: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
  onToolRequest: vi.fn(() => () => undefined),
  sendToolResponse: vi.fn(),
  setApiKey: vi.fn(),
  testConnection: vi.fn(),
}

beforeEach(() => {
  ;(globalThis as unknown as { window: { electronAPI: { agent: typeof fakeAgent } } }).window = {
    electronAPI: { agent: fakeAgent },
  }
  fakeAgent.renameThread.mockResolvedValue(undefined)
  fakeAgent.deleteThread.mockResolvedValue(undefined)
  fakeAgent.listThreads.mockResolvedValue([])
  fakeAgent.listCodexThreads.mockResolvedValue([])
  fakeAgent.forkCodexThread.mockResolvedValue({
    id: 'codex-fork-1',
    title: 'Forked session',
    createdAt: '',
    updatedAt: '',
  })
  fakeAgent.openThread.mockResolvedValue({ id: 'today-1', messages: [] })
  useAgentChatStore.setState({
    threadId: 'today-1',
    threadList: [
      {
        id: 'today-1',
        title: 'Today thread',
        createdAt: '',
        updatedAt: '',
        lastMessageAt: new Date().toISOString(),
      },
      {
        id: 'older-1',
        title: 'Older thread',
        createdAt: '',
        updatedAt: '',
        lastMessageAt: new Date(Date.now() - 100 * 24 * 60 * 60_000).toISOString(),
      },
    ],
    sidebarOpen: true,
    sidebarWidth: 240,
    isRunning: false,
    codexThreadList: [
      {
        id: 'codex-1',
        title: 'Codex native session',
        createdAt: '2026-05-08T01:00:00Z',
        updatedAt: '2026-05-08T01:10:00Z',
        cwd: 'D:/repo',
        model: 'gpt-5.5',
      },
    ],
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('ThreadSidebar', () => {
  it('renders a Today group and an Older group with their threads', () => {
    render(<ThreadSidebar />)
    expect(screen.getByText('Today')).toBeTruthy()
    expect(screen.getByText('Older')).toBeTruthy()
    expect(screen.getByText('Today thread')).toBeTruthy()
    expect(screen.getByText('Older thread')).toBeTruthy()
  })

  it('renders Codex sessions separately with a fork action', async () => {
    render(<ThreadSidebar />)
    expect(screen.getByText('Codex Sessions')).toBeTruthy()
    expect(screen.getByText('Codex native session')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /fork codex session codex native session/i }))
    await flush()

    expect(fakeAgent.forkCodexThread).toHaveBeenCalledWith('codex-1')
    expect(fakeAgent.listCodexThreads).toHaveBeenCalled()
  })

  it('clicking + New chat resets to the empty thread', () => {
    render(<ThreadSidebar />)
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }))
    expect(useAgentChatStore.getState().threadId).toBeUndefined()
    expect(useAgentChatStore.getState().messages).toEqual([])
  })

  it('inline rename: double-click title, edit, Enter', async () => {
    render(<ThreadSidebar />)
    fireEvent.doubleClick(screen.getByText('Today thread'))
    const input = screen.getByLabelText(/rename thread/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(fakeAgent.renameThread).toHaveBeenCalledWith('today-1', 'Renamed')
  })

  it('inline delete confirm: ⋯ → Delete → confirm', async () => {
    render(<ThreadSidebar />)
    fireEvent.click(screen.getByTestId('thread-menu-older-1'))
    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }))
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await flush()
    expect(fakeAgent.deleteThread).toHaveBeenCalledWith('older-1')
  })

  it('disables row click while a turn is running', () => {
    useAgentChatStore.setState({ isRunning: true })
    render(<ThreadSidebar />)
    const row = screen.getByText('Older thread').closest('button')
    expect((row as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders nothing when sidebarOpen is false', () => {
    useAgentChatStore.setState({ sidebarOpen: false })
    const { container } = render(<ThreadSidebar />)
    expect(container.firstChild).toBeNull()
  })

  it('exposes a left-edge resize separator that updates sidebarWidth via setSidebarWidth (with clamp)', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1600 })
    render(<ThreadSidebar />)
    const handle = screen.getByTestId('thread-sidebar-resize') as HTMLElement
    expect(handle.getAttribute('aria-orientation')).toBe('vertical')

    // pointermove/up are attached to document by the component, so dispatch
    // PointerEvent there directly (RTL fireEvent can't take `window`).
    function move(clientX: number): void {
      document.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX }),
      )
    }
    function up(): void {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }))
    }

    fireEvent.pointerDown(handle, { clientX: 1360 })
    move(1320) // width = 1600 - 1320 = 280, in [200, 360]
    up()
    expect(useAgentChatStore.getState().sidebarWidth).toBe(280)

    // Drag past max — clamped to 360.
    fireEvent.pointerDown(handle, { clientX: 1360 })
    move(1000)
    up()
    expect(useAgentChatStore.getState().sidebarWidth).toBe(360)
  })
})
