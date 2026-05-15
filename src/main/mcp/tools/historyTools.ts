import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

export function registerHistoryTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('query_history', {
    description: 'Query CATIMATION generation history.',
    inputSchema: z.object({
      query: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
  }, async (params) => {
    const result = await router.call('query_history', params)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  })
}
