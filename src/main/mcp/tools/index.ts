import { registerHistoryTools } from './historyTools'
import { registerImageTools } from './imageTools'
import { registerUiTools } from './uiTools'
import { registerVideoTools } from './videoTools'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

export function registerTools(server: McpServer, router: ToolRouter): void {
  registerImageTools(server, router)
  registerVideoTools(server, router)
  registerHistoryTools(server, router)
  registerUiTools(server, router)
}
