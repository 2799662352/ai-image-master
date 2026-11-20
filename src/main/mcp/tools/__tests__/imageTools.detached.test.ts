import { describe, expect, it, vi } from 'vitest'
import type { ZodTypeAny } from 'zod'
import { registerImageTools } from '../imageTools'
import { ImageTaskManager } from '../imageTaskRegistry'

/**
 * 游离调用(没有对话认领)的回执不能说「用户已经看到了」。
 *
 * 图照常生成、照常保存,只是不在任何对话里显示。回执要是还写着 "Already shown to the
 * user",agent 就会照着回复,用户去聊天里找一张根本不在那儿的图。真窗口验证时撞到的:
 * 游离出图的回执里一字不差地写着这句话。
 *
 * 渲染端在秒回的 ack 里带 `detached: true`,主进程记到任务上,之后每一种回执都据此改口。
 */

type Content = Array<Record<string, unknown>>
type Handler = (params: Record<string, unknown>) => Promise<{ content: Content }>
type Outcome = { status: 'succeeded'; result: unknown } | { status: 'failed'; error: string } | null

const P1 = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\one.png'
const P2 = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\two.png'

/**
 * 每一句都在声称「用户此刻在聊天里看得到它」。游离回执里一句都不许出现,
 * 不管是正文还是 resource_link 的说明。
 */
const CLAIMS_THE_USER_SEES_IT = [
  /Already shown to the user/i,
  /generated and shown to the user/i,
  /already visible in the chat/i,
  /already looking at the image/i,
  /ALREADY sees/,
  /sees its progress bubble/i,
  /The user sees the failure/i,
  /chat UI already shows/i,
  /in the app chat \+ history/i,
  /app history \+ chat/i,
  /appear there automatically/i,
  /appears there automatically/i,
  /just confirm to the user/i,
]

function everyWord(content: Content): string {
  return content.map((block) => `${block.text ?? ''}\n${block.description ?? ''}`).join('\n')
}

function expectNoFalseClaim(content: Content): void {
  const words = everyWord(content)
  for (const claim of CLAIMS_THE_USER_SEES_IT) expect(words, String(claim)).not.toMatch(claim)
}

/** 回执最后一行是给机器读的 JSON。 */
function machine(content: Content): Record<string, unknown> {
  return JSON.parse(String(content[0].text).split('\n').pop() as string) as Record<string, unknown>
}

/**
 * 模仿渲染端:秒回 ack(游离时带 `detached: true`),有结局就在下一个微任务里广播终态。
 * `plan` 返回 null = 一直在渲染(逼出 STILL RUNNING 交还)。
 */
function setup(options: { detached: boolean; plan: () => Outcome; budgetMs?: number }) {
  const tools: Array<{ name: string; config: { inputSchema: ZodTypeAny }; handler: Handler }> = []
  const server = {
    registerTool: (name: string, config: { inputSchema: ZodTypeAny }, handler: Handler) => {
      tools.push({ name, config, handler })
    },
  }
  const manager = new ImageTaskManager()
  const router = {
    call: vi.fn(async (name: string, params: Record<string, unknown>) => {
      const taskId = String(params.__taskId)
      const kind: 'single' | 'batch' = name === 'generate_images' ? 'batch' : 'single'
      const outcome = options.plan()
      if (outcome) queueMicrotask(() => manager.applyUpdate({ taskId, kind, ...outcome }))
      return { accepted: true, taskId, ...(options.detached ? { detached: true } : {}) }
    }),
  }
  registerImageTools(server as never, router as never, {
    manager,
    blockingBudgetMs: options.budgetMs ?? 5_000,
    checkLongPollMs: 10,
  })
  const run = (name: string, params: Record<string, unknown>) =>
    tools.find((tool) => tool.name === name)!.handler(params)
  return { run, manager }
}

const saved = (paths: string[]): Outcome => ({
  status: 'succeeded',
  result: { ok: true, count: paths.length || 1, model: 'gpt-image-2-vip', historyId: 7, paths },
})

describe('generate_image:游离调用的回执说实话', () => {
  it('存好了:说「没有在任何对话里显示」,路径照给,不催 agent「告诉用户图在聊天里」', async () => {
    const { run } = setup({ detached: true, plan: () => saved([P1]) })
    const { content } = await run('generate_image', { prompt: 'stray' })
    const text = String(content[0].text)

    expect(text).toContain('generate_image DONE — 1 image(s) saved. NOT shown in any chat')
    expect(text).toContain('belongs to no chat in the app')
    expect(text).toContain('Do NOT say the image is visible in the chat')
    expectNoFalseClaim(content)
    // 游离不改变「活干完了」这件事:路径、别重试、别批量看图都还在。
    expect(text).toContain(P1)
    expect(text).toMatch(/do NOT retry or re-generate/)
    expect(text).toMatch(/Do NOT batch-open these files with view_image/)
    expect(machine(content)).toMatchObject({ ok: true, paths: [P1], shownInChat: false })
    expect(content.find((block) => block.type === 'resource_link')).toMatchObject({
      description: 'Generated image saved locally (also in app history; not shown in any chat).',
    })
  })

  it('对照:有主的调用一个字都没变', async () => {
    const { run } = setup({ detached: false, plan: () => saved([P1]) })
    const { content } = await run('generate_image', { prompt: 'owned' })
    const text = String(content[0].text)

    expect(text).toContain('generate_image DONE — 1 image(s) saved. Already shown to the user.')
    expect(text).toContain('the image is already visible in the chat')
    expect(text).not.toContain('NOT shown in any chat')
    expect(machine(content)).not.toHaveProperty('shownInChat')
    expect(content.find((block) => block.type === 'resource_link')).toMatchObject({
      description: 'Generated image saved locally (also in app history + chat).',
    })
  })

  it('没拿到本地路径:说图只在历史记录里,不说「在聊天 + 历史里」', async () => {
    const { run } = setup({ detached: true, plan: () => saved([]) })
    const { content } = await run('generate_image', { prompt: 'stray' })
    const text = String(content[0].text)

    expect(text).toContain('generate_image DONE — 1 image(s) generated. NOT shown in any chat')
    expect(text).toContain('the image is in the app history page only')
    expectNoFalseClaim(content)
    expect(machine(content)).toMatchObject({ shownInChat: false })
  })

  it('保存还在后台:同样不说「已展示给用户」', async () => {
    const { run } = setup({
      detached: true,
      plan: () => ({
        status: 'succeeded',
        result: { ok: true, count: 1, model: 'm', historyId: null, paths: [], persistencePending: true },
      }),
    })
    const { content } = await run('generate_image', { prompt: 'stray' })
    const text = String(content[0].text)

    expect(text).toContain('generate_image DONE — 1 image(s) generated. NOT shown in any chat')
    expect(text).toContain('Local file save is still finishing in the background')
    expect(text).toContain('Treat this generation as COMPLETE')
    expectNoFalseClaim(content)
    expect(machine(content)).toMatchObject({ persistencePending: true, shownInChat: false })
  })

  it('超出预算交还 taskId:不说「用户已经看到生成中气泡」;之后 check 到的每一种状态也都不说', async () => {
    const { run, manager } = setup({ detached: true, plan: () => null, budgetMs: 10 })

    const handoff = await run('generate_image', { prompt: 'slow stray' })
    const handoffText = String(handoff.content[0].text)
    expect(handoffText).toContain('generate_image STILL RUNNING')
    expect(handoffText).toContain('no chat shows a "generating" bubble for it')
    expect(handoffText).toMatch(/check_image_task/)
    expectNoFalseClaim(handoff.content)
    const taskId = String(machine(handoff.content).taskId)

    const running = await run('check_image_task', { taskId })
    expect(String(running.content[0].text)).toContain('check_image_task — still rendering')
    expect(String(running.content[0].text)).toContain('no chat shows its progress')
    expectNoFalseClaim(running.content)

    manager.applyUpdate({ taskId, kind: 'single', status: 'succeeded', result: { ok: true, count: 1, paths: [P1] } })
    const done = await run('check_image_task', { taskId })
    expect(String(done.content[0].text)).toContain('generate_image DONE — 1 image(s) saved. NOT shown in any chat')
    expect(String(done.content[0].text)).toContain(P1)
    expectNoFalseClaim(done.content)
  })

  it('交还之后失败了:说「没有对话显示这次失败,你自己报」,不说「用户在聊天里看到了失败」', async () => {
    const { run, manager } = setup({ detached: true, plan: () => null, budgetMs: 10 })
    const handoff = await run('generate_image', { prompt: 'will fail' })
    const taskId = String(machine(handoff.content).taskId)

    manager.applyUpdate({ taskId, kind: 'single', status: 'failed', error: 'content policy' })
    const failed = await run('check_image_task', { taskId })
    const text = String(failed.content[0].text)

    expect(text).toContain('generate_image FAILED — content policy')
    expect(text).toContain('No chat shows this failure')
    expect(text).toContain('report the error in your reply')
    expectNoFalseClaim(failed.content)
  })

  it('对照:有主的交还 / 轮询 / 失败照旧说气泡在聊天里', async () => {
    const { run, manager } = setup({ detached: false, plan: () => null, budgetMs: 10 })
    const handoff = await run('generate_image', { prompt: 'slow owned' })
    expect(String(handoff.content[0].text)).toContain('the user ALREADY sees a live "generating" bubble in the chat')
    const taskId = String(machine(handoff.content).taskId)

    const running = await run('check_image_task', { taskId })
    expect(String(running.content[0].text)).toContain('the user sees its progress bubble')

    manager.applyUpdate({ taskId, kind: 'single', status: 'failed', error: 'content policy' })
    const failed = await run('check_image_task', { taskId })
    expect(String(failed.content[0].text)).toContain('The user sees the failure in the chat.')
  })

  it('只认 ack 里明确的 detached: true —— 别的形状一律按有主处理', async () => {
    for (const ack of [{ accepted: true, detached: 'yes' }, { accepted: true, detached: 1 }, null, 'ok', undefined]) {
      const tools: Array<{ name: string; handler: Handler }> = []
      const server = { registerTool: (name: string, _config: unknown, handler: Handler) => { tools.push({ name, handler }) } }
      const manager = new ImageTaskManager()
      const router = {
        call: vi.fn(async (_name: string, params: Record<string, unknown>) => {
          queueMicrotask(() => manager.applyUpdate({ taskId: String(params.__taskId), kind: 'single', ...saved([P1])! }))
          return ack
        }),
      }
      registerImageTools(server as never, router as never, { manager, blockingBudgetMs: 5_000 })
      const { content } = await tools.find((tool) => tool.name === 'generate_image')!.handler({ prompt: 'x' })
      expect(String(content[0].text), JSON.stringify(ack)).toContain('Already shown to the user.')
    }
  })
})

describe('generate_images:游离调用的回执说实话', () => {
  const batch = (failures: Array<{ index: number; error: string }> = []): Outcome => ({
    status: 'succeeded',
    result: {
      successes: [
        { ok: true, count: 1, model: 'm', historyId: 1, paths: [P1] },
        ...(failures.length === 0 ? [{ ok: true, count: 1, model: 'm', historyId: 2, paths: [P2] }] : []),
      ],
      failures,
      savedPaths: failures.length === 0 ? [P1, P2] : [P1],
    },
  })

  it('整批成功:说「没有在任何对话里显示」,路径照给', async () => {
    const { run } = setup({ detached: true, plan: () => batch() })
    const { content } = await run('generate_images', { prompts: ['a', 'b'] })
    const text = String(content[0].text)

    expect(text).toContain('generate_images DONE — 2/2 image(s) generated. NOT shown in any chat')
    expect(text).toContain(P1)
    expect(text).toContain(P2)
    expect(text).toContain('Do NOT say the image is visible in the chat')
    expectNoFalseClaim(content)
    expect(machine(content)).toMatchObject({ ok: true, count: 2, shownInChat: false })
    const links = content.filter((block) => block.type === 'resource_link')
    expect(links).toHaveLength(2)
    for (const link of links) expect(link.description).toContain('not shown in any chat')
  })

  it('部分失败:不说「聊天里已经显示了成功的那几张」', async () => {
    const { run } = setup({ detached: true, plan: () => batch([{ index: 1, error: 'upstream 500' }]) })
    const { content } = await run('generate_images', { prompts: ['a', 'b'] })
    const text = String(content[0].text)

    expect(text).toContain('generate_images PARTIAL/FAILED — 1 succeeded, 1 failed.')
    expect(text).toContain('Neither the successful image(s) nor the failures are shown in any chat')
    expect(text).toContain(P1)
    expect(text).toContain('upstream 500')
    expectNoFalseClaim(content)
    expect(machine(content)).toMatchObject({ ok: false, successCount: 1, failureCount: 1, shownInChat: false })
  })

  it('超出预算交还:不说「用户已经看到一排生成中气泡」;轮询到完成也不说', async () => {
    const { run, manager } = setup({ detached: true, plan: () => null, budgetMs: 10 })
    const handoff = await run('generate_images', { prompts: ['a', 'b'] })
    const text = String(handoff.content[0].text)
    expect(text).toContain('generate_images STILL RUNNING')
    expect(text).toContain('no chat shows "generating" bubbles for it')
    expectNoFalseClaim(handoff.content)

    const taskId = String(machine(handoff.content).taskId)
    manager.applyUpdate({ taskId, kind: 'batch', ...batch()! })
    const done = await run('check_image_task', { taskId })
    expect(String(done.content[0].text)).toContain('generate_images DONE — 2/2 image(s) generated. NOT shown in any chat')
    expectNoFalseClaim(done.content)
  })

  it('对照:有主的批量照旧', async () => {
    const owned = setup({ detached: false, plan: () => batch() })
    const done = await owned.run('generate_images', { prompts: ['a', 'b'] })
    expect(String(done.content[0].text)).toContain('generate_images DONE — 2/2 image(s) generated. Already shown to the user.')
    expect(machine(done.content)).not.toHaveProperty('shownInChat')

    const partial = setup({ detached: false, plan: () => batch([{ index: 1, error: 'upstream 500' }]) })
    const failed = await partial.run('generate_images', { prompts: ['a', 'b'] })
    expect(String(failed.content[0].text)).toContain('The chat UI already shows any successful image(s).')
    expect(machine(failed.content)).not.toHaveProperty('shownInChat')

    const slow = setup({ detached: false, plan: () => null, budgetMs: 10 })
    const handoff = await slow.run('generate_images', { prompts: ['a', 'b'] })
    expect(String(handoff.content[0].text)).toContain('the user ALREADY sees live "generating" bubbles in the chat')
  })
})
