import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadSidebar } from '../ThreadSidebar'
import { useAgentChatStore } from '../store'
import { useTabStore } from '../../../stores/useTabStore'

const fakeAgent = {
  listThreads: vi.fn(),
  listCodexThreads: vi.fn(),
  forkCodexThread: vi.fn(),
  openThread: vi.fn(),
  renameThread: vi.fn(),
  setThreadPinned: vi.fn(),
  deleteThread: vi.fn(),
  sendMessage: vi.fn(),
  cancel: vi.fn(),
  loadThread: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
  onToolRequest: vi.fn(() => () => undefined),
  sendToolResponse: vi.fn(),
  setApiKey: vi.fn(),
  testConnection: vi.fn(),
  declareThreadMemoryMode: vi.fn(),
}

beforeEach(() => {
  ;(globalThis as unknown as { window: { electronAPI: { agent: typeof fakeAgent } } }).window = {
    electronAPI: { agent: fakeAgent },
  }
  fakeAgent.renameThread.mockResolvedValue(undefined)
  fakeAgent.setThreadPinned.mockResolvedValue(undefined)
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
  fakeAgent.declareThreadMemoryMode.mockResolvedValue({ ok: true, pushed: true })
  useAgentChatStore.setState({
    memoriesGloballyEnabled: true,
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

  it('thread action menu absorbs pointer/mouse/click events so underlying UI is not triggered', () => {
    const docPointer = vi.fn()
    const docMouse = vi.fn()
    const docClick = vi.fn()
    document.addEventListener('pointerdown', docPointer)
    document.addEventListener('mousedown', docMouse)
    document.addEventListener('click', docClick)
    try {
      render(<ThreadSidebar />)
      fireEvent.click(screen.getByTestId('thread-menu-older-1'))
      docPointer.mockClear()
      docMouse.mockClear()
      docClick.mockClear()

      const rename = screen.getByRole('menuitem', { name: /rename/i })
      fireEvent.pointerDown(rename)
      fireEvent.mouseDown(rename)
      fireEvent.click(rename)

      expect(docPointer).not.toHaveBeenCalled()
      expect(docMouse).not.toHaveBeenCalled()
      expect(docClick).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('pointerdown', docPointer)
      document.removeEventListener('mousedown', docMouse)
      document.removeEventListener('click', docClick)
    }
  })

  it('keeps other rows clickable while a turn is running (parallel chats) and shows a running dot', () => {
    // A background thread is running. With parallel chats you must still be able
    // to switch to it without stopping it — so the row is NOT disabled.
    useAgentChatStore.setState({ runningByThread: { 'older-1': true } })
    render(<ThreadSidebar />)
    const row = screen.getByText('Older thread').closest('button')
    expect((row as HTMLButtonElement).disabled).toBe(false)
    // A running indicator is shown for that thread.
    expect(screen.getByLabelText('Running')).toBeTruthy()
    // Clicking switches to it (does not require Stop first).
    fireEvent.click(row as HTMLButtonElement)
    expect(fakeAgent.openThread).toHaveBeenCalledWith('older-1')
  })

  // Per-thread cross-session memory. Absent memoryMode = never chosen, and
  // codex remembers by default, so an untouched row reads as "remembering".
  it('turns memory OFF for a thread that has never chosen', async () => {
    render(<ThreadSidebar />)
    fireEvent.click(screen.getByTestId('thread-menu-older-1'))
    const toggle = screen.getByTestId('thread-memory-toggle-older-1')
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)
    await flush()

    expect(fakeAgent.declareThreadMemoryMode).toHaveBeenCalledWith('older-1', 'disabled')
    expect(fakeAgent.listThreads).toHaveBeenCalled()
  })

  it('turns memory back ON for a thread already opted out', async () => {
    useAgentChatStore.setState({
      threadList: [
        {
          id: 'older-1',
          title: 'Older thread',
          createdAt: '',
          updatedAt: '',
          lastMessageAt: new Date(Date.now() - 100 * 24 * 60 * 60_000).toISOString(),
          memoryMode: 'disabled',
        },
      ],
    })
    render(<ThreadSidebar />)
    fireEvent.click(screen.getByTestId('thread-menu-older-1'))
    const toggle = screen.getByTestId('thread-memory-toggle-older-1')
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle)
    await flush()

    expect(fakeAgent.declareThreadMemoryMode).toHaveBeenCalledWith('older-1', 'enabled')
  })

  it('disables the toggle while memory is off process-wide, and says why', () => {
    useAgentChatStore.setState({ memoriesGloballyEnabled: false })
    render(<ThreadSidebar />)
    fireEvent.click(screen.getByTestId('thread-menu-older-1'))

    const toggle = screen.getByTestId('thread-memory-toggle-older-1') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText(/记忆功能已全局关闭/)).toBeTruthy()
  })

  it('keeps the menu open and shows the reason when the choice is refused', async () => {
    fakeAgent.declareThreadMemoryMode.mockResolvedValue({
      ok: false,
      error: 'memory feature is disabled',
    })
    render(<ThreadSidebar />)
    fireEvent.click(screen.getByTestId('thread-menu-older-1'))
    fireEvent.click(screen.getByTestId('thread-memory-toggle-older-1'))
    await flush()

    expect(screen.getByRole('alert').textContent).toContain('memory feature is disabled')
    // Still open — a dismissed menu would hide the explanation.
    expect(screen.getByTestId('thread-memory-toggle-older-1')).toBeTruthy()
  })

  // Pinning (D1). The DB row is authoritative; the store patches the list
  // optimistically so the row jumps into the Pinned group before the refresh.
  it('pin button pins the thread and moves it into a leading Pinned group', async () => {
    // The refresh after the write returns the row truth: older-1 now pinned.
    const [today, older] = useAgentChatStore.getState().threadList
    fakeAgent.listThreads.mockResolvedValue([today, { ...older, pinnedAt: new Date().toISOString() }])
    render(<ThreadSidebar />)
    expect(screen.queryByText('Pinned')).toBeNull()
    fireEvent.click(screen.getByTestId('thread-pin-older-1'))
    await flush()

    expect(fakeAgent.setThreadPinned).toHaveBeenCalledWith('older-1', true)
    expect(fakeAgent.listThreads).toHaveBeenCalled()
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent ?? '')
    expect(headings[0]).toMatch(/pinned/i)
    // The pinned row left the Older bucket.
    expect(screen.queryByText('Older')).toBeNull()
  })

  it('unpins from the ⋯ menu', async () => {
    useAgentChatStore.setState({
      threadList: [
        {
          id: 'older-1',
          title: 'Older thread',
          createdAt: '',
          updatedAt: '',
          lastMessageAt: new Date(Date.now() - 100 * 24 * 60 * 60_000).toISOString(),
          pinnedAt: new Date().toISOString(),
        },
      ],
    })
    render(<ThreadSidebar />)
    expect(screen.getByText('Pinned')).toBeTruthy()
    fireEvent.click(screen.getByTestId('thread-menu-older-1'))
    fireEvent.click(screen.getByRole('menuitem', { name: /取消置顶/ }))
    await flush()
    expect(fakeAgent.setThreadPinned).toHaveBeenCalledWith('older-1', false)
  })

  it('search filters rows by title without touching the store list', () => {
    render(<ThreadSidebar />)
    fireEvent.change(screen.getByLabelText(/search threads/i), { target: { value: 'older' } })
    expect(screen.queryByText('Today thread')).toBeNull()
    expect(screen.getByText('Older thread')).toBeTruthy()
    expect(useAgentChatStore.getState().threadList).toHaveLength(2)
  })

  it('Agent 工作台 row opens the agent workspace tab and closes the drawer', () => {
    useAgentChatStore.setState({ isOpen: true })
    useTabStore.setState({ activeTab: 'generate', previousTab: null })
    render(<ThreadSidebar />)
    fireEvent.click(screen.getByRole('button', { name: /agent 工作台/i }))
    expect(useTabStore.getState().activeTab).toBe('agentWorkspace')
    expect(useAgentChatStore.getState().isOpen).toBe(false)
  })

  it('collapses a group longer than 6 rows behind a 更多 button', () => {
    useAgentChatStore.setState({
      threadId: undefined,
      threadList: Array.from({ length: 8 }, (_, i) => ({
        id: `t${i}`,
        title: `Thread ${i}`,
        createdAt: '',
        updatedAt: '',
        lastMessageAt: new Date(Date.now() - i * 60_000).toISOString(),
      })),
    })
    render(<ThreadSidebar />)
    expect(screen.getByText('Thread 5')).toBeTruthy()
    expect(screen.queryByText('Thread 7')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /更多/ }))
    expect(screen.getByText('Thread 7')).toBeTruthy()
  })

  // Subline (after Cursor's per-thread status line): message count + relative
  // time; a running thread says so instead of the time.
  it('shows the message count and relative time under the title', () => {
    useAgentChatStore.setState({
      threadList: [
        {
          id: 'today-1',
          title: 'Today thread',
          createdAt: '',
          updatedAt: '',
          lastMessageAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          messageCount: 12,
        },
        {
          id: 'older-1',
          title: 'Older thread',
          createdAt: '',
          updatedAt: '',
          lastMessageAt: new Date(Date.now() - 100 * 24 * 60 * 60_000).toISOString(),
          messageCount: 0,
        },
      ],
      runningByThread: { 'older-1': true },
    })
    render(<ThreadSidebar />)
    expect(screen.getByText('12 条消息 · 12m ago')).toBeTruthy()
    expect(screen.getByText('运行中 · 0 条消息')).toBeTruthy()
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
