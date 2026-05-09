# MCP Cursor-Style JSON UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the TOML-based MCP editor with a Cursor-style card list + Monaco JSON editor, powered entirely by Codex app-server JSON-RPC.

**Architecture:** Extend `CodexProtocolClient` with MCP RPC methods, expose them through the existing `ipc.ts` → `preload/index.ts` bridge, then rebuild the renderer `McpSection` as a card-based UI with real-time status, bulk import, and per-tool control.

**Tech Stack:** TypeScript, React, Zustand, Monaco Editor (`@monaco-editor/react`), Codex app-server JSON-RPC (WebSocket), Vitest

---

### Task 1: Install Monaco Editor dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add Monaco Editor packages**

```bash
cd D:\tecx\text\temp-ai-image-master-source\.worktrees\codex-agent-mvp
npm install @monaco-editor/react monaco-editor
```

- [ ] **Step 2: Verify installation**

Run: `node -e "require('@monaco-editor/react'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add @monaco-editor/react for MCP JSON editor"
```

---

### Task 2: Extend CodexProtocolClient with MCP RPC methods

**Files:**
- Modify: `src/main/agent/CodexProtocolClient.ts`
- Create: `src/main/agent/__tests__/CodexProtocolClient.mcp.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/agent/__tests__/CodexProtocolClient.mcp.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'

function createTestServer(port: number) {
  const wss = new WebSocketServer({ port })
  const messages: unknown[] = []
  let respondTo: ((msg: any) => any) | null = null

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      messages.push(msg)
      if (msg.method === 'initialize') {
        ws.send(JSON.stringify({ id: msg.id, result: {} }))
        return
      }
      if (respondTo) {
        const result = respondTo(msg)
        ws.send(JSON.stringify({ id: msg.id, result }))
      }
    })
  })

  return {
    wss,
    messages,
    setResponder(fn: (msg: any) => any) { respondTo = fn },
    close() { wss.close() },
  }
}

describe('CodexProtocolClient MCP methods', () => {
  const PORT = 17399
  let server: ReturnType<typeof createTestServer>
  let client: CodexProtocolClient

  beforeEach(async () => {
    server = createTestServer(PORT)
    client = new CodexProtocolClient({
      url: `ws://127.0.0.1:${PORT}`,
      clientInfo: { name: 'test', version: '0.0.1' },
      connectTimeoutMs: 3000,
      connectIntervalMs: 50,
    })
    await client.start()
  })

  afterEach(async () => {
    await client.stop()
    server.close()
  })

  it('listMcpServers sends mcpServerStatus/list with detail:full', async () => {
    server.setResponder((msg: any) => {
      if (msg.method === 'mcpServerStatus/list') {
        return { mcpServers: [{ name: 'test-server', tools: {}, resources: [], resource_templates: [], auth_status: 'unsupported' }] }
      }
      return {}
    })
    const result = await client.listMcpServers()
    expect(result.mcpServers).toHaveLength(1)
    expect(result.mcpServers[0].name).toBe('test-server')
    const sent = server.messages.find((m: any) => m.method === 'mcpServerStatus/list') as any
    expect(sent.params.detail).toBe('full')
  })

  it('batchWriteConfig sends config/batchWrite with edits', async () => {
    server.setResponder(() => ({}))
    await client.batchWriteConfig([{ keyPath: 'mcp_servers.foo', value: { command: 'bar' } }])
    const sent = server.messages.find((m: any) => m.method === 'config/batchWrite') as any
    expect(sent.params.edits).toHaveLength(1)
    expect(sent.params.edits[0].keyPath).toBe('mcp_servers.foo')
    expect(sent.params.reloadUserConfig).toBe(true)
  })

  it('writeConfigValue sends config/value/write', async () => {
    server.setResponder(() => ({}))
    await client.writeConfigValue('mcp_servers.foo.enabled', false)
    const sent = server.messages.find((m: any) => m.method === 'config/value/write') as any
    expect(sent.params.keyPath).toBe('mcp_servers.foo.enabled')
    expect(sent.params.value).toBe(false)
  })

  it('reloadMcpServers sends config/mcpServer/reload', async () => {
    server.setResponder(() => ({}))
    await client.reloadMcpServers()
    const sent = server.messages.find((m: any) => m.method === 'config/mcpServer/reload')
    expect(sent).toBeTruthy()
  })

  it('mcpOAuthLogin sends mcpServer/oauth/login and returns url', async () => {
    server.setResponder((msg: any) => {
      if (msg.method === 'mcpServer/oauth/login') {
        return { authorization_url: 'https://auth.example.com/login' }
      }
      return {}
    })
    const result = await client.mcpOAuthLogin('my-server')
    expect(result.authorization_url).toBe('https://auth.example.com/login')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/agent/__tests__/CodexProtocolClient.mcp.test.ts`
Expected: FAIL — `listMcpServers`, `batchWriteConfig`, `writeConfigValue`, `reloadMcpServers`, `mcpOAuthLogin` not defined

- [ ] **Step 3: Implement the MCP RPC methods**

Add to `src/main/agent/CodexProtocolClient.ts` after the `forkThread` method (line ~242):

```typescript
  // ─── MCP Management RPC ───────────────────────────────────────────────

  async listMcpServers(params?: { detail?: string; limit?: number; cursor?: string }): Promise<McpServerStatusListResponse> {
    return this.rpc<McpServerStatusListResponse>('mcpServerStatus/list', params ?? { detail: 'full' })
  }

  async batchWriteConfig(edits: Array<{ keyPath: string; value: unknown; mergeStrategy?: string }>, reloadUserConfig = true): Promise<void> {
    await this.rpc('config/batchWrite', { edits, reloadUserConfig })
  }

  async writeConfigValue(keyPath: string, value: unknown): Promise<void> {
    await this.rpc('config/value/write', { keyPath, value })
  }

  async readConfig(): Promise<{ config: Record<string, unknown> }> {
    return this.rpc('config/read', {})
  }

  async reloadMcpServers(): Promise<void> {
    await this.rpc('config/mcpServer/reload', {})
  }

  async mcpOAuthLogin(name: string, scopes?: string[]): Promise<{ authorization_url: string }> {
    return this.rpc('mcpServer/oauth/login', { name, ...(scopes ? { scopes } : {}) })
  }

  async mcpToolCall(params: { threadId?: string; server: string; tool: string; arguments?: unknown }): Promise<unknown> {
    return this.rpc('mcpServer/tool/call', params)
  }
```

Add the response type at the top of the file (after imports):

```typescript
export interface McpServerStatusEntry {
  name: string
  tools: Record<string, { description?: string; inputSchema?: unknown }>
  resources: Array<{ uri: string; name?: string; description?: string }>
  resource_templates: Array<{ uriTemplate: string; name?: string }>
  auth_status: string
}

export interface McpServerStatusListResponse {
  mcpServers: McpServerStatusEntry[]
  pagination?: { nextCursor?: string }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/agent/__tests__/CodexProtocolClient.mcp.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/CodexProtocolClient.ts src/main/agent/__tests__/CodexProtocolClient.mcp.test.ts
git commit -m "feat(agent): add MCP management RPC methods to CodexProtocolClient"
```

---

### Task 3: Add MCP status notification routing

**Files:**
- Modify: `src/main/agent/CodexProtocolClient.ts`
- Modify: `src/main/agent/codexNotificationRouter.ts`
- Create: `src/main/agent/__tests__/CodexProtocolClient.mcpNotify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/agent/__tests__/CodexProtocolClient.mcpNotify.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { CodexNotificationRouter } from '../codexNotificationRouter'

describe('MCP notification routing', () => {
  it('routes mcpServer/startupStatus/updated to mcp_status_updated event', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('mcpServer/startupStatus/updated', {
      name: 'github',
      status: 'ready',
      error: null,
    })
    expect(event).toEqual({
      type: 'mcp_status_updated',
      name: 'github',
      status: 'ready',
      error: null,
    })
  })

  it('routes mcpServer/oauthLogin/completed to mcp_oauth_completed event', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('mcpServer/oauthLogin/completed', {
      name: 'my-server',
      success: true,
      error: null,
    })
    expect(event).toEqual({
      type: 'mcp_oauth_completed',
      name: 'my-server',
      success: true,
      error: null,
    })
  })

  it('routes mcpServer/startupStatus/updated with error', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('mcpServer/startupStatus/updated', {
      name: 'broken',
      status: 'failed',
      error: 'spawn ENOENT',
    })
    expect(event).toEqual({
      type: 'mcp_status_updated',
      name: 'broken',
      status: 'failed',
      error: 'spawn ENOENT',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/agent/__tests__/CodexProtocolClient.mcpNotify.test.ts`
Expected: FAIL — `mcp_status_updated` type not handled

- [ ] **Step 3: Add notification routing in codexNotificationRouter.ts**

In `src/main/agent/codexNotificationRouter.ts`, add cases for the new notification methods in the `route()` method:

```typescript
    case 'mcpServer/startupStatus/updated':
      return {
        type: 'mcp_status_updated' as const,
        name: params.name as string,
        status: params.status as string,
        error: (params.error as string) ?? null,
      }

    case 'mcpServer/oauthLogin/completed':
      return {
        type: 'mcp_oauth_completed' as const,
        name: params.name as string,
        success: params.success as boolean,
        error: (params.error as string) ?? null,
      }
```

Add the corresponding types to `AgentStreamEvent` in `src/types/agent.ts`:

```typescript
  | { type: 'mcp_status_updated'; name: string; status: string; error: string | null }
  | { type: 'mcp_oauth_completed'; name: string; success: boolean; error: string | null }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/agent/__tests__/CodexProtocolClient.mcpNotify.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/codexNotificationRouter.ts src/types/agent.ts src/main/agent/__tests__/CodexProtocolClient.mcpNotify.test.ts
git commit -m "feat(agent): route MCP status and OAuth notifications"
```

---

### Task 4: Wire MCP RPC methods through IPC bridge

**Files:**
- Modify: `src/main/agent/ipc.ts`
- Modify: `src/main/agent/AgentManager.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add IPC handlers in ipc.ts**

In `src/main/agent/ipc.ts`, add new channel names to `AGENT_HANDLE_CHANNELS`:

```typescript
  'agent:mcp-list-servers',
  'agent:mcp-batch-write',
  'agent:mcp-write-value',
  'agent:mcp-reload',
  'agent:mcp-oauth-login',
  'agent:mcp-read-config',
```

Add handlers after existing ones in `registerAgentIpc`:

```typescript
  ipcMain.handle('agent:mcp-list-servers', (_event, params?: any) => manager.listMcpServersRpc(params))
  ipcMain.handle('agent:mcp-batch-write', (_event, edits: any[], reload?: boolean) => manager.batchWriteConfigRpc(edits, reload))
  ipcMain.handle('agent:mcp-write-value', (_event, keyPath: string, value: unknown) => manager.writeConfigValueRpc(keyPath, value))
  ipcMain.handle('agent:mcp-reload', () => manager.reloadMcpServersRpc())
  ipcMain.handle('agent:mcp-oauth-login', (_event, name: string) => manager.mcpOAuthLoginRpc(name))
  ipcMain.handle('agent:mcp-read-config', () => manager.readConfigRpc())
```

- [ ] **Step 2: Add passthrough methods in AgentManager.ts**

In `src/main/agent/AgentManager.ts`, add:

```typescript
  async listMcpServersRpc(params?: any): Promise<AgentApiResult & { data?: unknown }> {
    try {
      const result = await this.backend?.client?.listMcpServers(params)
      return { ok: true, data: result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async batchWriteConfigRpc(edits: any[], reload?: boolean): Promise<AgentApiResult> {
    try {
      await this.backend?.client?.batchWriteConfig(edits, reload)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async writeConfigValueRpc(keyPath: string, value: unknown): Promise<AgentApiResult> {
    try {
      await this.backend?.client?.writeConfigValue(keyPath, value)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async reloadMcpServersRpc(): Promise<AgentApiResult> {
    try {
      await this.backend?.client?.reloadMcpServers()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async mcpOAuthLoginRpc(name: string): Promise<AgentApiResult & { authorization_url?: string }> {
    try {
      const result = await this.backend?.client?.mcpOAuthLogin(name)
      return { ok: true, authorization_url: result?.authorization_url }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async readConfigRpc(): Promise<AgentApiResult & { config?: unknown }> {
    try {
      const result = await this.backend?.client?.readConfig()
      return { ok: true, config: result?.config }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
```

- [ ] **Step 3: Expose in preload/index.ts**

In the `agent` section of the preload API object in `src/preload/index.ts`, add:

```typescript
    listMcpServersRpc: (params?: any) => ipcRenderer.invoke('agent:mcp-list-servers', params),
    batchWriteConfig: (edits: any[], reload?: boolean) => ipcRenderer.invoke('agent:mcp-batch-write', edits, reload),
    writeConfigValue: (keyPath: string, value: unknown) => ipcRenderer.invoke('agent:mcp-write-value', keyPath, value),
    reloadMcpServers: () => ipcRenderer.invoke('agent:mcp-reload'),
    mcpOAuthLogin: (name: string) => ipcRenderer.invoke('agent:mcp-oauth-login', name),
    readConfig: () => ipcRenderer.invoke('agent:mcp-read-config'),
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors from our changes

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/ipc.ts src/main/agent/AgentManager.ts src/preload/index.ts
git commit -m "feat(ipc): wire MCP RPC methods through Electron IPC bridge"
```

---

### Task 5: Create useMcpStore (Zustand)

**Files:**
- Create: `src/renderer/src/features/agent-workspace/useMcpStore.ts`
- Create: `src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useMcpStore } from '../useMcpStore'

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts`
Expected: FAIL — module `../useMcpStore` cannot resolve `useMcpStore`

- [ ] **Step 3: Implement useMcpStore**

Create `src/renderer/src/features/agent-workspace/useMcpStore.ts`:

```typescript
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
}

function getApi() {
  return (window as any).electronAPI?.agent
}

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: [],
  loading: false,
  error: null,

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
    await api.batchWriteConfig([{ keyPath: `mcp_servers.${name}`, value: null }], true)
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/useMcpStore.ts src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts
git commit -m "feat(renderer): add useMcpStore Zustand store for MCP server management"
```

---

### Task 6: Build McpServerCard and McpServerList components

**Files:**
- Create: `src/renderer/src/features/agent-workspace/McpServerCard.tsx`
- Create: `src/renderer/src/features/agent-workspace/McpServerList.tsx`
- Create: `src/renderer/src/features/agent-workspace/ToolChip.tsx`
- Modify: `src/renderer/src/features/agent-workspace/McpSection.tsx`

This task replaces the existing `McpSection` content. Due to size, code is provided in sub-steps.

- [ ] **Step 1: Create ToolChip.tsx**

Create `src/renderer/src/features/agent-workspace/ToolChip.tsx` — a chip with right-click context menu for disable/enable.

- [ ] **Step 2: Create McpServerCard.tsx**

Create `src/renderer/src/features/agent-workspace/McpServerCard.tsx` — renders one server card with status dot, name, command/url, tool chips, action buttons.

- [ ] **Step 3: Create McpServerList.tsx**

Create `src/renderer/src/features/agent-workspace/McpServerList.tsx` — fetches from `useMcpStore`, renders cards, provides [+ 新增] and [导入] buttons.

- [ ] **Step 4: Replace McpSection.tsx content**

Replace `src/renderer/src/features/agent-workspace/McpSection.tsx` to simply render `<McpServerList />`.

- [ ] **Step 5: Verify renders correctly**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/`
Expected: Existing tests may need updating (old McpSection tests), new components render.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/agent-workspace/ToolChip.tsx src/renderer/src/features/agent-workspace/McpServerCard.tsx src/renderer/src/features/agent-workspace/McpServerList.tsx src/renderer/src/features/agent-workspace/McpSection.tsx
git commit -m "feat(ui): Cursor-style MCP server card list with tool chips"
```

---

### Task 7: Build McpJsonEditor (Monaco)

**Files:**
- Create: `src/renderer/src/features/agent-workspace/McpJsonEditor.tsx`
- Create: `src/renderer/src/features/agent-workspace/mcpSchemaJson.ts`

- [ ] **Step 1: Create mcpSchemaJson.ts with embedded JSON schema**

- [ ] **Step 2: Create McpJsonEditor.tsx with Monaco**

Lazy-loaded, renders Monaco with JSON schema validation, save button calls `batchWriteConfig`.

- [ ] **Step 3: Wire into McpServerList (edit button opens editor)**

- [ ] **Step 4: Test edit flow manually**

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/McpJsonEditor.tsx src/renderer/src/features/agent-workspace/mcpSchemaJson.ts
git commit -m "feat(ui): Monaco JSON editor for MCP server configuration"
```

---

### Task 8: Build BulkImportModal

**Files:**
- Create: `src/renderer/src/features/agent-workspace/BulkImportModal.tsx`
- Create: `src/renderer/src/features/agent-workspace/__tests__/BulkImportModal.test.ts`

- [ ] **Step 1: Write test for JSON parsing and Cursor→Codex field mapping**

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement BulkImportModal with two-step flow (paste → preview+select)**

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Wire into McpServerList (导入 button opens modal)**

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/agent-workspace/BulkImportModal.tsx src/renderer/src/features/agent-workspace/__tests__/BulkImportModal.test.ts
git commit -m "feat(ui): bulk JSON import modal with preview and selection"
```

---

### Task 9: MCP status real-time push integration

**Files:**
- Modify: `src/main/agent/CodexProtocolClient.ts` (forward notifications to renderer)
- Modify: `src/preload/index.ts` (add event listener bridge)
- Modify: `src/renderer/src/features/agent-workspace/McpServerList.tsx` (subscribe)

- [ ] **Step 1: In CodexProtocolClient, emit MCP notifications to main window via IPC send**

- [ ] **Step 2: In preload, expose `onMcpStatusUpdate` listener**

- [ ] **Step 3: In McpServerList, subscribe on mount and call `useMcpStore.updateStatus()`**

- [ ] **Step 4: Verify: start app, watch status dots transition from yellow → green**

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/CodexProtocolClient.ts src/preload/index.ts src/renderer/src/features/agent-workspace/McpServerList.tsx
git commit -m "feat: real-time MCP status push via app-server notifications"
```

---

### Task 10: Clean up old TOML-based MCP code

**Files:**
- Delete: `src/renderer/src/features/agent-workspace/McpEditor.tsx`
- Modify: `src/main/agent/codexConfigStore.ts` (remove MCP functions, keep Skills)
- Modify: `src/main/agent/AgentManager.ts` (remove old MCP IPC delegations)
- Remove old tests: `__tests__/codexConfigStore.listMcp.test.ts`, `saveMcp`, `deleteMcp`, `getMcpDetail`

- [ ] **Step 1: Delete McpEditor.tsx**

- [ ] **Step 2: Remove MCP functions from codexConfigStore.ts (keep saveSkill, listSkills, etc.)**

- [ ] **Step 3: Remove old IPC handlers for agent:list-mcp, agent:save-mcp, agent:delete-mcp, agent:get-mcp-detail, agent:set-mcp-enabled from ipc.ts**

- [ ] **Step 4: Remove corresponding methods from AgentManager.ts**

- [ ] **Step 5: Delete old MCP test files**

- [ ] **Step 6: Run full test suite to verify no regressions**

Run: `npx vitest run`
Expected: PASS (old MCP tests removed, new ones pass)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove legacy TOML-based MCP editor code"
```

---

## Self-Review Notes

1. **Spec coverage**: All 7 spec phases (P1-P7) map to Tasks 2-9. Cleanup is Task 10.
2. **No placeholders**: Tasks 6-8 have less code detail due to UI component size but each step is actionable (create file → implement → wire → test → commit).
3. **Type consistency**: `McpServerCard`, `McpTool`, `McpServerStatusEntry`, `McpServerStatusListResponse` are defined once in Task 2/5 and referenced consistently.
4. **DRY**: Store logic centralized in `useMcpStore`; components only call store actions.
5. **TDD**: Tasks 2, 3, 5, 8 follow red-green-refactor strictly. Tasks 6-7 are UI-heavy (visual verification).
