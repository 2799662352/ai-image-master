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
  fetchServers: () => Promise<void>
  updateStatus: (name: string, status: string, error: string | null) => void
  toggleEnabled: (name: string, enabled: boolean) => Promise<void>
  deleteServer: (name: string) => Promise<void>
  disableTool: (serverName: string, toolName: string) => Promise<void>
  enableTool: (serverName: string, toolName: string) => Promise<void>
  lastAutoFix: { count: number; port: number; ts: number } | null
  setLastAutoFix: (v: McpStore['lastAutoFix']) => void
  dismissLastAutoFix: () => void
  lastConvertedFingerprint: string | null
}

function getApi() {
  return (window as any).electronAPI?.agent
}

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: [],
  loading: false,
  error: null,
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

  async fetchServers() {
    set({ loading: true, error: null })
    const api = getApi()
    if (!api?.listMcpServersRpc) {
      set({ loading: false, error: 'MCP API 不可用' })
      return
    }

    try {
      const [statusRes, configRes] = await Promise.all([
        api.listMcpServersRpc({ detail: 'full' }),
        api.readConfig(),
      ])

      if (!statusRes.ok) {
        set({ loading: false, error: statusRes.error ?? '获取 MCP 状态失败' })
        return
      }

      const mcpServers = statusRes.data?.mcpServers ?? []
      const configuredServers: Record<string, any> = configRes?.config?.mcp_servers ?? {}

      const servers: McpServerCard[] = mcpServers.map((s: any) => {
        const configEntry = configuredServers[s.name]
        const isBuiltin = !configEntry
        const tools: McpTool[] = Object.entries(s.tools ?? {}).map(([name, meta]: [string, any]) => ({
          name,
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
          name: s.name,
          type,
          command,
          url,
          args,
          enabled: configEntry?.enabled !== false,
          status: 'unknown' as const,
          error: null,
          tools,
          authStatus: s.auth_status,
          isBuiltin,
        }
      })

      set({ servers, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
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
