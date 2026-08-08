import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'
import { READ_ONLY } from './annotations'

export function registerHistoryTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('query_history', {
    description:
      'Browse PAST CATIMATION generation history (older sessions). Returns a lean, ' +
      'base64-free summary list: { id, type, prompt, model, ratio, timestamp, imageCount, urls }. ' +
      'Do NOT use this to locate an image you just generated — `generate_image` already ' +
      'returns the saved `paths` + `dir`; open those directly instead. Use this only when the ' +
      'user explicitly asks about earlier/previous generations.',
    annotations: READ_ONLY,
    inputSchema: z.object({
      query: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
  }, async (params) => {
    const result = await router.call('query_history', params)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  })
}
