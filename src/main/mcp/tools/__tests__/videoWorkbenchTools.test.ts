import { describe, expect, it, vi } from 'vitest'
import type { ZodTypeAny } from 'zod'
import { registerVideoWorkbenchTools } from '../videoWorkbenchTools'

type Handler = (
  params: Record<string, unknown>,
  ctx?: unknown,
) => Promise<{ content: Array<{ type: string; text: string }> }>
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

function toolByName(tools: Captured[], name: string): Captured {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool not registered: ${name}`)
  return tool
}

describe('registerVideoWorkbenchTools / schemas', () => {
  it('注册全部五个工作台工具', () => {
    const { tools, server, router } = capture()
    registerVideoWorkbenchTools(server, router)
    expect(tools.map((t) => t.name)).toEqual([
      'video_workbench_add_tasks',
      'video_workbench_update_task',
      'video_workbench_start',
      'video_workbench_status',
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

  it('router 抛错时返回 ❌ banner 而不是异常外抛', async () => {
    const { tools, server } = capture()
    const router = { call: vi.fn(async () => { throw new Error('renderer offline') }) }
    registerVideoWorkbenchTools(server, router as any)
    const res = await toolByName(tools, 'video_workbench_add_tasks').handler({ tasks: [{}] })
    expect(res.content[0].text).toContain('❌')
    expect(res.content[0].text).toContain('renderer offline')
  })
})
