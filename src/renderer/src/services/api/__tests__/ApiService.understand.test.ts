import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiService } from '../ApiService'

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
    expect(url).toBe('http://175.178.198.17:3000/v1/chat/completions')
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer sk-test',
      'Content-Type': 'application/json',
    })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('qwen3.7-max-dashscope')
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

  it('maps 502 to a friendly Chinese error without throwing', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ ok: false, status: 502, statusText: 'Bad Gateway', body: '<html>502</html>' }),
    )
    const service = newServiceWithKey('sk-test')

    const result = await service.understand({ kind: 'web', query: 'x' })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toMatch(/繁忙|502/)
  })

  it('handles a non-JSON 200 body gracefully', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: true, body: 'not json at all' }))
    const service = newServiceWithKey('sk-test')

    const result = await service.understand({ kind: 'web', query: 'x' })

    expect(result.success).toBe(false)
  })

  it('returns a config error when no key is available (does not call fetch)', async () => {
    const service = newServiceWithKey(null)

    const result = await service.understand({ kind: 'web', query: 'x' })

    expect(result.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
