import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAgentWorkspaceStore } from '../../agent-workspace/useAgentWorkspaceStore'
import { AgentChatPanel } from '../AgentChatPanel'
import { useAgentChatStore } from '../store'
import { useTabStore } from '../../../stores/useTabStore'

const fakeAgent = {
  onEvent: vi.fn(() => () => undefined),
  onApprovalRequest: vi.fn(() => () => undefined),
  getSessionStatus: vi.fn().mockResolvedValue({
    model: 'codex-test',
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    webSearch: 'live',
    writableRoots: [],
  }),
  listThreads: vi.fn().mockResolvedValue([]),
  listCodexThreads: vi.fn().mockResolvedValue([]),
  restartCodex: vi.fn().mockResolvedValue({ ok: true }),
  setSessionConfig: vi.fn().mockResolvedValue({
    model: 'codex-test',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    webSearch: 'live',
    writableRoots: [],
  }),
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'electronAPI')
  useAgentChatStore.setState({ isOpen: false, messages: [], pendingApprovals: [], error: undefined })
  useAgentWorkspaceStore.setState({ section: 'overview', configDirty: false })
  useTabStore.setState({ activeTab: 'generate' })
  vi.clearAllMocks()
})

function renderOpenPanel(
  pendingApprovals: ReturnType<typeof useAgentChatStore.getState>['pendingApprovals'] = [],
): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { agent: fakeAgent },
  })
  useAgentChatStore.setState({ isOpen: true, messages: [], pendingApprovals })
  render(<AgentChatPanel />)
}

describe('AgentChatPanel slim-down', () => {
  it('does not render the three large Codex panels in the header', () => {
    renderOpenPanel()

    expect(screen.queryByText(/Codex permissions/i)).toBeNull()
    expect(screen.queryByText(/MCP servers/i)).toBeNull()
    expect(screen.queryByText(/Skills/i)).toBeNull()
  })

  it('renders a status strip and Open Agent Workspace link', () => {
    renderOpenPanel()

    expect(screen.getByText(/Open Agent Workspace/i)).toBeTruthy()
  })

  it('opens the Agent Workspace tab and closes the chat overlay', () => {
    renderOpenPanel()

    fireEvent.click(screen.getByText(/Open Agent Workspace/i))

    expect(useTabStore.getState().activeTab).toBe('agentWorkspace')
    expect(useAgentChatStore.getState().isOpen).toBe(false)
  })

  it('opens the Codex settings popover from the gear button and applies a patch', async () => {
    renderOpenPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Codex 设置' }))

    expect(await screen.findByTestId('codex-settings-popover')).toBeTruthy()
    // Session status loads into the popover form (danger-full-access checked).
    expect(
      await screen.findByRole('radio', { name: /danger-full-access/ }),
    ).toHaveProperty('checked', true)

    fireEvent.click(screen.getByRole('radio', { name: /workspace-write/ }))
    fireEvent.click(screen.getByRole('button', { name: /应用设置/ }))

    await waitFor(() =>
      expect(fakeAgent.setSessionConfig).toHaveBeenCalledWith({ sandboxMode: 'workspace-write' }),
    )
  })

  it('restarts Codex from the config dirty banner', async () => {
    useAgentWorkspaceStore.setState({ configDirty: true })
    renderOpenPanel()

    fireEvent.click(screen.getByText(/Restart Codex/i))

    await waitFor(() => expect(fakeAgent.restartCodex).toHaveBeenCalled())
    expect(useAgentWorkspaceStore.getState().configDirty).toBe(false)
  })
})

describe('AgentChatPanel pending server requests', () => {
  const base = { threadId: 'thread-1', createdAt: '2026-09-02T00:00:00.000Z' }

  it('停靠在滚动区外(输入框上方),而不是塞在对话顶部随内容滚走', () => {
    renderOpenPanel([
      { ...base, id: '1', method: 'item/commandExecution/requestApproval', params: { command: 'ls' } },
    ])

    const dock = screen.getByTestId('pending-server-requests')
    const scroll = document.querySelector('.chat-scroll')
    expect(scroll).toBeTruthy()
    expect(scroll!.contains(dock)).toBe(false)
    // 紧挨着滚动区之后,composer 之前。
    expect(scroll!.nextElementSibling).toBe(dock)
  })

  it('按方法分派:requestUserInput 走提问卡,其余走审批卡', () => {
    renderOpenPanel([
      { ...base, id: '1', method: 'item/commandExecution/requestApproval', params: { command: 'ls' } },
      {
        ...base,
        id: '2',
        method: 'item/tool/requestUserInput',
        params: {
          questions: [
            { id: 'q', header: 'H', question: '选哪个？', isOther: false, isSecret: false, options: [{ label: 'A', description: '' }] },
          ],
        },
      },
    ])

    expect(screen.getByRole('button', { name: /execute/i })).toBeTruthy()
    expect(screen.getByTestId('codex-user-input-card')).toBeTruthy()
    expect(screen.getByText('选哪个？')).toBeTruthy()
    // 提问卡绝不能长成 Approve/Deny —— 那个回包形状 app-server 不认。
    expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull()
  })
})
