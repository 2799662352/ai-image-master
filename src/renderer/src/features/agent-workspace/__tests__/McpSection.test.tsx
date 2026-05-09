import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    getMcpDetail: vi.fn().mockResolvedValue({
      id: 'personal:a',
      name: 'a',
      scope: 'personal',
      enabled: true,
      command: 'node',
      args: [],
      env: [],
      description: '',
    }),
    saveMcp: vi.fn().mockResolvedValue({ ok: true, id: 'personal:a' }),
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return { promise, resolve, reject }
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

  it('opens an existing MCP server in the editor', async () => {
    const api = installAgentApi([mcpFixture({ id: 'personal:a', name: 'a' })])

    render(<McpSection />)

    fireEvent.click(await screen.findByLabelText('Edit a'))

    expect(await screen.findByLabelText('Command')).toBeTruthy()
    expect(api.getMcpDetail).toHaveBeenCalledWith('personal:a')
  })

  it('ignores a stale list response when a newer load resolves first', async () => {
    const firstLoad = deferred<CodexMcpServerListItem[]>()
    const secondLoad = deferred<CodexMcpServerListItem[]>()
    const api = installAgentApi([])
    api.listMcp.mockReset()
    api.listMcp.mockReturnValueOnce(firstLoad.promise).mockReturnValueOnce(secondLoad.promise)

    render(
      <StrictMode>
        <McpSection />
      </StrictMode>,
    )

    await waitFor(() => expect(api.listMcp).toHaveBeenCalledTimes(2))

    await act(async () => {
      secondLoad.resolve([mcpFixture({ id: 'newer', name: 'newer' })])
    })

    expect(await screen.findByText('newer')).toBeTruthy()

    await act(async () => {
      firstLoad.resolve([mcpFixture({ id: 'stale', name: 'stale' })])
    })

    expect(screen.getByText('newer')).toBeTruthy()
    expect(screen.queryByText('stale')).toBeNull()
  })

  it('prevents overlapping MCP mutations while an action is in flight', async () => {
    const toggleResult = deferred<{ ok: true }>()
    const api = installAgentApi([mcpFixture({ id: 'a', name: 'a' })])
    api.setMcpEnabled.mockReturnValue(toggleResult.promise)

    render(<McpSection />)

    const toggleButton = await screen.findByLabelText('Disable a')
    fireEvent.click(toggleButton)
    fireEvent.click(toggleButton)

    expect(api.setMcpEnabled).toHaveBeenCalledTimes(1)
    expect((toggleButton as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      toggleResult.resolve({ ok: true })
    })
  })

  it('disables editor save while another MCP mutation is in flight', async () => {
    const toggleResult = deferred<{ ok: true }>()
    const api = installAgentApi([mcpFixture({ id: 'a', name: 'a' })])
    api.setMcpEnabled.mockReturnValue(toggleResult.promise)

    render(<McpSection />)

    fireEvent.click(await screen.findByText('New MCP Server'))
    fireEvent.click(screen.getByLabelText('Disable a'))

    const saveButton = await screen.findByText('Save')
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(true))
    fireEvent.click(saveButton)

    expect(api.saveMcp).not.toHaveBeenCalled()

    await act(async () => {
      toggleResult.resolve({ ok: true })
    })
  })

  it('refreshes after save even if the editor closes during the saved delay', async () => {
    const api = installAgentApi([mcpFixture({ id: 'a', name: 'a' })])
    api.listMcp.mockResolvedValueOnce([mcpFixture({ id: 'a', name: 'a' })]).mockResolvedValueOnce([])

    render(<McpSection />)

    fireEvent.click(await screen.findByText('New MCP Server'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'a' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } })
    fireEvent.click(screen.getByText('Save'))

    expect(await screen.findByText('Saved')).toBeTruthy()
    fireEvent.click(screen.getByText('Close'))

    await waitFor(() => expect(api.listMcp).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No MCP servers yet.')).toBeTruthy()
  })
})
