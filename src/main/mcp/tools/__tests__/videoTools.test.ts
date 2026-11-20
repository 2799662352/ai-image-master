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
import { ALL_VIDEO_MODEL_ALIASES } from '../../../../types/seedance'
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
    // 有主的调用(绝大多数):任务挂在发起它的对话上,渲染端在那个对话里开气泡。
    // 游离的(`threadId: undefined`)见文件末尾那一组。
    threadId: 'thread-1',
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
  it('registers generate_video, finalize_video_draft and check_video_task', () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    expect(tools.map((t) => t.name)).toEqual(['generate_video', 'finalize_video_draft', 'check_video_task'])
  })

  it('finalize_video_draft 走 generate_video 同一条主进程链路,只带样片任务号', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const call = vi.mocked(router.call)
    call.mockImplementation(async (name: string) =>
      name === 'generate_video'
        ? { taskId: 'task_final', status: 'queued' }
        : { found: true, task: { taskId: 'task_final', status: 'failed', error: 'x' } },
    )
    await tools.find((t) => t.name === 'finalize_video_draft')!.handler({ taskId: ' task_draft ' }, undefined)
    expect(call).toHaveBeenCalledWith(
      'generate_video',
      { prompt: '由样片生成成片', model: '2.5', fromDraftTaskId: 'task_draft' },
      undefined,
    )
  })

  /**
   * Roneyun-cn 的 2.5 样片:成片必须发给样片所在的渠道。写死 `model:'2.5'` 的话,成片会按火山去找
   * 一条 Roneyun 的样片,网关答 `task_origin_not_exist`。
   *
   * 🧬 变异点:把 `model === 'cn-seedance-2.5' ? … : '2.5'` 改回写死 '2.5',这条必红;
   * 把条件改成「任何 model 原样转发」,下一条(拒绝别的模型)必红。
   */
  it('finalize_video_draft 带 model:cn-seedance-2.5 → 成片发给 cn-seedance-2.5;别的值一律按 2.5', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const call = vi.mocked(router.call)
    call.mockImplementation(async (name: string) =>
      name === 'generate_video'
        ? { taskId: 'task_final', status: 'queued' }
        : { found: true, task: { taskId: 'task_final', status: 'failed', error: 'x' } },
    )
    const finalize = tools.find((t) => t.name === 'finalize_video_draft')!
    await finalize.handler({ taskId: 'task_cn_draft', model: 'cn-seedance-2.5' }, undefined)
    expect(call).toHaveBeenCalledWith(
      'generate_video',
      { prompt: '由样片生成成片', model: 'cn-seedance-2.5', fromDraftTaskId: 'task_cn_draft' },
      undefined,
    )
    call.mockClear()
    await finalize.handler({ taskId: 'task_d2', model: '2.0' }, undefined)
    expect(call).toHaveBeenCalledWith(
      'generate_video',
      { prompt: '由样片生成成片', model: '2.5', fromDraftTaskId: 'task_d2' },
      undefined,
    )
  })

  it('finalize_video_draft 的模型参数只收 2.5 与 cn-seedance-2.5(样片只有 2.5 家族有)', () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const schema = tools.find((t) => t.name === 'finalize_video_draft')!.config.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean }
    }
    expect(schema.safeParse({ taskId: 't', model: 'cn-seedance-2.5' }).success).toBe(true)
    expect(schema.safeParse({ taskId: 't', model: '2.5' }).success).toBe(true)
    expect(schema.safeParse({ taskId: 't' }).success).toBe(true)
    expect(schema.safeParse({ taskId: 't', model: 'cn-seedance-2.0-mini' }).success).toBe(false)
    expect(schema.safeParse({ taskId: 't', model: '2.5-flash' }).success).toBe(false)
  })

  describe('4K 只能由用户本人二次确认,AI 的调用一律挡下', () => {
    it('generate_video 要 4K(任何模型)→ 不调主进程,回执写明要用户确认', async () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      for (const model of ['2.0', '2.5']) {
        const res = await tools.find((t) => t.name === 'generate_video')!.handler(
          { prompt: 'x', model, resolution: '4k' },
          undefined,
        )
        const text = JSON.stringify(res)
        expect(text, model).toContain('二次确认')
        expect(text, model).toContain('用户')
      }
      expect(router.call).not.toHaveBeenCalled()
    })

    it('大小写 / 空白变体绕不过去(zod 之外的直接调用也不会被转发)', async () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      for (const resolution of [' 4K ', '4K', ' 4k']) {
        await tools.find((t) => t.name === 'generate_video')!.handler(
          { prompt: 'x', model: '2.0', resolution },
          undefined,
        )
      }
      expect(router.call).not.toHaveBeenCalled()
    })

    it('样片固定 480p,不受影响', async () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      router.call.mockResolvedValue({ taskId: 'task_d', status: 'queued' })
      await tools.find((t) => t.name === 'generate_video')!.handler(
        { prompt: 'x', model: '2.5', draft: true, resolution: '4k' },
        undefined,
      )
      expect(router.call).toHaveBeenCalled()
    })

    it('finalize_video_draft 没有任何分辨率参数 —— AI 只能出默认的 1080p 成片', () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      const shape = (tools.find((t) => t.name === 'finalize_video_draft')!.config.inputSchema as unknown as {
        shape: Record<string, unknown>
      }).shape
      // `model` 只是在 2.5 / cn-seedance-2.5 之间选渠道,不是分辨率。
      expect(Object.keys(shape)).toEqual(['taskId', 'model'])
    })

    it('finalize_video_draft 即使被塞了 finalResolution 也不转发给主进程', async () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      router.call.mockResolvedValue({ taskId: 'task_final', status: 'queued' })
      await tools.find((t) => t.name === 'finalize_video_draft')!.handler(
        { taskId: 'task_draft', finalResolution: '4k', resolution: '4k' },
        undefined,
      )
      expect(router.call).toHaveBeenCalledWith(
        'generate_video',
        { prompt: '由样片生成成片', model: '2.5', fromDraftTaskId: 'task_draft' },
        undefined,
      )
    })
  })

  it('generate_video 的 draft 只给 2.5', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const res = await tools.find((t) => t.name === 'generate_video')!.handler(
      { prompt: 'x', model: '2.0', draft: true },
      undefined,
    )
    expect(JSON.stringify(res)).toContain('Seedance \\"2.5\\" only')
    expect(router.call).not.toHaveBeenCalled()
  })

  /**
   * Roneyun-cn 的 2.0 三档没有样片(`cn-seedance-2.0-mini` 带 draft 上游回 400「draft is not supported」,
   * 2026-11-18 实测),在本机拦下,agent 才能拿到一句可操作的话,而不是一个网关错误。
   * `cn-seedance-2.5` 则与 2.5 一样放行(网关 2026-11-18 起透传 draft)。
   *
   * 🧬 变异点:把能力表里 `cn-seedance-2.0-mini` 的 `draft` 改成 true,第一条必红;
   * 把 `cn-seedance-2.5` 的改回 false,第二条必红。
   */
  it('generate_video 的 draft 不给 Roneyun-cn 的 2.0 三档', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    for (const model of ['cn-seedance-2.0', 'cn-seedance-2.0-fast', 'cn-seedance-2.0-mini']) {
      const res = await tools.find((t) => t.name === 'generate_video')!.handler(
        { prompt: 'x', model, draft: true },
        undefined,
      )
      expect(JSON.stringify(res), model).toContain('Seedance \\"2.5\\" only')
    }
    expect(router.call).not.toHaveBeenCalled()
  })

  it('generate_video 的 draft 放行 Roneyun-cn 的 2.5(与 2.5 一致)', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    router.call.mockResolvedValue({ taskId: 'task_cn_d', status: 'queued' })
    await tools.find((t) => t.name === 'generate_video')!.handler(
      { prompt: 'x', model: 'cn-seedance-2.5', draft: true },
      undefined,
    )
    expect(router.call).toHaveBeenCalled()
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

  /**
   * 每个可选模型都必须在 `model` 的 describe 里被提到。
   *
   * ## 为什么这条会漏,以及漏了会怎样
   *
   * 枚举是从能力表**自动派生**的(`ALL_VIDEO_MODEL_ALIASES`),所以加一个模型别名
   * 立刻就能被传进来 —— 而那段人话描述是**手写**的。两者不同步时,schema 层一切
   * 正常、类型检查一切正常、测试一切正常,唯一的症状是 **agent 不知道这个模型
   * 存在**:它照着描述选型,永远选不到没写进去的那个;万一选了,也不知道它的约束。
   *
   * 2026-08-31 加 `wan3-prime` 时正是这么漏的 —— 派生的枚举自动带上了它,两个
   * MCP 工具的描述里却一个字都没有。
   *
   * 只查「名字出现过」而不查措辞:描述该怎么写是人的判断,这里只保证**没有模型
   * 被忘掉**。
   */
  it('每个可选模型都在 model 描述里被提到 —— 枚举自动派生,描述是手写的', () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const shape = (tools[0].config.inputSchema as unknown as {
      shape: Record<string, { description?: string }>
    }).shape
    const desc = shape.model?.description ?? ''
    expect(desc, 'model 字段没有 describe').not.toBe('')

    const missing = ALL_VIDEO_MODEL_ALIASES.filter((alias) => !desc.includes(`"${alias}"`))
    expect(
      missing,
      missing.length === 0
        ? ''
        : `这些模型能被传进来,但描述里没提到:\n${missing.map((m) => `  - ${m}`).join('\n')}\n` +
          `agent 照着描述选型,选不到没写进去的那个。`,
    ).toEqual([])
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

  // Seedance 2.5 Flash(2026-11-16):走同一个工具,数字按能力表(4-30 秒、480p/720p、10/5/5、无样片)。
  describe('model "2.5-flash"', () => {
    it('在 model 枚举里(模型表加了别名,MCP 的 zod 枚举自动跟上)', () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      const schema = tools[0].config.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }
      expect(schema.safeParse({ prompt: 'x', model: '2.5-flash' }).success).toBe(true)
      expect(schema.safeParse({ prompt: 'x', model: '2.5-turbo' }).success).toBe(false)
    })

    it('30 秒 720p 放行并把 model 原样交给主进程', async () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      await tools[0].handler({ prompt: 'x', model: '2.5-flash', duration: 30, resolution: '720p' })
      const [name, params] = router.call.mock.calls[0]
      expect(name).toBe('generate_video')
      expect(params).toMatchObject({ model: '2.5-flash', duration: 30, resolution: '720p' })
    })

    it('1080p 被拦下(2.5 平台余额才有 1080p,Flash 没有),不调主进程', async () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      const res = await tools[0].handler({ prompt: 'x', model: '2.5-flash', resolution: '1080p' })
      expect(router.call).not.toHaveBeenCalled()
      expect((res.content[0] as { text: string }).text).toContain('480p / 720p')
    })

    it('样片(draft)被拒,而不是静默当普通生成发出去', async () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      const res = await tools[0].handler({ prompt: 'x', model: '2.5-flash', draft: true })
      expect(router.call).not.toHaveBeenCalled()
      expect((res.content[0] as { text: string }).text).toContain('样片')
    })

    it('edit 同样必须带参考视频', async () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      const res = await tools[0].handler({ prompt: 'x', model: '2.5-flash', taskMode: 'edit', duration: -1 })
      expect(router.call).not.toHaveBeenCalled()
      expect((res.content[0] as { text: string }).text).toContain('视频')
    })
  })

  it('generate_video handler rejects taskMode without a reference video', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const res = await tools[0].handler({ prompt: 'x', model: '2.5', taskMode: 'edit', duration: -1 })
    expect(router.call).not.toHaveBeenCalled()
    expect((res.content[0] as { text: string }).text).toContain('视频')
  })

  // 深度捕捉是 generate_video 的变体:同一个工具、同一条主进程链,差别只在输入规则。
  describe('model "depth"(深度捕捉)', () => {
    const SRC = 'D:/clips/run.mp4'

    it('一段源视频 → 放行并原样交给主进程(model / resolution / referenceVideos 都在)', async () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      await tools[0].handler({ prompt: '深度捕捉', model: 'depth', resolution: '480p', referenceVideos: [SRC] })
      // 第 1 次调用 = 提交;之后的(若有)是 renderAndWait 对假任务对象的轮询。
      const [name, params] = router.call.mock.calls[0]
      expect(name).toBe('generate_video')
      expect(params).toMatchObject({ model: 'depth', resolution: '480p', referenceVideos: [SRC] })
    })

    it('没有 duration / ratio 这些参数也行;给了 duration 不报「4-15」', async () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      await tools[0].handler({ prompt: '深度捕捉', model: 'depth', referenceVideos: [SRC], duration: 3 })
      expect(router.call.mock.calls[0][0]).toBe('generate_video')
    })

    it('不带源视频 → 当场拦下,不打主进程', async () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      const res = await tools[0].handler({ prompt: '深度捕捉', model: 'depth' })
      expect(router.call).not.toHaveBeenCalled()
      expect((res.content[0] as { text: string }).text).toContain('一段源视频')
    })

    it('带了图片 → 拦下', async () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      const res = await tools[0].handler({
        prompt: '深度捕捉',
        model: 'depth',
        referenceVideos: [SRC],
        referenceImages: ['D:/a.png'],
      })
      expect(router.call).not.toHaveBeenCalled()
      expect((res.content[0] as { text: string }).text).toContain('只接受一段源视频')
    })

    it('两段源视频 → 拦下', async () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      const res = await tools[0].handler({
        prompt: '深度捕捉',
        model: 'depth',
        referenceVideos: [SRC, 'D:/clips/b.mp4'],
      })
      expect(router.call).not.toHaveBeenCalled()
      expect((res.content[0] as { text: string }).text).toContain('一段源视频')
    })

    it('4k 不是深度捕捉的档位 → 拦下', async () => {
      const { tools, server, router } = capture()
      registerVideoTools(server, router)
      const res = await tools[0].handler({
        prompt: '深度捕捉',
        model: 'depth',
        resolution: '4k',
        referenceVideos: [SRC],
      })
      expect(router.call).not.toHaveBeenCalled()
      expect((res.content[0] as { text: string }).text).toContain('4k')
    })
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

  /**
   * 样片成功后给 agent 的下一步提示:Roneyun-cn 的 2.5 样片要提醒它「出成片也带 cn-seedance-2.5」,
   * 否则 finalize_video_draft 缺省按火山 2.5 去找,网关答 task_origin_not_exist。火山的样片不加这句。
   *
   * 🧬 变异点:`draftNextStep` 里把 cn 分支去掉,第一条必红;让所有样片都带这句,第二条必红。
   */
  it('样片成功:cn-seedance-2.5 的提示里要求 finalize 也带 model;火山 2.5 不带', async () => {
    const cn = makeTask({
      status: 'succeeded', persistence: 'done', draft: true, model: 'cn-seedance-2.5',
      localPath: 'D:/save/d.mp4', videoUrl: 'https://cdn/d.mp4',
    })
    const a = capture({ found: true, task: cn })
    registerVideoTools(a.server, a.router)
    const checkA = a.tools.find((t) => t.name === 'check_video_task')!
    const cnText = ((await checkA.handler({ taskId: 'task_cn' })).content[0] as { text: string }).text
    expect(cnText).toContain('pass model "cn-seedance-2.5" to finalize_video_draft')

    const volc = makeTask({
      status: 'succeeded', persistence: 'done', draft: true, model: '2.5',
      localPath: 'D:/save/d.mp4', videoUrl: 'https://cdn/d.mp4',
    })
    const b = capture({ found: true, task: volc })
    registerVideoTools(b.server, b.router)
    const checkB = b.tools.find((t) => t.name === 'check_video_task')!
    const volcText = ((await checkB.handler({ taskId: 'task_v' })).content[0] as { text: string }).text
    expect(volcText).toContain('finalize_video_draft')
    expect(volcText).not.toContain('cn-seedance-2.5')
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

/**
 * 任务不挂在任何对话上(`threadId` 缺席 —— 发起调用的线程不属于任何对话)时,渲染端不给它开
 * 气泡。回执要是还写着「已经在聊天里播放了」,agent 就会照着回复,用户去聊天里找一段
 * 根本不在那儿的视频。图片那边同一件事见 imageTools.detached.test.ts。
 */
describe('video banners:任务不属于任何对话时说实话', () => {
  /** 每一句都在声称「用户此刻在聊天里看得到它」。 */
  const CLAIMS_THE_USER_SEES_IT = [
    /already playing in the chat/i,
    /and playing in the chat/i,
    /sees a live progress bubble/i,
    /sees its progress bubble/i,
    /The user sees the failure/i,
    /playing in app chat/i,
    /just confirm to the user/i,
  ]
  const expectNoFalseClaim = (words: string): void => {
    for (const claim of CLAIMS_THE_USER_SEES_IT) expect(words, String(claim)).not.toMatch(claim)
  }
  const stray = (patch: Partial<SeedanceTaskState> = {}): SeedanceTaskState =>
    makeTask({ threadId: undefined, ...patch })

  it('成片已落盘:说「没有在任何对话里播放」,路径照给', () => {
    const text = buildDoneBanner(stray({ status: 'succeeded', persistence: 'done', localPath: 'D:/save/v.mp4' }))
    expect(text).toContain('generate_video DONE — video generated and saved locally. NOT playing in any chat')
    expect(text).toContain('📁 SAVED FILE: D:/save/v.mp4')
    expect(text).toContain('Do NOT say the video is playing in the chat')
    expect(text).toContain('do NOT re-generate')
    expectNoFalseClaim(text)
  })

  it('落盘失败 / 落盘还在跑:同样不说「正在聊天里播放」', () => {
    const saveFailed = buildDoneBanner(stray({ status: 'succeeded', persistence: 'failed', videoUrl: 'https://cdn/v.mp4' }))
    expect(saveFailed).toContain('local file save FAILED. NOT playing in any chat')
    expect(saveFailed).toContain('https://cdn/v.mp4')
    expectNoFalseClaim(saveFailed)

    const pending = buildDoneBanner(stray({ status: 'succeeded', persistence: 'running', videoUrl: 'https://cdn/v.mp4' }))
    expect(pending).toContain('generate_video DONE — video generated. NOT playing in any chat')
    expect(pending).toContain('persistencePending')
    // 没有气泡可指,路径是唯一能交付的东西 —— 所以这里要它再查一次,而不是「不需要就算了」。
    expect(pending).toContain('Call check_video_task ONCE more in ~10s to get the saved path')
    expectNoFalseClaim(pending)
  })

  it('还在跑 / 超预算交还 / 失败:不说用户看得到进度气泡或失败气泡', () => {
    const budget = buildBudgetExhaustedBanner(stray({ status: 'running' }))
    expect(budget).toContain('STILL RUNNING')
    expect(budget).toContain('no chat shows a progress bubble for it')
    expectNoFalseClaim(budget)

    const running = buildRunningBanner(stray({ status: 'running' }))
    expect(running).toContain('check_video_task again')
    expect(running).toContain('no chat shows its progress')
    expectNoFalseClaim(running)

    const failed = buildFailedBanner(stray({ status: 'failed', error: 'OutputVideoSensitive: 审核未通过' }))
    expect(failed).toContain('OutputVideoSensitive')
    expect(failed).toContain('No chat shows this failure')
    expect(failed).toContain('report the error in your reply')
    expectNoFalseClaim(failed)
  })

  it('空字符串的 threadId 也算没有归属', () => {
    const text = buildDoneBanner(stray({ threadId: '', status: 'succeeded', persistence: 'done', localPath: 'D:/save/v.mp4' }))
    expect(text).toContain('NOT playing in any chat')
  })

  it('经工具回包:resource_link 的说明也不说「在聊天里播放」', async () => {
    const task = stray({ status: 'succeeded', persistence: 'done', localPath: 'D:/save/v.mp4' })
    const { tools, server, router } = capture({ found: true, task })
    registerVideoTools(server, router)
    const check = tools.find((t) => t.name === 'check_video_task')!
    const res = await check.handler({ taskId: 'cgt-123' })

    expect(String(res.content[0].text)).toContain('NOT playing in any chat')
    expect(res.content[1]).toMatchObject({
      type: 'resource_link',
      description: 'Generated video saved locally (not playing in any chat).',
    })
  })

  it('对照:挂在对话上的任务照旧说气泡在聊天里', async () => {
    expect(buildDoneBanner(makeTask({ status: 'succeeded', persistence: 'done', localPath: 'D:/save/v.mp4' })))
      .toContain('generate_video DONE — video generated, saved locally, and already playing in the chat.')
    expect(buildDoneBanner(makeTask({ status: 'succeeded', persistence: 'failed' })))
      .toContain('video generated and playing in the chat, but the local file save FAILED.')
    expect(buildDoneBanner(makeTask({ status: 'succeeded', persistence: 'running' })))
      .toContain('otherwise just confirm to the user.')
    expect(buildBudgetExhaustedBanner(makeTask({ status: 'running' })))
      .toContain('the user sees a live progress bubble in the chat.')
    expect(buildRunningBanner(makeTask({ status: 'running' })))
      .toContain('the task is alive and the user sees its progress bubble.')
    expect(buildFailedBanner(makeTask({ status: 'failed', error: 'x' })))
      .toContain('The user sees the failure in the chat bubble.')

    const task = makeTask({ status: 'succeeded', persistence: 'done', localPath: 'D:/save/v.mp4' })
    const { tools, server, router } = capture({ found: true, task })
    registerVideoTools(server, router)
    const res = await tools.find((t) => t.name === 'check_video_task')!.handler({ taskId: 'cgt-123' })
    expect(res.content[1]).toMatchObject({
      description: 'Generated video saved locally (also playing in app chat + history).',
    })
  })
})
