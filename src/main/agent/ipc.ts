import { ipcMain } from 'electron'
import type { AgentToolResponse, CodexApprovalResponse } from '../../types/agent'
import type { ToolRouter } from '../mcp/ToolRouter'
import type { AgentManager } from './AgentManager'

const AGENT_HANDLE_CHANNELS = [
  'agent:send-message',
  'agent:cancel',
  'agent:list-threads',
  'agent:load-thread',
  'agent:open-thread',
  'agent:rename-thread',
  'agent:delete-thread',
  'agent:set-api-key',
  'agent:test-connection',
  'agent:get-session-status',
  'agent:set-session-config',
  'agent:set-allowed-roots',
  'agent:respond-approval',
  'agent:get-mcp-summary',
  'agent:get-skills-summary',
  'agent:list-skills',
  'agent:get-skill-detail',
  'agent:save-skill',
  'agent:delete-skill',
  'agent:open-skills-root',
  'agent:get-workspace-logs',
  'agent:restart-codex',
  'agent:list-codex-threads',
  'agent:read-codex-thread',
  'agent:fork-codex-thread',
  'agent:mcp-list-servers',
  'agent:mcp-batch-write',
  'agent:mcp-write-value',
  'agent:mcp-reload',
  'agent:mcp-oauth-login',
  'agent:mcp-read-config',
  'agent:mcp-status-snapshot',
  'agent:docker-gw-check',
  'agent:docker-gw-fix',
  'agent:docker-gw-status',
  'agent:docker-gw-stop',
  'agent:get-providers',
  'agent:set-active-provider',
  'agent:set-provider-api-key',
  'agent:set-apiyi-video-key',
  'agent:set-apiyi-video-model',
  'agent:add-custom-provider',
  'agent:update-custom-provider',
  'agent:remove-custom-provider',
]

export type GetAgentManager = () => Promise<AgentManager>
export type GetToolRouter = () => ToolRouter | null

// Registers all agent IPC handlers eagerly at app start. Each handler awaits
// `getManager()` so renderer-side calls that fire before the AgentManager has
// finished initializing (e.g. the chat sidebar's mount-time `agent:list-threads`)
// block on the manager-ready promise instead of failing with "No handler
// registered for ..." — which is the first-launch race users hit.
export function registerAgentIpc(getManager: GetAgentManager, getRouter: GetToolRouter): void {
  for (const channel of AGENT_HANDLE_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.removeAllListeners('agent:tool-response')

  ipcMain.handle('agent:send-message', async (_event, payload) =>
    (await getManager()).sendMessage(payload),
  )
  ipcMain.handle('agent:cancel', async (_event, payload) => {
    await (await getManager()).cancel(payload.threadId)
    return { success: true }
  })
  ipcMain.handle('agent:list-threads', async () => (await getManager()).listThreads())
  ipcMain.handle('agent:load-thread', async (_event, threadId: string) =>
    (await getManager()).loadThread(threadId),
  )
  ipcMain.handle('agent:open-thread', async (_event, threadId: string) =>
    (await getManager()).openThread(threadId),
  )
  ipcMain.handle('agent:rename-thread', async (_event, threadId: string, title: string) =>
    (await getManager()).renameThread(threadId, title),
  )
  ipcMain.handle('agent:delete-thread', async (_event, threadId: string) =>
    (await getManager()).deleteThread(threadId),
  )
  ipcMain.handle('agent:set-api-key', async (_event, key: unknown) => {
    try {
      await (await getManager()).setCodexApiKey(typeof key === 'string' ? key : '')
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('agent:test-connection', async () => (await getManager()).testConnection())
  ipcMain.handle('agent:get-session-status', async () => (await getManager()).getSessionStatus())
  ipcMain.handle('agent:set-session-config', async (_event, patch: unknown) =>
    (await getManager()).setSessionConfigPatch(patch),
  )
  ipcMain.handle('agent:set-allowed-roots', async (_event, roots: unknown) =>
    (await getManager()).setAllowedRoots(roots),
  )
  ipcMain.handle('agent:respond-approval', async (_event, payload: unknown) =>
    (await getManager()).respondToApprovalResponse(validateApprovalResponse(payload)),
  )
  ipcMain.handle('agent:get-mcp-summary', async () => (await getManager()).getMcpSummary())
  ipcMain.handle('agent:get-skills-summary', async () => (await getManager()).getSkillsSummary())
  ipcMain.handle('agent:list-skills', async () =>
    handleWorkspaceRequest(async () => (await getManager()).listSkills()),
  )
  ipcMain.handle('agent:get-skill-detail', async (_event, id: unknown) =>
    handleWorkspaceRequest(async () =>
      (await getManager()).getSkillDetail(validateWorkspaceId(id, 'Skill id')),
    ),
  )
  ipcMain.handle('agent:save-skill', async (_event, input: unknown) =>
    handleWorkspaceRequest(async () =>
      (await getManager()).saveSkill(input as Parameters<AgentManager['saveSkill']>[0]),
    ),
  )
  ipcMain.handle('agent:delete-skill', async (_event, id: unknown) =>
    handleWorkspaceRequest(async () =>
      (await getManager()).deleteSkill(validateWorkspaceId(id, 'Skill id')),
    ),
  )
  ipcMain.handle('agent:open-skills-root', async (_event, scope: unknown) => {
    if (scope !== 'repo' && scope !== 'user' && scope !== 'system') {
      return { ok: false as const, error: `Unknown scope: ${String(scope)}` }
    }
    return (await getManager()).openSkillsRoot(scope)
  })
  ipcMain.handle('agent:get-workspace-logs', async (_event, opts: unknown) =>
    handleWorkspaceRequest(async () =>
      (await getManager()).getWorkspaceLogs(opts as Parameters<AgentManager['getWorkspaceLogs']>[0]),
    ),
  )
  ipcMain.handle('agent:restart-codex', async () => {
    try {
      await (await getManager()).restartCodex()
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('agent:list-codex-threads', async () => (await getManager()).listCodexThreads())
  ipcMain.handle('agent:read-codex-thread', async (_event, threadId: unknown) =>
    (await getManager()).readCodexThread(validateThreadId(threadId)),
  )
  ipcMain.handle('agent:fork-codex-thread', async (_event, threadId: unknown) =>
    (await getManager()).forkCodexThread(validateThreadId(threadId)),
  )
  ipcMain.handle('agent:mcp-list-servers', async (_event, params?: unknown) =>
    (await getManager()).listMcpServersRpc(params),
  )
  ipcMain.handle('agent:mcp-batch-write', async (_event, edits: unknown[], reload?: boolean) =>
    (await getManager()).batchWriteConfigRpc(edits, reload),
  )
  ipcMain.handle('agent:mcp-write-value', async (_event, keyPath: string, value: unknown) =>
    (await getManager()).writeConfigValueRpc(keyPath, value),
  )
  ipcMain.handle('agent:mcp-reload', async () => (await getManager()).reloadMcpServersRpc())
  ipcMain.handle('agent:mcp-oauth-login', async (_event, name: string) =>
    (await getManager()).mcpOAuthLoginRpc(name),
  )
  ipcMain.handle('agent:mcp-read-config', async () => (await getManager()).readConfigRpc())
  ipcMain.handle('agent:mcp-status-snapshot', async () =>
    (await getManager()).getMcpStatusSnapshotRpc(),
  )
  ipcMain.handle('agent:docker-gw-check', async () => (await getManager()).dockerGatewayCheckRpc())
  ipcMain.handle('agent:docker-gw-fix', async (_event, opts?: { port?: number }) =>
    (await getManager()).dockerGatewayFixRpc(opts),
  )
  ipcMain.handle('agent:docker-gw-status', async () => (await getManager()).dockerGatewayStatusRpc())
  ipcMain.handle('agent:docker-gw-stop', async () => (await getManager()).dockerGatewayStopRpc())

  // ----- Codex provider management (v4.3+) -----
  ipcMain.handle('agent:get-providers', async () => {
    try {
      const snapshot = await (await getManager()).getProvidersSnapshot()
      return { ok: true as const, ...snapshot }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('agent:set-active-provider', async (_event, id: unknown) => {
    try {
      const validated = validateWorkspaceId(id, 'Provider id')
      const result = await (await getManager()).setActiveProvider(validated)
      return { ok: true as const, activeId: result.activeId }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(
    'agent:set-provider-api-key',
    async (_event, id: unknown, key: unknown) => {
      try {
        const validated = validateWorkspaceId(id, 'Provider id')
        await (await getManager()).setProviderApiKey(
          validated,
          typeof key === 'string' ? key : '',
        )
        return { ok: true as const }
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
  ipcMain.handle('agent:set-apiyi-video-key', async (_event, key: unknown) => {
    try {
      const validated = typeof key === 'string' ? key : ''
      const result = await (await getManager()).setApiyiVideoKey(validated)
      return result
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('agent:set-apiyi-video-model', async (_event, modelId: unknown) => {
    try {
      const validated = typeof modelId === 'string' ? modelId : ''
      const result = await (await getManager()).setApiyiVideoModel(validated)
      return result
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('agent:add-custom-provider', async (_event, input: unknown) => {
    try {
      const created = await (await getManager()).addCustomProvider(
        validateCustomProviderInput(input),
      )
      return { ok: true as const, provider: created }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(
    'agent:update-custom-provider',
    async (_event, id: unknown, patch: unknown) => {
      try {
        const validatedId = validateWorkspaceId(id, 'Provider id')
        const validatedPatch = validateCustomProviderPatch(patch)
        await (await getManager()).updateCustomProvider(validatedId, validatedPatch)
        return { ok: true as const }
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
  ipcMain.handle('agent:remove-custom-provider', async (_event, id: unknown) => {
    try {
      const validated = validateWorkspaceId(id, 'Provider id')
      const result = await (await getManager()).removeCustomProvider(validated)
      return { ok: true as const, activeId: result.activeId }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Tool-response routing only takes effect once the catimation MCP HTTP
  // listener is live (router != null). Resolving the router lazily lets us
  // register the listener at startup regardless of MCP boot order.
  ipcMain.on('agent:tool-response', (_event, response: AgentToolResponse) => {
    const router = getRouter()
    if (router) router.handleRendererResponse(response)
  })
}

async function handleWorkspaceRequest<T>(
  operation: () => T | Promise<T>,
): Promise<T | { ok: false; error: string }> {
  try {
    return await operation()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function validateWorkspaceId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function validateApprovalResponse(payload: unknown): CodexApprovalResponse {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid approval response payload')
  }
  const input = payload as Record<string, unknown>
  if (typeof input.id !== 'string' || input.id.trim().length === 0) {
    throw new Error('Approval response id must be a non-empty string')
  }
  if (typeof input.approved !== 'boolean') {
    throw new Error('Approval response approved must be a boolean')
  }
  if (input.message !== undefined && typeof input.message !== 'string') {
    throw new Error('Approval response message must be a string')
  }
  return {
    id: input.id,
    approved: input.approved,
    ...(typeof input.message === 'string' && input.message.length > 0 ? { message: input.message } : {}),
  }
}

function validateThreadId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Codex thread id must be a non-empty string')
  }
  return value
}

const ALLOWED_EXTRA_VALUE_TYPES = new Set(['string', 'boolean', 'number'])

function validateExtraTopLevelConfig(value: unknown): Record<string, string | boolean | number> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('extraTopLevelConfig must be an object of scalar values')
  }
  const result: Record<string, string | boolean | number> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
      throw new Error(`extraTopLevelConfig key "${key}" is not a valid TOML key`)
    }
    if (!ALLOWED_EXTRA_VALUE_TYPES.has(typeof raw)) {
      throw new Error(
        `extraTopLevelConfig value for "${key}" must be string|boolean|number`,
      )
    }
    result[key] = raw as string | boolean | number
  }
  return result
}

function validateCustomProviderInput(value: unknown): {
  id?: string
  name: string
  baseUrl: string
  envKey: string
  model?: string
  reasoningEffort?: string
  verbosity?: string
  requiresOpenaiAuth?: boolean
  extraTopLevelConfig?: Record<string, string | boolean | number>
  description?: string
} {
  if (!value || typeof value !== 'object') {
    throw new Error('Custom provider input must be an object')
  }
  const v = value as Record<string, unknown>
  if (typeof v.name !== 'string' || v.name.trim().length === 0) {
    throw new Error('Custom provider name must be a non-empty string')
  }
  if (typeof v.baseUrl !== 'string' || v.baseUrl.trim().length === 0) {
    throw new Error('Custom provider baseUrl must be a non-empty string')
  }
  return {
    name: v.name.trim(),
    baseUrl: v.baseUrl.trim(),
    envKey: typeof v.envKey === 'string' && v.envKey.trim() ? v.envKey.trim() : 'OPENAI_API_KEY',
    ...(typeof v.id === 'string' && v.id.trim() ? { id: v.id.trim() } : {}),
    ...(typeof v.model === 'string' && v.model ? { model: v.model } : {}),
    ...(typeof v.reasoningEffort === 'string' && v.reasoningEffort
      ? { reasoningEffort: v.reasoningEffort }
      : {}),
    ...(typeof v.verbosity === 'string' && v.verbosity ? { verbosity: v.verbosity } : {}),
    ...(typeof v.requiresOpenaiAuth === 'boolean'
      ? { requiresOpenaiAuth: v.requiresOpenaiAuth }
      : {}),
    ...(typeof v.description === 'string' && v.description ? { description: v.description } : {}),
    ...(v.extraTopLevelConfig !== undefined
      ? { extraTopLevelConfig: validateExtraTopLevelConfig(v.extraTopLevelConfig) ?? {} }
      : {}),
  }
}

function validateCustomProviderPatch(value: unknown): {
  name?: string
  baseUrl?: string
  envKey?: string
  model?: string
  reasoningEffort?: string
  verbosity?: string
  requiresOpenaiAuth?: boolean
  extraTopLevelConfig?: Record<string, string | boolean | number>
  description?: string
} {
  if (!value || typeof value !== 'object') {
    throw new Error('Custom provider patch must be an object')
  }
  const v = value as Record<string, unknown>
  const out: ReturnType<typeof validateCustomProviderPatch> = {}
  if (v.name !== undefined) {
    if (typeof v.name !== 'string' || v.name.trim().length === 0) {
      throw new Error('Custom provider name must be a non-empty string')
    }
    out.name = v.name.trim()
  }
  if (v.baseUrl !== undefined) {
    if (typeof v.baseUrl !== 'string' || v.baseUrl.trim().length === 0) {
      throw new Error('Custom provider baseUrl must be a non-empty string')
    }
    out.baseUrl = v.baseUrl.trim()
  }
  if (v.envKey !== undefined) {
    if (typeof v.envKey !== 'string') throw new Error('Custom provider envKey must be a string')
    out.envKey = v.envKey
  }
  if (v.model !== undefined) {
    if (typeof v.model !== 'string') throw new Error('Custom provider model must be a string')
    out.model = v.model
  }
  if (v.reasoningEffort !== undefined) {
    if (typeof v.reasoningEffort !== 'string') {
      throw new Error('Custom provider reasoningEffort must be a string')
    }
    out.reasoningEffort = v.reasoningEffort
  }
  if (v.verbosity !== undefined) {
    if (typeof v.verbosity !== 'string') {
      throw new Error('Custom provider verbosity must be a string')
    }
    out.verbosity = v.verbosity
  }
  if (v.requiresOpenaiAuth !== undefined) {
    if (typeof v.requiresOpenaiAuth !== 'boolean') {
      throw new Error('Custom provider requiresOpenaiAuth must be a boolean')
    }
    out.requiresOpenaiAuth = v.requiresOpenaiAuth
  }
  if (v.description !== undefined) {
    if (typeof v.description !== 'string') {
      throw new Error('Custom provider description must be a string')
    }
    out.description = v.description
  }
  if (v.extraTopLevelConfig !== undefined) {
    out.extraTopLevelConfig = validateExtraTopLevelConfig(v.extraTopLevelConfig) ?? {}
  }
  return out
}
