import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ApiService,
  QWEN_UNDERSTAND_FALLBACK_MODEL,
  QWEN_UNDERSTAND_FLAGSHIP_MODEL,
  QWEN_UNDERSTAND_MODEL,
  QWEN_UNDERSTAND_MODELS,
  QWEN_UNDERSTAND_OMNI_MODEL,
  QWEN_UNDERSTAND_PLUS_MODEL,
  audioFormatFromUrl,
  collectSseContent,
  resolveUnderstandModel,
} from '../ApiService'

describe('resolveUnderstandModel', () => {
  it('四档别名各自映射到真实模型名', () => {
    expect(resolveUnderstandModel('omni')).toBe('qwen3.8-omni-flash')
    // 3.7 两档与 3.8 并行保留(用户 2026-09-20 拍板暂不撤):plus / max 仍按字面指 3.7,
    // 老 skill / 老会话里写的 max 不改意思。
    expect(resolveUnderstandModel('plus')).toBe('qwen3.7-plus-dashscope')
    expect(resolveUnderstandModel('max')).toBe('qwen3.7-max-dashscope')
    // qwen3.8-max 走网关的 Miau 那条，模型 id 没有 -dashscope 后缀。
    expect(resolveUnderstandModel('flagship')).toBe('qwen3.8-max')
    expect(resolveUnderstandModel('3.8')).toBe('qwen3.8-max')
  })

  it('默认是全模态 omni;3.7 与旗舰只在被点名时启用', () => {
    // omni 与 3.7 / 3.8-max 的视频规格相同(2h / 2GB),默认换大档只是更贵。
    expect(QWEN_UNDERSTAND_MODEL).toBe('qwen3.8-omni-flash')
    expect(QWEN_UNDERSTAND_OMNI_MODEL).toBe(QWEN_UNDERSTAND_MODEL)
    expect(resolveUnderstandModel(undefined)).toBe(QWEN_UNDERSTAND_MODEL)
    expect(resolveUnderstandModel('qwen3.9-ultra')).toBe(QWEN_UNDERSTAND_MODEL)
    expect(resolveUnderstandModel(QWEN_UNDERSTAND_FLAGSHIP_MODEL)).toBe('qwen3.8-max')
    expect(resolveUnderstandModel(QWEN_UNDERSTAND_PLUS_MODEL)).toBe('qwen3.7-plus-dashscope')
  })

  it('白名单四档齐全,兜底仍是 3.7 Max', () => {
    expect(QWEN_UNDERSTAND_MODELS).toEqual([
      'qwen3.8-omni-flash',
      'qwen3.7-plus-dashscope',
      'qwen3.7-max-dashscope',
      'qwen3.8-max',
    ])
    expect(QWEN_UNDERSTAND_FALLBACK_MODEL).toBe('qwen3.7-max-dashscope')
  })
})

describe('audioFormatFromUrl / collectSseContent', () => {
  it('audioFormatFromUrl 按扩展名判定,忽略大小写与查询串;认不出返回 undefined', () => {
    expect(audioFormatFromUrl('https://x/a.MP3?sig=1')).toBe('mp3')
    expect(audioFormatFromUrl('https://x/a.flac#t=3')).toBe('flac')
    expect(audioFormatFromUrl('https://x/talk.m4a')).toBe('m4a')
    expect(audioFormatFromUrl('https://x/a.mp4')).toBeUndefined()
    expect(audioFormatFromUrl('https://x/a')).toBeUndefined()
  })

  it('collectSseContent 只拼 delta.content,跳过 [DONE] / reasoning / 半行;非 SSE 返回 null', () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"一只"}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}',
      ': keep-alive',
      'data: {"choices":[{"delta":{"content":"猫"}}]}',
      'data: {"choices":[{"del',
      'data: [DONE]',
      '',
    ].join('\n')
    expect(collectSseContent(sse)).toBe('一只猫')
    expect(collectSseContent('{"choices":[{"message":{"content":"plain"}}]}')).toBeNull()
    expect(collectSseContent('data: [DONE]\n')).toBe('')
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

  it('PDF 用 file part 而不是 image_url(发错形状上游读不出内容)', async () => {
    await newServiceWithKey('k').understand({
      kind: 'document', question: '总结一下', mediaUrl: 'https://x/paper.pdf',
    })
    expect(bodyOf().messages[0].content[1]).toEqual({
      type: 'file', file: { file_url: 'https://x/paper.pdf' },
    })
  })

  it('PDF 与图片混传时各用各的 part 类型', async () => {
    await newServiceWithKey('k').understand({
      kind: 'document',
      question: '对照看',
      mediaUrl: 'https://x/a.png',
      mediaUrls: ['https://x/spec.pdf?v=2', 'https://x/b.jpg'],
    })
    const parts = bodyOf().messages[0].content.slice(1)
    // 带查询串的 .pdf 也要认出来。
    expect(parts).toEqual([
      { type: 'file', file: { file_url: 'https://x/spec.pdf?v=2' } },
      { type: 'image_url', image_url: { url: 'https://x/a.png' } },
      { type: 'image_url', image_url: { url: 'https://x/b.jpg' } },
    ])
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
    expect(body.model).toBe('qwen3.8-omni-flash')
    // omni 还能出语音,这里只要文本回来(另一种产品、另一种计费)。
    expect(body.modalities).toEqual(['text'])
    expect(body.stream).toBeUndefined()
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

  it('defaults to omni and falls back to 3.7 max on a primary failure', async () => {
    fetchMock
      // primary (omni) → deterministic 400, no same-model retry
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 400, statusText: 'Bad Request', body: 'x' }))
      // fallback (3.7 max) → success
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
    expect(primaryBody.model).toBe('qwen3.8-omni-flash')
    expect(fallbackBody.model).toBe('qwen3.7-max-dashscope')
    // modalities 是 omni 专属字段,兜底模型不带。
    expect(fallbackBody.modalities).toBeUndefined()
  })

  it('honors an explicit model="plus" (3.7 Plus stays selectable while both generations run in parallel)', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ ok: true, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }),
    )
    const service = newServiceWithKey('sk-test')

    await service.understand({ kind: 'web', query: 'x' }, { model: 'plus' })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.model).toBe('qwen3.7-plus-dashscope')
    expect(body.modalities).toBeUndefined()
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

describe('ApiService.understand() — 音频(omni 专属)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(fakeResponse({
      ok: true,
      body: JSON.stringify({ choices: [{ message: { content: '他说:明天见' } }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const bodyAt = (i: number) => JSON.parse((fetchMock.mock.calls[i][1] as RequestInit).body as string)

  it('发 input_audio part,format 从 URL 扩展名推断;不管点了哪档都钉在 omni', async () => {
    const result = await newServiceWithKey('k').understand(
      { kind: 'audio', mediaUrl: 'https://x/talk.M4A?sig=1', question: '说了什么' },
      // 调用方点了 3.7 max —— 它听不见,必须被忽略。
      { model: 'max' },
    )

    expect(result).toEqual({ success: true, text: '他说:明天见' })
    const body = bodyAt(0)
    expect(body.model).toBe('qwen3.8-omni-flash')
    expect(body.modalities).toEqual(['text'])
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: '说了什么' },
      { type: 'input_audio', input_audio: { data: 'https://x/talk.M4A?sig=1', format: 'm4a' } },
    ])
  })

  it('显式 format 优先;推不出扩展名时按 mp3 发', async () => {
    const svc = newServiceWithKey('k')
    await svc.understand({ kind: 'audio', mediaUrl: 'https://x/blob', question: 'q', format: 'wav' })
    expect(bodyAt(0).messages[0].content[1].input_audio.format).toBe('wav')

    await svc.understand({ kind: 'audio', mediaUrl: 'https://x/blob', question: 'q' })
    expect(bodyAt(1).messages[0].content[1].input_audio.format).toBe('mp3')
  })

  it('音频失败不兜底到 3.7 max(换过去只会再换回 incorrect modal)', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ ok: false, status: 400, statusText: 'Bad Request', body: "incorrect modal 'audio'" }),
    )

    const result = await newServiceWithKey('k').understand(
      { kind: 'audio', mediaUrl: 'https://x/a.mp3', question: 'q' },
      { retryDelayMs: 0 },
    )

    expect(result.success).toBe(false)
    // 400 不重试、音频不兜底 → 只此一发。
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bodyAt(0).model).toBe('qwen3.8-omni-flash')
  })
})

describe('ApiService.understand() — 流式自适应', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const bodyAt = (i: number) => JSON.parse((fetchMock.mock.calls[i][1] as RequestInit).body as string)
  const sse = (...chunks: string[]) =>
    chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}`).join('\n\n')
    + '\n\ndata: [DONE]\n'

  it('非流式被上游以 stream 理由拒绝(4xx)→ 同一请求改 stream:true 重发并拼 SSE;同模型之后直接走流式', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse({
        ok: false, status: 400, statusText: 'Bad Request',
        body: '{"error":{"message":"This model only supports stream mode, please enable the stream parameter"}}',
      }))
      .mockResolvedValueOnce(fakeResponse({ ok: true, body: sse('一只', '猫') }))
      .mockResolvedValueOnce(fakeResponse({ ok: true, body: sse('再来一次') }))
    const svc = newServiceWithKey('k')

    const first = await svc.understand({ kind: 'web', query: 'q' }, { retryDelayMs: 0 })
    expect(first).toEqual({ success: true, text: '一只猫' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodyAt(0).stream).toBeUndefined()
    expect(bodyAt(1).stream).toBe(true)
    expect(bodyAt(1).model).toBe(bodyAt(0).model)

    // 会话级记住:同一模型第二次直接 stream:true,不再白花一次非流式往返。
    const second = await svc.understand({ kind: 'web', query: 'q2' }, { retryDelayMs: 0 })
    expect(second).toEqual({ success: true, text: '再来一次' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(bodyAt(2).stream).toBe(true)
  })

  it('流式请求若网关忽略 stream 直接回 JSON,也照常解析', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 400, body: 'stream required' }))
      .mockResolvedValueOnce(fakeResponse({
        ok: true, body: JSON.stringify({ choices: [{ message: { content: '普通 JSON' } }] }),
      }))

    const result = await newServiceWithKey('k').understand({ kind: 'web', query: 'q' }, { retryDelayMs: 0 })

    expect(result).toEqual({ success: true, text: '普通 JSON' })
    expect(bodyAt(1).stream).toBe(true)
  })

  it('一个与 stream 无关的 4xx 不触发改流式(照旧不重试、直接兜底)', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 400, body: 'invalid url' }))
      .mockResolvedValueOnce(fakeResponse({
        ok: true, body: JSON.stringify({ choices: [{ message: { content: '兜底' } }] }),
      }))

    const result = await newServiceWithKey('k').understand({ kind: 'web', query: 'q' }, { retryDelayMs: 0 })

    expect(result).toEqual({ success: true, text: '兜底' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodyAt(1).stream).toBeUndefined()
    expect(bodyAt(1).model).toBe('qwen3.7-max-dashscope')
  })
})
