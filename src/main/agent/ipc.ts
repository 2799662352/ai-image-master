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
  'agent:list-mcp',
  'agent:get-mcp-detail',
  'agent:save-mcp',
  'agent:delete-mcp',
  'agent:set-mcp-enabled',
  'agent:list-skills',
  'agent:get-skill-detail',
  'agent:save-skill',
  'agent:delete-skill',
  'agent:get-workspace-logs',
  'agent:restart-codex',
  'agent:list-codex-threads',
  'agent:read-codex-thread',
  'agent:fork-codex-thread',
]

export function registerAgentIpc(manager: AgentManager, router: ToolRouter): void {
  for (const channel of AGENT_HANDLE_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.removeAllListeners('agent:tool-response')

  ipcMain.handle('agent:send-message', (_event, payload) => manager.sendMessage(payload))
  ipcMain.handle('agent:cancel', async (_event, payload) => {
    await manager.cancel(payload.threadId)
    return { success: true }
  })
  ipcMain.handle('agent:list-threads', () => manager.listThreads())
  ipcMain.handle('agent:load-thread', (_event, threadId: string) => manager.loadThread(threadId))
  ipcMain.handle('agent:open-thread', (_event, threadId: string) => manager.openThread(threadId))
  ipcMain.handle('agent:rename-thread', (_event, threadId: string, title: string) =>
    manager.renameThread(threadId, title),
  )
  ipcMain.handle('agent:delete-thread', (_event, threadId: string) => manager.deleteThread(threadId))
  ipcMain.handle('agent:set-api-key', async (_event, key: unknown) => {
    try {
      await manager.setCodexApiKey(typeof key === 'string' ? key : '')
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('agent:test-connection', () => manager.testConnection())
  ipcMain.handle('agent:get-session-status', () => manager.getSessionStatus())
  ipcMain.handle('agent:set-session-config', (_event, patch: unknown) => manager.setSessionConfigPatch(patch))
  ipcMain.handle('agent:set-allowed-roots', (_event, roots: unknown) => manager.setAllowedRoots(roots))
  ipcMain.handle('agent:respond-approval', async (_event, payload: unknown) =>
    manager.respondToApprovalResponse(validateApprovalResponse(payload)),
  )
  ipcMain.handle('agent:get-mcp-summary', () => manager.getMcpSummary())
  ipcMain.handle('agent:get-skills-summary', () => manager.getSkillsSummary())
  ipcMain.handle('agent:list-mcp', () => handleWorkspaceRequest(() => manager.listMcp()))
  ipcMain.handle('agent:get-mcp-detail', (_event, id: unknown) =>
    handleWorkspaceRequest(() => manager.getMcpDetail(validateWorkspaceId(id, 'MCP server id'))),
  )
  ipcMain.handle('agent:save-mcp', (_event, input: unknown) =>
    handleWorkspaceRequest(() => manager.saveMcp(input as Parameters<AgentManager['saveMcp']>[0])),
  )
  ipcMain.handle('agent:delete-mcp', (_event, id: unknown) =>
    handleWorkspaceRequest(() => manager.deleteMcp(validateWorkspaceId(id, 'MCP server id'))),
  )
  ipcMain.handle('agent:set-mcp-enabled', (_event, payload: unknown) =>
    handleWorkspaceRequest(() => {
      const { id, enabled } = validateSetMcpEnabledPayload(payload)
      return manager.setMcpEnabled(id, enabled)
    }),
  )
  ipcMain.handle('agent:list-skills', () => handleWorkspaceRequest(() => manager.listSkills()))
  ipcMain.handle('agent:get-skill-detail', (_event, id: unknown) =>
    handleWorkspaceRequest(() => manager.getSkillDetail(validateWorkspaceId(id, 'Skill id'))),
  )
  ipcMain.handle('agent:save-skill', (_event, input: unknown) =>
    handleWorkspaceRequest(() => manager.saveSkill(input as Parameters<AgentManager['saveSkill']>[0])),
  )
  ipcMain.handle('agent:delete-skill', (_event, id: unknown) =>
    handleWorkspaceRequest(() => manager.deleteSkill(validateWorkspaceId(id, 'Skill id'))),
  )
  ipcMain.handle('agent:get-workspace-logs', (_event, opts: unknown) =>
    handleWorkspaceRequest(() => manager.getWorkspaceLogs(opts as Parameters<AgentManager['getWorkspaceLogs']>[0])),
  )
  ipcMain.handle('agent:restart-codex', async () => {
    try {
      await manager.restartCodex()
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('agent:list-codex-threads', () => manager.listCodexThreads())
  ipcMain.handle('agent:read-codex-thread', async (_event, threadId: unknown) =>
    manager.readCodexThread(validateThreadId(threadId)),
  )
  ipcMain.handle('agent:fork-codex-thread', async (_event, threadId: unknown) =>
    manager.forkCodexThread(validateThreadId(threadId)),
  )
  ipcMain.on('agent:tool-response', (_event, response: AgentToolResponse) => router.handleRendererResponse(response))
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

function validateSetMcpEnabledPayload(payload: unknown): { id: string; enabled: boolean } {
  if (!payload || typeof payload !== 'object') {
    throw new Error('MCP enabled payload must be an object')
  }
  const input = payload as Record<string, unknown>
  const id = validateWorkspaceId(input.id, 'MCP server id')
  if (typeof input.enabled !== 'boolean') {
    throw new Error('MCP enabled state must be a boolean')
  }
  return { id, enabled: input.enabled }
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
