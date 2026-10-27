// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  buildMediaKitSubmitBody,
  createMediaKitClient,
  parseMediaKitTaskResult,
} from '../client'

const auth = { Authorization: 'Bearer k' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('buildMediaKitSubmitBody', () => {
  it('把 URL 放进网关唯一认的位置:metadata.content[].video_url.url', () => {
    // 2026-09-01 实测:放 body.video_url / body.input_video 都回
    // `extract video_url failed: metadata missing`。适配器只从这一处抽。
    const body = buildMediaKitSubmitBody('volc-enhance-video', 'https://x/v.mp4', {})
    expect(body).toEqual({
      model: 'volc-enhance-video',
      metadata: { content: [{ type: 'video_url', video_url: { url: 'https://x/v.mp4' } }] },
    })
  })

  it('高清参数只写用户给了的键 —— 缺省交给网关,不把它的默认硬编码进来', () => {
    const body = buildMediaKitSubmitBody('volc-enhance-video', 'https://x/v.mp4', { resolution: '4k', fps: 60 })
    expect((body.metadata as any).resolution).toBe('4k')
    expect((body.metadata as any).fps).toBe(60)
    expect(body.metadata).not.toHaveProperty('tool_version')
    expect(body.metadata).not.toHaveProperty('scene')
  })

  it('去字幕 Pro 没有可调参数:给了也不带', () => {
    const body = buildMediaKitSubmitBody('volc-erase-subtitle-pro', 'https://x/v.mp4', { resolution: '4k' })
    expect(body.metadata).not.toHaveProperty('resolution')
  })
})

describe('parseMediaKitTaskResult', () => {
  it('OpenAI video 对象 → 内部状态;结果在 metadata.url', () => {
    // 形状来自网关真实返回(2026-09-01 测试网关)。
    expect(parseMediaKitTaskResult({
      id: 'task_1', object: 'video', status: 'in_progress', progress: 50, metadata: { url: '' },
    })).toEqual({ id: 'task_1', status: 'running', progress: 50 })

    expect(parseMediaKitTaskResult({
      id: 'task_1', status: 'completed', progress: 100, metadata: { url: 'https://volc/out.mp4' },
    })).toEqual({ id: 'task_1', status: 'succeeded', progress: 100, videoUrl: 'https://volc/out.mp4' })
  })

  it('失败时透传上游的错误码与文案 —— 那是唯一能告诉用户「源视频拉不到」的地方', () => {
    const r = parseMediaKitTaskResult({
      id: 'task_1', status: 'failed', progress: 100,
      error: { code: 'DownloadFileError', message: 'file upload by url failed ... 403 Forbidden' },
      metadata: { url: '' },
    })
    expect(r.status).toBe('failed')
    expect(r.error).toEqual({ code: 'DownloadFileError', message: expect.stringContaining('403') })
  })

  it('认不出的状态当 running —— 让轮询继续,而不是误判成失败丢掉一笔已扣的钱', () => {
    expect(parseMediaKitTaskResult({ id: 'x', status: 'something_new' }).status).toBe('running')
  })
})

describe('createMediaKitClient', () => {
  it('提交打 /videos,成功即报一次消费;轮询只在终态报', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'task_9', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'task_9', status: 'in_progress', progress: 50 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'task_9', status: 'completed', metadata: { url: 'https://o/1.mp4' } }))
    const billed = vi.fn()
    const client = createMediaKitClient({ fetchImpl, baseUrl: 'https://gw/v1', onBilledExchange: billed })

    const { id } = await client.submit('volc-enhance-video', 'https://x/v.mp4', {}, auth)
    expect(id).toBe('task_9')
    expect(fetchImpl.mock.calls[0][0]).toBe('https://gw/v1/videos')
    expect(billed).toHaveBeenCalledTimes(1)

    await client.query('task_9', auth)
    expect(billed).toHaveBeenCalledTimes(1) // running:不动钱,不报
    const done = await client.query('task_9', auth)
    expect(done.videoUrl).toBe('https://o/1.mp4')
    expect(billed).toHaveBeenCalledTimes(2) // 终态:报
    expect(fetchImpl.mock.calls[2][0]).toBe('https://gw/v1/videos/task_9')
  })

  it('鉴权头整份铺进请求 —— 平台模式的归属头一个都不能少', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 't', status: 'queued' }))
    const client = createMediaKitClient({ fetchImpl, baseUrl: 'https://gw/v1' })
    await client.submit('volc-enhance-video', 'https://x/v.mp4', {}, {
      Authorization: 'Bearer shadow', 'X-Platform-User-Id': 'u1', 'X-Project-Id': '345',
    })
    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>
    expect(headers['X-Platform-User-Id']).toBe('u1')
    expect(headers['X-Project-Id']).toBe('345')
  })

  it('401 的报错带上「哪种钱 → 打给谁」', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'Invalid token' } }, 401))
    const client = createMediaKitClient({ fetchImpl, baseUrl: 'https://gw.example/v1', retryOptions: { attempts: 1 } })
    await expect(client.submit('volc-enhance-video', 'https://x/v.mp4', {}, auth))
      .rejects.toThrow(/自填 Key → gw\.example/)
  })

  it('空 Authorization 在出网前就被挡下', async () => {
    const fetchImpl = vi.fn()
    const client = createMediaKitClient({ fetchImpl, baseUrl: 'https://gw/v1' })
    await expect(client.submit('volc-enhance-video', 'https://x/v.mp4', {}, { Authorization: 'Bearer ' }))
      .rejects.toThrow(/Authorization/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
