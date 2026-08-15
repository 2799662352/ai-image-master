// 总闸拦下自动生成时,回给模型的横幅必须说实话。
//
// 病根:add_tasks 的横幅是按**请求参数** autoStart 写的,不是按**结果**。用户把
// 「允许 AI 自动生成」关掉后,渲染端一张都没提交,横幅却照旧宣布「Rendering
// started」并承诺「跑完会推给你」—— 模型于是告诉用户已经在渲染了,然后等一条
// 永远不会来的推送。功能本身拦住了,但模型对用户说了假话,等于白做。
//
// start 那条同样:started 为空时横幅让模型「see skipped reasons」,而不带 cardIds
// 的调用 skipped 是空的,模型被指向一个不存在的东西,永远不知道是开关关着。

import { describe, expect, it, vi } from 'vitest'
import type { ZodTypeAny } from 'zod'
import { registerVideoWorkbenchTools } from '../videoWorkbenchTools'

type Handler = (
  params: Record<string, unknown>,
  ctx?: unknown,
) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>

type Captured = {
  name: string
  config: { description: string; inputSchema: ZodTypeAny; outputSchema?: ZodTypeAny }
  handler: Handler
}

function capture(routerResult: unknown): { tools: Captured[]; server: any; router: any } {
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

const BLOCKED_START = {
  started: [],
  skipped: [{ cardId: 'c1', reason: '用户关闭了「允许 AI 自动生成」' }],
  blocked: true,
  hint: '用户在视频工作台关闭了「允许 AI 自动生成」,请让他自己点「全部生成」。',
}

describe('add_tasks 横幅按结果说话,不按请求参数', () => {
  it('被总闸拦下时不得宣布已开始渲染、也不得承诺会推送完成', async () => {
    const { tools, server, router } = capture({
      cardIds: ['c1'],
      total: 1,
      start: BLOCKED_START,
    })
    registerVideoWorkbenchTools(server, router)

    const res = await toolByName(tools, 'video_workbench_add_tasks').handler({
      tasks: [{ prompt: 'a' }],
      autoStart: true,
    })
    const text = res.content[0].text

    expect(text).not.toContain('Rendering started')
    expect(text).not.toContain('批次渲染完成')
    // 必须让模型知道「是用户关掉了开关」,并把球踢回给用户
    expect(text).toContain('允许 AI 自动生成')
    expect(text).toContain('全部生成')
  })

  it('没被拦下时照旧宣布已开始渲染(不改变既有行为)', async () => {
    const { tools, server, router } = capture({
      cardIds: ['c1'],
      total: 1,
      start: { started: ['c1'], skipped: [] },
    })
    registerVideoWorkbenchTools(server, router)

    const res = await toolByName(tools, 'video_workbench_add_tasks').handler({
      tasks: [{ prompt: 'a' }],
      autoStart: true,
    })
    expect(res.content[0].text).toContain('Rendering started')
  })

  it('没传 autoStart 时仍是「只填卡未启动」', async () => {
    const { tools, server, router } = capture({ cardIds: ['c1'], total: 1 })
    registerVideoWorkbenchTools(server, router)
    const res = await toolByName(tools, 'video_workbench_add_tasks').handler({ tasks: [{ prompt: 'a' }] })
    expect(res.content[0].text).toContain('not started')
  })
})

describe('start 横幅在被拦下时说明原因', () => {
  it('不再让模型去看不存在的 skipped reasons,而是点名开关', async () => {
    const { tools, server, router } = capture({ ...BLOCKED_START, skipped: [] })
    registerVideoWorkbenchTools(server, router)

    const res = await toolByName(tools, 'video_workbench_start').handler({})
    const text = res.content[0].text

    expect(text).toContain('允许 AI 自动生成')
    expect(text).toContain('全部生成')
    expect(text).not.toContain('see skipped reasons')
  })

  it('真的什么都没启动(不是被拦)时维持原来的提示', async () => {
    const { tools, server, router } = capture({
      started: [],
      skipped: [{ cardId: 'c1', reason: '提示词为空' }],
    })
    registerVideoWorkbenchTools(server, router)
    const res = await toolByName(tools, 'video_workbench_start').handler({})
    expect(res.content[0].text).toContain('see skipped reasons')
  })
})

describe('工具描述如实说明 autoStart 可能被拒', () => {
  it('add_tasks 与 start 的描述都提到用户可以关掉自动生成', () => {
    const { tools, server, router } = capture({})
    registerVideoWorkbenchTools(server, router)
    expect(toolByName(tools, 'video_workbench_add_tasks').config.description).toContain('允许 AI 自动生成')
    expect(toolByName(tools, 'video_workbench_start').config.description).toContain('允许 AI 自动生成')
  })
})
