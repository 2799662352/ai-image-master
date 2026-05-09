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
    useMcpStore.setState({ servers: [], loading: false, error: null, hasFetchedOnce: false, syncing: false })
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

  it('fetchServers requests detail:"toolsAndAuthOnly" to avoid slow resource probing (codex PR #16831)', async () => {
    mockApi.listMcpServersRpc.mockResolvedValue({ ok: true, data: { mcpServers: [] } })
    mockApi.readConfig.mockResolvedValue({ ok: true, config: { mcp_servers: {} } })

    await useMcpStore.getState().fetchServers()

    expect(mockApi.listMcpServersRpc).toHaveBeenCalledWith({ detail: 'toolsAndAuthOnly' })
  })

  it('fetchServers falls back to config-only when listMcpServersRpc fails', async () => {
    mockApi.listMcpServersRpc.mockResolvedValue({ ok: false, error: 'rpc died' })
    mockApi.readConfig.mockResolvedValue({
      ok: true,
      config: { mcp_servers: { local: { command: 'node', args: ['s.js'] } } },
    })

    await useMcpStore.getState().fetchServers()
    const state = useMcpStore.getState()
    expect(state.servers).toHaveLength(1)
    expect(state.servers[0].name).toBe('local')
    expect(state.loading).toBe(false)
    expect(state.syncError).toBe('rpc died')
  })

  it('fetchServers does NOT set loading on subsequent calls (uses syncing instead)', async () => {
    mockApi.listMcpServersRpc.mockResolvedValue({ ok: true, data: { mcpServers: [] } })
    mockApi.readConfig.mockResolvedValue({ ok: true, config: { mcp_servers: {} } })

    await useMcpStore.getState().fetchServers()
    expect(useMcpStore.getState().hasFetchedOnce).toBe(true)
    expect(useMcpStore.getState().loading).toBe(false)

    let observedLoading: boolean | null = null
    mockApi.listMcpServersRpc.mockImplementationOnce(async () => {
      observedLoading = useMcpStore.getState().loading
      return { ok: true, data: { mcpServers: [] } }
    })
    await useMcpStore.getState().fetchServers()
    expect(observedLoading).toBe(false)
  })

  it('fetchServers does not block forever when RPC hangs (timeout)', async () => {
    vi.useFakeTimers()
    try {
      mockApi.listMcpServersRpc.mockImplementation(() => new Promise(() => {}))
      mockApi.readConfig.mockImplementation(() => new Promise(() => {}))
      const promise = useMcpStore.getState().fetchServers()
      await vi.advanceTimersByTimeAsync(25_000)
      await promise
      const state = useMcpStore.getState()
      expect(state.loading).toBe(false)
      expect(state.syncError).toMatch(/timeout|超时/i)
    } finally {
      vi.useRealTimers()
    }
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
      [{ keyPath: 'mcp_servers.github', value: null, mergeStrategy: 'replace' }],
      true,
    )
  })

  describe('autofix store fields', () => {
    it('setLastAutoFix stores value and dismissLastAutoFix clears it', () => {
      useMcpStore.getState().setLastAutoFix({ count: 3, port: 8811, ts: 1000 })
      expect(useMcpStore.getState().lastAutoFix).toEqual({ count: 3, port: 8811, ts: 1000 })

      useMcpStore.getState().dismissLastAutoFix()
      expect(useMcpStore.getState().lastAutoFix).toBeNull()
    })

    it('lastConvertedFingerprint persists across state changes', () => {
      useMcpStore.setState({ lastConvertedFingerprint: 'a,b,c' })
      expect(useMcpStore.getState().lastConvertedFingerprint).toBe('a,b,c')
    })

    it('dismissLastAutoFix does not touch lastConvertedFingerprint', () => {
      useMcpStore.setState({ lastConvertedFingerprint: 'x', lastAutoFix: { count: 1, port: 8811, ts: 1 } })
      useMcpStore.getState().dismissLastAutoFix()
      expect(useMcpStore.getState().lastConvertedFingerprint).toBe('x')
    })
  })
})
