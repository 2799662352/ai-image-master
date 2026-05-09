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

interface McpStore {
  servers: McpServerCard[]
  loading: boolean
  error: string | null
  loggingIn: string | null
  hasFetchedOnce: boolean
  syncing: boolean
  syncError: string | null
  fetchServers: () => Promise<void>
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
): McpServerCard[] {
  const live = new Map<string, any>(liveServers.map((s: any) => [s.name, s]))
  const names = new Set<string>([...Object.keys(configMap), ...liveServers.map((s: any) => s.name)])
  return Array.from(names).map((name) => {
    const configEntry = configMap[name]
    const liveEntry = live.get(name)
    const isBuiltin = !configEntry
    const tools: McpTool[] = Object.entries(liveEntry?.tools ?? {}).map(([n, meta]: [string, any]) => ({
      name: n,
      description: meta?.description,
      disabled: false,
    }))
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
    return {
      name,
      type,
      command,
      url,
      args,
      enabled: configEntry?.enabled !== false,
      status: 'unknown' as const,
      error: null,
      tools,
      authStatus: liveEntry?.auth_status,
      isBuiltin,
    }
  })
}

function getApi() {
  return (window as any).electronAPI?.agent
}

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: [],
  loading: false,
  error: null,
  loggingIn: null,
  hasFetchedOnce: false,
  syncing: false,
  syncError: null,
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
      const res = await api.mcpOAuthLogin(name)
      if (res?.authorization_url) {
        const shell = (window as any).electronAPI?.shell
        if (shell?.openExternal) {
          await shell.openExternal(res.authorization_url)
        } else {
          set((state) => ({
            servers: state.servers.map((s) =>
              s.name === name ? { ...s, error: `无法打开浏览器，请手动访问：${res.authorization_url}` } : s,
            ),
          }))
        }
      }
    } catch (err) {
      set((state) => ({
        servers: state.servers.map((s) =>
          s.name === name ? { ...s, error: err instanceof Error ? err.message : String(err) } : s,
        ),
      }))
    } finally {
      set({ loggingIn: null })
    }
  },

  async fetchServers() {
    const isFirstFetch = !get().hasFetchedOnce
    if (isFirstFetch) {
      set({ loading: true, error: null, syncError: null })
    } else {
      set({ syncing: true, syncError: null })
    }

    const api = getApi()
    if (!api?.listMcpServersRpc || !api?.readConfig) {
      set({ loading: false, syncing: false, error: 'MCP API 不可用', hasFetchedOnce: true })
      return
    }

    // Run both calls in parallel but tolerate either failing/hanging. If only
    // config succeeds we still render cards (without live tools / auth status).
    const TIMEOUT_MS = 8_000
    const [statusResult, configResult] = await Promise.allSettled([
      withTimeout(api.listMcpServersRpc({ detail: 'full' }), TIMEOUT_MS, 'listMcpServersRpc'),
      withTimeout(api.readConfig(), TIMEOUT_MS, 'readConfig'),
    ])

    let liveServers: any[] = []
    let configMap: Record<string, any> = {}
    let syncError: string | null = null

    if (statusResult.status === 'fulfilled' && statusResult.value?.ok) {
      liveServers = statusResult.value.data?.mcpServers ?? []
    } else {
      const reason =
        statusResult.status === 'rejected'
          ? statusResult.reason instanceof Error
            ? statusResult.reason.message
            : String(statusResult.reason)
          : statusResult.value?.error ?? '获取 MCP 状态失败'
      syncError = reason
    }

    if (configResult.status === 'fulfilled' && configResult.value?.ok !== false) {
      configMap = (configResult.value as any)?.config?.mcp_servers ?? {}
    } else if (configResult.status === 'rejected') {
      const reason = configResult.reason instanceof Error ? configResult.reason.message : String(configResult.reason)
      // If both failed, surface the harder error (config) as primary
      if (!syncError) syncError = reason
      else syncError = `${syncError}; readConfig: ${reason}`
    }

    const servers = buildServersFromConfig(configMap, liveServers)
    set({
      servers,
      loading: false,
      syncing: false,
      syncError,
      error: null,
      hasFetchedOnce: true,
    })
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
