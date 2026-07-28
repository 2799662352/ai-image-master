import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiService, SEED_AUDIO_MODEL, SEED_AUDIO_SITE_KEY } from '../ApiService'

/**
 * seed-audio-1.0 契约(docs/seed-audio-1.0-api-guide.md):
 * - POST {site}/v1/audio/speech,必须带 Accept: application/json 才走 JSON 响应;
 * - 参考音频:http(s) → metadata.references[].audio_url,data: → audio_data(裸 base64);
 * - 不发 voice(speaker 体系与旧 TTS 不兼容);
 * - JSON 响应 { audio, duration, original_duration, format, url }。
 */
describe('ApiService.generateAudio', () => {
  let service: ApiService
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.clear()
    // Miau 站点(antigravity)配上 key,当前站点保持默认 b-apiyi(无 key),
    // 以验证 siteKey pin 的站点/Key 解析
    localStorage.setItem('api_key_antigravity', 'sk-miau-token')
    service = new ApiService()
    fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ audio: 'QUJD', duration: 12.1, original_duration: 12.3, format: 'mp3', url: '' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs /v1/audio/speech on the pinned Miau site with Accept: application/json', async () => {
    const result = await service.generateAudio({
      input: '一位女声用自然口语说:你好。',
      siteKey: SEED_AUDIO_SITE_KEY,
    })

    expect(result.success).toBe(true)
    expect(result.audioBase64).toBe('QUJD')
    expect(result.duration).toBe(12.1)
    expect(result.originalDuration).toBe(12.3)
    expect(result.url).toBeUndefined() // 上游空字符串不透传

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://miauapi.13797248455.xyz/v1/audio/speech')
    expect(init.headers['Accept']).toBe('application/json')
    expect(init.headers['Authorization']).toBe('Bearer sk-miau-token')

    const body = JSON.parse(init.body)
    expect(body.model).toBe(SEED_AUDIO_MODEL)
    expect(body.input).toBe('一位女声用自然口语说:你好。')
    expect(body.response_format).toBe('mp3')
    // 不发 voice;默认语速不发 speed
    expect('voice' in body).toBe(false)
    expect('speed' in body).toBe(false)
    expect('metadata' in body).toBe(false)
  })

  it('maps reference audios: http(s) → audio_url, data URI → bare-base64 audio_data, capped at 2', async () => {
    await service.generateAudio({
      input: '结合参考音频的风格朗读',
      siteKey: SEED_AUDIO_SITE_KEY,
      referenceAudios: [
        'https://example.com/ref1.mp3',
        'data:audio/mpeg;base64,QkFTRTY0',
        'https://example.com/ref3.mp3', // 超出上限,应被截断
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.metadata.references).toEqual([
      { audio_url: 'https://example.com/ref1.mp3' },
      { audio_data: 'QkFTRTY0' },
    ])
  })

  it('sends non-default speed and clamps to the OpenAI range', async () => {
    await service.generateAudio({ input: 'x', siteKey: SEED_AUDIO_SITE_KEY, speed: 1.5 })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).speed).toBe(1.5)

    await service.generateAudio({ input: 'x', siteKey: SEED_AUDIO_SITE_KEY, speed: 99 })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).speed).toBe(4)
  })

  it('returns a clear error when the pinned site has no API key', async () => {
    localStorage.removeItem('api_key_antigravity')
    const freshService = new ApiService()
    const result = await freshService.generateAudio({ input: 'x', siteKey: SEED_AUDIO_SITE_KEY })
    expect(result.success).toBe(false)
    expect(result.error).toContain('API Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces upstream error messages on non-OK responses', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'speaker not found' } }), { status: 400 }),
    )
    const result = await service.generateAudio({ input: 'x', siteKey: SEED_AUDIO_SITE_KEY })
    expect(result.success).toBe(false)
    expect(result.error).toContain('speaker not found')
    expect(result.error).toContain('400')
  })

  it('fails cleanly when a 200 response has no audio payload', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const result = await service.generateAudio({ input: 'x', siteKey: SEED_AUDIO_SITE_KEY })
    expect(result.success).toBe(false)
    expect(result.error).toContain('非预期响应')
  })

  it('rejects empty input without hitting the network', async () => {
    const result = await service.generateAudio({ input: '   ', siteKey: SEED_AUDIO_SITE_KEY })
    expect(result.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
