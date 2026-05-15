import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { McpServerCard } from '../McpServerCard'
import type { McpServerCard as McpServerCardData } from '../useMcpStore'

afterEach(() => {
  cleanup()
})

function makeServer(overrides: Partial<McpServerCardData> = {}): McpServerCardData {
  return {
    name: 'test-server',
    type: 'stdio',
    command: 'docker',
    args: ['run', '-i', 'mcp/test'],
    enabled: true,
    status: 'ready',
    error: null,
    tools: [],
    isBuiltin: false,
    ...overrides,
  }
}

describe('McpServerCard', () => {
  it('renders a toggle switch (not a button) bound to enabled state', () => {
    const onToggle = vi.fn()
    render(
      <McpServerCard
        server={makeServer({ enabled: true })}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={onToggle}
        onLogin={vi.fn()}
      />,
    )
    const toggle = screen.getByRole('switch', { name: /启用|enabled/i })
    expect(toggle).toBeTruthy()
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('clicking the toggle switch flips state via onToggle', () => {
    const onToggle = vi.fn()
    render(
      <McpServerCard
        server={makeServer({ enabled: true })}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={onToggle}
        onLogin={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('switch'))
    expect(onToggle).toHaveBeenCalledWith('test-server', false)
  })

  it('shows a "登录" button when authStatus is notLoggedIn', () => {
    const onLogin = vi.fn()
    render(
      <McpServerCard
        server={makeServer({
          name: 'hf-mcp-server',
          type: 'http',
          url: 'https://x',
          authStatus: 'notLoggedIn',
          status: 'starting',
          error: '需要登录',
        })}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onLogin={onLogin}
      />,
    )
    const loginButton = screen.getByRole('button', { name: /登录/ })
    fireEvent.click(loginButton)
    expect(onLogin).toHaveBeenCalledWith('hf-mcp-server')
  })

  it('does not render a login button when already logged in', () => {
    render(
      <McpServerCard
        server={makeServer({ authStatus: 'loggedIn' })}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onLogin={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /^登录$/ })).toBeNull()
  })

  it('shows "登录中..." when loggingIn matches the server name', () => {
    render(
      <McpServerCard
        server={makeServer({ authStatus: 'notLoggedIn', status: 'starting', error: '需要登录' })}
        loggingIn={true}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onLogin={vi.fn()}
      />,
    )
    expect(screen.getByText(/登录中/)).toBeTruthy()
  })

  it('renders the docker MCP bug error with a hint', () => {
    render(
      <McpServerCard
        server={makeServer({
          status: 'failed',
          error: 'Codex bug #19425：docker MCP 已启动但工具未暴露。建议改用 docker mcp gateway。',
        })}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onLogin={vi.fn()}
      />,
    )
    // Both substrings should be present in the rendered DOM
    expect(screen.getByText(/#19425/)).toBeTruthy()
    expect(screen.getByText(/gateway/)).toBeTruthy()
  })

  it('explains ready servers that return no tools', () => {
    render(
      <McpServerCard
        server={makeServer({ name: 'mcp-docker', status: 'ready', tools: [] })}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onLogin={vi.fn()}
      />,
    )
    expect(screen.getByText(/服务器已连接，但未返回工具/)).toBeTruthy()
  })

  it('renders tool descriptions in the DOM for hover help', () => {
    render(
      <McpServerCard
        server={makeServer({
          tools: [{ name: 'search', description: 'Search repositories' }],
        })}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onLogin={vi.fn()}
      />,
    )
    expect(screen.getByText('Search repositories')).toBeTruthy()
  })
})
