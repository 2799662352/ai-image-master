import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

export function registerUiTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('open_image_viewer', {
    description: 'Open CATIMATION image viewer with one or more image URLs.',
    inputSchema: z.object({
      urls: z.array(z.string()).min(1),
      startIndex: z.number().int().min(0).default(0),
    }),
  }, async (params) => {
    await router.call('open_image_viewer', params)
    return { content: [{ type: 'text', text: 'opened' }] }
  })
}
