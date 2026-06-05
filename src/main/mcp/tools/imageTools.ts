import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

export function registerImageTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('generate_image', {
    description:
      'Generate images in CATIMATION. Always renders on the stable gpt-image-2-vip channel ' +
      '(the `model` field is ignored by the renderer). Output is saved to history and shown in chat.',
    inputSchema: z.object({
      prompt: z.string().min(1).describe('Image description / prompt.'),
      model: z
        .string()
        .optional()
        .describe('Ignored: the renderer forces gpt-image-2-vip for stability.'),
      ratio: z
        .string()
        .optional()
        .describe('Aspect ratio, e.g. "1:1", "16:9", "9:16", "3:2". Omit or "auto" lets the model decide.'),
      resolution: z
        .enum(['1K', '2K', '4K'])
        .optional()
        .describe('Resolution tier. 1K=fast (default), 2K=recommended, 4K=print detail.'),
      quality: z
        .enum(['auto', 'low', 'medium', 'high'])
        .optional()
        .describe('Rendering quality. "high" for text/print; "auto" lets the model decide (default).'),
      referenceImages: z
        .array(z.string())
        .optional()
        .describe('Optional reference images (data URLs or paths) for image-to-image / editing.'),
    }),
  }, async (params) => {
    const result = await router.call('generate_image', params)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  })
}
