import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('ApiService.testConnection', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    vi.resetModules()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns true when /v1/models responds 200', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('{}', { status: 200 }),
    )
    globalThis.fetch = mockFetch

    const { ApiService } = await import('../ApiService')
    const service = new ApiService()

    const result = await service.testConnection('test-key-123')
    expect(result).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/models'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key-123',
        }),
      }),
    )
  })

  it('returns false when /v1/models responds non-200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{}', { status: 401 }),
    )

    const { ApiService } = await import('../ApiService')
    const service = new ApiService()

    const result = await service.testConnection('bad-key')
    expect(result).toBe(false)
  })

  it('returns false when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

    const { ApiService } = await import('../ApiService')
    const service = new ApiService()

    const result = await service.testConnection('any-key')
    expect(result).toBe(false)
  })
})
