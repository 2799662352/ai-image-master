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
    isAppBundled: false,
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

  // Cursor-style UX: edit + delete buttons must be ALWAYS visible (not
  // hover-revealed) so users do not need to know to hover and never need
  // to scroll the card off-screen to reach destructive actions.
  it('renders edit and delete buttons in the header row, always visible (no hover required)', () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    render(
      <McpServerCard
        server={makeServer()}
        onEdit={onEdit}
        onDelete={onDelete}
        onToggle={vi.fn()}
        onLogin={vi.fn()}
      />,
    )
    const editBtn = screen.getByRole('button', { name: /编辑 test-server/ })
    const deleteBtn = screen.getByRole('button', { name: /删除 test-server/ })
    expect(editBtn).toBeTruthy()
    expect(deleteBtn).toBeTruthy()
    fireEvent.click(editBtn)
    expect(onEdit).toHaveBeenCalledWith('test-server')
    fireEvent.click(deleteBtn)
    expect(onDelete).toHaveBeenCalledWith('test-server')
  })

  it('hides edit and delete buttons for codex built-in servers', () => {
    render(
      <McpServerCard
        server={makeServer({ isBuiltin: true })}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onLogin={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /编辑/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull()
  })

  it('shows a "预装" badge for app-bundled MCPs', () => {
    render(
      <McpServerCard
        server={makeServer({ name: 'apiyi', isAppBundled: true })}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onLogin={vi.fn()}
      />,
    )
    expect(screen.getByText('预装')).toBeTruthy()
  })

  it('apiyi (bundled) gets the api-key hint instead of the Docker MCP Gateway hint', () => {
    render(
      <McpServerCard
        server={makeServer({
          name: 'apiyi',
          isAppBundled: true,
          command: 'node',
          args: ['/path/to/apiyi-mcp/dist/index.js'],
          status: 'ready',
          tools: [],
        })}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onLogin={vi.fn()}
      />,
    )
    // Post-refactor: hint must point to the ✏️ JSON editor (not the deleted
    // "设置 → 视频理解 API Key" path) and explicitly flag the whitespace-key
    // trap (apiyi-mcp accepts " " as truthy, then Google GenAI rejects it).
    expect(screen.getByText(/env\.APIYI_API_KEY/)).toBeTruthy()
    expect(screen.getByText(/不能是空格/)).toBeTruthy()
    expect(screen.queryByText(/视频理解 API Key/)).toBeNull()
    expect(screen.queryByText(/Docker Desktop/)).toBeNull()
  })
})
