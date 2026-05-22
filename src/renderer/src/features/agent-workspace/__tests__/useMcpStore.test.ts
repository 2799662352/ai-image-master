import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApi = {
  listMcpServersRpc: vi.fn(),
  batchWriteConfig: vi.fn(),
  writeConfigValue: vi.fn(),
  reloadMcpServers: vi.fn(),
  mcpOAuthLogin: vi.fn(),
  readConfig: vi.fn(),
  readRawConfig: vi.fn(),
  getMcpStatusSnapshot: vi.fn().mockResolvedValue({ ok: true, snapshot: {} }),
  onMcpStatus: vi.fn().mockReturnValue(() => undefined),
}

vi.stubGlobal('window', {
  electronAPI: { agent: mockApi, shell: { openExternal: vi.fn() } },
})

// Import AFTER stubbing window
const { useMcpStore } = await import('../useMcpStore')

describe('useMcpStore', () => {
  beforeEach(() => {
    useMcpStore.setState({
      servers: [],
      loading: false,
      error: null,
      codexConfigError: null,
      hasFetchedOnce: false,
      syncing: false,
      syncError: null,
      liveStatusByName: {},
    })
    vi.clearAllMocks()
    mockApi.getMcpStatusSnapshot.mockResolvedValue({ ok: true, snapshot: {} })
    mockApi.onMcpStatus.mockReturnValue(() => undefined)
    ;(window as any).electronAPI.shell.openExternal.mockResolvedValue({ success: true })
  })

  it('fetchServers does NOT block on listMcpServersRpc — paints from config alone', async () => {
    // Simulate listMcpServersRpc hanging forever (real-world: 11 servers, codex stalls on tools/list)
    mockApi.listMcpServersRpc.mockImplementation(() => new Promise(() => {}))
    mockApi.readConfig.mockResolvedValue({
      ok: true,
      config: { mcp_servers: { a: { command: 'x' }, b: { command: 'y' } } },
    })

    await useMcpStore.getState().fetchServers()
    const state = useMcpStore.getState()
    expect(state.servers.map((s) => s.name).sort()).toEqual(['a', 'b'])
    expect(state.loading).toBe(false)
    // Tools sync is fired but does NOT block — no timeout error visible
    expect(state.syncError).toBeNull()
  })

  it('fetchServers fires syncTools in background with detail:"toolsAndAuthOnly"', async () => {
    let resolveList: (v: any) => void = () => undefined
    mockApi.listMcpServersRpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve
        }),
    )
    mockApi.readConfig.mockResolvedValue({ ok: true, config: { mcp_servers: { gh: { command: 'docker' } } } })

    await useMcpStore.getState().fetchServers()
    expect(mockApi.listMcpServersRpc).toHaveBeenCalledWith({ detail: 'toolsAndAuthOnly' })
    expect(useMcpStore.getState().syncing).toBe(true)

    resolveList({
      ok: true,
      data: [
        { name: 'gh', tools: { search: { description: 'd' } }, resources: [], resourceTemplates: [], authStatus: 'unsupported' },
      ],
    })
    await new Promise((r) => setTimeout(r, 0))
    const state = useMcpStore.getState()
    expect(state.syncing).toBe(false)
    expect(state.servers[0].tools).toHaveLength(1)
    expect(state.servers[0].status).toBe('ready')
  })

  it('syncTools supports older { data: { mcpServers } } response shape as a fallback', async () => {
    mockApi.listMcpServersRpc.mockResolvedValue({
      ok: true,
      data: { mcpServers: [{ name: 'legacy', tools: { t: {} }, authStatus: 'unsupported' }] },
    })
    useMcpStore.setState({
      servers: [{ name: 'legacy', type: 'stdio', command: 'node', enabled: true, status: 'starting', error: null, tools: [], isBuiltin: false, isAppBundled: false }],
    })

    await useMcpStore.getState().syncTools()

    expect(useMcpStore.getState().servers[0].status).toBe('ready')
  })

  it('syncTools unwraps IPC response shape { ok, data: { data: [...] } } from AgentManager', async () => {
    mockApi.listMcpServersRpc.mockResolvedValue({
      ok: true,
      data: {
        data: [{ name: 'wrapped', tools: { t: {} }, authStatus: 'unsupported' }],
        nextCursor: null,
      },
    })
    useMcpStore.setState({
      servers: [
        {
          name: 'wrapped',
          type: 'stdio',
          command: 'node',
          enabled: true,
          status: 'starting',
          error: null,
          tools: [],
          isBuiltin: false,
          isAppBundled: false,
        },
      ],
    })

    await useMcpStore.getState().syncTools()

    expect(useMcpStore.getState().servers[0]).toMatchObject({
      status: 'ready',
      tools: [{ name: 't', disabled: false }],
    })
  })

  it('syncTools marks notLoggedIn servers as failed so they do not stay yellow', async () => {
    mockApi.listMcpServersRpc.mockResolvedValue({
      ok: true,
      data: [{ name: 'hf', tools: {}, authStatus: 'notLoggedIn' }],
    })
    useMcpStore.setState({
      servers: [{ name: 'hf', type: 'http', url: 'https://huggingface.co/mcp', enabled: true, status: 'starting', error: null, tools: [], isBuiltin: false, isAppBundled: false }],
    })

    await useMcpStore.getState().syncTools()

    expect(useMcpStore.getState().servers[0]).toMatchObject({
      status: 'failed',
      error: '需要登录',
      authStatus: 'notLoggedIn',
    })
  })

  it('syncTools accepts Codex tool arrays with descriptions', async () => {
    mockApi.listMcpServersRpc.mockResolvedValue({
      ok: true,
      data: {
        data: [
          {
            name: 'array-tools',
            tools: [{ name: 'search', description: 'Search things' }],
            authStatus: 'unsupported',
          },
        ],
      },
    })
    useMcpStore.setState({
      servers: [
        {
          name: 'array-tools',
          type: 'stdio',
          command: 'node',
          enabled: true,
          status: 'starting',
          error: null,
          tools: [],
          isBuiltin: false,
          isAppBundled: false,
        },
      ],
    })

    await useMcpStore.getState().syncTools()

    expect(useMcpStore.getState().servers[0].tools).toEqual([
      { name: 'search', description: 'Search things', disabled: false },
    ])
  })

  it('startOAuthLogin opens camelCase authorizationUrl values', async () => {
    mockApi.mcpOAuthLogin.mockResolvedValue({ ok: true, authorizationUrl: 'https://auth.example.com/login' })
    useMcpStore.setState({
      servers: [
        { name: 'hf', type: 'http', url: 'https://huggingface.co/mcp', enabled: true, status: 'failed', error: '需要登录', tools: [], authStatus: 'notLoggedIn', isBuiltin: false, isAppBundled: false },
      ],
    })

    await useMcpStore.getState().startOAuthLogin('hf')

    expect((window as any).electronAPI.shell.openExternal).toHaveBeenCalledWith('https://auth.example.com/login')
    expect(useMcpStore.getState().servers[0].error).toBeNull()
  })

  it('startOAuthLogin surfaces browser open failures with the manual URL', async () => {
    mockApi.mcpOAuthLogin.mockResolvedValue({ ok: true, authorization_url: 'https://auth.example.com/login' })
    ;(window as any).electronAPI.shell.openExternal.mockResolvedValue({ success: false, error: 'unsafe_scheme' })
    useMcpStore.setState({
      servers: [
        { name: 'hf', type: 'http', url: 'https://huggingface.co/mcp', enabled: true, status: 'failed', error: '需要登录', tools: [], authStatus: 'notLoggedIn', isBuiltin: false, isAppBundled: false },
      ],
    })

    await useMcpStore.getState().startOAuthLogin('hf')

    expect(useMcpStore.getState().servers[0].error).toContain('https://auth.example.com/login')
  })

  // -------------------------------------------------------------------------
  // Codex rejecting the on-disk config (e.g. invalid `transport`) USED TO
  // wall the user off the entire MCP page — `fetchServers` set `error` and
  // `McpServerList` short-circuited to a full-page error with only a
  // "Retry" button, leaving NO path back to the JSON editor that exists
  // precisely to fix this scenario. The store now falls back to the
  // codex-bypass `readRawConfig` RPC: cards still render, but a
  // `codexConfigError` banner tells the user codex refused to load them.
  // -------------------------------------------------------------------------
  it('fetchServers falls back to readRawConfig when codex rejects the config and surfaces the error as a non-fatal banner', async () => {
    mockApi.listMcpServersRpc.mockImplementation(() => new Promise(() => {}))
    mockApi.readConfig.mockResolvedValue({
      ok: false,
      error: 'invalid configuration: invalid transport in `mcp_servers.apiyi`',
    })
    mockApi.readRawConfig.mockResolvedValue({
      ok: true,
      config: {
        mcp_servers: {
          apiyi: { command: '/electron', args: ['index.js'], enabled: true, transport: 'bogus' },
          good: { command: 'npx', args: ['-y', 'x'], enabled: false },
        },
      },
      raw: '[mcp_servers.apiyi]\ntransport = "bogus"\n',
    })

    await useMcpStore.getState().fetchServers()

    const state = useMcpStore.getState()
    expect(state.error).toBeNull()
    expect(state.codexConfigError).toContain('invalid transport')
    expect(state.servers.map((s) => s.name).sort()).toEqual(['apiyi', 'good'])
    expect(state.loading).toBe(false)
    expect(state.hasFetchedOnce).toBe(true)
  })

  it('fetchServers escalates to fatal error when codex AND readRawConfig both fail', async () => {
    mockApi.listMcpServersRpc.mockImplementation(() => new Promise(() => {}))
    mockApi.readConfig.mockResolvedValue({
      ok: false,
      error: 'invalid configuration: invalid transport in `mcp_servers.apiyi`',
    })
    mockApi.readRawConfig.mockResolvedValue({ ok: false, error: 'EACCES: permission denied' })

    await useMcpStore.getState().fetchServers()

    const state = useMcpStore.getState()
    expect(state.error).toContain('invalid transport')
    expect(state.servers).toEqual([])
    expect(state.codexConfigError).toBeNull()
  })

  it('fetchServers does not invoke readRawConfig on the happy path', async () => {
    mockApi.listMcpServersRpc.mockImplementation(() => new Promise(() => {}))
    mockApi.readConfig.mockResolvedValue({
      ok: true,
      config: { mcp_servers: { a: { command: 'x' } } },
    })
    mockApi.readRawConfig.mockResolvedValue({ ok: true, config: { mcp_servers: {} } })

    await useMcpStore.getState().fetchServers()

    expect(mockApi.readRawConfig).not.toHaveBeenCalled()
    expect(useMcpStore.getState().codexConfigError).toBeNull()
  })

  it('configured-enabled servers default to "starting" until a status notification arrives', async () => {
    mockApi.listMcpServersRpc.mockImplementation(() => new Promise(() => {}))
    mockApi.readConfig.mockResolvedValue({
      ok: true,
      config: { mcp_servers: { active: { command: 'x' }, off: { command: 'y', enabled: false } } },
    })

    await useMcpStore.getState().fetchServers()
    const byName = Object.fromEntries(useMcpStore.getState().servers.map((s) => [s.name, s]))
    expect(byName.active.status).toBe('starting')
    expect(byName.off.status).toBe('cancelled')
  })

  it('liveStatusByName overrides default status when set (e.g. from notifications)', async () => {
    useMcpStore.setState({
      liveStatusByName: { gh: { status: 'ready', error: null }, broken: { status: 'failed', error: 'boom' } },
    })
    mockApi.listMcpServersRpc.mockImplementation(() => new Promise(() => {}))
    mockApi.readConfig.mockResolvedValue({
      ok: true,
      config: { mcp_servers: { gh: { command: 'x' }, broken: { command: 'y' } } },
    })

    await useMcpStore.getState().fetchServers()
    const byName = Object.fromEntries(useMcpStore.getState().servers.map((s) => [s.name, s]))
    expect(byName.gh.status).toBe('ready')
    expect(byName.broken.status).toBe('failed')
    expect(byName.broken.error).toBe('boom')
  })

  // Previously this test asserted that codex's `readConfig` failure
  // surfaced as a FATAL `error`. After the readRawConfig fallback landed,
  // codex schema rejections become a non-fatal `codexConfigError` banner
  // and only escalate to `error` if the raw read ALSO fails. Behaviour
  // is split across two test cases now; this one keeps the original
  // "MCP API unavailable" branch (no `readConfig` available at all) as
  // a genuine fatal.
  it('readConfig failure becomes a fatal error only when the readRawConfig RPC is unavailable', async () => {
    // Drop readRawConfig from the API surface for this test only.
    const originalRaw = mockApi.readRawConfig
    ;(mockApi as any).readRawConfig = undefined
    try {
      mockApi.readConfig.mockResolvedValue({ ok: false, error: 'config dead' })
      mockApi.listMcpServersRpc.mockImplementation(() => new Promise(() => {}))

      await useMcpStore.getState().fetchServers()
      const state = useMcpStore.getState()
      expect(state.error).toBe('config dead')
      expect(state.codexConfigError).toBeNull()
      expect(state.loading).toBe(false)
    } finally {
      ;(mockApi as any).readRawConfig = originalRaw
    }
  })

  it('updateStatus updates a server status in-place', () => {
    useMcpStore.setState({
      servers: [{ name: 'github', type: 'stdio', command: 'docker', enabled: true, status: 'starting', error: null, tools: [], isBuiltin: false, isAppBundled: false }],
    })
    useMcpStore.getState().updateStatus('github', 'ready', null)
    expect(useMcpStore.getState().servers[0].status).toBe('ready')
  })

  it('updateStatus sets error on failed', () => {
    useMcpStore.setState({
      servers: [{ name: 'broken', type: 'stdio', command: 'nope', enabled: true, status: 'starting', error: null, tools: [], isBuiltin: false, isAppBundled: false }],
    })
    useMcpStore.getState().updateStatus('broken', 'failed', 'spawn ENOENT')
    const s = useMcpStore.getState().servers[0]
    expect(s.status).toBe('failed')
    expect(s.error).toBe('spawn ENOENT')
  })

  it('toggleEnabled calls writeConfigValue and updates state', async () => {
    useMcpStore.setState({
      servers: [{ name: 'github', type: 'stdio', command: 'docker', enabled: true, status: 'ready', error: null, tools: [], isBuiltin: false, isAppBundled: false }],
    })
    mockApi.writeConfigValue.mockResolvedValue({ ok: true })
    await useMcpStore.getState().toggleEnabled('github', false)
    expect(mockApi.writeConfigValue).toHaveBeenCalledWith('mcp_servers.github.enabled', false)
  })

  it('deleteServer calls batchWriteConfig to remove key', async () => {
    useMcpStore.setState({
      servers: [{ name: 'github', type: 'stdio', command: 'docker', enabled: true, status: 'ready', error: null, tools: [], isBuiltin: false, isAppBundled: false }],
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
