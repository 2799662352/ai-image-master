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

  it('accepts every gpt-image-2-vip ratio exposed by the UI dropdown', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const schema = tools.find((t) => t.name === 'generate_image')!.config.inputSchema
    const ratios = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:4', '4:5']
    for (const ratio of ratios) {
      expect(schema.safeParse({ prompt: 'a cat', ratio }).success, ratio).toBe(true)
    }
  })

  it('rejects ratios outside the gpt-image-2-vip UI dropdown', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const schema = tools.find((t) => t.name === 'generate_image')!.config.inputSchema
    expect(schema.safeParse({ prompt: 'a cat', ratio: '2:1' }).success).toBe(false)
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

  it('accepts the selectable model channels (vip / 腾讯 / 万相) and rejects others', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const genSchema = tools.find((t) => t.name === 'generate_image')!.config.inputSchema
    for (const model of ['gpt-image-2-vip', 'custom-imagemodel-gt', 'wan2.7-image-pro']) {
      expect(genSchema.safeParse({ prompt: 'x', model }).success, model).toBe(true)
    }
    expect(genSchema.safeParse({ prompt: 'x', model: 'gpt-image-2' }).success).toBe(false)

    const batchSchema = tools.find((t) => t.name === 'generate_images')!.config.inputSchema
    expect(batchSchema.safeParse({ prompts: ['a', 'b'], model: 'wan2.7-image-pro' }).success).toBe(true)
    expect(batchSchema.safeParse({ prompts: ['a', 'b'], model: 'nope' }).success).toBe(false)
  })

  it('accepts count 1–12 for wan2.7 组图 and rejects out-of-range / non-int', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const schema = tools.find((t) => t.name === 'generate_image')!.config.inputSchema
    expect(schema.safeParse({ prompt: 'x', model: 'wan2.7-image-pro', count: 1 }).success).toBe(true)
    expect(schema.safeParse({ prompt: 'x', model: 'wan2.7-image-pro', count: 12 }).success).toBe(true)
    expect(schema.safeParse({ prompt: 'x', count: 0 }).success).toBe(false)
    expect(schema.safeParse({ prompt: 'x', count: 13 }).success).toBe(false)
    expect(schema.safeParse({ prompt: 'x', count: 2.5 }).success).toBe(false)
  })

  it('forwards count to the renderer generate_image call (enables wan2.7 enable_sequential)', async () => {
    const { tools, server, router } = capture({ ok: true, count: 4, model: 'wan2.7-image-pro', paths: [] })
    registerImageTools(server, router)
    const handler = tools.find((t) => t.name === 'generate_image')!.handler

    await handler({ prompt: '同一只猫的四季', model: 'wan2.7-image-pro', count: 4 })

    expect(router.call).toHaveBeenCalledWith(
      'generate_image',
      expect.objectContaining({ model: 'wan2.7-image-pro', count: 4 }),
      undefined,
    )
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

  it('reports a clean DONE (not an error) when persistence is still pending in the background', async () => {
    // Renderer hit its persistence budget: image rendered + shown, but
    // history/file save still settling. Success = generation; the banner must
    // say COMPLETE, forbid retries, and point at query_history for later.
    const { tools, server, router } = capture({
      ok: true,
      count: 1,
      model: 'gpt-image-2-vip',
      historyId: null,
      paths: [],
      persistencePending: true,
    })
    registerImageTools(server, router)
    const handler = tools.find((t) => t.name === 'generate_image')!.handler

    const { content } = await handler({ prompt: 'a cat' })
    const text = content[0].text as string

    expect(text).toContain('generate_image DONE')
    expect(text).toMatch(/still finishing in the background/i)
    expect(text).toMatch(/do not retry/i)
    expect(text).toContain('query_history')
    expect(text).toContain('"persistencePending":true')
  })

  it('registers generate_images for batch image fan-out', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const tool = tools.find((t) => t.name === 'generate_images')
    expect(tool).toBeDefined()
    expect(tool!.config.inputSchema.safeParse({
      prompts: ['cat one', 'cat two'],
      ratio: '21:9',
      resolution: '2K',
      quality: 'high',
    }).success).toBe(true)
  })

  it('generate_images fans out one renderer call per prompt concurrently and returns one combined DONE banner', async () => {
    const paths = [
      'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\cat-1.png',
      'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\cat-2.png',
      'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\cat-3.png',
    ]
    let inFlight = 0
    let maxInFlight = 0
    const { tools, server, router } = capture()
    router.call = vi.fn(async (_name: string, params: Record<string, unknown>) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      const idx = Number(params.__batchIndex) - 1
      return { ok: true, count: 1, model: 'gpt-image-2-vip', historyId: idx + 10, paths: [paths[idx]] }
    })
    registerImageTools(server, router)
    const handler = tools.find((t) => t.name === 'generate_images')!.handler

    const { content } = await handler({ prompts: ['cat one', 'cat two', 'cat three'], ratio: '1:1' })

    expect(router.call).toHaveBeenCalledTimes(3)
    expect(maxInFlight).toBeGreaterThan(1)
    const text = content[0].text as string
    expect(text).toContain('generate_images DONE — 3/3 image(s) generated')
    expect(text).toContain(paths[0])
    expect(text).toContain(paths[1])
    expect(text).toContain(paths[2])
    expect(text).toMatch(/Do NOT open these files with view_image/i)
    expect(content.filter((c) => c.type === 'resource_link')).toHaveLength(3)
  })

  it('generate_images stays DONE when some saves are pending; lists available paths + notes the rest', async () => {
    const savedPath = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\cat-1.png'
    const { tools, server, router } = capture()
    router.call = vi.fn(async (_name: string, params: Record<string, unknown>) => {
      const idx = Number(params.__batchIndex)
      return idx === 1
        ? { ok: true, count: 1, model: 'gpt-image-2-vip', historyId: 10, paths: [savedPath] }
        : { ok: true, count: 1, model: 'gpt-image-2-vip', historyId: null, paths: [], persistencePending: true }
    })
    registerImageTools(server, router)
    const handler = tools.find((t) => t.name === 'generate_images')!.handler

    const { content } = await handler({ prompts: ['cat one', 'cat two'] })
    const text = content[0].text as string

    // Generation succeeded for both → DONE, never PARTIAL/FAILED.
    expect(text).toContain('generate_images DONE — 2/2 image(s) generated')
    expect(text).toContain(savedPath)
    expect(text).toMatch(/1 file save\(s\) are still finishing in the background/i)
    expect(text).toMatch(/do not retry/i)
    // The blanket "never query_history" line is dropped when paths are incomplete.
    expect(text).not.toMatch(/Do NOT run query_history and do NOT search the filesystem/i)
  })
})
