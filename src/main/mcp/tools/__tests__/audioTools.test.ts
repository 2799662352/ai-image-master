import { describe, expect, it, vi } from 'vitest'
import type { ZodTypeAny } from 'zod'
import { registerAudioTools } from '../audioTools'

type Handler = (params: Record<string, unknown>, ctx?: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>
type Captured = { name: string; config: { description: string; inputSchema: ZodTypeAny }; handler: Handler }

function capture(routerResult: unknown = { success: true, prompt: 'x', format: 'mp3', duration: 5, billedSeconds: 5 }): {
  tools: Captured[]
  server: any
  router: { call: ReturnType<typeof vi.fn> }
} {
  const tools: Captured[] = []
  const server = {
    registerTool: (name: string, config: Captured['config'], handler: Handler) => tools.push({ name, config, handler }),
  }
  const router = { call: vi.fn(async () => routerResult) }
  return { tools, server, router }
}

describe('registerAudioTools / generate_audio', () => {
  it('registers generate_audio with a zod inputSchema', () => {
    const { tools, server, router } = capture()
    registerAudioTools(server, router as any)
    const tool = tools.find((t) => t.name === 'generate_audio')
    expect(tool).toBeDefined()
    expect(tool!.config.inputSchema).toBeDefined()
  })

  it('accepts input + optional format/speed/referenceAudios', () => {
    const { tools, server, router } = capture()
    registerAudioTools(server, router as any)
    const schema = tools.find((t) => t.name === 'generate_audio')!.config.inputSchema
    expect(schema.safeParse({ input: '一位女声说你好' }).success).toBe(true)
    expect(schema.safeParse({ input: 'x', format: 'wav', speed: 1.5 }).success).toBe(true)
    expect(schema.safeParse({ input: 'x', referenceAudios: ['https://e/a.mp3'] }).success).toBe(true)
  })

  it('rejects empty input, out-of-enum format, out-of-range speed, and >2 reference audios', () => {
    const { tools, server, router } = capture()
    registerAudioTools(server, router as any)
    const schema = tools.find((t) => t.name === 'generate_audio')!.config.inputSchema
    expect(schema.safeParse({ input: '' }).success).toBe(false)
    expect(schema.safeParse({ input: 'x', format: 'flac' }).success).toBe(false)
    expect(schema.safeParse({ input: 'x', speed: 9 }).success).toBe(false)
    expect(schema.safeParse({ input: 'x', referenceAudios: ['a', 'b', 'c'] }).success).toBe(false)
  })

  it('forwards the call to the renderer and wraps a success result into a DONE banner', async () => {
    const { tools, server, router } = capture({
      success: true,
      prompt: 'p',
      format: 'mp3',
      duration: 12.3,
      billedSeconds: 13,
      remoteUrl: 'https://cos.example.com/image-history/audio/a.mp3',
      filePath: 'C:\\ud\\audio-history\\a.mp3',
    })
    registerAudioTools(server, router as any)
    const handler = tools.find((t) => t.name === 'generate_audio')!.handler

    const out = await handler({ input: '念一段' })
    expect(router.call).toHaveBeenCalledWith('generate_audio', { input: '念一段' }, undefined)
    const text = out.content[0].text
    expect(text).toContain('✅ generate_audio DONE')
    expect(text).toContain('12.3s')
    expect(text).toContain('https://cos.example.com/image-history/audio/a.mp3')
    expect(text).toContain('C:\\ud\\audio-history\\a.mp3')
    expect(text).toContain('"ok":true')
  })

  it('wraps a renderer failure into a failed banner (no throw)', async () => {
    const { tools, server, router } = capture({ success: false, error: 'speaker not found' })
    registerAudioTools(server, router as any)
    const handler = tools.find((t) => t.name === 'generate_audio')!.handler

    const out = await handler({ input: 'x' })
    expect(out.content[0].text).toContain('❌ generate_audio failed: speaker not found')
    expect(out.content[0].text).toContain('"ok":false')
  })

  it('turns a thrown router error into a failed banner', async () => {
    const { tools, server } = capture()
    const router = { call: vi.fn(async () => { throw new Error('renderer gone') }) }
    registerAudioTools(server, router as any)
    const handler = tools.find((t) => t.name === 'generate_audio')!.handler

    const out = await handler({ input: 'x' })
    expect(out.content[0].text).toContain('❌ generate_audio failed: renderer gone')
  })
})
