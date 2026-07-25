// 任务生命周期:取消(cancel)与重启接管(adopt)。
//
// 取消的计费语义来自上游文档(火山方舟「取消或删除视频生成任务」):
// DELETE /api/v3/contents/generations/tasks/{id} 只对 queued 生效(转 cancelled,
// 不计费);running **不支持**,调了也没用 —— 所以 running 阶段的「取消」只能是
// 本地放弃(视频照样生成、照样计费)。billed 字段就是把这个差别如实带回渲染端,
// 让按钮文案能写清楚,而不是让用户误以为省了钱。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SeedanceTaskManager } from '../taskManager'
import type { SeedanceClient, SeedanceQueryResult } from '../client'
import type { CreateVideoTaskInput, SeedanceTaskUpdate } from '../types'
import { setSeedanceRegionMemory } from '../region'

const INPUT: CreateVideoTaskInput = { prompt: '一只猫在雨里跳舞' }

function makeClient(statuses: SeedanceQueryResult[]): SeedanceClient {
  let i = 0
  return {
    createTask: vi.fn(async () => ({ id: 'task-1' })),
    queryTask: vi.fn(async () => statuses[Math.min(i++, statuses.length - 1)]),
    downloadVideo: vi.fn(async () => Buffer.from('mp4')),
    deleteTask: vi.fn(async () => {}),
  }
}

describe('SeedanceTaskManager 生命周期', () => {
  let broadcasts: SeedanceTaskUpdate[]
  let persistVideo: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    broadcasts = []
    persistVideo = vi.fn(async () => ({ localPath: 'D:/save/video.mp4', remoteUrl: 'https://cos/v.mp4' }))
    setSeedanceRegionMemory('global')
  })

  afterEach(() => {
    vi.useRealTimers()
    setSeedanceRegionMemory('global')
  })

  function makeManager(client: SeedanceClient) {
    return new SeedanceTaskManager({
      client,
      getApiKey: () => 'sk-test',
      persistVideo,
      broadcast: (u) => broadcasts.push(u),
    })
  }

  describe('cancel', () => {
    it('queued 阶段:调上游 DELETE,落 cancelled 且不计费', async () => {
      const client = makeClient([{ id: 'task-1', status: 'queued' }])
      const mgr = makeManager(client)
      await mgr.submit({ input: INPUT, content: [] })

      const res = await mgr.cancel('task-1')

      expect(res).toMatchObject({ ok: true, billed: false })
      expect(client.deleteTask).toHaveBeenCalledWith('task-1', 'sk-test')
      expect(mgr.get('task-1')?.status).toBe('cancelled')
      expect(broadcasts.at(-1)).toMatchObject({ taskId: 'task-1', status: 'cancelled' })
      mgr.dispose()
    })

    it('running 阶段:不调上游(文档明确不支持),本地放弃并如实标记仍会计费', async () => {
      const client = makeClient([{ id: 'task-1', status: 'running' }])
      const mgr = makeManager(client)
      await mgr.submit({ input: INPUT, content: [] })
      await vi.advanceTimersByTimeAsync(6_000)
      expect(mgr.get('task-1')?.status).toBe('running')

      const res = await mgr.cancel('task-1')

      expect(res).toMatchObject({ ok: true, billed: true })
      expect(client.deleteTask).not.toHaveBeenCalled()
      expect(mgr.get('task-1')?.status).toBe('cancelled')
      mgr.dispose()
    })

    it('取消后在途的轮询结果不得复活任务', async () => {
      // 第一轮 running(让任务进 running),之后上游转 succeeded —— 取消后
      // 这条 succeeded 绝不能覆盖 cancelled,否则会触发落盘并写进历史。
      const client = makeClient([
        { id: 'task-1', status: 'running' },
        { id: 'task-1', status: 'succeeded', content: { video_url: 'https://cdn/v.mp4' } },
      ])
      const mgr = makeManager(client)
      await mgr.submit({ input: INPUT, content: [] })
      await vi.advanceTimersByTimeAsync(6_000)

      await mgr.cancel('task-1')
      await vi.advanceTimersByTimeAsync(30_000)

      expect(mgr.get('task-1')?.status).toBe('cancelled')
      expect(persistVideo).not.toHaveBeenCalled()
      expect(broadcasts.some((b) => b.status === 'succeeded')).toBe(false)
      mgr.dispose()
    })

    it('已成功的任务:取消是 no-op,不动状态', async () => {
      const client = makeClient([{ id: 'task-1', status: 'succeeded', content: { video_url: 'https://cdn/v.mp4' } }])
      const mgr = makeManager(client)
      await mgr.submit({ input: INPUT, content: [] })
      await vi.advanceTimersByTimeAsync(6_000)
      expect(mgr.get('task-1')?.status).toBe('succeeded')

      const res = await mgr.cancel('task-1')

      expect(res.ok).toBe(false)
      expect(res.reason).toBeTruthy()
      expect(client.deleteTask).not.toHaveBeenCalled()
      expect(mgr.get('task-1')?.status).toBe('succeeded')
      mgr.dispose()
    })

    it('未知 taskId:返回 ok:false 而非抛错', async () => {
      const mgr = makeManager(makeClient([]))
      const res = await mgr.cancel('nope')
      expect(res.ok).toBe(false)
      mgr.dispose()
    })

    it('上游 DELETE 失败:仍本地停下,但计费状态未知按「会计费」如实上报', async () => {
      const client = makeClient([{ id: 'task-1', status: 'queued' }])
      client.deleteTask = vi.fn(async () => {
        throw new Error('Seedance API 500: boom')
      })
      const mgr = makeManager(client)
      await mgr.submit({ input: INPUT, content: [] })

      const res = await mgr.cancel('task-1')

      expect(res).toMatchObject({ ok: true, billed: true })
      expect(res.reason).toContain('boom')
      expect(mgr.get('task-1')?.status).toBe('cancelled')
      mgr.dispose()
    })
  })

  describe('adopt(重启接管)', () => {
    it('重新登记任务并恢复轮询,succeeded 后照旧落盘 + 广播', async () => {
      const client = makeClient([{ id: 'task-9', status: 'succeeded', content: { video_url: 'https://cdn/v.mp4' } }])
      const mgr = makeManager(client)

      const adopted = mgr.adopt({
        taskId: 'task-9',
        clientId: 'wb-card-1',
        source: 'workbench',
        prompt: INPUT.prompt,
        model: '2.0',
        resolution: '720p',
        ratio: '16:9',
        duration: 5,
      })

      expect(adopted?.taskId).toBe('task-9')
      expect(adopted?.clientId).toBe('wb-card-1')
      expect(mgr.get('task-9')).toBeDefined()

      await vi.advanceTimersByTimeAsync(6_000)

      expect(mgr.get('task-9')?.status).toBe('succeeded')
      expect(persistVideo).toHaveBeenCalledTimes(1)
      const done = broadcasts.find((b) => b.persistence === 'done')
      expect(done).toMatchObject({ clientId: 'wb-card-1', source: 'workbench', localPath: 'D:/save/video.mp4' })
      mgr.dispose()
    })

    it('已在跟踪的 taskId 不重复接管(幂等,不起第二个轮询)', async () => {
      const client = makeClient([{ id: 'task-1', status: 'running' }])
      const mgr = makeManager(client)
      await mgr.submit({ input: INPUT, content: [] })

      const again = mgr.adopt({
        taskId: 'task-1',
        prompt: INPUT.prompt,
        model: '2.0',
        resolution: '720p',
        ratio: '16:9',
        duration: 5,
      })

      expect(again).toBeUndefined()
      await vi.advanceTimersByTimeAsync(6_000)
      // 只有一个轮询循环在跑 → 一个 6s 周期只查一次
      expect(client.queryTask).toHaveBeenCalledTimes(1)
      mgr.dispose()
    })

    it('接管后立刻可被取消(queued 档真取消)', async () => {
      const client = makeClient([{ id: 'task-9', status: 'queued' }])
      const mgr = makeManager(client)
      mgr.adopt({
        taskId: 'task-9',
        prompt: INPUT.prompt,
        model: '2.0',
        resolution: '720p',
        ratio: '16:9',
        duration: 5,
      })

      const res = await mgr.cancel('task-9')

      expect(res).toMatchObject({ ok: true, billed: false })
      expect(client.deleteTask).toHaveBeenCalledWith('task-9', 'sk-test')
      mgr.dispose()
    })
  })
})
