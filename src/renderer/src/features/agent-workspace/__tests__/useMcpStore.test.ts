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

  it('fetchServers fires syncTools in background with detail:"full"', async () => {
    let resolveList: (v: any) => void = () => undefined
    mockApi.listMcpServersRpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve
        }),
    )
    mockApi.readConfig.mockResolvedValue({ ok: true, config: { mcp_servers: { gh: { command: 'docker' } } } })

    await useMcpStore.getState().fetchServers()
    // 0.137: request `full` so resources + resourceTemplates + serverInfo
    // come back (toolsAndAuthOnly omits the MCP resource inventory).
    expect(mockApi.listMcpServersRpc).toHaveBeenCalledWith({ detail: 'full' })
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

  it('syncTools captures resources, resourceTemplates, serverInfo and a typed authStatus (full detail)', async () => {
    mockApi.listMcpServersRpc.mockResolvedValue({
      ok: true,
      data: {
        data: [
          {
            name: 'figma',
            tools: { get_file: { description: 'read a file' } },
            resources: [
              { name: 'design', uri: 'figma://design/1', title: 'Design', mimeType: 'application/json' },
            ],
            resourceTemplates: [
              { name: 'node', uriTemplate: 'figma://node/{id}', description: 'A node by id' },
            ],
            serverInfo: { name: 'figma', title: 'Figma', version: '1.4.0', websiteUrl: 'https://figma.com' },
            authStatus: 'bearerToken',
          },
        ],
        nextCursor: null,
      },
    })
    useMcpStore.setState({
      servers: [
        { name: 'figma', type: 'http', url: 'https://mcp.figma.com/mcp', enabled: true, status: 'starting', error: null, tools: [], isBuiltin: false, isAppBundled: false },
      ],
    })

    await useMcpStore.getState().syncTools()

    const s = useMcpStore.getState().servers[0]
    expect(s.status).toBe('ready')
    expect(s.authStatus).toBe('bearerToken')
    expect(s.resources).toEqual([
      { name: 'design', uri: 'figma://design/1', title: 'Design', description: undefined, mimeType: 'application/json' },
    ])
    expect(s.resourceTemplates).toEqual([
      { name: 'node', uriTemplate: 'figma://node/{id}', title: undefined, description: 'A node by id', mimeType: undefined },
    ])
    expect(s.serverInfo).toMatchObject({ title: 'Figma', version: '1.4.0', websiteUrl: 'https://figma.com' })
  })

  it('syncTools normalizes snake_case resource_templates + server_info shapes', async () => {
    mockApi.listMcpServersRpc.mockResolvedValue({
      ok: true,
      data: [
        {
          name: 'legacy',
          tools: {},
          resources: [{ name: 'r', uri: 'x://r' }],
          resource_templates: [{ name: 't', uri_template: 'x://t/{id}' }],
          server_info: { name: 'legacy', version: '0.9.0' },
          authStatus: 'oAuth',
        },
      ],
    })
    useMcpStore.setState({
      servers: [
        { name: 'legacy', type: 'http', url: 'https://x', enabled: true, status: 'starting', error: null, tools: [], isBuiltin: false, isAppBundled: false },
      ],
    })

    await useMcpStore.getState().syncTools()

    const s = useMcpStore.getState().servers[0]
    expect(s.resourceTemplates).toEqual([
      { name: 't', uriTemplate: 'x://t/{id}', title: undefined, description: undefined, mimeType: undefined },
    ])
    expect(s.serverInfo).toMatchObject({ version: '0.9.0' })
    expect(s.authStatus).toBe('oAuth')
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
  // v4.3.18: when codex has already rejected the on-disk config and we've
  // surfaced a fatal red banner via `codexConfigError` (with a "修复 X"
  // deep-link), `listMcpServersRpc` necessarily fails for the same root
  // cause (one shared config-reload pipeline). Re-displaying the same error
  // as an amber `syncError` banner was double-banner noise pointing at the
  // same broken entry. `syncTools` now stays silent in that case.
  // -------------------------------------------------------------------------
  it('syncTools suppresses syncError when codexConfigError already covers the same invalid-transport root cause', async () => {
    useMcpStore.setState({
      codexConfigError: 'invalid configuration: invalid transport in `mcp_servers.apiyi`',
      servers: [
        { name: 'apiyi', type: 'stdio', command: 'node', enabled: true, status: 'failed', error: null, tools: [], isBuiltin: false, isAppBundled: false },
      ],
    })
    mockApi.listMcpServersRpc.mockResolvedValue({
      ok: false,
      error: 'failed to reload config: C:\\...config.toml:1:1: invalid transport',
    })

    await useMcpStore.getState().syncTools()

    const state = useMcpStore.getState()
    expect(state.syncError).toBeNull()
    expect(state.syncing).toBe(false)
  })

  it('syncTools still reports unrelated sync errors even when codexConfigError is set', async () => {
    // If codex's reload pipeline is broken AND there's an UNRELATED RPC
    // failure on top (network, IPC handler missing, etc.), the user needs
    // to see it — only invalid-transport / reload-config noise is muted.
    useMcpStore.setState({
      codexConfigError: 'invalid configuration: invalid transport in `mcp_servers.apiyi`',
    })
    mockApi.listMcpServersRpc.mockResolvedValue({
      ok: false,
      error: 'spawn ENOENT: codex binary missing',
    })

    await useMcpStore.getState().syncTools()

    expect(useMcpStore.getState().syncError).toContain('spawn ENOENT')
  })

  it('syncTools reports ok=false errors normally when codexConfigError is NOT set', async () => {
    // Sanity: A→fix shouldn't accidentally swallow errors on the happy
    // path. With no codexConfigError, every ok=false surfaces as before.
    mockApi.listMcpServersRpc.mockResolvedValue({
      ok: false,
      error: 'failed to reload config: 1:1: invalid transport',
    })

    await useMcpStore.getState().syncTools()

    expect(useMcpStore.getState().syncError).toContain('invalid transport')
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
