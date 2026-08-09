import { describe, expect, it, vi } from 'vitest'
import type { ZodTypeAny } from 'zod'
import {
  registerVideoTools,
  buildBudgetExhaustedBanner,
  buildRunningBanner,
  buildDoneBanner,
  buildFailedBanner,
  buildUnknownTaskBanner,
  GENERATE_BLOCKING_BUDGET_MS,
} from '../videoTools'
import type { SeedanceTaskState } from '../../../services/seedance/types'

type Handler = (
  params: Record<string, unknown>,
  ctx?: unknown,
) => Promise<{ content: Array<Record<string, unknown>> }>
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

function makeTask(patch: Partial<SeedanceTaskState> = {}): SeedanceTaskState {
  return {
    taskId: 'cgt-123',
    prompt: '一只猫在雨里跳舞',
    model: '2.0-fast',
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    status: 'queued',
    createdAt: Date.now() - 30_000,
    updatedAt: Date.now(),
    persistence: 'idle',
    ...patch,
  }
}

describe('registerVideoTools / schemas', () => {
  it('registers generate_video and check_video_task', () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    expect(tools.map((t) => t.name)).toEqual(['generate_video', 'check_video_task'])
  })

  it('first blocking window is short (~75s) so turn/steer interjection stays responsive', () => {
    // The model cannot process queued turn/steer input while blocked inside this
    // tool call, so the first window must be short — it hands back a taskId and
    // lets check_video_task (~25s long-poll) drive the rest. Guards against a
    // regression back to the old 10-minute budget.
    expect(GENERATE_BLOCKING_BUDGET_MS).toBeGreaterThanOrEqual(45_000)
    expect(GENERATE_BLOCKING_BUDGET_MS).toBeLessThanOrEqual(90_000)
  })

  it('generate_video accepts a bare prompt', () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const schema = tools[0].config.inputSchema
    expect(schema.safeParse({ prompt: '猫跳舞' }).success).toBe(true)
  })

  it('generate_video rejects empty prompt / bad duration / bad resolution', () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const schema = tools[0].config.inputSchema
    expect(schema.safeParse({ prompt: '' }).success).toBe(false)
    // duration 现在是朴素整数区间 [-1, 30]，不再是 union([literal(-1), int().min(4)])。
    // 换掉的原因:union 转成 JSON Schema 是 anyOf，客户端校验器对它支持参差 —— 实测
    // 有客户端拿它校验合法的 -1 直接判失败，请求根本发不出来。工具 schema 是给别人的
    // 校验器吃的，越朴素越可移植。
    expect(schema.safeParse({ prompt: 'x', duration: -1 }).success).toBe(true)
    // 代价:0–3 在 schema 层放行，由 validateSeedanceRequest 按模型分档拦（它本来就要
    // 管 4–15 / 4–30 的差别，schema 这层从来就管不全）。
    expect(schema.safeParse({ prompt: 'x', duration: 3 }).success).toBe(true)
    expect(schema.safeParse({ prompt: 'x', duration: -2 }).success).toBe(false)
    // schema 放到全模型最宽的 4–30（2.5 需要）；按模型收窄由 validateSeedanceRequest
    // 在 handler 里做，所以 16 在这一层是合法的、31 才越界。
    expect(schema.safeParse({ prompt: 'x', duration: 16 }).success).toBe(true)
    expect(schema.safeParse({ prompt: 'x', duration: 31 }).success).toBe(false)
    expect(schema.safeParse({ prompt: 'x', duration: 15 }).success).toBe(true)
    expect(schema.safeParse({ prompt: 'x', resolution: '4K' }).success).toBe(false)
  })

  it('generate_video handler rejects 1080p on 2.0-fast without calling upstream', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const res = await tools[0].handler({ prompt: 'x', model: '2.0-fast', resolution: '1080p' })
    expect(router.call).not.toHaveBeenCalled()
    expect((res.content[0] as { text: string }).text).toContain('1080p')
  })

  it('generate_video handler rejects 16s on 2.0 but allows it on 2.5', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const tooLong = await tools[0].handler({ prompt: 'x', model: '2.0', duration: 16 })
    expect(router.call).not.toHaveBeenCalled()
    expect((tooLong.content[0] as { text: string }).text).toContain('4-15')

    await tools[0].handler({ prompt: 'x', model: '2.5', duration: 30 })
    expect(router.call).toHaveBeenCalled()
  })

  it('generate_video handler rejects taskMode without a reference video', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const res = await tools[0].handler({ prompt: 'x', model: '2.5', taskMode: 'edit', duration: -1 })
    expect(router.call).not.toHaveBeenCalled()
    expect((res.content[0] as { text: string }).text).toContain('视频')
  })

  it('generate_video blocks until succeeded and returns DONE + saved path + resource_link', async () => {
    const { tools, server, router } = capture()
    // 第 1 次 call = 提交（返回 queued 任务）；后续 = check_video_task 轮询。
    router.call
      .mockResolvedValueOnce(makeTask())
      .mockResolvedValueOnce({ found: true, task: makeTask({ status: 'running' }) })
      .mockResolvedValueOnce({
        found: true,
        task: makeTask({ status: 'succeeded', persistence: 'done', localPath: 'D:/save/v.mp4', videoUrl: 'https://cdn/v.mp4' }),
      })
    registerVideoTools(server, router)
    const res = await tools[0].handler({ prompt: '猫跳舞' })
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('DONE')
    expect(text).toContain('D:/save/v.mp4')
    // 交付优先:DONE banner 必须要求先给用户一句话交付,再做任何 QA。
    expect(text).toMatch(/send the user a one-line delivery message NOW/i)
    expect((res.content[1] as { type: string; mimeType: string }).type).toBe('resource_link')
    // 提交 1 次 + 轮询 2 次,全部走 router
    expect(router.call).toHaveBeenCalledTimes(3)
    expect(router.call.mock.calls[0][0]).toBe('generate_video')
    expect(router.call.mock.calls[1][0]).toBe('check_video_task')
  })

  it('generate_video blocks until failed and returns the failure banner', async () => {
    const { tools, server, router } = capture()
    router.call
      .mockResolvedValueOnce(makeTask())
      .mockResolvedValueOnce({
        found: true,
        task: makeTask({ status: 'failed', error: 'OutputVideoSensitive: 审核未通过' }),
      })
    registerVideoTools(server, router)
    const res = await tools[0].handler({ prompt: '猫跳舞' })
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('FAILED')
    expect(text).toContain('OutputVideoSensitive')
  })

  it('generate_video handler maps SEEDANCE_KEY_MISSING to settings guidance', async () => {
    const { tools, server, router } = capture()
    router.call.mockRejectedValueOnce(new Error('SEEDANCE_KEY_MISSING'))
    registerVideoTools(server, router)
    const res = await tools[0].handler({ prompt: 'x' })
    expect((res.content[0] as { text: string }).text).toContain('Seedance 视频生成')
  })

  it('check_video_task succeeded with localPath attaches a video resource_link', async () => {
    const task = makeTask({ status: 'succeeded', persistence: 'done', localPath: 'D:/save/v.mp4', videoUrl: 'https://cdn/v.mp4' })
    const { tools, server, router } = capture({ found: true, task })
    registerVideoTools(server, router)
    const res = await tools[1].handler({ taskId: 'cgt-123' })
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('DONE')
    expect(text).toContain('D:/save/v.mp4')
    expect(text).toContain('do NOT call check_video_task again')
    const link = res.content[1] as { type: string; mimeType: string }
    expect(link.type).toBe('resource_link')
    expect(link.mimeType).toBe('video/mp4')
  })

  it('check_video_task unknown taskId returns explicit guidance', async () => {
    const { tools, server, router } = capture({ found: false })
    registerVideoTools(server, router)
    const res = await tools[1].handler({ taskId: 'nope' })
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('unknown taskId')
    expect(text).toContain('generate_video')
  })
})

describe('video banners', () => {
  it('budget-exhausted banner hands off to check_video_task with machine JSON', () => {
    const text = buildBudgetExhaustedBanner(makeTask({ status: 'running' }))
    expect(text).toContain('STILL RUNNING')
    expect(text).toContain('check_video_task')
    expect(text).toContain('Do NOT resubmit')
    expect(JSON.parse(text.split('\n').at(-1)!)).toMatchObject({ taskId: 'cgt-123', status: 'running' })
  })

  it('running banner shows elapsed seconds and re-poll instruction', () => {
    const text = buildRunningBanner(makeTask({ status: 'running' }))
    expect(text).toContain('running')
    expect(text).toMatch(/Elapsed: \d+s/)
    expect(text).toContain('check_video_task again')
  })

  it('done banner: persistence pending → COMPLETE + persistencePending hint', () => {
    const text = buildDoneBanner(makeTask({ status: 'succeeded', persistence: 'running', videoUrl: 'https://cdn/v.mp4' }))
    expect(text).toContain('DONE')
    expect(text).toContain('persistencePending')
    expect(text).toContain('do NOT retry')
  })

  it('done banner: persistence failed → video fine, save failed, remote URL fallback', () => {
    const text = buildDoneBanner(makeTask({ status: 'succeeded', persistence: 'failed', videoUrl: 'https://cdn/v.mp4' }))
    expect(text).toContain('local file save FAILED')
    expect(text).toContain('https://cdn/v.mp4')
  })

  it('failed banner carries upstream error', () => {
    const text = buildFailedBanner(makeTask({ status: 'failed', error: 'OutputVideoSensitive: 审核未通过' }))
    expect(text).toContain('FAILED')
    expect(text).toContain('OutputVideoSensitive')
  })

  it('unknown banner tells codex to resubmit instead of re-checking', () => {
    const text = buildUnknownTaskBanner('cgt-x')
    expect(text).toContain('cgt-x')
    expect(text).toContain('NEW generate_video')
  })
})
