import { describe, expect, it, vi } from 'vitest'
import type { ZodTypeAny } from 'zod'
import { registerVideoWorkbenchTools } from '../videoWorkbenchTools'

type Handler = (
  params: Record<string, unknown>,
  ctx?: unknown,
) => Promise<{
  content: Array<{ type: string; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}>
type Captured = {
  name: string
  config: { description: string; inputSchema: ZodTypeAny; outputSchema?: ZodTypeAny }
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

function toolByName(tools: Captured[], name: string): Captured {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool not registered: ${name}`)
  return tool
}

describe('registerVideoWorkbenchTools / schemas', () => {
  it('注册全部工作台工具', () => {
    const { tools, server, router } = capture()
    registerVideoWorkbenchTools(server, router)
    expect(tools.map((t) => t.name)).toEqual([
      'video_workbench_add_tasks',
      'video_workbench_update_task',
      'video_workbench_start',
      'video_workbench_status',
      'video_workbench_export',
      'video_workbench_apply',
      'video_workbench_remove_tasks',
    ])
  })

  it('add_tasks schema:接受批量任务与 autoStart,拒绝空 tasks/超限时长', () => {
    const { tools, server, router } = capture()
    registerVideoWorkbenchTools(server, router)
    const schema = toolByName(tools, 'video_workbench_add_tasks').config.inputSchema
    expect(
      schema.safeParse({
        tasks: [
          { prompt: '一只猫在雨里跳舞', model: '2.0-fast', duration: 8, referenceImages: ['C:/a.png'] },
          {},
        ],
        autoStart: true,
      }).success,
    ).toBe(true)
    expect(schema.safeParse({ tasks: [] }).success).toBe(false)
    expect(schema.safeParse({ tasks: [{ duration: 30 }] }).success).toBe(false)
    expect(schema.safeParse({ tasks: [{ resolution: '4K' }] }).success).toBe(false)
  })

  it('update_task schema:cardId 必填', () => {
    const { tools, server, router } = capture()
    registerVideoWorkbenchTools(server, router)
    const schema = toolByName(tools, 'video_workbench_update_task').config.inputSchema
    expect(schema.safeParse({ cardId: 'c1', prompt: '新提示词' }).success).toBe(true)
    expect(schema.safeParse({ prompt: '缺 cardId' }).success).toBe(false)
  })

  it('status schema:接受可选 boardId 过滤', () => {
    const { tools, server, router } = capture()
    registerVideoWorkbenchTools(server, router)
    const schema = toolByName(tools, 'video_workbench_status').config.inputSchema
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ boardId: 'b1' }).success).toBe(true)
    expect(schema.safeParse({ boardId: 'b1', cardIds: ['c1'] }).success).toBe(true)
    expect(schema.safeParse({ boardId: 42 }).success).toBe(false)
  })

  it('全部工具声明 outputSchema(MCP 2025-11-25 structured output)', () => {
    const { tools, server, router } = capture()
    registerVideoWorkbenchTools(server, router)
    for (const tool of tools) {
      expect(tool.config.outputSchema, `${tool.name} 缺 outputSchema`).toBeDefined()
    }
  })

  it('export schema:boardId 可选', () => {
    const { tools, server, router } = capture()
    registerVideoWorkbenchTools(server, router)
    const schema = toolByName(tools, 'video_workbench_export').config.inputSchema
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ boardId: 'b1' }).success).toBe(true)
    expect(schema.safeParse({ boardId: 7 }).success).toBe(false)
  })

  it('apply schema:导出的 IR 原样回带能过校验(round-trip),坏 IR 被挡下', () => {
    const { tools, server, router } = capture()
    registerVideoWorkbenchTools(server, router)
    const schema = toolByName(tools, 'video_workbench_apply').config.inputSchema
    // 导出形态:字段填满 + 只读 result 注解 + wbref 占位。
    const exported = {
      irVersion: 1,
      revision: 3,
      activeBoardId: 'b1',
      boards: [{
        id: 'b1',
        name: '页面 1',
        cards: [{
          id: 'c1',
          prompt: '一只猫',
          model: '2.0',
          resolution: '720p',
          ratio: '16:9',
          duration: 5,
          generateAudio: true,
          mode: 'multimodal_ref',
          webSearch: false,
          referenceImages: [{ name: '(内嵌素材)', src: 'wbref://c1/referenceImages/0' }],
          referenceVideos: [],
          referenceAudios: [],
          result: { status: 'succeeded', taskId: 't-1', remoteUrl: 'https://cos/v.mp4' },
        }],
      }],
    }
    expect(schema.safeParse({ ir: exported }).success).toBe(true)
    expect(schema.safeParse({ ir: exported, mode: 'replace', force: true }).success).toBe(true)
    // 手搓的最小新卡:规格全省(声明式 = 回默认值)。
    expect(schema.safeParse({
      ir: { irVersion: 1, revision: 0, boards: [{ name: '新页', cards: [{ prompt: '一镜' }] }] },
    }).success).toBe(true)

    expect(schema.safeParse({ ir: { ...exported, boards: [] } }).success).toBe(false)
    expect(schema.safeParse({ ir: { boards: exported.boards, revision: 0 } }).success).toBe(false)
    expect(schema.safeParse({ mode: 'merge' }).success).toBe(false)
    expect(schema.safeParse({ ir: { ...exported, mode: 'nuke' }, mode: 'nuke' }).success).toBe(false)
    // 页名空串不该混进来 —— apply 会跳过整页,不如在 schema 就挡住。
    expect(schema.safeParse({
      ir: { irVersion: 1, revision: 0, boards: [{ name: '', cards: [] }] },
    }).success).toBe(false)
  })

  it('remove_tasks schema:cardIds 非空必填', () => {
    const { tools, server, router } = capture()
    registerVideoWorkbenchTools(server, router)
    const schema = toolByName(tools, 'video_workbench_remove_tasks').config.inputSchema
    expect(schema.safeParse({ cardIds: ['c1'] }).success).toBe(true)
    expect(schema.safeParse({ cardIds: [] }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
  })
})

describe('handlers → router.call 透传与 banner', () => {
  it('add_tasks:结果 JSON 进回包;autoStart 时 banner 指示轮询', async () => {
    const { tools, server, router } = capture({ cardIds: ['c1', 'c2'], total: 2 })
    registerVideoWorkbenchTools(server, router)
    const tool = toolByName(tools, 'video_workbench_add_tasks')
    const res = await tool.handler({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], autoStart: true })
    expect(router.call).toHaveBeenCalledWith(
      'video_workbench_add_tasks',
      expect.objectContaining({ autoStart: true }),
      undefined,
    )
    const text = res.content[0].text
    expect(text).toContain('video_workbench_status')
    expect(text).toContain('"cardIds":["c1","c2"]')
  })

  it('add_tasks 未 autoStart:banner 说明只填卡未启动', async () => {
    const { tools, server, router } = capture({ cardIds: ['c1'], total: 1 })
    registerVideoWorkbenchTools(server, router)
    const tool = toolByName(tools, 'video_workbench_add_tasks')
    const res = await tool.handler({ tasks: [{ prompt: 'a' }] })
    expect(res.content[0].text).toContain('not started')
  })

  it('start:有启动项时 banner 要求轮询,全部跳过时给警告', async () => {
    const started = capture({ started: ['c1'], skipped: [] })
    registerVideoWorkbenchTools(started.server, started.router)
    const startTool = toolByName(started.tools, 'video_workbench_start')
    const okRes = await startTool.handler({})
    expect(okRes.content[0].text).toContain('render(s) submitted')

    const skipped = capture({ started: [], skipped: [{ cardId: 'c1', reason: '提示词为空' }] })
    registerVideoWorkbenchTools(skipped.server, skipped.router)
    const skipTool = toolByName(skipped.tools, 'video_workbench_start')
    const skipRes = await skipTool.handler({ cardIds: ['c1'] })
    expect(skipRes.content[0].text).toContain('nothing started')
    expect(skipRes.content[0].text).toContain('提示词为空')
  })

  it('status:有渲染中卡片时提示继续轮询,全终态时提示完成', async () => {
    const busyCase = capture({ total: 2, cards: [{ status: 'running' }, { status: 'succeeded' }] })
    registerVideoWorkbenchTools(busyCase.server, busyCase.router)
    const busyRes = await toolByName(busyCase.tools, 'video_workbench_status').handler({})
    expect(busyRes.content[0].text).toContain('still rendering')

    const doneCase = capture({ total: 1, cards: [{ status: 'succeeded', localPath: 'C:/v.mp4' }] })
    registerVideoWorkbenchTools(doneCase.server, doneCase.router)
    const doneRes = await toolByName(doneCase.tools, 'video_workbench_status').handler({})
    expect(doneRes.content[0].text).toContain('No card is rendering')
  })

  it('export:banner 指向 apply 并要求保留 revision', async () => {
    const ir = { irVersion: 1, revision: 2, activeBoardId: 'b1', boards: [{ id: 'b1', name: '页面 1', cards: [] }] }
    const { tools, server, router } = capture(ir)
    registerVideoWorkbenchTools(server, router)
    const res = await toolByName(tools, 'video_workbench_export').handler({ boardId: 'b1' })
    expect(router.call).toHaveBeenCalledWith('video_workbench_export', { boardId: 'b1' }, undefined)
    expect(res.structuredContent).toEqual(ir)
    expect(res.content[0].text).toContain('video_workbench_apply')
    expect(res.content[0].text).toContain('revision')
  })

  const emptyDiff = {
    boards: { created: [], renamed: [], removed: [] },
    cards: { created: [], updated: [], moved: [], removed: [] },
  }

  it('apply 冲突:banner 明说什么都没写、要求重新 export(不是 isError)', async () => {
    const result = { ok: false, conflict: { expected: 2, actual: 5 }, ...emptyDiff, skipped: [], revision: 5 }
    const { tools, server, router } = capture(result)
    registerVideoWorkbenchTools(server, router)
    const res = await toolByName(tools, 'video_workbench_apply').handler({
      ir: { irVersion: 1, revision: 2, boards: [{ name: '页面 1', cards: [] }] },
    })
    expect(res.isError).toBeUndefined()
    expect(res.structuredContent).toEqual(result)
    const text = res.content[0].text
    expect(text).toContain('nothing was written')
    expect(text).toContain('revision 2 to 5')
    expect(text).toContain('video_workbench_export')
  })

  it('apply 非冲突失败:仍提示什么都没写', async () => {
    const result = { ok: false, ...emptyDiff, skipped: [{ reason: '不认识的 irVersion: 9' }], revision: 1 }
    const { tools, server, router } = capture(result)
    registerVideoWorkbenchTools(server, router)
    const res = await toolByName(tools, 'video_workbench_apply').handler({
      ir: { irVersion: 9, revision: 1, boards: [{ name: 'x', cards: [] }] },
    })
    expect(res.content[0].text).toContain('nothing was written')
    expect(res.content[0].text).toContain('不认识的 irVersion')
  })

  it('apply 成功:banner 带新 revision;有 skip 时要求转告用户', async () => {
    const clean = capture({ ok: true, ...emptyDiff, cards: { created: ['c9'], updated: [], moved: [], removed: [] }, skipped: [], revision: 4 })
    registerVideoWorkbenchTools(clean.server, clean.router)
    const cleanRes = await toolByName(clean.tools, 'video_workbench_apply').handler({
      ir: { irVersion: 1, revision: 3, boards: [{ name: '页面 1', cards: [{ prompt: 'x' }] }] },
    })
    expect(cleanRes.content[0].text).toContain('New revision 4')
    // 无 skip 时不加第二条警告横幅(JSON 兜底里的 "skipped":[] 不算)。
    expect(cleanRes.content[0].text).not.toContain('item(s) skipped')

    const partial = capture({
      ok: true,
      ...emptyDiff,
      skipped: [{ cardId: 'c1', reason: '卡片正在生成,规格已定格不可改(位置改动已生效)' }],
      revision: 4,
    })
    registerVideoWorkbenchTools(partial.server, partial.router)
    const partialRes = await toolByName(partial.tools, 'video_workbench_apply').handler({
      ir: { irVersion: 1, revision: 3, boards: [{ name: '页面 1', cards: [] }] },
    })
    expect(partialRes.content[0].text).toContain('1 item(s) skipped')
    expect(partialRes.content[0].text).toContain('规格已定格')
  })

  it('apply mode/force 透传给 renderer', async () => {
    const { tools, server, router } = capture({ ok: true, ...emptyDiff, skipped: [], revision: 1 })
    registerVideoWorkbenchTools(server, router)
    const ir = { irVersion: 1, revision: 0, boards: [{ name: '页面 1', cards: [] }] }
    await toolByName(tools, 'video_workbench_apply').handler({ ir, mode: 'replace', force: true })
    expect(router.call).toHaveBeenCalledWith(
      'video_workbench_apply',
      { ir, mode: 'replace', force: true },
      undefined,
    )
  })

  it('router 抛错时返回 ❌ banner 而不是异常外抛', async () => {
    const { tools, server } = capture()
    const router = { call: vi.fn(async () => { throw new Error('renderer offline') }) }
    registerVideoWorkbenchTools(server, router as any)
    const res = await toolByName(tools, 'video_workbench_add_tasks').handler({ tasks: [{}] })
    expect(res.content[0].text).toContain('❌')
    expect(res.content[0].text).toContain('renderer offline')
  })
})

describe('structured output(MCP 2025-11-25)', () => {
  const workbench = {
    activeBoardId: 'b1',
    boards: [{ id: 'b1', name: '页面 1', cardCount: 2 }],
    statusCounts: { draft: 2, preparing: 0, queued: 0, running: 0, succeeded: 0, failed: 0 },
  }
  const cardSnapshot = {
    cardId: 'c1',
    boardId: 'b1',
    order: 0,
    prompt: '一只猫',
    model: '2.0',
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    generateAudio: true,
    mode: 'multimodal_ref',
    webSearch: false,
    referenceCounts: { images: 1, videos: 0, audios: 0 },
    references: { images: [{ name: '主角立绘@a1' }], videos: [], audios: [] },
    status: 'succeeded',
    taskId: 't-1',
    localPath: 'C:/v.mp4',
    remoteUrl: 'https://cos/v.mp4',
  }

  it('status:成功结果带 structuredContent(text JSON 兜底保留)且通过 outputSchema', async () => {
    const routerResult = { total: 1, activeBoardId: 'b1', boards: workbench.boards, cards: [cardSnapshot] }
    const { tools, server, router } = capture(routerResult)
    registerVideoWorkbenchTools(server, router)
    const tool = toolByName(tools, 'video_workbench_status')
    const res = await tool.handler({ boardId: 'b1' })
    expect(res.isError).toBeUndefined()
    expect(res.structuredContent).toEqual(routerResult)
    expect(res.content[0].text).toContain('"total":1')
    expect(tool.config.outputSchema!.safeParse(res.structuredContent).success).toBe(true)
  })

  it('写操作:structuredContent 含 workbench 全局摘要且通过各自 outputSchema', async () => {
    const cases: Array<{ name: string; routerResult: Record<string, unknown>; params: Record<string, unknown> }> = [
      {
        name: 'video_workbench_add_tasks',
        routerResult: { cardIds: ['c1', 'c2'], total: 2, workbench },
        params: { tasks: [{ prompt: 'a' }, { prompt: 'b' }] },
      },
      {
        name: 'video_workbench_update_task',
        routerResult: { ok: true, card: cardSnapshot, workbench },
        params: { cardId: 'c1', prompt: '改' },
      },
      {
        name: 'video_workbench_start',
        routerResult: { started: ['c1'], skipped: [], workbench },
        params: {},
      },
      {
        name: 'video_workbench_remove_tasks',
        routerResult: { removed: ['c2'], total: 1, workbench },
        params: { cardIds: ['c2'] },
      },
      {
        name: 'video_workbench_export',
        routerResult: {
          irVersion: 1,
          revision: 3,
          activeBoardId: 'b1',
          boards: [{ id: 'b1', name: '页面 1', cards: [{ id: 'c1', prompt: '一只猫' }] }],
        },
        params: {},
      },
      {
        name: 'video_workbench_apply',
        routerResult: {
          ok: true,
          boards: { created: ['b2'], renamed: ['b1'], removed: [] },
          cards: { created: ['c9'], updated: ['c1'], moved: ['c1'], removed: ['c2'] },
          skipped: [{ cardId: 'c3', reason: '卡片正在生成,拒绝删除(已保留在页面上)' }],
          revision: 4,
        },
        params: { ir: { irVersion: 1, revision: 3, boards: [{ name: '页面 1', cards: [] }] } },
      },
    ]
    for (const c of cases) {
      const { tools, server, router } = capture(c.routerResult)
      registerVideoWorkbenchTools(server, router)
      const tool = toolByName(tools, c.name)
      const res = await tool.handler(c.params)
      expect(res.structuredContent, `${c.name} 缺 structuredContent`).toEqual(c.routerResult)
      const parsed = tool.config.outputSchema!.safeParse(res.structuredContent)
      expect(parsed.success, `${c.name} outputSchema 校验失败: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
    }
  })

  it('执行错误:isError: true + content 报错(不再只靠 ❌ 文本横幅),无 structuredContent', async () => {
    const { tools, server } = capture()
    const router = { call: vi.fn(async () => { throw new Error('renderer offline') }) }
    registerVideoWorkbenchTools(server, router as any)
    for (const tool of tools) {
      const res = await tool.handler(
        tool.name === 'video_workbench_update_task' ? { cardId: 'c1' } : { tasks: [{}], cardIds: ['c1'] },
      )
      expect(res.isError, `${tool.name} 应标记 isError`).toBe(true)
      expect(res.structuredContent).toBeUndefined()
      expect(res.content[0].text).toContain('renderer offline')
    }
  })
})
