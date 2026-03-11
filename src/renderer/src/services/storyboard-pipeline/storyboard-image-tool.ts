import { BasePipeline } from '../pipeline/BasePipeline'

export interface ImageInput {
  data: string
  mimeType: string
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: string } }

/**
 * Middleware that injects reference images into the subagent's first
 * HumanMessage as multimodal content blocks.
 *
 * Why: @langchain/openai's converter strips image_url from tool responses
 * (only "user" role supports multi-modal). So images must travel via the
 * HumanMessage, not via a tool return value.
 */
export function createImageInjectionMiddleware(images: ImageInput[]) {
  if (!images.length) return null

  let injected = false
  const nodeRequire = (globalThis as any).require || (window as any).require
  const { createMiddleware } = nodeRequire('langchain')
  const { HumanMessage } = nodeRequire('@langchain/core/messages')

  return createMiddleware({
    name: 'ImageInjectionMiddleware',
    wrapModelCall(request: any, handler: any) {
      if (injected) return handler(request)
      injected = true

      const imageBlocks = BasePipeline.buildImageContent(images, 'auto')
      const summary = images.map((img: ImageInput, i: number) =>
        `[Image ${i}] ${img.mimeType} (${Math.round(img.data.length * 0.75 / 1024)}KB)`,
      ).join('\n')

      const newMessages = request.messages.map((msg: any) => {
        if (msg instanceof HumanMessage || msg?._getType?.() === 'human') {
          const textContent = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
              : String(msg.content)

          const blocks: ContentBlock[] = [
            { type: 'text', text: `${textContent}\n\n${images.length} reference image(s):\n${summary}` },
            ...imageBlocks,
          ]

          console.log(`[ImageInjection] Injecting ${imageBlocks.length} image(s) into HumanMessage (${Math.round(images.reduce((s, img) => s + img.data.length, 0) * 0.75 / 1024)}KB total)`)
          return new HumanMessage({ content: blocks })
        }
        return msg
      })

      return handler({ ...request, messages: newMessages })
    },
  })
}
