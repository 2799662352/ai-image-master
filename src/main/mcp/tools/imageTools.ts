import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

export function registerImageTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('generate_image', {
    description: 'Generate images in CATIMATION using the configured image model.',
    inputSchema: z.object({
      prompt: z.string().min(1),
      model: z.string().optional(),
      ratio: z.string().optional(),
      referenceImages: z.array(z.string()).optional(),
    }),
  }, async (params) => {
    const result = await router.call('generate_image', params)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  })
}
