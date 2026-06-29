import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SeedanceTaskManager } from '../taskManager'
import type { SeedanceClient, SeedanceQueryResult } from '../client'
import type { CreateVideoTaskInput, SeedanceTaskUpdate } from '../types'

const INPUT: CreateVideoTaskInput = { prompt: '一只猫在雨里跳舞' }

function makeClient(statuses: SeedanceQueryResult[]): SeedanceClient {
  let i = 0
  return {
    createTask: vi.fn(async () => ({ id: 'task-1' })),
    queryTask: vi.fn(async () => statuses[Math.min(i++, statuses.length - 1)]),
    downloadVideo: vi.fn(async () => Buffer.from('mp4')),
  }
}

describe('SeedanceTaskManager', () => {
  let broadcasts: SeedanceTaskUpdate[]
  let persistVideo: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    broadcasts = []
    persistVideo = vi.fn(async () => ({ localPath: 'D:/save/video.mp4', remoteUrl: 'https://cos/v.mp4' }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeManager(client: SeedanceClient) {
    return new SeedanceTaskManager({
      client,
      getApiKey: () => 'sk-test',
      persistVideo,
      broadcast: (u) => broadcasts.push(u),
    })
  }

  it('submit 立即返回 queued 并广播', async () => {
    const mgr = makeManager(makeClient([{ id: 'task-1', status: 'running' }]))
    const state = await mgr.submit({ input: INPUT, content: [{ type: 'text', text: INPUT.prompt }], threadId: 'th-1' })
    expect(state.taskId).toBe('task-1')
    expect(state.status).toBe('queued')
    expect(state.threadId).toBe('th-1')
    expect(broadcasts).toHaveLength(1)
    mgr.dispose()
  })

  it('announcePreparing 广播 queued 预备卡片并返回 clientId，不创建轮询任务', () => {
    const mgr = makeManager(makeClient([]))
    const clientId = mgr.announcePreparing({ input: INPUT, threadId: 'th-1' })
    expect(clientId).toMatch(/^pending-/)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toMatchObject({
      taskId: clientId,
      clientId,
      status: 'queued',
      threadId: 'th-1',
      prompt: INPUT.prompt,
      persistence: 'idle',
    })
    expect(mgr.get(clientId)).toBeUndefined() // 没有真实任务被登记
    mgr.dispose()
  })

  it('announceFailed 广播 failed 卡片并带错误信息', () => {
    const mgr = makeManager(makeClient([]))
    mgr.announceFailed({ clientId: 'pending-x', input: INPUT, threadId: 'th-1', error: 'boom' })
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toMatchObject({
      taskId: 'pending-x',
      clientId: 'pending-x',
      status: 'failed',
      error: 'boom',
    })
    mgr.dispose()
  })

  it('submit 把 clientId 写进任务状态与每条广播', async () => {
    const mgr = makeManager(makeClient([{ id: 'task-1', status: 'running' }]))
    const state = await mgr.submit({ input: INPUT, content: [], threadId: 'th-1', clientId: 'pending-x' })
    expect(state.clientId).toBe('pending-x')
    expect(broadcasts[0]).toMatchObject({ taskId: 'task-1', clientId: 'pending-x', status: 'queued' })
    mgr.dispose()
  })

  it('无 API Key 时 submit 报 SEEDANCE_KEY_MISSING', async () => {
    const mgr = new SeedanceTaskManager({
      client: makeClient([]),
      getApiKey: () => '',
      persistVideo,
      broadcast: () => {},
    })
    await expect(
      mgr.submit({ input: INPUT, content: [] }),
    ).rejects.toThrow('SEEDANCE_KEY_MISSING')
  })

  it('queued→running→succeeded 全流程：落盘成功后 persistence done + localPath', async () => {
    const mgr = makeManager(
      makeClient([
        { id: 'task-1', status: 'running' },
        { id: 'task-1', status: 'succeeded', content: { video_url: 'https://cdn/v.mp4' } },
      ]),
    )
    await mgr.submit({ input: INPUT, content: [] })

    await vi.advanceTimersByTimeAsync(6_000) // → running
    expect(mgr.get('task-1')?.status).toBe('running')

    await vi.advanceTimersByTimeAsync(6_000) // → succeeded + persist
    const t = mgr.get('task-1')!
    expect(t.status).toBe('succeeded')
    expect(t.videoUrl).toBe('https://cdn/v.mp4')
    expect(t.persistence).toBe('done')
    expect(t.localPath).toBe('D:/save/video.mp4')
    expect(t.remoteUrl).toBe('https://cos/v.mp4')
    // 广播链：queued → running → succeeded(persist running) → persist done
    expect(broadcasts.map((b) => `${b.status}/${b.persistence}`)).toEqual([
      'queued/idle',
      'running/idle',
      'succeeded/running',
      'succeeded/done',
    ])
    mgr.dispose()
  })

  it('落盘失败不影响任务 succeeded（persistence failed）', async () => {
    persistVideo.mockRejectedValueOnce(new Error('disk full'))
    const mgr = makeManager(
      makeClient([{ id: 'task-1', status: 'succeeded', content: { video_url: 'https://cdn/v.mp4' } }]),
    )
    await mgr.submit({ input: INPUT, content: [] })
    await vi.advanceTimersByTimeAsync(6_000)
    const t = mgr.get('task-1')!
    expect(t.status).toBe('succeeded')
    expect(t.persistence).toBe('failed')
    expect(t.videoUrl).toBe('https://cdn/v.mp4')
    mgr.dispose()
  })

  it('failed 透传上游 error code/message', async () => {
    const mgr = makeManager(
      makeClient([
        { id: 'task-1', status: 'failed', error: { code: 'OutputVideoSensitive', message: '内容审核未通过' } },
      ]),
    )
    await mgr.submit({ input: INPUT, content: [] })
    await vi.advanceTimersByTimeAsync(6_000)
    const t = mgr.get('task-1')!
    expect(t.status).toBe('failed')
    expect(t.error).toContain('OutputVideoSensitive')
    expect(t.error).toContain('内容审核未通过')
    mgr.dispose()
  })

  it('单次 queryTask 网络抖动不判死刑，下一轮继续', async () => {
    const client = makeClient([{ id: 'task-1', status: 'succeeded', content: { video_url: 'https://cdn/v.mp4' } }])
    ;(client.queryTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ETIMEDOUT'))
    const mgr = makeManager(client)
    await mgr.submit({ input: INPUT, content: [] })
    await vi.advanceTimersByTimeAsync(6_000) // 抖动，仍 queued
    expect(mgr.get('task-1')?.status).toBe('queued')
    await vi.advanceTimersByTimeAsync(6_000) // 恢复 → succeeded
    expect(mgr.get('task-1')?.status).toBe('succeeded')
    mgr.dispose()
  })

  it('waitForChange：状态变化立即返回，不等满超时', async () => {
    const mgr = makeManager(
      makeClient([{ id: 'task-1', status: 'succeeded', content: { video_url: 'https://cdn/v.mp4' } }]),
    )
    await mgr.submit({ input: INPUT, content: [] })

    const waitPromise = mgr.waitForChange('task-1', 25_000)
    await vi.advanceTimersByTimeAsync(6_000) // 轮询命中 succeeded → 唤醒 waiter
    const snap = await waitPromise
    expect(snap?.status).toBe('succeeded')
    mgr.dispose()
  })

  it('waitForChange：无变化时超时返回当前快照', async () => {
    const mgr = makeManager(makeClient([{ id: 'task-1', status: 'queued' }]))
    await mgr.submit({ input: INPUT, content: [] })
    const waitPromise = mgr.waitForChange('task-1', 3_000)
    await vi.advanceTimersByTimeAsync(3_000)
    const snap = await waitPromise
    expect(snap?.status).toBe('queued')
    mgr.dispose()
  })

  it('waitForChange：终态任务直接返回，不挂起', async () => {
    const mgr = makeManager(
      makeClient([{ id: 'task-1', status: 'failed', error: { message: 'boom' } }]),
    )
    await mgr.submit({ input: INPUT, content: [] })
    await vi.advanceTimersByTimeAsync(6_000)
    const snap = await mgr.waitForChange('task-1', 25_000) // 不推进时钟也应立即返回
    expect(snap?.status).toBe('failed')
    mgr.dispose()
  })

  it('未知 taskId 返回 undefined', async () => {
    const mgr = makeManager(makeClient([]))
    expect(mgr.get('nope')).toBeUndefined()
    expect(await mgr.waitForChange('nope', 1_000)).toBeUndefined()
    mgr.dispose()
  })

  it('终态后 30 分钟清理任务', async () => {
    const mgr = makeManager(
      makeClient([{ id: 'task-1', status: 'failed', error: { message: 'boom' } }]),
    )
    await mgr.submit({ input: INPUT, content: [] })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(mgr.get('task-1')).toBeDefined()
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(mgr.get('task-1')).toBeUndefined()
    mgr.dispose()
  })
})
