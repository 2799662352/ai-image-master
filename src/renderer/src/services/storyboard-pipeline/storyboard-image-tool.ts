import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { BasePipeline } from '../pipeline/BasePipeline'

export interface ImageInput {
  data: string
  mimeType: string
}

export function createViewImagesTool(images: ImageInput[]) {
  return tool(
    async () => {
      if (!images.length) return 'No images available for analysis.'
      const blocks = BasePipeline.buildImageContent(images, 'high')
      const summary = images.map((img, i) =>
        `[Image ${i}] ${img.mimeType} (${Math.round(img.data.length * 0.75 / 1024)}KB)`
      ).join('\n')
      return JSON.stringify({
        description: `${images.length} reference image(s) available for visual analysis.`,
        summary,
        images: blocks,
      })
    },
    {
      name: 'view_images',
      description: 'View all reference images for visual analysis. Returns multimodal image content. Call this FIRST before any analysis. No parameters needed.',
      schema: z.object({}),
    },
  )
}
