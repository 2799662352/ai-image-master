// 可灵分镜的 MCP 面:generate_video 的入参校验与透传,工作台两组工具的 schema 都认 multiShot。

import { describe, expect, it, vi } from 'vitest'
import type { ZodTypeAny } from 'zod'
import { WORKBENCH_IR_VERSION } from '../../../../types/videoWorkbench'
import { registerVideoTools } from '../videoTools'
import { registerVideoWorkbenchTools } from '../videoWorkbenchTools'
import { zMultiShot } from '../klingMultiShotSchema'

type Handler = (params: Record<string, unknown>, ctx?: unknown) => Promise<{ content: Array<Record<string, unknown>> }>
type Captured = { name: string; config: { description: string; inputSchema: ZodTypeAny }; handler: Handler }

function capture(): { tools: Captured[]; server: any; router: any } {
  const tools: Captured[] = []
  const server = {
    registerTool: (name: string, config: Captured['config'], handler: Handler) => {
      tools.push({ name, config, handler })
    },
  }
  const router = { call: vi.fn(async () => ({ ok: true })) }
  return { tools, server, router }
}

const SHOTS = [
  { prompt: '雨夜街头,人物回头', duration: 2 },
  { prompt: '特写:雨滴落在水洼里', duration: 3 },
]

const textOf = (res: { content: Array<Record<string, unknown>> }): string => (res.content[0] as { text: string }).text

describe('zMultiShot schema', () => {
  const schema = () => zMultiShot()

  it('三种 type 都收;缺省(= 单镜头)也收', () => {
    expect(schema().safeParse(undefined).success).toBe(true)
    expect(schema().safeParse({ type: 'intelligence' }).success).toBe(true)
    expect(schema().safeParse({ type: 'off' }).success).toBe(true)
    expect(schema().safeParse({ type: 'customize', shots: SHOTS }).success).toBe(true)
  })

  it('未知 type / 超过 6 个镜头 / 镜头时长不是 ≥1 的整数:schema 层就拒', () => {
    expect(schema().safeParse({ type: 'storyboard' }).success).toBe(false)
    expect(schema().safeParse({ type: 'customize', shots: Array.from({ length: 7 }, () => SHOTS[0]) }).success).toBe(false)
    expect(schema().safeParse({ type: 'customize', shots: [{ prompt: 'a', duration: 0 }] }).success).toBe(false)
    expect(schema().safeParse({ type: 'customize', shots: [{ prompt: 'a', duration: 1.5 }] }).success).toBe(false)
  })

  it('JSON Schema 朴素:没有 anyOf / oneOf(客户端校验器对它们支持参差)', async () => {
    const { z } = await import('zod')
    const json = JSON.stringify(z.toJSONSchema(z.object({ multiShot: zMultiShot() })))
    expect(json).not.toMatch(/anyOf|oneOf/)
  })
})

describe('generate_video × multiShot', () => {
  const base = { prompt: '雨夜追逐', model: 'kling4', duration: 5 }

  it('自定义分镜:放行,归一后的分镜交给主进程', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    await tools[0].handler({ ...base, multiShot: { type: 'customize', shots: SHOTS } })
    const [name, params] = router.call.mock.calls[0]
    expect(name).toBe('generate_video')
    expect(params.multiShot).toEqual({ type: 'customize', shots: SHOTS })
  })

  it('智能分镜:放行', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    await tools[0].handler({ ...base, multiShot: { type: 'intelligence' } })
    expect(router.call.mock.calls[0][1].multiShot).toEqual({ type: 'intelligence' })
  })

  it('{type:"off"}:当没有分镜 —— 主进程那一层收不到这个键', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    await tools[0].handler({ ...base, multiShot: { type: 'off' } })
    expect(router.call.mock.calls[0][1]).not.toHaveProperty('multiShot')
  })

  it('没传 duration:按运行时的默认 5 秒对账,而不是说「需要先确定总时长」', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    await tools[0].handler({ prompt: '雨夜追逐', model: 'kling4', multiShot: { type: 'customize', shots: SHOTS } })
    expect(router.call.mock.calls[0][0]).toBe('generate_video')
  })

  it('时长之和对不上:当场拦下并说清差几秒,不打主进程', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const res = await tools[0].handler({ ...base, duration: 8, multiShot: { type: 'customize', shots: SHOTS } })
    expect(router.call).not.toHaveBeenCalled()
    expect(textOf(res)).toContain('各镜头时长之和需等于视频总时长')
  })

  it('customize 却没给 shots:明确报错,不悄悄退成单镜头', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const res = await tools[0].handler({ ...base, multiShot: { type: 'customize' } })
    expect(router.call).not.toHaveBeenCalled()
    expect(textOf(res)).toContain('shots')
  })

  it('不收分镜的模型:明说不支持', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const res = await tools[0].handler({ prompt: 'x', model: '2.0', duration: 5, multiShot: { type: 'customize', shots: SHOTS } })
    expect(router.call).not.toHaveBeenCalled()
    expect(textOf(res)).toContain('不支持分镜')
  })

  it('没有 multiShot 的请求原样透传(不多不少)', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    await tools[0].handler({ ...base })
    expect(router.call.mock.calls[0][1]).toEqual({ ...base })
  })
})

describe('video_workbench_* × multiShot', () => {
  const toolSchema = (name: string): ZodTypeAny => {
    const { tools, server, router } = capture()
    registerVideoWorkbenchTools(server, router)
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`tool not registered: ${name}`)
    return tool.config.inputSchema
  }

  it('add_tasks 的任务项收分镜', () => {
    const schema = toolSchema('video_workbench_add_tasks')
    const ok = schema.safeParse({ tasks: [{ prompt: '', model: 'kling4', duration: 5, multiShot: { type: 'customize', shots: SHOTS } }] })
    expect(ok.success).toBe(true)
  })

  it('update_task 收分镜(含 off 清除)', () => {
    const schema = toolSchema('video_workbench_update_task')
    expect(schema.safeParse({ cardId: 'c1', multiShot: { type: 'customize', shots: SHOTS } }).success).toBe(true)
    expect(schema.safeParse({ cardId: 'c1', multiShot: { type: 'off' } }).success).toBe(true)
  })

  it('apply 的 IR 卡收分镜', () => {
    const schema = toolSchema('video_workbench_apply')
    const ir = {
      irVersion: WORKBENCH_IR_VERSION,
      structureRevision: 0,
      boards: [{ name: 'b', cards: [{ prompt: '', model: 'kling4', multiShot: { type: 'intelligence' } }] }],
    }
    expect(schema.safeParse({ ir }).success).toBe(true)
  })

  it('set_spec 是批量规格工具:不收分镜(分镜是每张卡的内容,不是批量规格)', () => {
    const schema = toolSchema('video_workbench_set_spec')
    const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape ?? {}
    expect(Object.keys(shape)).not.toContain('multiShot')
  })
})
