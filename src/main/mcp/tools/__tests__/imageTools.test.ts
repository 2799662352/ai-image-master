import { describe, expect, it, vi } from 'vitest'
import type { ZodTypeAny } from 'zod'
import { registerImageTools } from '../imageTools'
import { ImageTaskManager } from '../imageTaskRegistry'

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

  it('accepts the selectable model channels (vip / image2 官方 / 腾讯 / 万相 / nano2 / seedream 5.0 pro) and rejects others', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const genSchema = tools.find((t) => t.name === 'generate_image')!.config.inputSchema
    for (const model of ['gpt-image-2-vip', 'gpt-image-2', 'custom-imagemodel-gt', 'wan2.7-image-pro', 'gemini-3.1-flash-image', 'doubao-seedream-5-0-pro-260628']) {
      expect(genSchema.safeParse({ prompt: 'x', model }).success, model).toBe(true)
    }
    expect(genSchema.safeParse({ prompt: 'x', model: 'gpt-image-2-all' }).success).toBe(false)

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

  it('accepts 9–20 prompts in one batch and rejects more than 20', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const schema = tools.find((t) => t.name === 'generate_images')!.config.inputSchema

    expect(schema.safeParse({ prompts: Array.from({ length: 9 }, (_, i) => `shot ${i + 1}`) }).success).toBe(true)
    expect(schema.safeParse({ prompts: Array.from({ length: 20 }, (_, i) => `shot ${i + 1}`) }).success).toBe(true)
    expect(schema.safeParse({ prompts: Array.from({ length: 21 }, (_, i) => `shot ${i + 1}`) }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Async (broadcast-driven) handler tests
//
// The render runs in the RENDERER. Main: create task → `router.call` KICKS the
// renderer (it acks immediately) → renderer broadcasts a terminal
// `image:task-update` → main applies it. Tests simulate that renderer by having
// the mocked `router.call` settle the task (via manager.applyUpdate) on the
// `__taskId` it received — exactly the real ack→render→broadcast sequence.
// ---------------------------------------------------------------------------

type Outcome = { status: 'succeeded' | 'failed'; result?: unknown; error?: string } | null

function captureAsync(): { tools: Captured[]; server: any; manager: ImageTaskManager } {
  const tools: Captured[] = []
  const server = {
    registerTool: (name: string, config: Captured['config'], handler: Handler) => {
      tools.push({ name, config, handler })
    },
  }
  return { tools, server, manager: new ImageTaskManager() }
}

/**
 * A router whose `call` mimics the renderer: it acks instantly and (when `plan`
 * returns an outcome) broadcasts that terminal update back on the next
 * microtask. Return `null` from `plan` to leave the task "running" (forces the
 * STILL RUNNING handoff path).
 */
function autoRouter(
  manager: ImageTaskManager,
  plan: (name: string, params: Record<string, unknown>) => Outcome,
): { call: ReturnType<typeof vi.fn> } {
  return {
    call: vi.fn(async (name: string, params: Record<string, unknown>) => {
      const taskId = String(params.__taskId)
      const kind: 'single' | 'batch' = name === 'generate_images' ? 'batch' : 'single'
      const outcome = plan(name, params)
      if (outcome) queueMicrotask(() => manager.applyUpdate({ taskId, kind, ...outcome }))
      return { accepted: true, taskId }
    }),
  }
}

function getHandler(tools: Captured[], name: string): Handler {
  return tools.find((t) => t.name === name)!.handler
}

describe('generate_image (kick + budget + DONE/handoff)', () => {
  it('forwards count to the renderer generate_image call (enables wan2.7 enable_sequential)', async () => {
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => ({
      status: 'succeeded',
      result: { ok: true, count: 4, model: 'wan2.7-image-pro', paths: [] },
    }))
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 5_000 })

    await getHandler(tools, 'generate_image')({ prompt: '同一只猫的四季', model: 'wan2.7-image-pro', count: 4 })

    expect(router.call).toHaveBeenCalledWith(
      'generate_image',
      expect.objectContaining({ model: 'wan2.7-image-pro', count: 4 }),
      undefined,
    )
  })

  it('emits a resource_link per saved path (codex-native generate→save→read parity)', async () => {
    const winPath = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\deadbeef.png'
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => ({
      status: 'succeeded',
      result: { ok: true, count: 1, model: 'gpt-image-2-vip', historyId: 42, paths: [winPath] },
    }))
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 5_000 })

    const { content } = await getHandler(tools, 'generate_image')({ prompt: 'a cat' })

    expect(content[0].type).toBe('text')
    expect(content[0].text).toContain('"historyId":42')
    const link = content.find((c) => c.type === 'resource_link')
    expect(link).toBeDefined()
    expect(link!.uri).toMatch(/^file:\/\/\//)
    expect(link!.uri).toContain('deadbeef.png')
    expect(link!.name).toBe('deadbeef.png')
    expect(link!.mimeType).toBe('image/png')
  })

  it('text banner names the saved folder, lists paths, and forbids history/fs hunts', async () => {
    const winPath = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\deadbeef.png'
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => ({
      status: 'succeeded',
      result: { ok: true, count: 1, model: 'gpt-image-2-vip', historyId: 42, paths: [winPath] },
    }))
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 5_000 })

    const { content } = await getHandler(tools, 'generate_image')({ prompt: 'a cat' })
    const text = content[0].text as string

    expect(text).toContain('generate_image DONE')
    expect(text).toContain('C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads')
    expect(text).toContain(winPath)
    expect(text).toMatch(/do not run query_history/i)
    expect(text).toMatch(/do not search the filesystem/i)
    expect(text).toContain('"historyId":42')
    expect(text).toContain('"dir":')
    expect(text.length).toBeLessThan(2000)
  })

  it('returns only the text summary when no paths were saved', async () => {
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => ({
      status: 'succeeded',
      result: { ok: true, count: 1, model: 'gpt-image-2-vip', paths: [] },
    }))
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 5_000 })

    const { content } = await getHandler(tools, 'generate_image')({ prompt: 'a cat' })

    expect(content).toHaveLength(1)
    expect(content[0].type).toBe('text')
  })

  it('reports a clean DONE (not an error) when persistence is still pending in the background', async () => {
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => ({
      status: 'succeeded',
      result: { ok: true, count: 1, model: 'gpt-image-2-vip', historyId: null, paths: [], persistencePending: true },
    }))
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 5_000 })

    const { content } = await getHandler(tools, 'generate_image')({ prompt: 'a cat' })
    const text = content[0].text as string

    expect(text).toContain('generate_image DONE')
    expect(text).toMatch(/still finishing in the background/i)
    expect(text).toMatch(/do not retry/i)
    expect(text).toContain('query_history')
    expect(text).toContain('"persistencePending":true')
  })

  it('returns ✅ DONE directly when the render finishes within the budget', async () => {
    const winPath = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\fast.png'
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => ({
      status: 'succeeded',
      result: { ok: true, count: 1, model: 'gpt-image-2-vip', historyId: 7, paths: [winPath] },
    }))
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 5_000 })

    const { content } = await getHandler(tools, 'generate_image')({ prompt: 'a cat' })
    const text = content[0].text as string
    expect(text).toContain('generate_image DONE')
    expect(text).toContain(winPath)
    expect(content.find((c) => c.type === 'resource_link')).toBeDefined()
  })

  it('hands off ⏳ STILL RUNNING + taskId when the render exceeds the budget', async () => {
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => null) // renderer acks but never broadcasts
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 10 })

    const { content } = await getHandler(tools, 'generate_image')({ prompt: 'a slow cat' })
    const text = content[0].text as string
    expect(text).toContain('generate_image STILL RUNNING')
    expect(text).toMatch(/check_image_task/)
    expect(text).toMatch(/do not resubmit generate_image/i)
    const taskId = JSON.parse(text.split('\n').pop() as string).taskId as string
    expect(typeof taskId).toBe('string')
    expect(taskId.length).toBeGreaterThan(0)

    // Still running until the renderer broadcasts a terminal update.
    expect(manager.get(taskId)!.status).toBe('running')
    manager.applyUpdate({ taskId, kind: 'single', status: 'succeeded', result: { ok: true, count: 1, paths: [] } })
    expect(manager.get(taskId)!.status).toBe('succeeded')
  })

  it('throws (tool error) when the render fails within the budget', async () => {
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => ({ status: 'failed', error: 'upstream 500' }))
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 5_000 })

    await expect(getHandler(tools, 'generate_image')({ prompt: 'boom' })).rejects.toThrow('upstream 500')
  })

  it('fails the task immediately when the renderer never even acks (router.call rejects)', async () => {
    const { tools, server, manager } = captureAsync()
    const router = { call: vi.fn(async () => { throw new Error('renderer gone') }) }
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 5_000 })

    await expect(getHandler(tools, 'generate_image')({ prompt: 'x' })).rejects.toThrow('renderer gone')
  })
})

describe('generate_images (single kick + combined banner)', () => {
  it('kicks the renderer ONCE with the prompts and returns one combined DONE banner', async () => {
    const paths = [
      'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\cat-1.png',
      'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\cat-2.png',
      'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\cat-3.png',
    ]
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => ({
      status: 'succeeded',
      result: {
        successes: paths.map((p, i) => ({ ok: true, count: 1, model: 'gpt-image-2-vip', historyId: i + 10, paths: [p] })),
        failures: [],
        savedPaths: paths,
      },
    }))
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 5_000 })

    const { content } = await getHandler(tools, 'generate_images')({ prompts: ['cat one', 'cat two', 'cat three'], ratio: '1:1' })

    expect(router.call).toHaveBeenCalledTimes(1)
    expect(router.call).toHaveBeenCalledWith(
      'generate_images',
      expect.objectContaining({ prompts: ['cat one', 'cat two', 'cat three'] }),
      undefined,
    )
    const text = content[0].text as string
    expect(text).toContain('generate_images DONE — 3/3 image(s) generated')
    expect(text).toContain(paths[0])
    expect(text).toContain(paths[1])
    expect(text).toContain(paths[2])
    // 交付优先 + 上下文保护:先一句话交付,QA 需要看图时最多 1 张代表图。
    expect(text).toMatch(/send the user a one-line delivery message NOW/i)
    expect(text).toMatch(/Do NOT batch-open these files with view_image/i)
    expect(content.filter((c) => c.type === 'resource_link')).toHaveLength(3)
  })

  it('stays DONE when some saves are pending; lists available paths + notes the rest', async () => {
    const savedPath = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\cat-1.png'
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => ({
      status: 'succeeded',
      result: {
        successes: [
          { ok: true, count: 1, model: 'gpt-image-2-vip', historyId: 10, paths: [savedPath] },
          { ok: true, count: 1, model: 'gpt-image-2-vip', historyId: null, paths: [], persistencePending: true },
        ],
        failures: [],
        savedPaths: [savedPath],
      },
    }))
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 5_000 })

    const { content } = await getHandler(tools, 'generate_images')({ prompts: ['cat one', 'cat two'] })
    const text = content[0].text as string

    expect(text).toContain('generate_images DONE — 2/2 image(s) generated')
    expect(text).toContain(savedPath)
    expect(text).toMatch(/1 file save\(s\) are still finishing in the background/i)
    expect(text).toMatch(/do not retry/i)
    expect(text).not.toMatch(/Do NOT run query_history and do NOT search the filesystem/i)
  })

  it('hands off ⏳ STILL RUNNING + a batch taskId when the batch exceeds the budget', async () => {
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => null)
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 10 })

    const { content } = await getHandler(tools, 'generate_images')({ prompts: ['cat one', 'cat two'] })
    const text = content[0].text as string
    expect(text).toContain('generate_images STILL RUNNING')
    expect(text).toMatch(/check_image_task/)
    expect(text).toMatch(/do not resubmit generate_images/i)

    const taskId = JSON.parse(text.split('\n').pop() as string).taskId as string
    expect(manager.get(taskId)!.kind).toBe('batch')
    expect(manager.get(taskId)!.status).toBe('running')
  })
})

describe('check_image_task (fallback poller over the image task table)', () => {
  it('returns an unknown-task banner for an id the table never had', async () => {
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => null)
    registerImageTools(server, router as any, { manager, checkLongPollMs: 10 })
    const check = getHandler(tools, 'check_image_task')

    const { content } = await check({ taskId: 'nope-not-real' })
    const text = content[0].text as string
    expect(text).toContain('unknown taskId')
    expect(text).toContain('"status":"unknown"')
  })

  it('long-polls RUNNING while in flight, then DONE after the render settles', async () => {
    const winPath = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\slow.png'
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => null) // never auto-settles
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 10, checkLongPollMs: 10 })
    const gen = getHandler(tools, 'generate_image')
    const check = getHandler(tools, 'check_image_task')

    const handoff = await gen({ prompt: 'slow' })
    const taskId = JSON.parse((handoff.content[0].text as string).split('\n').pop() as string).taskId as string

    const running = await check({ taskId })
    expect(running.content[0].text).toContain('check_image_task — still rendering')

    // The renderer broadcasts completion → next check returns DONE + the path.
    manager.applyUpdate({
      taskId,
      kind: 'single',
      status: 'succeeded',
      result: { ok: true, count: 1, model: 'gpt-image-2-vip', historyId: 9, paths: [winPath] },
    })
    const done = await check({ taskId })
    const text = done.content[0].text as string
    expect(text).toContain('generate_image DONE')
    expect(text).toContain(winPath)
    expect(done.content.find((c) => c.type === 'resource_link')).toBeDefined()
  })

  it('returns the combined batch banner once a handed-off batch settles', async () => {
    const p1 = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\b-1.png'
    const p2 = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\b-2.png'
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => null)
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 10, checkLongPollMs: 1000 })
    const gen = getHandler(tools, 'generate_images')
    const check = getHandler(tools, 'check_image_task')

    const handoff = await gen({ prompts: ['cat one', 'cat two'] })
    const taskId = JSON.parse((handoff.content[0].text as string).split('\n').pop() as string).taskId as string

    setTimeout(
      () =>
        manager.applyUpdate({
          taskId,
          kind: 'batch',
          status: 'succeeded',
          result: {
            successes: [
              { ok: true, count: 1, model: 'gpt-image-2-vip', historyId: 11, paths: [p1] },
              { ok: true, count: 1, model: 'gpt-image-2-vip', historyId: 12, paths: [p2] },
            ],
            failures: [],
            savedPaths: [p1, p2],
          },
        }),
      5,
    )

    const { content } = await check({ taskId })
    const text = content[0].text as string
    expect(text).toContain('generate_images DONE — 2/2 image(s) generated')
    expect(text).toContain(p1)
    expect(text).toContain(p2)
    expect(content.filter((c) => c.type === 'resource_link')).toHaveLength(2)
  })

  it('returns a FAILED banner (not a throw) when the tracked render failed', async () => {
    const { tools, server, manager } = captureAsync()
    const router = autoRouter(manager, () => null)
    registerImageTools(server, router as any, { manager, blockingBudgetMs: 10, checkLongPollMs: 10 })
    const gen = getHandler(tools, 'generate_image')
    const check = getHandler(tools, 'check_image_task')

    const handoff = await gen({ prompt: 'willfail' })
    const taskId = JSON.parse((handoff.content[0].text as string).split('\n').pop() as string).taskId as string

    manager.applyUpdate({ taskId, kind: 'single', status: 'failed', error: 'content policy' })
    const { content } = await check({ taskId })
    const text = content[0].text as string
    expect(text).toContain('generate_image FAILED')
    expect(text).toContain('content policy')
    expect(text).toContain('"ok":false')
  })
})
