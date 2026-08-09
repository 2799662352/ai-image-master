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
    downloadVideo: vi.fn(async (_url: string, destPath: string) => destPath),
    deleteTask: vi.fn(async () => {}),
  }
}

describe('SeedanceTaskManager', () => {
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

  it('submit 立即返回 queued 并广播', async () => {
    const mgr = makeManager(makeClient([{ id: 'task-1', status: 'running' }]))
    const state = await mgr.submit({ input: INPUT, content: [{ type: 'text', text: INPUT.prompt }], threadId: 'th-1' })
    expect(state.taskId).toBe('task-1')
    expect(state.status).toBe('queued')
    expect(state.threadId).toBe('th-1')
    expect(broadcasts).toHaveLength(1)
    mgr.dispose()
  })

  it('submit 按 region 选择上游模型 ID（默认 global=dreamina）', async () => {
    const client = makeClient([{ id: 'task-1', status: 'running' }])
    const mgr = makeManager(client)
    await mgr.submit({ input: { ...INPUT, model: '2.0' }, content: [] })
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'dreamina-seedance-2-0-260128' }),
      'sk-test',
    )
    setSeedanceRegionMemory('cn')
    await mgr.submit({ input: { ...INPUT, model: '2.0-fast' }, content: [] })
    expect(client.createTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'doubao-seedance-2-0-fast-260128' }),
      'sk-test',
    )
    mgr.dispose()
  })

  it('submit 支持 2.0-mini 别名与智能时长 duration=-1', async () => {
    const client = makeClient([{ id: 'task-1', status: 'running' }])
    const mgr = makeManager(client)
    await mgr.submit({ input: { ...INPUT, model: '2.0-mini', duration: -1 }, content: [] })
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'dreamina-seedance-2-0-mini-260615', duration: -1 }),
      'sk-test',
    )
    mgr.dispose()
  })

  it('submit 支持 2.5 与 30 秒时长', async () => {
    const client = makeClient([{ id: 'task-1', status: 'running' }])
    const mgr = makeManager(client)
    await mgr.submit({ input: { ...INPUT, model: '2.5', duration: 30 }, content: [] })
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'dreamina-seedance-2-5-260628', duration: 30 }),
      'sk-test',
    )
    mgr.dispose()
  })

  it('taskMode 透传并强制 adaptive 比例（文档 4.9）', async () => {
    const client = makeClient([{ id: 'task-1', status: 'running' }])
    const mgr = makeManager(client)
    await mgr.submit({
      input: { ...INPUT, model: '2.5', taskMode: 'extend', duration: 20, ratio: '16:9' },
      // 校验按真正会发出去的 content[] 数素材，不看入参字段 —— 所以这里得给真视频项。
      content: [{ type: 'video_url', video_url: { url: 'https://x/v.mp4' } }],
    })
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskMode: 'extend', ratio: 'adaptive' }),
      'sk-test',
    )
    mgr.dispose()
  })

  it('不传 taskMode 时请求体里完全没有这个字段（兼容旧上游）', async () => {
    const client = makeClient([{ id: 'task-1', status: 'running' }])
    const mgr = makeManager(client)
    await mgr.submit({ input: { ...INPUT, model: '2.0' }, content: [] })
    const body = (client.createTask as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]
    expect(Object.hasOwn(body as object, 'taskMode')).toBe(false)
    mgr.dispose()
  })

  it('提交前按模型能力拦下非法组合，不打上游', async () => {
    const client = makeClient([{ id: 'task-1', status: 'running' }])
    const mgr = makeManager(client)
    // 30 秒是 2.5 的上限，2.0 只到 15。
    await expect(
      mgr.submit({ input: { ...INPUT, model: '2.0', duration: 30 }, content: [] }),
    ).rejects.toThrow(/4-15/)
    // edit 必须带视频参考。
    await expect(
      mgr.submit({ input: { ...INPUT, model: '2.5', taskMode: 'edit', duration: -1 }, content: [] }),
    ).rejects.toThrow(/视频/)
    expect(client.createTask).not.toHaveBeenCalled()
    mgr.dispose()
  })

  it('succeeded 透传上游实际 seed 与 completion_tokens(计费口径)', async () => {
    const mgr = makeManager(
      makeClient([
        {
          id: 'task-1',
          status: 'succeeded',
          content: { video_url: 'https://cdn/v.mp4' },
          seed: 123456789,
          usage: { completion_tokens: 81234, total_tokens: 81234 },
        },
      ]),
    )
    await mgr.submit({ input: INPUT, content: [] })
    await vi.advanceTimersByTimeAsync(6_000)
    const t = mgr.get('task-1')!
    expect(t.actualSeed).toBe(123456789)
    expect(t.completionTokens).toBe(81234)
    // succeeded 那条广播也带上(渲染端卡片直接消费)
    const succeededBroadcast = broadcasts.find((b) => b.status === 'succeeded')
    expect(succeededBroadcast).toMatchObject({ actualSeed: 123456789, completionTokens: 81234 })
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
      // 预备卡片带 client-only 'preparing' 相位，渲染端据此显示「正在准备素材…」
      // 而非与上游 queued 同形的「排队中」。
      phase: 'preparing',
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
    // 真实任务广播不带 preparing 相位（只有 announcePreparing 的预备卡片才带）。
    expect(broadcasts[0].phase).toBeUndefined()
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

  /**
   * 落盘失败此前是一次定生死:几秒内试三次，然后永久 persistence='failed'，本地和
   * COS 都没副本，只剩上游那条一天后过期的地址。用户过几小时回来点播放，视频就
   * "没了"，而重生成要花钱。上游地址有效期整整一天，几秒就放弃是把窗口扔了。
   */
  it('落盘失败后在后台继续重试，成功则原地升级回 done', async () => {
    persistVideo
      .mockRejectedValueOnce(new Error('ERR_CONNECTION_CLOSED'))
      .mockResolvedValueOnce({ localPath: 'D:/save/v.mp4', remoteUrl: 'https://cos/v.mp4' })
    const mgr = makeManager(
      makeClient([{ id: 'task-1', status: 'succeeded', content: { video_url: 'https://cdn/v.mp4' } }]),
    )
    await mgr.submit({ input: INPUT, content: [] })
    await vi.advanceTimersByTimeAsync(6_000)
    // 第一轮失败：如实标 failed，界面要能显示「没保存下来」，不能因为后台还在试就装没事。
    expect(mgr.get('task-1')!.persistence).toBe('failed')

    // 一分钟后的后台重试成功 → 原地升级。
    await vi.advanceTimersByTimeAsync(60_000)
    const t = mgr.get('task-1')!
    expect(t.persistence).toBe('done')
    expect(t.localPath).toBe('D:/save/v.mp4')
    expect(t.remoteUrl).toBe('https://cos/v.mp4')
    mgr.dispose()
  })

  it('后台重试用尽后停手，不无限重试', async () => {
    persistVideo.mockRejectedValue(new Error('disk full'))
    const mgr = makeManager(
      makeClient([{ id: 'task-1', status: 'succeeded', content: { video_url: 'https://cdn/v.mp4' } }]),
    )
    await mgr.submit({ input: INPUT, content: [] })
    await vi.advanceTimersByTimeAsync(6_000)
    // 1 + 5 + 15 分钟三轮重试后应当停手（再多也没意义:任务 30 分钟后就被清理了）。
    await vi.advanceTimersByTimeAsync(25 * 60_000)
    expect(persistVideo).toHaveBeenCalledTimes(4) // 首次 + 3 轮重试
    expect(mgr.get('task-1')?.persistence ?? 'failed').toBe('failed')
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
