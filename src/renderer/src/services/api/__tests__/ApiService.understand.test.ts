import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ApiService,
  QWEN_UNDERSTAND_FLAGSHIP_MODEL,
  QWEN_UNDERSTAND_MODEL,
  resolveUnderstandModel,
} from '../ApiService'

describe('resolveUnderstandModel', () => {
  it('三档别名各自映射到真实模型名', () => {
    expect(resolveUnderstandModel('plus')).toBe('qwen3.7-plus-dashscope')
    expect(resolveUnderstandModel('max')).toBe('qwen3.7-max-dashscope')
    // qwen3.8-max 走网关的 Miau 那条，模型 id 没有 -dashscope 后缀。
    expect(resolveUnderstandModel('flagship')).toBe('qwen3.8-max')
    expect(resolveUnderstandModel('3.8')).toBe('qwen3.8-max')
  })

  it('旗舰只在被点名时启用，默认仍是 plus', () => {
    // 3.8 与 3.7-plus 的视频规格相同(2h / 2GB)，默认换旗舰只是更贵。
    expect(resolveUnderstandModel(undefined)).toBe(QWEN_UNDERSTAND_MODEL)
    expect(resolveUnderstandModel('qwen3.9-ultra')).toBe(QWEN_UNDERSTAND_MODEL)
    expect(resolveUnderstandModel(QWEN_UNDERSTAND_FLAGSHIP_MODEL)).toBe('qwen3.8-max')
  })
})

/** Minimal Response-like stub for fetch. */
function fakeResponse(opts: {
  ok: boolean
  status?: number
  statusText?: string
  body: string
}): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    statusText: opts.statusText ?? '',
    text: async () => opts.body,
  } as unknown as Response
}

function newServiceWithKey(key: string | null): ApiService {
  const service = new ApiService()
  vi.spyOn(service, 'getStoredApiKey').mockReturnValue(key)
  vi.spyOn(service, 'getStoredVisionApiKey').mockReturnValue(null)
  return service
}

describe('ApiService.understand() — 多图与 fps', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(fakeResponse({
      ok: true,
      body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const bodyOf = () => JSON.parse(fetchMock.mock.calls[0][1].body as string)

  it('多图并列在同一条 message 里(跨图比较才成立),且保序去重', async () => {
    await newServiceWithKey('k').understand({
      kind: 'document',
      question: '这两张里的人是同一个吗',
      mediaUrl: 'https://x/a.png',
      // 故意夹一个与主图重复的、一个空串：去重但不许重排。
      mediaUrls: ['https://x/b.png', 'https://x/a.png', '   ', 'https://x/c.png'],
    })
    const parts = bodyOf().messages[0].content
    expect(parts[0]).toEqual({ type: 'text', text: '这两张里的人是同一个吗' })
    // 顺序即身份：提问里说「第二张」就得是第二张。
    expect(parts.slice(1).map((p: { image_url: { url: string } }) => p.image_url.url))
      .toEqual(['https://x/a.png', 'https://x/b.png', 'https://x/c.png'])
  })

  it('只给单张时形状不变(不因为支持了多图就改变既有调用)', async () => {
    await newServiceWithKey('k').understand({
      kind: 'document', question: 'q', mediaUrl: 'https://x/a.png',
    })
    const parts = bodyOf().messages[0].content
    expect(parts).toHaveLength(2)
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'https://x/a.png' } })
  })

  it('fps 作为 video_url 的同级字段送出;不给就不出现这个键', async () => {
    await newServiceWithKey('k').understand({
      kind: 'video', question: 'q', mediaUrl: 'https://x/v.mp4', fps: 0.5,
    })
    // 官方 curl 里 fps 与 video_url 平级 —— 塞进 video_url 内部上游会忽略。
    expect(bodyOf().messages[0].content[1]).toEqual({
      type: 'video_url', video_url: { url: 'https://x/v.mp4' }, fps: 0.5,
    })

    fetchMock.mockClear()
    await newServiceWithKey('k').understand({
      kind: 'video', question: 'q', mediaUrl: 'https://x/v.mp4',
    })
    expect(bodyOf().messages[0].content[1]).not.toHaveProperty('fps')
  })
})

describe('ApiService.understand()', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('builds a qwen multimodal video request (text + video_url, no result_format) and returns text', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        ok: true,
        body: JSON.stringify({ choices: [{ message: { content: '画面里有一只猫' } }] }),
      }),
    )
    const service = newServiceWithKey('sk-test')

    const result = await service.understand({
      kind: 'video',
      mediaUrl: 'https://example.com/a.mp4',
      question: '这个视频在干什么',
    })

    expect(result).toEqual({ success: true, text: '画面里有一只猫' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://miauapi.13797248455.xyz/v1/chat/completions')
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer sk-test',
      'Content-Type': 'application/json',
    })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('qwen3.7-plus-dashscope')
    expect(body.result_format).toBeUndefined()
    expect(body.enable_search).toBeUndefined()
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: '这个视频在干什么' },
      { type: 'video_url', video_url: { url: 'https://example.com/a.mp4' } },
    ])
  })

  it('sets enable_search=true and plain-text content for web_research', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        ok: true,
        body: JSON.stringify({ choices: [{ message: { content: '今天的新闻……' } }] }),
      }),
    )
    const service = newServiceWithKey('sk-test')

    const result = await service.understand({ kind: 'web', query: '今天的 AI 新闻' })

    expect(result).toEqual({ success: true, text: '今天的新闻……' })
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.enable_search).toBe(true)
    expect(body.messages[0].content).toBe('今天的 AI 新闻')
  })

  it('maps a persistent 502 to a friendly Chinese error after exhausting retries', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ ok: false, status: 502, statusText: 'Bad Gateway', body: '<html>502</html>' }),
    )
    const service = newServiceWithKey('sk-test')

    const result = await service.understand(
      { kind: 'web', query: 'x' },
      { retryDelayMs: 0, fallback: false },
    )

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toMatch(/繁忙|502/)
    // 1 initial + 2 retries = 3 attempts (default retries = 2); fallback disabled
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries a transient network error and then succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(
        Object.assign(new TypeError('fetch failed'), { cause: 'SocketError: other side closed' }),
      )
      .mockResolvedValueOnce(
        fakeResponse({
          ok: true,
          body: JSON.stringify({ choices: [{ message: { content: '一只白兔子' } }] }),
        }),
      )
    const service = newServiceWithKey('sk-test')

    const result = await service.understand(
      { kind: 'video', mediaUrl: 'https://x/a.mp4', question: 'q' },
      { retryDelayMs: 0 },
    )

    expect(result).toEqual({ success: true, text: '一只白兔子' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a transient 502 and then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 502, body: 'bad' }))
      .mockResolvedValueOnce(
        fakeResponse({
          ok: true,
          body: JSON.stringify({ choices: [{ message: { content: '今天的新闻' } }] }),
        }),
      )
    const service = newServiceWithKey('sk-test')

    const result = await service.understand({ kind: 'web', query: 'x' }, { retryDelayMs: 0 })

    expect(result).toEqual({ success: true, text: '今天的新闻' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a deterministic 400 error', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ ok: false, status: 400, statusText: 'Bad Request', body: 'invalid url' }),
    )
    const service = newServiceWithKey('sk-test')

    const result = await service.understand(
      { kind: 'video', mediaUrl: 'bad-url', question: 'q' },
      { retryDelayMs: 0, fallback: false },
    )

    expect(result.success).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('handles a non-JSON 200 body gracefully', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: true, body: 'not json at all' }))
    const service = newServiceWithKey('sk-test')

    const result = await service.understand({ kind: 'web', query: 'x' }, { fallback: false })

    expect(result.success).toBe(false)
  })

  it('defaults to qwen3.7-plus-dashscope and falls back to max on a primary failure', async () => {
    fetchMock
      // primary (plus) → deterministic 400, no same-model retry
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 400, statusText: 'Bad Request', body: 'x' }))
      // fallback (max) → success
      .mockResolvedValueOnce(
        fakeResponse({ ok: true, body: JSON.stringify({ choices: [{ message: { content: '兜底成功' } }] }) }),
      )
    const service = newServiceWithKey('sk-test')

    const result = await service.understand(
      { kind: 'video', mediaUrl: 'https://x/a.mp4', question: 'q' },
      { retryDelayMs: 0 },
    )

    expect(result).toEqual({ success: true, text: '兜底成功' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const primaryBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    const fallbackBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(primaryBody.model).toBe('qwen3.7-plus-dashscope')
    expect(fallbackBody.model).toBe('qwen3.7-max-dashscope')
  })

  it('honors an explicit model="max" override and does NOT fall back (max is the fallback model)', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ ok: false, status: 400, statusText: 'Bad Request', body: 'x' }),
    )
    const service = newServiceWithKey('sk-test')

    const result = await service.understand(
      { kind: 'web', query: 'x' },
      { retryDelayMs: 0, model: 'max' },
    )

    expect(result.success).toBe(false)
    // primary === max === fallback model → no extra fallback attempt
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.model).toBe('qwen3.7-max-dashscope')
  })

  it('returns a config error when no key is available (does not call fetch)', async () => {
    const service = newServiceWithKey(null)

    const result = await service.understand({ kind: 'web', query: 'x' })

    expect(result.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
