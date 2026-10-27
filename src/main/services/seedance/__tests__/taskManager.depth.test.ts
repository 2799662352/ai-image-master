// 深度捕捉(depth)在 taskManager 里的落点。
//
// 它是 `generate_video` 的变体而不是另一个工具,所以整条任务链(提交 → 轮询 → 落盘 →
// 广播)必须原样复用。这里钉住它与生成模型**不同**的那几处:
//
//   1. 路由:depth 只走 depth 通道,Seedance 直连 / 平台网关一次都不碰,不论哪种计费;
//   2. 展示:没有画幅 / 时长参数,状态里是 `adaptive` / `-1`,而不是编出来的 16:9 / 5 秒
//      —— 预备卡片、真实任务、失败卡片三处同口径;
//   3. 校验:恰好一段源视频;带图 / 音频、多段视频都在提交前拦下,不打上游;
//   4. 完成:结果地址进 persistVideo,和别的模型一样落盘 + COS。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SeedanceTaskManager } from '../taskManager'
import type { SeedanceClient, SeedanceQueryResult } from '../client'
import type {
  CreateVideoTaskInput,
  SeedanceContentItem,
  SeedanceTaskUpdate,
  VideoBillingSource,
} from '../types'
import type { VideoTransport } from '../../videoTransport'
import { setSeedanceRegionMemory } from '../region'

const SOURCE = 'https://cos.example/relay/src.mp4'
const OUT = 'https://rh.example/out/depth.mp4'

const INPUT: CreateVideoTaskInput = {
  prompt: '深度捕捉',
  model: 'depth',
  resolution: '480p',
  referenceVideos: [SOURCE],
}
const CONTENT: SeedanceContentItem[] = [
  { type: 'text', text: '深度捕捉' },
  { type: 'video_url', role: 'reference_video', video_url: { url: SOURCE } },
]

function makeClient(): SeedanceClient {
  return {
    createTask: vi.fn(async () => ({ id: 'ark-should-not-be-used' })),
    queryTask: vi.fn(async () => ({ id: 'x', status: 'running' as const })),
    downloadVideo: vi.fn(async (_url: string, destPath: string) => destPath),
    deleteTask: vi.fn(async () => {}),
  }
}

function makeTransport(statuses: SeedanceQueryResult[]) {
  let i = 0
  return {
    requireApiKey: vi.fn(() => {}),
    createTask: vi.fn(async () => ({ id: 'task_depth_1' })),
    queryTask: vi.fn(async () => statuses[Math.min(i++, statuses.length - 1)]),
  } satisfies VideoTransport
}

describe('taskManager × depth', () => {
  let broadcasts: SeedanceTaskUpdate[]
  let persistVideo: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    broadcasts = []
    persistVideo = vi.fn(async () => ({ localPath: 'D:/save/depth.mp4', remoteUrl: 'https://cos/d.mp4' }))
    setSeedanceRegionMemory('global')
  })
  afterEach(() => {
    vi.useRealTimers()
    setSeedanceRegionMemory('global')
  })

  function makeManager(
    client: SeedanceClient,
    depthTransport: VideoTransport | undefined,
    extra: {
      seedanceGatewayTransport?: VideoTransport
      resolveBilling?: (prefer?: VideoBillingSource) => VideoBillingSource
    } = {},
  ) {
    return new SeedanceTaskManager({
      client,
      getApiKey: () => 'sk-test',
      persistVideo,
      broadcast: (u) => broadcasts.push(u),
      ...(depthTransport ? { depthTransport } : {}),
      ...extra,
    })
  }

  describe('路由', () => {
    it('走 depth 通道,Seedance 直连与平台网关一次都不碰', async () => {
      for (const billing of [undefined, 'own-key' as const, 'platform' as const]) {
        const client = makeClient()
        const depth = makeTransport([{ id: 'task_depth_1', status: 'running' }])
        const gateway = makeTransport([])
        const mgr = makeManager(client, depth, { seedanceGatewayTransport: gateway })

        const state = await mgr.submit({
          input: INPUT,
          content: CONTENT,
          ...(billing ? { billing } : {}),
        })

        expect(depth.createTask, String(billing)).toHaveBeenCalledTimes(1)
        expect(client.createTask, String(billing)).not.toHaveBeenCalled()
        expect(gateway.createTask, String(billing)).not.toHaveBeenCalled()
        expect(state.taskId).toBe('task_depth_1')
        mgr.dispose()
      }
    })

    it('transport 收到的是已解析的事实:分辨率与 content[]', async () => {
      const depth = makeTransport([{ id: 'task_depth_1', status: 'running' }])
      const mgr = makeManager(makeClient(), depth)

      await mgr.submit({ input: { ...INPUT, resolution: '1080p' }, content: CONTENT })

      const ctx = depth.createTask.mock.calls[0][0]
      expect(ctx.model).toBe('depth')
      expect(ctx.resolution).toBe('1080p')
      expect(ctx.content).toEqual(CONTENT)
      mgr.dispose()
    })

    it('depth 通道没接线时抛错,绝不回落 Seedance 直连', async () => {
      const client = makeClient()
      const mgr = makeManager(client, undefined)

      await expect(mgr.submit({ input: INPUT, content: CONTENT })).rejects.toThrow(/深度捕捉通道/)
      expect(client.createTask).not.toHaveBeenCalled()
      mgr.dispose()
    })

    it('密钥检查也问 depth 通道自己 —— 平台缺凭据别让人去填火山密钥', async () => {
      const client = makeClient()
      const depth = makeTransport([])
      depth.requireApiKey.mockImplementation(() => {
        throw new Error('平台余额未就绪：请先选择计费池')
      })
      const mgr = makeManager(client, depth)

      await expect(mgr.submit({ input: INPUT, content: CONTENT, billing: 'platform' })).rejects.toThrow(
        /计费池/,
      )
      expect(depth.createTask).not.toHaveBeenCalled()
      mgr.dispose()
    })
  })

  describe('状态展示:没有画幅 / 时长参数', () => {
    it('真实任务:ratio=adaptive、duration=-1,即使调用方传了别的', async () => {
      const depth = makeTransport([{ id: 'task_depth_1', status: 'running' }])
      const mgr = makeManager(makeClient(), depth)

      const state = await mgr.submit({
        input: { ...INPUT, ratio: '9:16', duration: 12 },
        content: CONTENT,
      })

      expect(state.ratio).toBe('adaptive')
      expect(state.duration).toBe(-1)
      expect(state.model).toBe('depth')
      expect(state.resolution).toBe('480p')
      mgr.dispose()
    })

    it('默认分辨率与别的模型一致:720p(三档产物与价格都一样,取中间档)', async () => {
      const depth = makeTransport([{ id: 'task_depth_1', status: 'running' }])
      const mgr = makeManager(makeClient(), depth)
      const { resolution: _drop, ...noRes } = INPUT
      const state = await mgr.submit({ input: noRes, content: CONTENT })
      expect(state.resolution).toBe('720p')
      mgr.dispose()
    })

    it('预备卡片与失败卡片同口径,气泡在提交前后不会跳', () => {
      const mgr = makeManager(makeClient(), makeTransport([]))

      const clientId = mgr.announcePreparing({ input: INPUT, threadId: 't1' })
      const prep = broadcasts.find((b) => b.taskId === clientId)!
      expect(prep.ratio).toBe('adaptive')
      expect(prep.duration).toBe(-1)

      mgr.announceFailed({ clientId, input: INPUT, threadId: 't1', error: 'boom' })
      const failed = broadcasts.filter((b) => b.taskId === clientId).pop()!
      expect(failed.status).toBe('failed')
      expect(failed.ratio).toBe('adaptive')
      expect(failed.duration).toBe(-1)
      mgr.dispose()
    })

    it('生成模型不受影响:预备卡片仍是 16:9 / 5s', () => {
      const mgr = makeManager(makeClient(), makeTransport([]))
      const clientId = mgr.announcePreparing({ input: { prompt: 'x', model: '2.0' } })
      const prep = broadcasts.find((b) => b.taskId === clientId)!
      expect(prep.ratio).toBe('16:9')
      expect(prep.duration).toBe(5)
      mgr.dispose()
    })
  })

  describe('提交前校验', () => {
    it('没有源视频 / 多段源视频 → 抛错,不打上游', async () => {
      const depth = makeTransport([])
      const mgr = makeManager(makeClient(), depth)

      await expect(
        mgr.submit({ input: INPUT, content: [{ type: 'text', text: 'x' }] }),
      ).rejects.toThrow(/一段源视频/)
      await expect(
        mgr.submit({
          input: INPUT,
          content: [
            ...CONTENT,
            { type: 'video_url', role: 'reference_video', video_url: { url: `${SOURCE}?2` } },
          ],
        }),
      ).rejects.toThrow(/一段源视频/)
      expect(depth.createTask).not.toHaveBeenCalled()
      mgr.dispose()
    })

    it('带了图片 / 音频 → 针对性报错', async () => {
      const depth = makeTransport([])
      const mgr = makeManager(makeClient(), depth)

      await expect(
        mgr.submit({
          input: INPUT,
          content: [...CONTENT, { type: 'image_url', role: 'reference_image', image_url: { url: 'https://a/1.png' } }],
        }),
      ).rejects.toThrow(/只接受一段源视频/)
      expect(depth.createTask).not.toHaveBeenCalled()
      mgr.dispose()
    })

    it('不认识的分辨率(4k)被拦', async () => {
      const depth = makeTransport([])
      const mgr = makeManager(makeClient(), depth)
      await expect(
        mgr.submit({ input: { ...INPUT, resolution: '4k' as never }, content: CONTENT }),
      ).rejects.toThrow(/4k/)
      expect(depth.createTask).not.toHaveBeenCalled()
      mgr.dispose()
    })
  })

  describe('完成', () => {
    it('成功后结果地址进 persistVideo,广播带本地路径与 COS 地址', async () => {
      const depth = makeTransport([
        { id: 'task_depth_1', status: 'running' },
        { id: 'task_depth_1', status: 'succeeded', content: { video_url: OUT } },
      ])
      const mgr = makeManager(makeClient(), depth)

      await mgr.submit({ input: INPUT, content: CONTENT, billing: 'platform' })
      await vi.advanceTimersByTimeAsync(30_000)

      expect(persistVideo).toHaveBeenCalledTimes(1)
      expect(persistVideo.mock.calls[0][0]).toMatchObject({
        videoUrl: OUT,
        model: 'depth',
        taskId: 'task_depth_1',
        billing: 'platform',
      })
      const last = broadcasts[broadcasts.length - 1]
      expect(last.status).toBe('succeeded')
      expect(last.localPath).toBe('D:/save/depth.mp4')
      expect(last.remoteUrl).toBe('https://cos/d.mp4')
      mgr.dispose()
    })

    it('上游失败 → 失败卡片带原因,不落盘', async () => {
      const depth = makeTransport([
        {
          id: 'task_depth_1',
          status: 'failed',
          error: { code: 'upstream_error', message: 'video too long' },
        },
      ])
      const mgr = makeManager(makeClient(), depth)

      await mgr.submit({ input: INPUT, content: CONTENT })
      await vi.advanceTimersByTimeAsync(30_000)

      const last = broadcasts[broadcasts.length - 1]
      expect(last.status).toBe('failed')
      expect(last.error).toMatch(/video too long/)
      expect(persistVideo).not.toHaveBeenCalled()
      mgr.dispose()
    })

    it('轮询认的是提交时那条 depth 通道,不会换成 Seedance 去查', async () => {
      const client = makeClient()
      const depth = makeTransport([{ id: 'task_depth_1', status: 'running' }])
      const mgr = makeManager(client, depth)

      await mgr.submit({ input: INPUT, content: CONTENT })
      await vi.advanceTimersByTimeAsync(20_000)

      expect(depth.queryTask).toHaveBeenCalled()
      expect(client.queryTask).not.toHaveBeenCalled()
      mgr.dispose()
    })
  })

  // 腾讯点播的视频深度估计很慢(实测 60 秒的片子 21~22 分钟),30 分钟的通用上限会把
  // 还在上游跑、也照样计费的任务提前判死。只给 depth 放宽到 50 分钟,别的模型不变。
  describe('轮询上限', () => {
    it('depth:30 分钟时仍在跑的任务不判死,仍在继续查询', async () => {
      const depth = makeTransport([{ id: 'task_depth_1', status: 'running' }])
      const mgr = makeManager(makeClient(), depth)

      await mgr.submit({ input: INPUT, content: CONTENT })
      await vi.advanceTimersByTimeAsync(31 * 60_000)

      expect(mgr.get('task_depth_1')?.status).not.toBe('failed')
      const callsAt31 = depth.queryTask.mock.calls.length
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(depth.queryTask.mock.calls.length).toBeGreaterThan(callsAt31)
      expect(mgr.get('task_depth_1')?.status).not.toBe('failed')
      mgr.dispose()
    })

    it('depth:第 22 分钟出结果(实测量级)照常成功落盘', async () => {
      let polls = 0
      const depth = {
        requireApiKey: vi.fn(() => {}),
        createTask: vi.fn(async () => ({ id: 'task_depth_1' })),
        queryTask: vi.fn(async (): Promise<SeedanceQueryResult> => {
          polls += 1
          // 6 秒一轮,第 22 分钟 ≈ 第 220 轮。
          return polls >= 220
            ? { id: 'task_depth_1', status: 'succeeded', content: { video_url: OUT } }
            : { id: 'task_depth_1', status: 'running' }
        }),
      } satisfies VideoTransport
      const mgr = makeManager(makeClient(), depth)

      await mgr.submit({ input: INPUT, content: CONTENT })
      await vi.advanceTimersByTimeAsync(25 * 60_000)

      expect(mgr.get('task_depth_1')?.status).toBe('succeeded')
      expect(persistVideo).toHaveBeenCalledTimes(1)
      mgr.dispose()
    })

    it('depth:超过 50 分钟才判超时,报文里写的是 50 分钟', async () => {
      const depth = makeTransport([{ id: 'task_depth_1', status: 'running' }])
      const mgr = makeManager(makeClient(), depth)

      await mgr.submit({ input: INPUT, content: CONTENT })
      await vi.advanceTimersByTimeAsync(51 * 60_000)

      const task = mgr.get('task_depth_1')
      expect(task?.status).toBe('failed')
      expect(task?.error).toContain('轮询超时')
      expect(task?.error).toContain('50 分钟')
      expect(persistVideo).not.toHaveBeenCalled()
      mgr.dispose()
    })

    it('其它模型仍是 30 分钟,报文写 30 分钟', async () => {
      const client = makeClient()
      const mgr = makeManager(client, undefined)

      await mgr.submit({ input: { prompt: '一只猫在雨里跳舞' }, content: [] })
      await vi.advanceTimersByTimeAsync(31 * 60_000)

      const task = mgr.get('ark-should-not-be-used')
      expect(task?.status).toBe('failed')
      expect(task?.error).toContain('30 分钟')
      mgr.dispose()
    })
  })
})
