import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApi = {
  listMcpServersRpc: vi.fn(),
  batchWriteConfig: vi.fn(),
  writeConfigValue: vi.fn(),
  reloadMcpServers: vi.fn(),
  mcpOAuthLogin: vi.fn(),
  readConfig: vi.fn(),
}

vi.stubGlobal('window', {
  electronAPI: { agent: mockApi },
})

// Import AFTER stubbing window
const { useMcpStore } = await import('../useMcpStore')

describe('useMcpStore', () => {
  beforeEach(() => {
    useMcpStore.setState({ servers: [], loading: false, error: null })
    vi.clearAllMocks()
  })

  it('fetchServers populates server list from RPC response', async () => {
    mockApi.listMcpServersRpc.mockResolvedValue({
      ok: true,
      data: {
        mcpServers: [
          {
            name: 'github',
            tools: { search_code: { description: 'Search code' } },
            resources: [],
            resource_templates: [],
            auth_status: 'unsupported',
          },
        ],
      },
    })
    mockApi.readConfig.mockResolvedValue({ ok: true, config: { mcp_servers: { github: { command: 'docker', args: ['run'] } } } })

    await useMcpStore.getState().fetchServers()
    const state = useMcpStore.getState()
    expect(state.servers).toHaveLength(1)
    expect(state.servers[0].name).toBe('github')
    expect(state.servers[0].tools).toHaveLength(1)
    expect(state.servers[0].tools[0].name).toBe('search_code')
  })

  it('updateStatus updates a server status in-place', () => {
    useMcpStore.setState({
      servers: [{ name: 'github', type: 'stdio', command: 'docker', enabled: true, status: 'starting', error: null, tools: [], isBuiltin: false }],
    })
    useMcpStore.getState().updateStatus('github', 'ready', null)
    expect(useMcpStore.getState().servers[0].status).toBe('ready')
  })

  it('updateStatus sets error on failed', () => {
    useMcpStore.setState({
      servers: [{ name: 'broken', type: 'stdio', command: 'nope', enabled: true, status: 'starting', error: null, tools: [], isBuiltin: false }],
    })
    useMcpStore.getState().updateStatus('broken', 'failed', 'spawn ENOENT')
    const s = useMcpStore.getState().servers[0]
    expect(s.status).toBe('failed')
    expect(s.error).toBe('spawn ENOENT')
  })

  it('toggleEnabled calls writeConfigValue and updates state', async () => {
    useMcpStore.setState({
      servers: [{ name: 'github', type: 'stdio', command: 'docker', enabled: true, status: 'ready', error: null, tools: [], isBuiltin: false }],
    })
    mockApi.writeConfigValue.mockResolvedValue({ ok: true })
    await useMcpStore.getState().toggleEnabled('github', false)
    expect(mockApi.writeConfigValue).toHaveBeenCalledWith('mcp_servers.github.enabled', false)
  })

  it('deleteServer calls batchWriteConfig to remove key', async () => {
    useMcpStore.setState({
      servers: [{ name: 'github', type: 'stdio', command: 'docker', enabled: true, status: 'ready', error: null, tools: [], isBuiltin: false }],
    })
    mockApi.batchWriteConfig.mockResolvedValue({ ok: true })
    mockApi.listMcpServersRpc.mockResolvedValue({ ok: true, data: { mcpServers: [] } })
    mockApi.readConfig.mockResolvedValue({ ok: true, config: { mcp_servers: {} } })
    await useMcpStore.getState().deleteServer('github')
    expect(mockApi.batchWriteConfig).toHaveBeenCalledWith(
      [{ keyPath: 'mcp_servers.github', value: null }],
      true,
    )
  })
})
