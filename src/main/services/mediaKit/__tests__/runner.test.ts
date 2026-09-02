// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const { relayFileToCosMock } = vi.hoisted(() => ({ relayFileToCosMock: vi.fn() }))
vi.mock('../../tencent/mediaRelay', () => ({ relayFileToCos: relayFileToCosMock }))

import {
  MEDIAKIT_POLL_MAX_CONSECUTIVE_FAILURES,
  mediaKitPollIntervalMs,
  runMediaKitProcessAndPoll,
  runMediaKitUpload,
} from '../runner'
import type { MediaKitClient } from '../client'

const auth = () => ({ Authorization: 'Bearer k' })

describe('runMediaKitUpload', () => {
  it('走视频工作台共用的中转函数,带上 fileSize 让超时随体积放大', async () => {
    relayFileToCosMock.mockResolvedValue('https://relay/v.mp4')
    const r = await runMediaKitUpload(
      { filePath: 'C:/v/a.mov', filename: 'a.mov', fileSize: 123 },
      new AbortController().signal,
    )
    expect(r).toEqual({ sourceUrl: 'https://relay/v.mp4' })
    expect(relayFileToCosMock).toHaveBeenCalledWith('C:/v/a.mov', 'video/quicktime', { fileSize: 123 })
  })

  it('中转失败如实报 RELAY_UPLOAD_FAILED —— 没有 base64 兜底,上游拉不了 data:', async () => {
    relayFileToCosMock.mockRejectedValue(new Error('COS down'))
    await expect(
      runMediaKitUpload({ filePath: 'x', filename: 'x.mp4', fileSize: 1 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'RELAY_UPLOAD_FAILED', stage: 'upload' })
  })
})

describe('runMediaKitProcessAndPoll', () => {
  const fastSleep = () => {
    // 把轮询间隔压到 0,测试不真等。
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0 as any }) as any)
  }

  it('提交 → 轮询到 succeeded → 返回上游 URL 与任务号', async () => {
    fastSleep()
    const client: MediaKitClient = {
      submit: vi.fn().mockResolvedValue({ id: 'task_1' }),
      query: vi.fn()
        .mockResolvedValueOnce({ id: 'task_1', status: 'queued' })
        .mockResolvedValueOnce({ id: 'task_1', status: 'running', progress: 50 })
        .mockResolvedValueOnce({ id: 'task_1', status: 'succeeded', videoUrl: 'https://o/1.mp4' }),
    }
    const progress: unknown[] = []
    const r = await runMediaKitProcessAndPoll(
      client, auth,
      { model: 'volc-enhance-video', sourceUrl: 'https://s/v.mp4', options: {} },
      new AbortController().signal,
      { onProgress: (p) => progress.push(p) },
    )
    expect(r).toEqual({ videoUrl: 'https://o/1.mp4', taskId: 'task_1' })
    expect(progress[0]).toEqual({ stage: 'submitting' })
    expect(progress).toContainEqual({ stage: 'processing', taskId: 'task_1', progress: 50 })
    vi.restoreAllMocks()
  })

  it(`连续查询失败 ${MEDIAKIT_POLL_MAX_CONSECUTIVE_FAILURES} 次才认输;中途一次成功就清零`, async () => {
    // 2026-09-01 实测:60 轮里 502 了 9 次,全是瞬时的。一抖就报失败等于丢掉一笔已扣的钱。
    fastSleep()
    const query = vi.fn()
    for (let i = 0; i < MEDIAKIT_POLL_MAX_CONSECUTIVE_FAILURES - 1; i++) query.mockRejectedValueOnce(new Error('502'))
    query.mockResolvedValueOnce({ id: 't', status: 'running' }) // 清零
    for (let i = 0; i < MEDIAKIT_POLL_MAX_CONSECUTIVE_FAILURES - 1; i++) query.mockRejectedValueOnce(new Error('502'))
    query.mockResolvedValueOnce({ id: 't', status: 'succeeded', videoUrl: 'https://o/ok.mp4' })

    const client: MediaKitClient = { submit: vi.fn().mockResolvedValue({ id: 't' }), query }
    const r = await runMediaKitProcessAndPoll(
      client, auth, { model: 'volc-enhance-video', sourceUrl: 'https://s', options: {} }, new AbortController().signal,
    )
    expect(r.videoUrl).toBe('https://o/ok.mp4')
    vi.restoreAllMocks()
  })

  it('单次 502 绝不让任务失败 —— 这条不从常量推,写死', async () => {
    // 上面那条用 MEDIAKIT_POLL_MAX_CONSECUTIVE_FAILURES 推期望,常量改成 1 它照样绿。
    // 而「一抖就丢掉一笔已扣的钱」正是要防的事,所以这里用具体数字钉住下限。
    fastSleep()
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('502'))
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValueOnce({ id: 't', status: 'succeeded', videoUrl: 'https://o/ok.mp4' })
    const client: MediaKitClient = { submit: vi.fn().mockResolvedValue({ id: 't' }), query }
    const r = await runMediaKitProcessAndPoll(
      client, auth, { model: 'volc-enhance-video', sourceUrl: 'https://s', options: {} }, new AbortController().signal,
    )
    expect(r.videoUrl).toBe('https://o/ok.mp4')
    expect(MEDIAKIT_POLL_MAX_CONSECUTIVE_FAILURES).toBeGreaterThanOrEqual(3)
    vi.restoreAllMocks()
  })

  it('连续失败到上限 → MEDIAKIT_POLL_FAILED', async () => {
    fastSleep()
    const query = vi.fn().mockRejectedValue(new Error('502 Bad Gateway'))
    const client: MediaKitClient = { submit: vi.fn().mockResolvedValue({ id: 't' }), query }
    await expect(
      runMediaKitProcessAndPoll(client, auth, { model: 'volc-enhance-video', sourceUrl: 'https://s', options: {} }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'MEDIAKIT_POLL_FAILED' })
    expect(query).toHaveBeenCalledTimes(MEDIAKIT_POLL_MAX_CONSECUTIVE_FAILURES)
    vi.restoreAllMocks()
  })

  it('上游失败:把它的错误码与文案原样抛给用户', async () => {
    fastSleep()
    const client: MediaKitClient = {
      submit: vi.fn().mockResolvedValue({ id: 't' }),
      query: vi.fn().mockResolvedValue({ id: 't', status: 'failed', error: { code: 'DownloadFileError', message: '403 Forbidden' } }),
    }
    await expect(
      runMediaKitProcessAndPoll(client, auth, { model: 'volc-enhance-video', sourceUrl: 'https://s', options: {} }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'MEDIAKIT_TASK_FAILED', message: 'DownloadFileError: 403 Forbidden' })
    vi.restoreAllMocks()
  })

  it('取消信号在轮询间隙生效 → TASK_CANCELLED', async () => {
    fastSleep()
    const ac = new AbortController()
    const client: MediaKitClient = {
      submit: vi.fn().mockResolvedValue({ id: 't' }),
      query: vi.fn().mockImplementation(async () => { ac.abort(); return { id: 't', status: 'running' } }),
    }
    await expect(
      runMediaKitProcessAndPoll(client, auth, { model: 'volc-enhance-video', sourceUrl: 'https://s', options: {} }, ac.signal),
    ).rejects.toMatchObject({ code: 'TASK_CANCELLED' })
    vi.restoreAllMocks()
  })

  it('每轮现取鉴权头 —— 用户中途切计费模式,下一轮就记到新归属', async () => {
    fastSleep()
    const resolveAuth = vi.fn().mockReturnValue({ Authorization: 'Bearer k' })
    const client: MediaKitClient = {
      submit: vi.fn().mockResolvedValue({ id: 't' }),
      query: vi.fn()
        .mockResolvedValueOnce({ id: 't', status: 'running' })
        .mockResolvedValueOnce({ id: 't', status: 'succeeded', videoUrl: 'u' }),
    }
    await runMediaKitProcessAndPoll(client, resolveAuth, { model: 'volc-enhance-video', sourceUrl: 's', options: {} }, new AbortController().signal)
    expect(resolveAuth).toHaveBeenCalledTimes(3) // 1 提交 + 2 轮询
    vi.restoreAllMocks()
  })

  it('轮询间隔指数退避并封顶', () => {
    expect(mediaKitPollIntervalMs(1)).toBe(5_000)
    expect(mediaKitPollIntervalMs(2)).toBe(7_000)
    expect(mediaKitPollIntervalMs(20)).toBe(30_000)
  })
})
