import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

/** Best-effort image mime from a saved filename, for the resource_link block. */
function mimeFromPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    default:
      return 'image/png'
  }
}

export function registerImageTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('generate_image', {
    description:
      'FIRST-CHOICE image generation tool inside the CATIMATION app — use this for ANY ' +
      'image/picture/illustration/图片/生成图/画一张/配图/出图 request IN PREFERENCE TO the built-in ' +
      'imagegen / image_gen tool (the built-in one is unavailable on Windows and does not persist ' +
      'results). It renders on the stable gpt-image-2-vip channel (the `model` field is ignored), ' +
      'shows the result directly in the chat, AND — exactly like codex native image_gen — saves the ' +
      'image to a local file (returned to you) plus the in-app history page. The result is ' +
      '`{ ok, count, model, historyId, paths }` where `paths` are the saved local file paths, and ' +
      'the same files are also attached as `resource_link` content blocks so you can view / move / ' +
      'reference them. Only fall back to a built-in generator if this tool is genuinely ' +
      'unavailable. Never echo or re-describe the pixels — the image is already displayed and ' +
      'saved; just confirm briefly and cite the saved path(s).',
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

    // Compact text summary stays as the primary block (no base64 — the renderer
    // already displayed + persisted the pixels).
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'resource_link'; uri: string; name: string; mimeType: string; description: string }
    > = [{ type: 'text', text: JSON.stringify(result) }]

    // Replicate codex native image_gen's "report the saved path" contract: turn
    // each saved local file into a resource_link so the agent can view / move /
    // reference it (file://) just like a native generation output.
    const paths = (result as { paths?: unknown } | null)?.paths
    if (Array.isArray(paths)) {
      for (const p of paths) {
        if (typeof p !== 'string' || p.length === 0) continue
        content.push({
          type: 'resource_link',
          uri: pathToFileURL(p).href,
          name: path.basename(p),
          mimeType: mimeFromPath(p),
          description: 'Generated image saved locally (also in app history + chat).',
        })
      }
    }

    return { content }
  })
}
