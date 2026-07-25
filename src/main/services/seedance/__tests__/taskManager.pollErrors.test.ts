// 轮询失败的分类处理。
//
// 原实现对 queryTask 的任何异常一律 `continue` + 固定 6s 重试：401/403/404 这类
// 永不自愈的错误会被当成网络抖动，重试约 300 次耗满 30 分钟，最后报一句与真实
// 原因无关的「轮询超时」，真因只进 console.warn。重启接管（adopt）一个上游早已
// 清理掉的任务时必然踩到这条路径。
//
// 这里钉住三件事：永久错误立刻如实失败；暂时错误仍然重试；持续失败要退避，
// 且超时报告必须带上最后一次的真实失败原因。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SeedanceTaskManager } from '../taskManager'
import { SeedanceApiError } from '../client'
import type { SeedanceClient, SeedanceQueryResult } from '../client'
import type { CreateVideoTaskInput, SeedanceTaskUpdate } from '../types'
import { setSeedanceRegionMemory } from '../region'

const INPUT: CreateVideoTaskInput = { prompt: '一只猫在雨里跳舞' }

const SUCCEEDED: SeedanceQueryResult = {
  id: 'task-1',
  status: 'succeeded',
  content: { video_url: 'https://upstream/v.mp4' },
}

function makeClient(queryTask: SeedanceClient['queryTask']): SeedanceClient {
  return {
    createTask: vi.fn(async () => ({ id: 'task-1' })),
    queryTask,
    downloadVideo: vi.fn(async () => Buffer.from('mp4')),
    deleteTask: vi.fn(async () => {}),
  }
}

/** 每次都抛同一个上游错误。 */
function alwaysFails(status: number, message: string, retryAfterMs?: number): SeedanceClient['queryTask'] {
  return vi.fn(async () => {
    throw new SeedanceApiError(message, status, retryAfterMs)
  })
}

describe('SeedanceTaskManager 轮询失败分类', () => {
  let broadcasts: SeedanceTaskUpdate[]

  beforeEach(() => {
    vi.useFakeTimers()
    broadcasts = []
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
      persistVideo: vi.fn(async () => ({ localPath: 'D:/save/v.mp4' })),
      broadcast: (u) => broadcasts.push(u),
      // 退避抖动固定为 0，让等待时长在用例里可精确断言。
      random: () => 0,
    })
  }

  const ADOPT = {
    taskId: 'task-old',
    prompt: '隔夜任务',
    model: '2.0' as const,
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
  }

  it('401：密钥失效立刻失败并如实报错，不再重试', async () => {
    const client = makeClient(alwaysFails(401, 'Seedance API 401: invalid api key'))
    const mgr = makeManager(client)
    await mgr.submit({ input: INPUT, content: [] })

    await vi.advanceTimersByTimeAsync(6_000)

    const task = mgr.get('task-1')
    expect(task?.status).toBe('failed')
    expect(task?.error).toContain('401')
    expect(task?.error).toContain('invalid api key')

    // 关键：不能再花 30 分钟重试一个永远不会好的错误。
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(client.queryTask).toHaveBeenCalledTimes(1)
  })

  it('404：重启接管到已被上游清理的任务，立刻失败而不是转圈 30 分钟', async () => {
    const client = makeClient(alwaysFails(404, 'Seedance API 404: task not found'))
    const mgr = makeManager(client)
    mgr.adopt(ADOPT)

    await vi.advanceTimersByTimeAsync(6_000)

    const task = mgr.get('task-old')
    expect(task?.status).toBe('failed')
    expect(task?.error).toContain('404')
    expect(client.queryTask).toHaveBeenCalledTimes(1)
  })

  it('5xx：上游暂时故障仍然重试，恢复后照常出结果', async () => {
    let calls = 0
    const client = makeClient(vi.fn(async () => {
      calls += 1
      if (calls <= 2) throw new SeedanceApiError('Seedance API 503: upstream busy', 503)
      return SUCCEEDED
    }))
    const mgr = makeManager(client)
    await mgr.submit({ input: INPUT, content: [] })

    await vi.advanceTimersByTimeAsync(6_000) // 第 1 次失败
    expect(mgr.get('task-1')?.status).toBe('queued')
    await vi.advanceTimersByTimeAsync(6_000) // 第 2 次失败（首次重试保持原节奏）
    expect(mgr.get('task-1')?.status).toBe('queued')
    await vi.advanceTimersByTimeAsync(9_000) // 退避后第 3 次 → 成功

    expect(mgr.get('task-1')?.status).toBe('succeeded')
  })

  it('连续失败逐步退避，不再每 6 秒硬敲上游', async () => {
    const client = makeClient(alwaysFails(503, 'Seedance API 503: upstream busy'))
    const mgr = makeManager(client)
    await mgr.submit({ input: INPUT, content: [] })

    await vi.advanceTimersByTimeAsync(6_000)
    expect(client.queryTask).toHaveBeenCalledTimes(1)

    // 单次抖动的语义保留：第一次重试仍按基础间隔。
    await vi.advanceTimersByTimeAsync(6_000)
    expect(client.queryTask).toHaveBeenCalledTimes(2)

    // 第二次之后开始退避：6s 不够，需要 9s。
    await vi.advanceTimersByTimeAsync(6_000)
    expect(client.queryTask).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(client.queryTask).toHaveBeenCalledTimes(3)
  })

  it('429：按上游 Retry-After 等待，而不是继续 6 秒一次', async () => {
    let calls = 0
    const client = makeClient(vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new SeedanceApiError('Seedance API 429: rate limited', 429, 20_000)
      return SUCCEEDED
    }))
    const mgr = makeManager(client)
    await mgr.submit({ input: INPUT, content: [] })

    await vi.advanceTimersByTimeAsync(6_000)
    expect(client.queryTask).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(6_000)
    expect(client.queryTask).toHaveBeenCalledTimes(1) // 仍在等 Retry-After

    await vi.advanceTimersByTimeAsync(14_000)
    expect(client.queryTask).toHaveBeenCalledTimes(2)
    expect(mgr.get('task-1')?.status).toBe('succeeded')
  })

  it('超时收场时带上最后一次的真实失败原因', async () => {
    const client = makeClient(alwaysFails(503, 'Seedance API 503: upstream busy'))
    const mgr = makeManager(client)
    await mgr.submit({ input: INPUT, content: [] })

    await vi.advanceTimersByTimeAsync(31 * 60_000)

    const task = mgr.get('task-1')
    expect(task?.status).toBe('failed')
    expect(task?.error).toContain('轮询超时')
    expect(task?.error).toContain('503') // 真因不能只留在 console.warn 里
  })

  it('普通网络错误（无状态码）仍视为可重试', async () => {
    let calls = 0
    const client = makeClient(vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('ETIMEDOUT')
      return SUCCEEDED
    }))
    const mgr = makeManager(client)
    await mgr.submit({ input: INPUT, content: [] })

    await vi.advanceTimersByTimeAsync(6_000)
    expect(mgr.get('task-1')?.status).toBe('queued')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(mgr.get('task-1')?.status).toBe('succeeded')
  })
})
