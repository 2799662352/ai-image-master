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
  ipcMain.handle('agent:list-codex-threads', () => manager.listCodexThreads())
  ipcMain.handle('agent:read-codex-thread', async (_event, threadId: unknown) =>
    manager.readCodexThread(validateThreadId(threadId)),
  )
  ipcMain.handle('agent:fork-codex-thread', async (_event, threadId: unknown) =>
    manager.forkCodexThread(validateThreadId(threadId)),
  )
  ipcMain.on('agent:tool-response', (_event, response: AgentToolResponse) => router.handleRendererResponse(response))
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
