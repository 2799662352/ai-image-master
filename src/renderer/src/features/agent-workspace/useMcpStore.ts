import { create } from 'zustand'

export interface McpTool {
  name: string
  description?: string
  disabled?: boolean
}

/**
 * MCP server names that ship with the desktop app and live under
 * `resources/<name>/` (vendored at build time by scripts/vendor-*.mjs).
 * These are seeded into the user's codex `config.toml` on first boot and
 * are functionally always present — the user can disable but not uninstall.
 *
 * Kept as a Set so add cost is O(1) when more bundled MCPs land in future
 * releases (currently only apiyi-mcp-server for video / audio / PDF
 * understanding).
 */
export const APP_BUNDLED_MCP_NAMES: ReadonlySet<string> = new Set(['apiyi'])

export interface McpServerCard {
  name: string
  type: 'stdio' | 'http'
  command?: string
  url?: string
  args?: string[]
  enabled: boolean
  status: 'starting' | 'ready' | 'failed' | 'cancelled' | 'unknown'
  error: string | null
  tools: McpTool[]
  authStatus?: string
  /**
   * `true` when codex reports the server live but our config has no entry
   * for it — i.e. codex's internal built-ins (e.g. docker-mcp-gateway).
   * Edit/delete UI is hidden for these.
   */
  isBuiltin: boolean
  /**
   * `true` when the server's name is in `APP_BUNDLED_MCP_NAMES` — i.e. the
   * desktop app vendored it into `resources/` and seeded it into the user's
   * codex config. Edit/delete is still available (the user can opt out by
   * disabling or removing), but the UI groups them into a separate
   * "🎁 预装" section so they're discoverable on the MCP page even when
   * mixed with 20+ user-added entries.
   */
  isAppBundled: boolean
}

interface LiveStatus {
  status: string
  error: string | null
}

interface McpStore {
  servers: McpServerCard[]
  loading: boolean
  /**
   * Fatal error: we genuinely could not read ANY form of the config (codex
   * RPC failed AND the raw TOML read also failed). When non-null the list
   * UI shows the full-page error fallback. NOT used for codex schema
   * rejections — those go into `codexConfigError` so the user keeps access
   * to the JSON editor and can fix the broken section.
   */
  error: string | null
  /**
   * Codex's Rust parser refused the on-disk config (e.g. invalid
   * `transport` in some mcp_servers block). We still rendered cards from
   * the raw TOML fallback, but tools, auth, and live status will be empty
   * until the user fixes the config and reloads codex. Surfaced as a
   * banner above the list (NOT as an error wall) so the user can reach
   * the JSON editor to fix the offending entry.
   */
  codexConfigError: string | null
  loggingIn: string | null
  hasFetchedOnce: boolean
  syncing: boolean
  syncError: string | null
  /**
   * Latest status emitted by codex per server, keyed by server name.
   * Persists across page mounts so dots stay correct when the user
   * navigates away and back (and so we don't lose the very early
   * `mcp_status_updated` notifications fired during agent startup).
   */
  liveStatusByName: Record<string, LiveStatus>
  fetchServers: () => Promise<void>
  /** Fire-and-forget background fetch of tools + auth from listMcpServersRpc. */
  syncTools: () => Promise<void>
  updateStatus: (name: string, status: string, error: string | null) => void
  toggleEnabled: (name: string, enabled: boolean) => Promise<void>
  deleteServer: (name: string) => Promise<void>
  disableTool: (serverName: string, toolName: string) => Promise<void>
  enableTool: (serverName: string, toolName: string) => Promise<void>
  startOAuthLogin: (name: string) => Promise<void>
  lastAutoFix: { count: number; port: number; ts: number } | null
  setLastAutoFix: (v: McpStore['lastAutoFix']) => void
  dismissLastAutoFix: () => void
  lastConvertedFingerprint: string | null
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function buildServersFromConfig(
  configMap: Record<string, any>,
  liveServers: any[] = [],
  liveStatusByName: Record<string, LiveStatus> = {},
): McpServerCard[] {
  const live = new Map<string, any>(liveServers.map((s: any) => [s.name, s]))
  const names = new Set<string>([...Object.keys(configMap), ...liveServers.map((s: any) => s.name)])
  return Array.from(names).map((name) => {
    const configEntry = configMap[name]
    const liveEntry = live.get(name)
    const isBuiltin = !configEntry
    const enabled = configEntry?.enabled !== false
    const tools = normalizeTools(liveEntry?.tools)
    let type: 'stdio' | 'http' = 'stdio'
    let command: string | undefined
    let url: string | undefined
    let args: string[] | undefined
    if (configEntry) {
      if (configEntry.url) {
        type = 'http'
        url = configEntry.url
      } else {
        command = configEntry.command
        args = configEntry.args
      }
    }

    // Status precedence:
    //  1. Cached `mcp_status_updated` notification from codex (most accurate)
    //  2. Live RPC data: server appearing in liveServers means codex finished
    //     handshake → derive 'ready'
    //  3. Defaults: 'starting' for enabled (codex is still bringing it up),
    //     'cancelled' for disabled
    const cached = liveStatusByName[name]
    let status: McpServerCard['status']
    let error: string | null = null
    const authStatus = liveEntry?.auth_status ?? liveEntry?.authStatus
    if (cached) {
      status = cached.status as McpServerCard['status']
      error = cached.error
    } else if (authStatus === 'notLoggedIn') {
      status = 'failed'
      error = '需要登录'
    } else if (liveEntry) {
      status = 'ready'
    } else if (!enabled) {
      status = 'cancelled'
    } else {
      status = 'starting'
    }

    return {
      name,
      type,
      command,
      url,
      args,
      enabled,
      status,
      error,
      tools,
      authStatus,
      isBuiltin,
      isAppBundled: APP_BUNDLED_MCP_NAMES.has(name),
    }
  })
}

function getLiveServersFromListResponse(res: any): any[] {
  const payload = res?.data
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.mcpServers)) return payload.mcpServers
  return []
}

function normalizeTools(raw: any): McpTool[] {
  if (!raw) return []
  if (Array.isArray(raw)) {
    return raw
      .map((tool) => ({
        name: String(tool?.name ?? tool?.id ?? ''),
        description: typeof tool?.description === 'string' ? tool.description : undefined,
        disabled: false,
      }))
      .filter((tool) => tool.name.length > 0)
  }
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([name, meta]: [string, any]) => ({
      name,
      description: typeof meta?.description === 'string' ? meta.description : undefined,
      disabled: false,
    }))
  }
  return []
}

function getAuthorizationUrl(res: any): string | null {
  const url = res?.authorization_url ?? res?.authorizationUrl
  return typeof url === 'string' && url.length > 0 ? url : null
}

function setServerError(set: (partial: any) => void, name: string, error: string): void {
  set((state: McpStore) => ({
    servers: state.servers.map((s) => (s.name === name ? { ...s, error } : s)),
  }))
}

function getApi() {
  return (window as any).electronAPI?.agent
}

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: [],
  loading: false,
  error: null,
  codexConfigError: null,
  loggingIn: null,
  hasFetchedOnce: false,
  syncing: false,
  syncError: null,
  liveStatusByName: {},
  lastAutoFix: null,
  lastConvertedFingerprint: null,

  setLastAutoFix(v) {
    set({ lastAutoFix: v })
    if (v) {
      setTimeout(() => {
        if (useMcpStore.getState().lastAutoFix?.ts === v.ts) {
          set({ lastAutoFix: null })
        }
      }, 8_000)
    }
  },

  dismissLastAutoFix() {
    set({ lastAutoFix: null })
  },

  async startOAuthLogin(name) {
    const api = getApi()
    if (!api?.mcpOAuthLogin) return
    set({ loggingIn: name })
    set((state) => ({
      servers: state.servers.map((s) => (s.name === name ? { ...s, error: null } : s)),
    }))
    try {
      const res = await withTimeout(api.mcpOAuthLogin(name), 20_000, 'mcpOAuthLogin')
      if ((res as any)?.ok === false) {
        setServerError(set, name, (res as any).error ?? '启动登录失败')
        return
      }
      const authorizationUrl = getAuthorizationUrl(res)
      if (!authorizationUrl) {
        setServerError(set, name, 'Codex 未返回登录链接')
        return
      }

      if (authorizationUrl) {
        const shell = (window as any).electronAPI?.shell
        if (shell?.openExternal) {
          const openResult = await shell.openExternal(authorizationUrl)
          if (openResult?.success === false) {
            setServerError(set, name, `无法打开浏览器，请手动访问：${authorizationUrl}`)
          }
        } else {
          setServerError(set, name, `无法打开浏览器，请手动访问：${authorizationUrl}`)
        }
      }
    } catch (err) {
      setServerError(set, name, err instanceof Error ? err.message : String(err))
    } finally {
      set({ loggingIn: null })
    }
  },

  async fetchServers() {
    const isFirstFetch = !get().hasFetchedOnce
    if (isFirstFetch) {
      set({ loading: true, error: null, codexConfigError: null, syncError: null })
    }

    const api = getApi()
    if (!api?.readConfig) {
      set({ loading: false, error: 'MCP API 不可用', codexConfigError: null, hasFetchedOnce: true })
      return
    }

    // First paint: config-only. We deliberately do NOT block on
    // `listMcpServersRpc` here. With many MCP servers, Codex's tool
    // discovery can stall on slow/dead servers (openai/codex#19556,
    // #21318). Status comes from `mcp_status_updated` notifications;
    // tools come from a background `syncTools()` call below.
    let configMap: Record<string, any> = {}
    let codexConfigError: string | null = null
    let fatalError: string | null = null

    try {
      const configRes = await withTimeout(api.readConfig(), 10_000, 'readConfig')
      if ((configRes as any)?.ok === false) {
        // Codex rejected the on-disk TOML. Most common cause is a stale
        // `[mcp_servers.X]` block with a transport value that codex no
        // longer recognises (or an env var with a `null` value the Rust
        // schema can't deserialize). Falling through to the raw TOML
        // reader below lets the user still see and EDIT the offending
        // section instead of getting stuck on an error wall.
        codexConfigError = (configRes as any).error ?? 'readConfig failed'
      } else {
        configMap = (configRes as any)?.config?.mcp_servers ?? {}
      }
    } catch (err) {
      codexConfigError = err instanceof Error ? err.message : String(err)
    }

    // Fallback: bypass codex's strict parser and read ~/.codex/config.toml
    // directly. We only do this when codex rejected the config — the happy
    // path stays untouched.
    if (codexConfigError && api?.readRawConfig) {
      try {
        const rawRes = await withTimeout(api.readRawConfig(), 10_000, 'readRawConfig')
        if ((rawRes as any)?.ok !== false) {
          const rawMcp = (rawRes as any)?.config?.mcp_servers
          if (rawMcp && typeof rawMcp === 'object') {
            configMap = rawMcp as Record<string, any>
          }
          // If the raw read also failed to parse TOML, surface that
          // parseError too — but don't treat it as fatal; an empty
          // config map is still useful (user sees the empty list +
          // banner and can click "+ 新增" to start fresh).
          if ((rawRes as any)?.parseError && !codexConfigError.includes('TOML')) {
            codexConfigError = `${codexConfigError}\n(原始 TOML 也解析失败: ${(rawRes as any).parseError})`
          }
        } else {
          // Raw read itself errored — this means even fs.readFile threw.
          // That's a genuine fatal: we can't recover, escalate.
          fatalError = codexConfigError
        }
      } catch (err) {
        fatalError = `${codexConfigError}\n(回退读取失败: ${err instanceof Error ? err.message : String(err)})`
      }
    } else if (codexConfigError) {
      // No fallback available — treat as fatal.
      fatalError = codexConfigError
    }

    if (fatalError) {
      set({ loading: false, error: fatalError, codexConfigError: null, hasFetchedOnce: true })
      return
    }

    const servers = buildServersFromConfig(configMap, [], get().liveStatusByName)
    set({
      servers,
      loading: false,
      error: null,
      codexConfigError,
      hasFetchedOnce: true,
    })

    // Fire-and-forget tool sync. Updates servers when it eventually returns.
    // NOTE: When codexConfigError is set, this will also fail (codex has
    // refused to load the servers), but we still call it so the user gets
    // a consistent retry path via the "刷新" button.
    void get().syncTools()
  },

  async syncTools() {
    const api = getApi()
    if (!api?.listMcpServersRpc) return
    set({ syncing: true, syncError: null })
    try {
      // 60s budget — Codex's own tools/list timeout is 30s per server. With
      // many servers we want to give the entire batch room, but still bail
      // eventually so `syncing` doesn't stay true forever.
      const res = await withTimeout(
        api.listMcpServersRpc({ detail: 'toolsAndAuthOnly' }),
        60_000,
        'listMcpServersRpc',
      )
      if ((res as any)?.ok === false) {
        set({ syncing: false, syncError: (res as any).error ?? '工具列表同步失败' })
        return
      }
      const liveServers = getLiveServersFromListResponse(res)
      const liveByName = new Map(liveServers.map((s: any) => [s.name, s]))
      set((state) => ({
        syncing: false,
        syncError: null,
        servers: state.servers.map((s) => {
          const live = liveByName.get(s.name)
          if (!live) return s
          const tools = normalizeTools(live.tools)
          // If server appears in live results but we never got a status
          // notification, infer 'ready' (codex only includes connected
          // servers in this list when detail=toolsAndAuthOnly).
          const cached = state.liveStatusByName[s.name]
          const status = cached ? s.status : ('ready' as const)
          return {
            ...s,
            tools,
            authStatus: live.auth_status ?? live.authStatus ?? s.authStatus,
            status: (live.auth_status ?? live.authStatus) === 'notLoggedIn' ? 'failed' : status,
            error: (live.auth_status ?? live.authStatus) === 'notLoggedIn' ? '需要登录' : s.error,
          }
        }),
      }))
    } catch (err) {
      // Suppress timeouts — status still arrives via notifications. Surface
      // unexpected errors so users can debug.
      const msg = err instanceof Error ? err.message : String(err)
      set({ syncing: false, syncError: /timeout/i.test(msg) ? null : msg })
    }
  },

  updateStatus(name, status, error) {
    set((state) => ({
      liveStatusByName: { ...state.liveStatusByName, [name]: { status, error } },
      servers: state.servers.map((s) =>
        s.name === name ? { ...s, status: status as McpServerCard['status'], error } : s,
      ),
    }))
  },

  async toggleEnabled(name, enabled) {
    const api = getApi()
    if (!api?.writeConfigValue) return
    await api.writeConfigValue(`mcp_servers.${name}.enabled`, enabled)
    set((state) => ({
      servers: state.servers.map((s) => (s.name === name ? { ...s, enabled } : s)),
    }))
  },

  async deleteServer(name) {
    const api = getApi()
    if (!api?.batchWriteConfig) return
    await api.batchWriteConfig([{ keyPath: `mcp_servers.${name}`, value: null, mergeStrategy: 'replace' }], true)
    await get().fetchServers()
  },

  async disableTool(serverName, toolName) {
    const api = getApi()
    if (!api?.readConfig || !api?.writeConfigValue) return
    const configRes = await api.readConfig()
    const current: string[] = configRes?.config?.mcp_servers?.[serverName]?.disabled_tools ?? []
    if (!current.includes(toolName)) {
      await api.writeConfigValue(`mcp_servers.${serverName}.disabled_tools`, [...current, toolName])
    }
    set((state) => ({
      servers: state.servers.map((s) =>
        s.name === serverName
          ? { ...s, tools: s.tools.map((t) => (t.name === toolName ? { ...t, disabled: true } : t)) }
          : s,
      ),
    }))
  },

  async enableTool(serverName, toolName) {
    const api = getApi()
    if (!api?.readConfig || !api?.writeConfigValue) return
    const configRes = await api.readConfig()
    const current: string[] = configRes?.config?.mcp_servers?.[serverName]?.disabled_tools ?? []
    await api.writeConfigValue(`mcp_servers.${serverName}.disabled_tools`, current.filter((t) => t !== toolName))
    set((state) => ({
      servers: state.servers.map((s) =>
        s.name === serverName
          ? { ...s, tools: s.tools.map((t) => (t.name === toolName ? { ...t, disabled: false } : t)) }
          : s,
      ),
    }))
  },
}))

// ─── Global IPC subscription ──────────────────────────────────────────────
//
// Notifications (`mcpServer/startupStatus/updated`) are emitted by codex
// during agent startup, often BEFORE the user navigates to the MCP page. If
// we wait until <McpServerList> mounts to register the listener, every dot
// stays grey forever. Two-pronged fix:
//   1. Register the listener at module load (this file is imported by
//      <McpServerList>, which is imported lazily — so this still runs only
//      after the agent workspace tab is opened, but well before the MCP page
//      is mounted).
//   2. Pull a snapshot of latest-per-server statuses from main on registration
//      so we recover statuses emitted before this listener registered.
let mcpListenerInstalled = false
export function installMcpStatusListener(): void {
  if (mcpListenerInstalled) return
  if (typeof window === 'undefined') return
  const api = (window as any).electronAPI?.agent
  if (!api?.onMcpStatus) return
  mcpListenerInstalled = true

  api.onMcpStatus((event: any) => {
    if (event?.type === 'mcp_status_updated' && typeof event.name === 'string') {
      useMcpStore.getState().updateStatus(event.name, event.status, event.error ?? null)
    }
  })

  if (api.getMcpStatusSnapshot) {
    api
      .getMcpStatusSnapshot()
      .then((res: any) => {
        const snapshot = (res?.snapshot ?? res) as Record<string, LiveStatus> | undefined
        if (!snapshot) return
        useMcpStore.setState((state) => {
          const merged = { ...state.liveStatusByName, ...snapshot }
          return {
            liveStatusByName: merged,
            servers: state.servers.map((s) => {
              const live = merged[s.name]
              return live ? { ...s, status: live.status as McpServerCard['status'], error: live.error } : s
            }),
          }
        })
      })
      .catch(() => undefined)
  }
}

installMcpStatusListener()
