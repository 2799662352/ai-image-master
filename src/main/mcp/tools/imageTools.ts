import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

export function registerImageTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('generate_image', {
    description:
      'Generate images from a text prompt inside the CATIMATION app. PREFER this tool for any ' +
      'image/picture/illustration/图片/生成图 request: it renders on the stable gpt-image-2-vip ' +
      'channel (the `model` field is ignored), shows the result directly in the chat, AND saves it ' +
      'to the history page — which the built-in image generator cannot do. If for some reason this ' +
      'tool is unavailable, you may fall back to your built-in generator (use whatever works), but ' +
      'this one is the in-app path that actually persists and displays the image. Returns only a ' +
      'compact summary ({ ok, count, model }) — the actual image is displayed to the user, so you ' +
      'do not need to embed or describe the pixels.',
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
