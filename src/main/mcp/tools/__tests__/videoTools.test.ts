import { describe, expect, it, vi } from 'vitest'
import type { ZodTypeAny } from 'zod'
import {
  registerVideoTools,
  buildCreatedBanner,
  buildRunningBanner,
  buildDoneBanner,
  buildFailedBanner,
  buildUnknownTaskBanner,
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
    expect(schema.safeParse({ prompt: 'x', duration: 2 }).success).toBe(false)
    expect(schema.safeParse({ prompt: 'x', duration: 13 }).success).toBe(false)
    expect(schema.safeParse({ prompt: 'x', resolution: '4K' }).success).toBe(false)
  })

  it('generate_video handler rejects 1080p on 2.0-fast without calling upstream', async () => {
    const { tools, server, router } = capture()
    registerVideoTools(server, router)
    const res = await tools[0].handler({ prompt: 'x', resolution: '1080p' })
    expect(router.call).not.toHaveBeenCalled()
    expect((res.content[0] as { text: string }).text).toContain('1080p requires model "2.0"')
  })

  it('generate_video handler returns created banner with taskId + polling instruction', async () => {
    const { tools, server, router } = capture(makeTask())
    registerVideoTools(server, router)
    const res = await tools[0].handler({ prompt: '猫跳舞' })
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('TASK CREATED')
    expect(text).toContain('cgt-123')
    expect(text).toContain('check_video_task')
    expect(text).toContain('do NOT resubmit')
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
  it('created banner front-loads taskId and machine JSON', () => {
    const text = buildCreatedBanner(makeTask())
    expect(text).toContain('cgt-123')
    expect(JSON.parse(text.split('\n').at(-1)!)).toMatchObject({ taskId: 'cgt-123', status: 'queued' })
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
