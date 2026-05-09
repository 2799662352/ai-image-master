import { create } from 'zustand'

export interface McpTool {
  name: string
  description?: string
  disabled?: boolean
}

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
  isBuiltin: boolean
}

interface OAuthCompletedPayload {
  name: string
  success: boolean
  error: string | null
}

interface McpStore {
  servers: McpServerCard[]
  loading: boolean
  syncing: boolean
  error: string | null
  syncError: string | null
  /** Server name currently in OAuth flow (browser opened, awaiting completion). */
  loggingIn: string | null

  fetchServers: () => Promise<void>
  syncLiveStatus: () => Promise<void>
  updateStatus: (name: string, status: string, error: string | null) => void
  toggleEnabled: (name: string, enabled: boolean) => Promise<void>
  deleteServer: (name: string) => Promise<void>
  disableTool: (serverName: string, toolName: string) => Promise<void>
  enableTool: (serverName: string, toolName: string) => Promise<void>
  startOAuthLogin: (name: string) => Promise<void>
  handleOAuthCompleted: (payload: OAuthCompletedPayload) => void
}

function getApi() {
  return (window as any).electronAPI?.agent
}

function getShell() {
  return (window as any).electronAPI?.shell
}

function buildServerFromConfig(name: string, entry: any): McpServerCard {
  let type: 'stdio' | 'http' = 'stdio'
  let command: string | undefined
  let url: string | undefined
  let args: string[] | undefined

  if (entry.url) {
    type = 'http'
    url = entry.url
  } else {
    command = entry.command
    args = entry.args
  }

  return {
    name,
    type,
    command,
    url,
    args,
    enabled: entry.enabled !== false,
    status: 'unknown',
    error: null,
    tools: [],
    isBuiltin: false,
  }
}

/**
 * Detect docker-based stdio servers. When these come back from
 * mcpServerStatus/list with empty tools we hit Codex's known
 * "tools not surfaced" bug (issue #19425, dupes #20771/#21406/#21654).
 * Show a more actionable error so users don't think it's our fault.
 */
function isDockerCommand(card: { command?: string; args?: string[] }): boolean {
  if (!card.command) return false
  const cmd = card.command.toLowerCase()
  return cmd === 'docker' || cmd.endsWith('/docker') || cmd.endsWith('\\docker.exe') || cmd.endsWith('/docker.exe')
}

function setServerError(name: string, error: string | null) {
  useMcpStore.setState((state) => ({
    servers: state.servers.map((s) => (s.name === name ? { ...s, error } : s)),
  }))
}

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: [],
  loading: false,
  syncing: false,
  error: null,
  syncError: null,
  loggingIn: null,

  async fetchServers() {
    set({ loading: true, error: null })
    const api = getApi()
    if (!api?.readConfig) {
      set({ loading: false, error: 'MCP API 不可用' })
      return
    }

    try {
      const configRes = await api.readConfig()
      if (configRes && configRes.ok === false) {
        throw new Error(configRes.error ?? '读取配置失败')
      }
      const configuredServers: Record<string, any> = configRes?.config?.mcp_servers ?? {}

      const servers: McpServerCard[] = Object.entries(configuredServers).map(
        ([name, entry]: [string, any]) => buildServerFromConfig(name, entry),
      )

      set({ servers, loading: false })

      void get().syncLiveStatus()
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  async syncLiveStatus() {
    const api = getApi()
    if (!api?.listMcpServersRpc) return

    set({ syncing: true, syncError: null })
    try {
      const statusRes = await api.listMcpServersRpc({ detail: 'full' })
      if (!statusRes?.ok) {
        set({
          syncing: false,
          syncError: statusRes?.error ?? '获取实时状态失败',
        })
        return
      }

      // Codex 0.128+ ListMcpServerStatusResponse shape:
      //   { data: McpServerStatus[], nextCursor: string | null }
      // Pinned by openai/codex/codex-rs/app-server-protocol/schema/typescript/v2/
      // ListMcpServerStatusResponse.ts. Older shape `{ mcpServers: [...] }` was
      // assumed during initial implementation but never existed in the wire
      // protocol — keeping the fallback for safety.
      const rpcResult = statusRes.data ?? {}
      const liveServers: any[] = rpcResult.data ?? rpcResult.mcpServers ?? []
      const liveByName = new Map<string, any>(liveServers.map((s) => [s.name, s]))

      set((state) => ({
        syncing: false,
        servers: state.servers.map((card) => {
          const live = liveByName.get(card.name)
          if (!live) {
            return { ...card, status: 'failed', error: card.error ?? '未在 Codex 中注册或启动失败' }
          }
          const toolEntries = Object.entries(live.tools ?? {})
          const tools: McpTool[] = toolEntries.map(([name, meta]: [string, any]) => ({
            name,
            description: meta?.description,
            disabled: (card.tools.find((t) => t.name === name)?.disabled) ?? false,
          }))
          // Codex schema uses camelCase; tolerate snake_case for older versions
          const authStatus = live.authStatus ?? live.auth_status

          let status: McpServerCard['status']
          let error: string | null
          if (toolEntries.length > 0) {
            status = 'ready'
            error = null
          } else if (authStatus === 'notLoggedIn') {
            status = 'starting'
            error = '需要登录'
          } else if (isDockerCommand(card)) {
            // Codex 0.128/0.130 known bug: docker-based stdio MCP servers
            // start successfully but their tools never reach the model.
            // See openai/codex#19425 (dupes #20771/#21654/#21789/#21881).
            // Workaround: try `docker mcp gateway run` instead of running
            // each container directly.
            status = 'failed'
            error = 'Codex bug #19425：docker MCP 已启动但工具未暴露。建议改用 docker mcp gateway。'
          } else {
            status = 'failed'
            error = '服务器未导出工具'
          }

          return {
            ...card,
            tools,
            authStatus,
            status,
            error,
          }
        }),
      }))
    } catch (err) {
      set({ syncing: false, syncError: err instanceof Error ? err.message : String(err) })
    }
  },

  updateStatus(name, status, error) {
    set((state) => ({
      servers: state.servers.map((s) =>
        s.name === name ? { ...s, status: status as McpServerCard['status'], error } : s,
      ),
    }))
  },

  async toggleEnabled(name, enabled) {
    const api = getApi()
    if (!api?.writeConfigValue) return

    // Optimistic update so the toggle feels instant.
    const prevEnabled = get().servers.find((s) => s.name === name)?.enabled
    set((state) => ({
      servers: state.servers.map((s) => (s.name === name ? { ...s, enabled } : s)),
      error: null,
    }))

    const writeRes = await api.writeConfigValue(`mcp_servers.${name}.enabled`, enabled)
    if (writeRes && writeRes.ok === false) {
      // Roll back optimistic state and surface error.
      set((state) => ({
        servers: state.servers.map((s) =>
          s.name === name && prevEnabled !== undefined ? { ...s, enabled: prevEnabled } : s,
        ),
        error: writeRes.error ?? '写入配置失败',
      }))
      return
    }

    // Make Codex actually pick up the change without a full UI refresh.
    if (api.reloadMcpServers) {
      await api.reloadMcpServers()
    }
    void get().syncLiveStatus()
  },

  async deleteServer(name) {
    const api = getApi()
    if (!api?.batchWriteConfig) return

    // Optimistic remove — UI updates instantly, no global re-fetch.
    const prev = get().servers
    set((state) => ({
      servers: state.servers.filter((s) => s.name !== name),
      error: null,
    }))

    const res = await api.batchWriteConfig(
      [{ keyPath: `mcp_servers.${name}`, value: null, mergeStrategy: 'replace' }],
      true,
    )

    if (res && res.ok === false) {
      // Roll back optimistic deletion.
      set({ servers: prev, error: res.error ?? '删除失败' })
      return
    }

    // Sync live status only — avoids the full fetchServers() round-trip
    // and keeps the rest of the cards stable.
    void get().syncLiveStatus()
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

  async startOAuthLogin(name) {
    const api = getApi()
    const shell = getShell()
    if (!api?.mcpOAuthLogin) {
      setServerError(name, 'OAuth API 不可用')
      return
    }

    set((state) => ({ servers: state.servers.map(s => s.name === name ? { ...s, error: null } : s) }))

    const res = await api.mcpOAuthLogin(name)
    if (!res?.ok || !res.authorization_url) {
      setServerError(name, `OAuth 启动失败：${res?.error ?? '未知错误'}`)
      return
    }

    set({ loggingIn: name })
    if (shell?.openExternal) {
      await shell.openExternal(res.authorization_url)
    } else {
      setServerError(name, '无法打开浏览器，请手动访问：' + res.authorization_url)
    }
  },

  handleOAuthCompleted({ name, success, error }) {
    if (success) {
      set((state) => ({
        loggingIn: state.loggingIn === name ? null : state.loggingIn,
        servers: state.servers.map((s) =>
          s.name === name ? { ...s, error: null, status: 'starting' } : s,
        ),
      }))
      void get().syncLiveStatus()
    } else {
      set((state) => ({
        loggingIn: state.loggingIn === name ? null : state.loggingIn,
        servers: state.servers.map((s) =>
          s.name === name ? { ...s, error: error ?? '登录失败' } : s,
        ),
      }))
    }
  },
}))
