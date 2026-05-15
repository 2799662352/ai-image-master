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
