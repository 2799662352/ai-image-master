import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('ApiService signal support', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    vi.resetModules()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('makeApiRequest should pass signal to fetch', async () => {
    const mockResponse = new Response(
      JSON.stringify({
        data: [{ url: 'https://example.com/image.png' }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
    const mockFetch = vi.fn().mockResolvedValue(mockResponse)
    globalThis.fetch = mockFetch

    const { ApiService } = await import('../ApiService')
    const service = new ApiService() as any
    service.apiKey = 'test-key'
    service.currentSite = 'b-apiyi'
    service.models['test-signal-model'] = {
      name: 'test',
      displayName: 'Test Model',
      apiType: 'openai',
    }

    const controller = new AbortController()
    await service.generateImage({
      prompt: 'test prompt',
      model: 'test-signal-model',
      count: 1,
      signal: controller.signal,
    })

    expect(mockFetch).toHaveBeenCalled()
    const fetchCall = mockFetch.mock.calls[0]
    expect(fetchCall[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(fetchCall[1]?.signal.aborted).toBe(false)
  })

  it('generateImage should abort when signal is aborted', async () => {
    const controller = new AbortController()
    const mockFetch = vi.fn().mockImplementation(() => {
      return new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    })
    globalThis.fetch = mockFetch

    const { ApiService } = await import('../ApiService')
    const service = new ApiService() as any
    service.apiKey = 'test-key'
    service.currentSite = 'b-apiyi'
    service.models['test-signal-model'] = {
      name: 'test',
      displayName: 'Test Model',
      apiType: 'openai',
    }

    const promise = service.generateImage({
      prompt: 'test prompt',
      model: 'test-signal-model',
      count: 1,
      signal: controller.signal,
    })

    controller.abort()

    const result = await promise
    expect(result.success).toBe(false)
  })

  it('normalizes legacy gemini image preview model keys before lookup/generation', async () => {
    const mockResponse = new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: 'AAAA',
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
    const mockFetch = vi.fn().mockResolvedValue(mockResponse)
    globalThis.fetch = mockFetch

    const { ApiService } = await import('../ApiService')
    const service = new ApiService() as any
    service.apiKey = 'test-key'
    service.currentSite = 'b-apiyi'

    const result = await service.generateImage({
      prompt: 'test prompt',
      model: 'gemini-3.1-flash-image-preview',
      count: 1,
    })

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalled()
    expect(String(mockFetch.mock.calls[0][0])).toContain('gemini-3.1-flash-image:generateContent')
    expect(String(mockFetch.mock.calls[0][0])).not.toContain('gemini-3.1-flash-image-preview')
  })
})
