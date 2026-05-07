import { ipcMain } from 'electron'
import type { AgentToolResponse } from '../../types/agent'
import type { ToolRouter } from '../mcp/ToolRouter'
import type { AgentManager } from './AgentManager'

export function registerAgentIpc(manager: AgentManager, router: ToolRouter): void {
  ipcMain.handle('agent:send-message', (_event, payload) => manager.sendMessage(payload))
  ipcMain.handle('agent:cancel', async (_event, payload) => {
    await manager.cancel(payload.threadId)
    return { success: true }
  })
  ipcMain.handle('agent:list-threads', () => manager.listThreads())
  ipcMain.handle('agent:load-thread', (_event, threadId: string) => manager.loadThread(threadId))
  ipcMain.handle('agent:set-api-key', async (_event, key: unknown) => {
    try {
      await manager.setCodexApiKey(typeof key === 'string' ? key : '')
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('agent:test-connection', () => manager.testConnection())
  ipcMain.on('agent:tool-response', (_event, response: AgentToolResponse) => router.handleRendererResponse(response))
}
