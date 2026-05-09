import { act, cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentChatPanel } from '../AgentChatPanel'
import { useAgentChatStore } from '../store'
import type { CodexApprovalRequest } from '../../../../../types/agent'

let approvalRequestHandler: ((request: CodexApprovalRequest) => void) | undefined

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
  onApprovalRequest: vi.fn(() => () => undefined),
  sendToolResponse: vi.fn(),
  respondApproval: vi.fn(),
  setApiKey: vi.fn(),
  testConnection: vi.fn(),
  getSessionStatus: vi.fn(),
  setSessionConfig: vi.fn(),
}

beforeEach(() => {
  approvalRequestHandler = undefined
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    ...(globalThis as unknown as { window: Record<string, unknown> }).window,
    electronAPI: { agent: fakeAgent },
    innerWidth: 1600,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
  fakeAgent.listThreads.mockResolvedValue([])
  fakeAgent.openThread.mockResolvedValue({ id: 't1', messages: [] })
  fakeAgent.onApprovalRequest.mockImplementation(((handler: (request: CodexApprovalRequest) => void) => {
    approvalRequestHandler = handler
    return () => {
      approvalRequestHandler = undefined
    }
  }) as typeof fakeAgent.onApprovalRequest)
  fakeAgent.respondApproval.mockResolvedValue({ ok: true })
  fakeAgent.getSessionStatus.mockResolvedValue({
    model: 'gpt-5.5',
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    webSearch: 'live',
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
    pendingApprovals: [],
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

  it('keeps approval subscription active while closed and shows pending prompt when opened', async () => {
    const request: CodexApprovalRequest = {
      id: '43',
      threadId: 'thread-1',
      method: 'request_permission',
      params: { reason: 'run command', command: 'npm test -- --watch=false' },
      createdAt: '2026-05-09T00:00:00.000Z',
    }
    useAgentChatStore.setState({ isOpen: false })

    render(<AgentChatPanel />)
    expect(fakeAgent.onApprovalRequest).toHaveBeenCalledTimes(1)

    act(() => {
      approvalRequestHandler?.(request)
    })
    expect(screen.queryByText(/request_permission/i)).toBeNull()

    act(() => {
      useAgentChatStore.getState().toggle()
    })

    expect(await screen.findByText(/request_permission/i)).toBeTruthy()
    expect(screen.getByText(/npm test -- --watch=false/i)).toBeTruthy()
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

  it('shows a compact Codex status strip instead of inline permission controls', async () => {
    render(<AgentChatPanel />)
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.getByText(/Codex · danger-full-access · never · live/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open Agent Workspace/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /apply permissions/i })).toBeNull()
  })

  it('renders approval requests from subscription and removes them after approval response succeeds', async () => {
    const request: CodexApprovalRequest = {
      id: '41',
      threadId: 'thread-1',
      method: 'request_permission',
      params: { reason: 'run command', command: 'npm test' },
      createdAt: '2026-05-09T00:00:00.000Z',
    }

    render(<AgentChatPanel />)
    expect(fakeAgent.onApprovalRequest).toHaveBeenCalledTimes(1)

    act(() => {
      approvalRequestHandler?.(request)
    })

    expect(await screen.findByText(/request_permission/i)).toBeTruthy()
    expect(screen.getByText(/npm test/i)).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /approve/i }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fakeAgent.respondApproval).toHaveBeenCalledWith({ id: '41', approved: true })
    expect(screen.queryByText(/request_permission/i)).toBeNull()
  })

  it('sends denial responses with a message and removes the approval prompt after success', async () => {
    const request: CodexApprovalRequest = {
      id: '42',
      threadId: 'thread-1',
      method: 'request_permission',
      params: { reason: 'run command', command: 'npm run build' },
      createdAt: '2026-05-09T00:00:00.000Z',
    }

    render(<AgentChatPanel />)

    act(() => {
      approvalRequestHandler?.(request)
    })

    expect(await screen.findByText(/request_permission/i)).toBeTruthy()
    expect(screen.getByText(/npm run build/i)).toBeTruthy()

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/denial message/i), { target: { value: 'Too risky' } })
      fireEvent.click(screen.getByRole('button', { name: /deny/i }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fakeAgent.respondApproval).toHaveBeenCalledWith({
      id: '42',
      approved: false,
      message: 'Too risky',
    })
    expect(screen.queryByText(/request_permission/i)).toBeNull()
  })
})
