import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentChatPanel } from '../AgentChatPanel'
import { useAgentChatStore } from '../store'

const fakeAgent = {
  listThreads: vi.fn(),
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
  getSessionStatus: vi.fn(),
}

beforeEach(() => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    ...(globalThis as unknown as { window: Record<string, unknown> }).window,
    electronAPI: { agent: fakeAgent },
    innerWidth: 1600,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
  fakeAgent.listThreads.mockResolvedValue([])
  fakeAgent.openThread.mockResolvedValue({ id: 't1', messages: [] })
  fakeAgent.getSessionStatus.mockResolvedValue({
    model: 'gpt-5.5',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
    webSearch: true,
    writableRoots: [],
  })
  useAgentChatStore.setState({
    isOpen: true,
    messages: [],
    error: undefined,
    panelWidth: 420,
    sidebarOpen: true,
    sidebarWidth: 240,
    threadList: [],
    bootstrapped: false,
    isRunning: false,
    tokenUsage: undefined,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AgentChatPanel + sidebar integration', () => {
  it('calls bootstrap() on first open', () => {
    render(<AgentChatPanel />)
    expect(fakeAgent.listThreads).toHaveBeenCalledTimes(1)
  })

  it('sets right offset = sidebarWidth when sidebar is open', () => {
    render(<AgentChatPanel />)
    const aside = screen.getByTestId('agent-chat-panel') as HTMLElement
    expect(aside.style.right).toBe('240px')
  })

  it('sets right offset = 0 when sidebar is fully collapsed (no 24px rail)', () => {
    useAgentChatStore.setState({ sidebarOpen: false })
    render(<AgentChatPanel />)
    const aside = screen.getByTestId('agent-chat-panel') as HTMLElement
    expect(aside.style.right).toBe('0px')
  })

  it('does not render ThreadSidebar when chat panel is closed', () => {
    useAgentChatStore.setState({ isOpen: false, sidebarOpen: true })
    render(<AgentChatPanel />)
    expect(screen.queryByTestId('thread-sidebar')).toBeNull()
  })

  it('header sidebar toggle button flips sidebarOpen', () => {
    render(<AgentChatPanel />)
    const btn = screen.getByRole('button', { name: /thread sidebar/i })
    fireEvent.click(btn)
    expect(useAgentChatStore.getState().sidebarOpen).toBe(false)
  })

  it('CodexStatusPanel reflects the renderer-selected model label, not the main-process default', async () => {
    useAgentChatStore.setState({ selectedModelId: 'gpt-5.4-nano' })

    render(<AgentChatPanel />)
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.getByText(/Codex GPT-5\.4 Nano/i)).toBeTruthy()
    expect(screen.queryByText(/Codex gpt-5\.5/i)).toBeNull()
  })
})
