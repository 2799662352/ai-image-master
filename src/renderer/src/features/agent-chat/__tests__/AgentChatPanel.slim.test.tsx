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

function renderOpenPanel(): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { agent: fakeAgent },
  })
  useAgentChatStore.setState({ isOpen: true, messages: [], pendingApprovals: [] })
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
