import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAgentChatStore } from '../../features/agent-chat'
import { useTabStore } from '../../stores'
import { AgentStatusButton } from '../AgentStatusButton'

describe('AgentStatusButton', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useAgentChatStore.setState({ isOpen: false })
    useTabStore.setState({ activeTab: 'generate', previousTab: null })
  })

  it('renders compact pill with sandbox and approval', () => {
    render(<AgentStatusButton />)

    const button = screen.getByTestId('agent-status-button')
    expect(button.textContent).toMatch(/Codex/)
    expect(button.textContent).toContain('workspace-write')
    expect(button.textContent).toContain('on-request')
  })

  it('opens chat panel on click', () => {
    const open = vi.spyOn(useAgentChatStore.getState(), 'toggle')
    render(<AgentStatusButton />)

    fireEvent.click(screen.getByTestId('agent-status-button'))

    expect(open).toHaveBeenCalled()
  })

  it('switches to agentWorkspace tab on Open Workspace link', () => {
    render(<AgentStatusButton />)

    fireEvent.click(screen.getByText(/Open Workspace/))

    expect(useTabStore.getState().activeTab).toBe('agentWorkspace')
  })
})
