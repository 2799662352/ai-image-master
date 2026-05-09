import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import AgentWorkspacePage from '../../../pages-react/AgentWorkspacePage'
import { useAgentWorkspaceStore } from '../useAgentWorkspaceStore'

afterEach(() => {
  cleanup()
  useAgentWorkspaceStore.setState({ section: 'overview', configDirty: false })
})

describe('AgentWorkspacePage', () => {
  it('renders the six sections in nav', () => {
    render(<AgentWorkspacePage />)

    for (const label of ['Overview', 'Permissions', 'MCP Servers', 'Skills', 'Threads', 'Logs']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('switches active section when nav item clicked', () => {
    render(<AgentWorkspacePage />)

    fireEvent.click(screen.getByText('MCP Servers'))

    expect(screen.getByTestId('section-mcp')).toBeTruthy()
  })
})
