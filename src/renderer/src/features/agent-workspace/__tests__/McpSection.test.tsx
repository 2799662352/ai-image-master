import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CodexMcpServerListItem } from '../../../../../types/agent'
import { McpSection } from '../McpSection'
import { useAgentWorkspaceStore } from '../useAgentWorkspaceStore'

function mcpFixture(overrides: Partial<CodexMcpServerListItem>): CodexMcpServerListItem {
  return {
    id: 'github',
    name: 'github',
    scope: 'personal',
    enabled: true,
    command: 'npx',
    argsSummary: 'mcp-server-github',
    envKeysRedacted: ['GITHUB_TOKEN'],
    lastModifiedIso: '2026-05-09T00:00:00.000Z',
    provenance: 'manual',
    warnings: [],
    ...overrides,
  }
}

function installAgentApi(items: CodexMcpServerListItem[]) {
  const api = {
    listMcp: vi.fn().mockResolvedValue(items),
    deleteMcp: vi.fn().mockResolvedValue({ ok: true }),
    setMcpEnabled: vi.fn().mockResolvedValue({ ok: true }),
    restartCodex: vi.fn().mockResolvedValue({ ok: true }),
  }

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      agent: api,
    },
  })

  return api
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'electronAPI')
  useAgentWorkspaceStore.setState({ section: 'overview', configDirty: false })
  vi.restoreAllMocks()
})

describe('McpSection', () => {
  it('lists MCP servers grouped by scope and shows redacted env keys', async () => {
    installAgentApi([
      mcpFixture({ id: 'github', name: 'github', scope: 'personal', envKeysRedacted: ['GITHUB_TOKEN'] }),
      mcpFixture({
        id: 'local',
        name: 'local',
        scope: 'workspace',
        command: 'node',
        argsSummary: './local-server.js',
        envKeysRedacted: ['LOCAL_SECRET'],
      }),
    ])

    render(<McpSection />)

    expect(await screen.findByText('Personal (~/.codex)')).toBeTruthy()
    expect(screen.getByText('Workspace (<projectRoot>/.codex)')).toBeTruthy()
    expect(screen.getByText('github')).toBeTruthy()
    expect(screen.getByText('local')).toBeTruthy()
    expect(screen.getByText('GITHUB_TOKEN')).toBeTruthy()
    expect(screen.getByText('LOCAL_SECRET')).toBeTruthy()
  })

  it('refreshes after delete', async () => {
    const api = installAgentApi([])
    api.listMcp.mockResolvedValueOnce([mcpFixture({ id: 'a', name: 'a' })]).mockResolvedValueOnce([])

    render(<McpSection />)

    expect(await screen.findByText('a')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Delete a'))
    fireEvent.click(screen.getByText('Confirm delete'))

    expect(await screen.findByText('No MCP servers yet.')).toBeTruthy()
    expect(api.deleteMcp).toHaveBeenCalledWith('a')
  })
})
