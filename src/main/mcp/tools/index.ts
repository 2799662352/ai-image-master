import { registerAskTools } from './askTools'
import { registerAudioTools } from './audioTools'
import { registerCanvasTools } from './canvasTools'
import { registerDirectorTools } from './directorTools'
import { registerHistoryTools } from './historyTools'
import { registerImageTools } from './imageTools'
import { registerPortraitTools } from './portraitTools'
import { registerUiTools } from './uiTools'
import { registerUnderstandTools } from './understandTools'
import { registerVideoTools } from './videoTools'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

export function registerTools(server: McpServer, router: ToolRouter): void {
  registerImageTools(server, router)
  registerVideoTools(server, router)
  registerAudioTools(server, router)
  registerPortraitTools(server, router)
  registerHistoryTools(server, router)
  registerUiTools(server, router)
  registerAskTools(server, router)
  registerCanvasTools(server, router)
  registerDirectorTools(server, router)
  registerUnderstandTools(server, router)
}
