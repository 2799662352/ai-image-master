import { create } from 'zustand'
import { getApiService } from '../../services/api'

export interface McpTool {
  name: string
  description?: string
  disabled?: boolean
}

/**
 * MCP auth posture as reported by codex 0.137's `mcpServerStatus/list`.
 * `unsupported` = the server advertises no auth; `notLoggedIn` = OAuth/token
 * required but absent (we surface a "登录" button); `bearerToken` = a static
 * token (e.g. Figma's `bearer_token_env_var`) is in use; `oAuth` = an OAuth
 * session is active. We keep `(string & {})` so an unknown future variant
 * renders verbatim instead of throwing.
 */
export type McpAuthStatus = 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth' | (string & {})

/** A concrete resource an MCP server can read (codex `Resource`). */
export interface McpResource {
  name: string
  uri: string
  title?: string
  description?: string
  mimeType?: string
}

/** A parameterised resource template (codex `ResourceTemplate`). */
export interface McpResourceTemplate {
  name: string
  uriTemplate: string
  title?: string
  description?: string
  mimeType?: string
}

/** Presentation metadata advertised by an initialized server (`McpServerInfo`). */
export interface McpServerInfo {
  title?: string
  version?: string
  description?: string
  websiteUrl?: string
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
  authStatus?: McpAuthStatus
  /**
   * MCP resource inventory surfaced by codex 0.137 when we request
   * `detail: 'full'`. Empty for servers that expose no resources, or until
   * the background `syncTools()` resolves. `toolsAndAuthOnly` omits these.
   */
  resources?: McpResource[]
  resourceTemplates?: McpResourceTemplate[]
  /** Server-advertised metadata (title / version / website). */
  serverInfo?: McpServerInfo | null
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
  /**
   * Per-server in-flight flag for {@link McpStore.refreshServer}, keyed by
   * name. Independent from the global `syncing` so a single card can spin
   * (and its refresh button disable) without touching the others or the
   * global 刷新 button.
   */
  syncingByName: Record<string, boolean>
  fetchServers: () => Promise<void>
  /** Fire-and-forget background fetch of tools + auth from listMcpServersRpc. */
  syncTools: () => Promise<void>
  /**
   * Refresh a SINGLE server's tools/resources/auth without disturbing the
   * others. Codex exposes no per-name query (only the batch
   * `mcpServerStatus/list`), so under the hood this still issues the batch
   * RPC — but it applies ONLY this server's slice to its own card and leaves
   * every other card untouched. Timeouts degrade silently (status keeps
   * flowing via notifications); genuine errors land on this card's `error`.
   */
  refreshServer: (name: string) => Promise<void>
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
      resources: normalizeResources(liveEntry?.resources),
      resourceTemplates: normalizeResourceTemplates(
        liveEntry?.resourceTemplates ?? liveEntry?.resource_templates,
      ),
      serverInfo: normalizeServerInfo(liveEntry?.serverInfo ?? liveEntry?.server_info),
      isBuiltin,
      isAppBundled: APP_BUNDLED_MCP_NAMES.has(name),
    }
  })
}

function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function normalizeResources(raw: any): McpResource[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((r: any) => ({
      name: String(r?.name ?? r?.title ?? r?.uri ?? ''),
      uri: String(r?.uri ?? ''),
      title: pickString(r?.title),
      description: pickString(r?.description),
      mimeType: pickString(r?.mimeType, r?.mime_type),
    }))
    .filter((r) => r.name.length > 0 || r.uri.length > 0)
}

function normalizeResourceTemplates(raw: any): McpResourceTemplate[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((r: any) => ({
      name: String(r?.name ?? r?.title ?? ''),
      uriTemplate: String(r?.uriTemplate ?? r?.uri_template ?? ''),
      title: pickString(r?.title),
      description: pickString(r?.description),
      mimeType: pickString(r?.mimeType, r?.mime_type),
    }))
    .filter((r) => r.name.length > 0 || r.uriTemplate.length > 0)
}

function normalizeServerInfo(raw: any): McpServerInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const info: McpServerInfo = {
    title: pickString(raw.title),
    version: pickString(raw.version),
    description: pickString(raw.description),
    websiteUrl: pickString(raw.websiteUrl, raw.website_url),
  }
  if (!info.title && !info.version && !info.description && !info.websiteUrl) return null
  return info
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
  syncingByName: {},
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

    // Cold-start reliability hook for the bundled apiyi-mcp: once we've
    // confirmed codex is up enough to read its config (no codexConfigError),
    // mirror the app's already-configured apiyi key into mcp_servers.apiyi.env
    // so the user never has to re-paste it. Best-effort, first successful
    // fetch only; the construction microtask may have run before codex was
    // ready, so this is the guaranteed-codex-up retry.
    if (isFirstFetch && !codexConfigError) {
      try {
        void getApiService().syncApiyiKeyToMcp()
      } catch {
        /* best-effort; never block the MCP list on the apiyi key bridge */
      }
    }

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
      // 95s outer ceiling — sits just ABOVE the main-side list RPC budget
      // (CodexProtocolClient.MCP_LIST_TIMEOUT_MS = 90s) so the inner call wins
      // the race on the happy path (returning real data) and this is only a
      // backstop so `syncing` never sticks true forever. The 90s inner budget
      // is what lets a slow server (apiyi's 60s startup) resolve in ONE pass
      // instead of being cut off at the old 30s default.
      // `full` (vs the lighter `toolsAndAuthOnly`) so codex also returns each
      // server's resource + resourceTemplate inventory and `serverInfo`
      // (title/version/website). This adds a `resources/list` round-trip per
      // server, but it's a fire-and-forget background sync, so a slow server
      // can't block first paint (which is config-only).
      const res = await withTimeout(
        api.listMcpServersRpc({ detail: 'full' }),
        95_000,
        'listMcpServersRpc',
      )
      if ((res as any)?.ok === false) {
        // When codex has already rejected the on-disk TOML, `fetchServers`
        // surfaces a fatal red banner via `codexConfigError` with a "修复"
        // deep-link. `listMcpServersRpc` necessarily fails for the same
        // root cause (codex shares one config-reload pipeline between
        // RPCs), so re-displaying the same error as an amber `syncError`
        // banner is just noise pointing back to the same broken entry.
        // Stay silent here; the fix path runs through the red banner.
        const rawErr = (res as any).error
        const sameRootCause =
          !!get().codexConfigError
          && typeof rawErr === 'string'
          && (/invalid transport/i.test(rawErr) || /reload config/i.test(rawErr))
        set({
          syncing: false,
          syncError: sameRootCause ? null : (rawErr ?? '工具列表同步失败'),
        })
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
          // servers in this list when detail=full).
          const cached = state.liveStatusByName[s.name]
          const status = cached ? s.status : ('ready' as const)
          const authStatus = live.auth_status ?? live.authStatus ?? s.authStatus
          return {
            ...s,
            tools,
            authStatus,
            resources: normalizeResources(live.resources),
            resourceTemplates: normalizeResourceTemplates(
              live.resourceTemplates ?? live.resource_templates,
            ),
            serverInfo: normalizeServerInfo(live.serverInfo ?? live.server_info) ?? s.serverInfo ?? null,
            status: authStatus === 'notLoggedIn' ? 'failed' : status,
            error: authStatus === 'notLoggedIn' ? '需要登录' : s.error,
          }
        }),
      }))
    } catch (err) {
      // Suppress timeouts — a slow/hung MCP server must NOT blank the whole
      // panel; status keeps arriving via `mcp_status_updated` notifications and
      // the config-only first paint already populated every server. Match BOTH
      // wordings: our `withTimeout` throws "… timeout after …" while codex's
      // own RPC layer throws "… timed out after 30000ms" — the old `/timeout/i`
      // missed the latter, which is exactly why a single slow server leaked a
      // fatal "工具列表刷新失败" banner. Genuinely unexpected errors still surface.
      const msg = err instanceof Error ? err.message : String(err)
      const isTimeout = /timed out|timeout/i.test(msg)
      set({ syncing: false, syncError: isTimeout ? null : msg })
    }
  },

  async refreshServer(name) {
    const api = getApi()
    if (!api?.listMcpServersRpc) return
    // Per-server spin — independent from the global `syncing`, so refreshing
    // ONE card never disables the others or the global 刷新 button.
    set((state) => ({ syncingByName: { ...state.syncingByName, [name]: true } }))
    const clearSpin = (extra?: Partial<McpServerCard>): void =>
      set((state) => {
        const { [name]: _drop, ...rest } = state.syncingByName
        return {
          syncingByName: rest,
          servers: extra
            ? state.servers.map((s) => (s.name === name ? { ...s, ...extra } : s))
            : state.servers,
        }
      })
    try {
      // Codex has no per-name query, so we still issue the batch list — but we
      // apply ONLY this server's slice below. 95s ceiling mirrors syncTools so
      // a slow server can resolve in one pass.
      const res = await withTimeout(
        api.listMcpServersRpc({ detail: 'full' }),
        95_000,
        'refreshServer',
      )
      if ((res as any)?.ok === false) {
        const rawErr = (res as any).error
        // Same config-reload root cause as syncTools: stay silent if the red
        // banner already owns it; otherwise surface on THIS card only.
        const sameRootCause =
          !!get().codexConfigError
          && typeof rawErr === 'string'
          && (/invalid transport/i.test(rawErr) || /reload config/i.test(rawErr))
        clearSpin(sameRootCause ? undefined : { error: rawErr ?? '刷新失败' })
        return
      }
      const live = getLiveServersFromListResponse(res).find((s: any) => s.name === name)
      if (!live) {
        // Server not in the live inventory (still starting / not connected).
        // Leave the card as-is; status will arrive via notifications.
        clearSpin()
        return
      }
      const authStatus = live.auth_status ?? live.authStatus
      clearSpin({
        tools: normalizeTools(live.tools),
        authStatus,
        resources: normalizeResources(live.resources),
        resourceTemplates: normalizeResourceTemplates(
          live.resourceTemplates ?? live.resource_templates,
        ),
        serverInfo: normalizeServerInfo(live.serverInfo ?? live.server_info) ?? undefined,
        status: authStatus === 'notLoggedIn' ? 'failed' : ('ready' as const),
        error: authStatus === 'notLoggedIn' ? '需要登录' : null,
      })
    } catch (err) {
      // Timeouts degrade silently (notifications keep status fresh); genuine
      // errors land on this card only — never a global banner.
      const msg = err instanceof Error ? err.message : String(err)
      const isTimeout = /timed out|timeout/i.test(msg)
      clearSpin(isTimeout ? undefined : { error: msg })
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
