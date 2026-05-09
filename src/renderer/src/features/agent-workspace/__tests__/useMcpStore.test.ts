import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApi = {
  listMcpServersRpc: vi.fn(),
  batchWriteConfig: vi.fn(),
  writeConfigValue: vi.fn(),
  reloadMcpServers: vi.fn(),
  mcpOAuthLogin: vi.fn(),
  readConfig: vi.fn(),
}

const mockShell = {
  openExternal: vi.fn(),
}

vi.stubGlobal('window', {
  electronAPI: { agent: mockApi, shell: mockShell },
})

// Import AFTER stubbing window
const { useMcpStore } = await import('../useMcpStore')

describe('useMcpStore', () => {
  beforeEach(() => {
    useMcpStore.setState({ servers: [], loading: false, error: null, loggingIn: null })
    vi.clearAllMocks()
  })

  it('fetchServers loads from config first then enriches via syncLiveStatus', async () => {
    mockApi.readConfig.mockResolvedValue({
      ok: true,
      config: { mcp_servers: { github: { command: 'docker', args: ['run'] } } },
    })

    let resolveStatus!: (v: any) => void
    mockApi.listMcpServersRpc.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve
      }),
    )

    await useMcpStore.getState().fetchServers()

    // Phase 1: config-only data is visible
    let state = useMcpStore.getState()
    expect(state.loading).toBe(false)
    expect(state.servers).toHaveLength(1)
    expect(state.servers[0].name).toBe('github')
    expect(state.servers[0].tools).toHaveLength(0)
    expect(state.syncing).toBe(true)

    // Phase 2: live status arrives, tools merged in.
    // Schema matches openai/codex ListMcpServerStatusResponse: { data, nextCursor }
    resolveStatus({
      ok: true,
      data: {
        data: [
          {
            name: 'github',
            tools: { search_code: { description: 'Search code' } },
            resources: [],
            resourceTemplates: [],
            authStatus: 'unsupported',
          },
        ],
        nextCursor: null,
      },
    })
    await new Promise((r) => setTimeout(r, 0))

    state = useMcpStore.getState()
    expect(state.syncing).toBe(false)
    expect(state.servers[0].tools).toHaveLength(1)
    expect(state.servers[0].tools[0].name).toBe('search_code')
    expect(state.servers[0].authStatus).toBe('unsupported')
  })

  it('syncLiveStatus failure surfaces syncError without clearing servers', async () => {
    useMcpStore.setState({
      servers: [{ name: 'redis', type: 'stdio', command: 'docker', enabled: true, status: 'unknown', error: null, tools: [], isBuiltin: false }],
    })
    mockApi.listMcpServersRpc.mockResolvedValue({ ok: false, error: 'timeout' })

    await useMcpStore.getState().syncLiveStatus()
    const state = useMcpStore.getState()
    expect(state.syncing).toBe(false)
    expect(state.syncError).toBe('timeout')
    expect(state.servers).toHaveLength(1)
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
    mockApi.listMcpServersRpc.mockResolvedValue({ ok: true, data: { data: [], nextCursor: null } })
    mockApi.readConfig.mockResolvedValue({ ok: true, config: { mcp_servers: {} } })
    await useMcpStore.getState().deleteServer('github')
    expect(mockApi.batchWriteConfig).toHaveBeenCalledWith(
      [{ keyPath: 'mcp_servers.github', value: null, mergeStrategy: 'replace' }],
      true,
    )
  })

  it('syncLiveStatus marks ready/failed based on list response (Codex schema: data + nextCursor)', async () => {
    useMcpStore.setState({
      servers: [
        { name: 'context7', type: 'http', url: 'https://x', enabled: true, status: 'unknown', error: null, tools: [], isBuiltin: false },
        { name: 'redis', type: 'stdio', command: 'docker', enabled: true, status: 'unknown', error: null, tools: [], isBuiltin: false },
        { name: 'broken', type: 'stdio', command: 'nope', enabled: true, status: 'unknown', error: null, tools: [], isBuiltin: false },
      ],
    })

    // Real Codex 0.128 mcpServerStatus/list response:
    // ListMcpServerStatusResponse = { data: McpServerStatus[], nextCursor: string | null }
    // Pinned by openai/codex/codex-rs/app-server-protocol/schema/typescript/v2/ListMcpServerStatusResponse.ts
    mockApi.listMcpServersRpc.mockResolvedValue({
      ok: true,
      data: {
        data: [
          {
            name: 'context7',
            tools: { resolve_library: { description: 'find lib' } },
            resources: [],
            resourceTemplates: [],
            authStatus: 'unsupported',
          },
          {
            name: 'redis',
            tools: {},
            resources: [],
            resourceTemplates: [],
            authStatus: 'unsupported',
          },
        ],
        nextCursor: null,
      },
    })

    await useMcpStore.getState().syncLiveStatus()
    const servers = useMcpStore.getState().servers
    expect(servers.find((s) => s.name === 'context7')!.status).toBe('ready')
    expect(servers.find((s) => s.name === 'context7')!.tools).toHaveLength(1)
    expect(servers.find((s) => s.name === 'context7')!.authStatus).toBe('unsupported')
    expect(servers.find((s) => s.name === 'redis')!.status).toBe('failed')
    expect(servers.find((s) => s.name === 'broken')!.status).toBe('failed')
  })

  it('syncLiveStatus surfaces notLoggedIn auth as starting status with login hint', async () => {
    useMcpStore.setState({
      servers: [
        { name: 'hf-mcp-server', type: 'http', url: 'https://huggingface.co/mcp', enabled: true, status: 'unknown', error: null, tools: [], isBuiltin: false },
      ],
    })
    mockApi.listMcpServersRpc.mockResolvedValue({
      ok: true,
      data: {
        data: [
          { name: 'hf-mcp-server', tools: {}, resources: [], resourceTemplates: [], authStatus: 'notLoggedIn' },
        ],
        nextCursor: null,
      },
    })
    await useMcpStore.getState().syncLiveStatus()
    const s = useMcpStore.getState().servers[0]
    expect(s.status).toBe('starting')
    expect(s.error).toBe('需要登录')
    expect(s.authStatus).toBe('notLoggedIn')
  })

  it('startOAuthLogin opens authorization_url via shell.openExternal and sets loggingIn', async () => {
    useMcpStore.setState({
      servers: [{ name: 'hf-mcp-server', type: 'http', url: 'https://x', enabled: true, status: 'starting', error: '需要登录', tools: [], authStatus: 'notLoggedIn', isBuiltin: false }],
    })
    mockApi.mcpOAuthLogin.mockResolvedValue({
      ok: true,
      authorization_url: 'https://huggingface.co/oauth/authorize?...',
    })
    mockShell.openExternal.mockResolvedValue({ ok: true })

    await useMcpStore.getState().startOAuthLogin('hf-mcp-server')

    expect(mockApi.mcpOAuthLogin).toHaveBeenCalledWith('hf-mcp-server')
    expect(mockShell.openExternal).toHaveBeenCalledWith('https://huggingface.co/oauth/authorize?...')
    expect(useMcpStore.getState().loggingIn).toBe('hf-mcp-server')
  })

  it('startOAuthLogin surfaces error when RPC fails and does not set loggingIn', async () => {
    useMcpStore.setState({
      servers: [{ name: 'hf-mcp-server', type: 'http', url: 'https://x', enabled: true, status: 'failed', error: null, tools: [], isBuiltin: false }],
    })
    mockApi.mcpOAuthLogin.mockResolvedValue({ ok: false, error: 'OAuth not supported' })

    await useMcpStore.getState().startOAuthLogin('hf-mcp-server')

    expect(mockShell.openExternal).not.toHaveBeenCalled()
    expect(useMcpStore.getState().loggingIn).toBeNull()
    const s = useMcpStore.getState().servers.find((x) => x.name === 'hf-mcp-server')!
    expect(s.error).toContain('OAuth not supported')
  })

  it('handleOAuthCompleted clears loggingIn and triggers status sync on success', async () => {
    useMcpStore.setState({
      servers: [{ name: 'hf-mcp-server', type: 'http', url: 'https://x', enabled: true, status: 'starting', error: '需要登录', tools: [], authStatus: 'notLoggedIn', isBuiltin: false }],
      loggingIn: 'hf-mcp-server',
    })
    mockApi.listMcpServersRpc.mockResolvedValue({
      ok: true,
      data: { data: [{ name: 'hf-mcp-server', tools: { search: {} }, resources: [], resourceTemplates: [], authStatus: 'loggedIn' }], nextCursor: null },
    })

    useMcpStore.getState().handleOAuthCompleted({ name: 'hf-mcp-server', success: true, error: null })
    await new Promise((r) => setTimeout(r, 0))

    expect(useMcpStore.getState().loggingIn).toBeNull()
    expect(mockApi.listMcpServersRpc).toHaveBeenCalled()
  })

  it('handleOAuthCompleted records error on failure', () => {
    useMcpStore.setState({
      servers: [{ name: 'hf-mcp-server', type: 'http', url: 'https://x', enabled: true, status: 'starting', error: null, tools: [], isBuiltin: false }],
      loggingIn: 'hf-mcp-server',
    })

    useMcpStore.getState().handleOAuthCompleted({ name: 'hf-mcp-server', success: false, error: 'access denied' })

    expect(useMcpStore.getState().loggingIn).toBeNull()
    const s = useMcpStore.getState().servers[0]
    expect(s.error).toContain('access denied')
  })

  it('deleteServer optimistically removes from state before status sync', async () => {
    useMcpStore.setState({
      servers: [
        { name: 'github', type: 'stdio', command: 'docker', enabled: true, status: 'ready', error: null, tools: [], isBuiltin: false },
        { name: 'context7', type: 'http', url: 'https://x', enabled: true, status: 'ready', error: null, tools: [], isBuiltin: false },
      ],
    })
    let resolveBatch!: (v: any) => void
    mockApi.batchWriteConfig.mockReturnValue(new Promise((r) => { resolveBatch = r }))

    const promise = useMcpStore.getState().deleteServer('github')

    expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual(['context7'])

    resolveBatch({ ok: true })
    mockApi.listMcpServersRpc.mockResolvedValue({ ok: true, data: { data: [], nextCursor: null } })
    await promise
    expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual(['context7'])
  })

  it('deleteServer rolls back on error', async () => {
    const original = { name: 'github', type: 'stdio' as const, command: 'docker', enabled: true, status: 'ready' as const, error: null, tools: [], isBuiltin: false }
    useMcpStore.setState({ servers: [original] })
    mockApi.batchWriteConfig.mockResolvedValue({ ok: false, error: 'config locked' })

    await useMcpStore.getState().deleteServer('github')

    expect(useMcpStore.getState().servers).toHaveLength(1)
    expect(useMcpStore.getState().servers[0].name).toBe('github')
    expect(useMcpStore.getState().error).toContain('config locked')
  })

  it('toggleEnabled triggers reloadMcpServers + syncLiveStatus so Codex picks up change', async () => {
    useMcpStore.setState({
      servers: [{ name: 'github', type: 'stdio', command: 'docker', enabled: true, status: 'ready', error: null, tools: [], isBuiltin: false }],
    })
    mockApi.writeConfigValue.mockResolvedValue({ ok: true })
    mockApi.reloadMcpServers.mockResolvedValue({ ok: true })
    mockApi.listMcpServersRpc.mockResolvedValue({ ok: true, data: { data: [], nextCursor: null } })

    await useMcpStore.getState().toggleEnabled('github', false)

    expect(mockApi.writeConfigValue).toHaveBeenCalledWith('mcp_servers.github.enabled', false)
    expect(mockApi.reloadMcpServers).toHaveBeenCalled()
    expect(mockApi.listMcpServersRpc).toHaveBeenCalled()
    expect(useMcpStore.getState().servers[0].enabled).toBe(false)
  })

  it('toggleEnabled rolls back on write failure', async () => {
    useMcpStore.setState({
      servers: [{ name: 'github', type: 'stdio', command: 'docker', enabled: true, status: 'ready', error: null, tools: [], isBuiltin: false }],
    })
    mockApi.writeConfigValue.mockResolvedValue({ ok: false, error: 'permission denied' })

    await useMcpStore.getState().toggleEnabled('github', false)

    expect(useMcpStore.getState().servers[0].enabled).toBe(true)
    expect(useMcpStore.getState().error).toContain('permission denied')
  })

  it('syncLiveStatus flags docker-based stdio servers with empty tools as Codex bug', async () => {
    useMcpStore.setState({
      servers: [
        { name: 'sequentialthinking', type: 'stdio', command: 'docker', args: ['run', '-i', 'mcp/sequentialthinking'], enabled: true, status: 'unknown', error: null, tools: [], isBuiltin: false },
      ],
    })
    mockApi.listMcpServersRpc.mockResolvedValue({
      ok: true,
      data: {
        data: [
          { name: 'sequentialthinking', tools: {}, resources: [], resourceTemplates: [], authStatus: 'unsupported' },
        ],
        nextCursor: null,
      },
    })

    await useMcpStore.getState().syncLiveStatus()
    const s = useMcpStore.getState().servers[0]
    expect(s.status).toBe('failed')
    expect(s.error).toMatch(/Codex bug|#19425|gateway/i)
  })

  it('fetchServers falls back to config-only when status RPC fails', async () => {
    mockApi.listMcpServersRpc.mockRejectedValue(new Error('timeout'))
    mockApi.readConfig.mockResolvedValue({
      ok: true,
      config: {
        mcp_servers: {
          redis: { command: 'docker', args: ['run', 'redis'] },
          myhttp: { url: 'https://example.com/mcp' },
        },
      },
    })

    await useMcpStore.getState().fetchServers()
    const state = useMcpStore.getState()
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.servers).toHaveLength(2)
    expect(state.servers[0].name).toBe('redis')
    expect(state.servers[0].type).toBe('stdio')
    expect(state.servers[0].tools).toHaveLength(0)
    expect(state.servers[1].name).toBe('myhttp')
    expect(state.servers[1].type).toBe('http')
  })

  it('startOAuthLogin clears previous error before calling mcpOAuthLogin', async () => {
    useMcpStore.setState({
      servers: [{ name: 'hf', type: 'http', url: 'https://x', enabled: true, status: 'starting', error: 'timed out waiting for OAuth callback', tools: [], authStatus: 'notLoggedIn', isBuiltin: false }],
    })
    mockApi.mcpOAuthLogin.mockResolvedValue({ ok: true, authorization_url: 'https://auth.example.com/login' })
    mockShell.openExternal.mockResolvedValue({ ok: true })

    await useMcpStore.getState().startOAuthLogin('hf')

    const s = useMcpStore.getState().servers.find((x) => x.name === 'hf')!
    expect(s.error).toBeNull()
  })

  it('startOAuthLogin calls shell.openExternal with authorization_url', async () => {
    useMcpStore.setState({
      servers: [{ name: 'hf', type: 'http', url: 'https://x', enabled: true, status: 'starting', error: null, tools: [], authStatus: 'notLoggedIn', isBuiltin: false }],
    })
    mockApi.mcpOAuthLogin.mockResolvedValue({ ok: true, authorization_url: 'https://auth.example.com/login' })
    mockShell.openExternal.mockResolvedValue({ ok: true })

    await useMcpStore.getState().startOAuthLogin('hf')

    expect(mockShell.openExternal).toHaveBeenCalledOnce()
    expect(mockShell.openExternal).toHaveBeenCalledWith('https://auth.example.com/login')
    expect(useMcpStore.getState().loggingIn).toBe('hf')
  })

  it('startOAuthLogin sets helpful error when shell is unavailable', async () => {
    const savedShell = (window as any).electronAPI.shell
    ;(window as any).electronAPI.shell = undefined

    useMcpStore.setState({
      servers: [{ name: 'hf', type: 'http', url: 'https://x', enabled: true, status: 'starting', error: null, tools: [], authStatus: 'notLoggedIn', isBuiltin: false }],
    })
    mockApi.mcpOAuthLogin.mockResolvedValue({ ok: true, authorization_url: 'https://auth.example.com/login' })

    await useMcpStore.getState().startOAuthLogin('hf')

    const s = useMcpStore.getState().servers.find((x) => x.name === 'hf')!
    expect(s.error).toContain('无法打开浏览器')
    ;(window as any).electronAPI.shell = savedShell
  })
})
