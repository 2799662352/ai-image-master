import { describe, expect, it, vi } from 'vitest'
import type { ZodTypeAny } from 'zod'
import { registerImageTools } from '../imageTools'

type Handler = (params: Record<string, unknown>) => Promise<{ content: Array<Record<string, unknown>> }>
type Captured = {
  name: string
  config: { description: string; inputSchema: ZodTypeAny }
  handler: Handler
}

function capture(routerResult: unknown = { ok: true }): { tools: Captured[]; server: any; router: any } {
  const tools: Captured[] = []
  const server = {
    registerTool: (name: string, config: Captured['config'], handler: Handler) => {
      tools.push({ name, config, handler })
    },
  }
  const router = { call: vi.fn(async () => routerResult) }
  return { tools, server, router }
}

describe('registerImageTools / generate_image schema', () => {
  it('registers generate_image with a zod inputSchema', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const tool = tools.find((t) => t.name === 'generate_image')
    expect(tool).toBeDefined()
    expect(tool!.config.inputSchema).toBeDefined()
  })

  it('accepts the 3-axis params: prompt + ratio + resolution + quality', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const schema = tools.find((t) => t.name === 'generate_image')!.config.inputSchema
    const result = schema.safeParse({
      prompt: 'a cat',
      ratio: '16:9',
      resolution: '2K',
      quality: 'high',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a bare prompt (all else optional)', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const schema = tools.find((t) => t.name === 'generate_image')!.config.inputSchema
    expect(schema.safeParse({ prompt: 'a cat' }).success).toBe(true)
  })

  it('rejects an empty prompt', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const schema = tools.find((t) => t.name === 'generate_image')!.config.inputSchema
    expect(schema.safeParse({ prompt: '' }).success).toBe(false)
  })

  it('rejects out-of-enum resolution and quality', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const schema = tools.find((t) => t.name === 'generate_image')!.config.inputSchema
    expect(schema.safeParse({ prompt: 'x', resolution: '8K' }).success).toBe(false)
    expect(schema.safeParse({ prompt: 'x', quality: 'ultra' }).success).toBe(false)
  })

  it('emits a resource_link per saved path (codex-native generate→save→read parity)', async () => {
    const winPath = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\deadbeef.png'
    const { tools, server, router } = capture({
      ok: true,
      count: 1,
      model: 'gpt-image-2-vip',
      historyId: 42,
      paths: [winPath],
    })
    registerImageTools(server, router)
    const handler = tools.find((t) => t.name === 'generate_image')!.handler

    const { content } = await handler({ prompt: 'a cat' })

    // First block: the compact text summary (no base64).
    expect(content[0].type).toBe('text')
    expect(content[0].text).toContain('"historyId":42')
    // Second block: a resource_link pointing at the saved local file.
    const link = content.find((c) => c.type === 'resource_link')
    expect(link).toBeDefined()
    expect(link!.uri).toMatch(/^file:\/\/\//)
    expect(link!.uri).toContain('deadbeef.png')
    expect(link!.name).toBe('deadbeef.png')
    expect(link!.mimeType).toBe('image/png')
  })

  it('text banner names the saved folder, lists paths, and forbids history/fs hunts', async () => {
    const winPath = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\deadbeef.png'
    const { tools, server, router } = capture({
      ok: true,
      count: 1,
      model: 'gpt-image-2-vip',
      historyId: 42,
      paths: [winPath],
    })
    registerImageTools(server, router)
    const handler = tools.find((t) => t.name === 'generate_image')!.handler

    const { content } = await handler({ prompt: 'a cat' })
    const text = content[0].text as string

    expect(text).toContain('generate_image DONE')
    // Folder + exact file path both present in PLAIN TEXT (not only resource_link).
    expect(text).toContain('C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads')
    expect(text).toContain(winPath)
    // Steers the agent away from the slow/timeout-prone locating paths.
    expect(text).toMatch(/do not run query_history/i)
    expect(text).toMatch(/do not search the filesystem/i)
    // Machine line preserved for programmatic consumers.
    expect(text).toContain('"historyId":42')
    expect(text).toContain('"dir":')
    // Must stay tiny — Codex truncates tool results at ~10 KiB (openai/codex#6544).
    expect(text.length).toBeLessThan(2000)
  })

  it('returns only the text summary when no paths were saved', async () => {
    const { tools, server, router } = capture({ ok: true, count: 1, model: 'gpt-image-2-vip', paths: [] })
    registerImageTools(server, router)
    const handler = tools.find((t) => t.name === 'generate_image')!.handler

    const { content } = await handler({ prompt: 'a cat' })

    expect(content).toHaveLength(1)
    expect(content[0].type).toBe('text')
  })
})
