import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * parseResponse 健壮性回归：
 * 网关限流 / 5xx / 被劫持时常返回 HTML 错误页或空体。旧实现直接 response.json()
 * 会抛 "Unexpected token '<'"，把真实根因吞掉 → 用户看到的报错不完整。
 * 新实现：先 text 后 parse，非 JSON / 空体 / 非 OK 都把原始 body 片段带回。
 */
describe('ApiService.parseResponse robustness', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  async function makeService() {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    return service
  }

  const cfg = { capabilities: {} } as any

  it('HTTP 200 with HTML body (gateway error page) → surfaces raw snippet, not JSON SyntaxError', async () => {
    const service = await makeService()
    const html = '<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>'
    const resp = new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
    const result = await (service as any).parseResponse(resp, cfg)
    expect(result.success).toBe(false)
    expect(result.error).not.toContain('Unexpected token')
    expect(result.error).toContain('502 Bad Gateway')
    expect(result.error).toContain('非 JSON')
  })

  it('HTTP 200 with empty body → friendly empty-response message', async () => {
    const service = await makeService()
    const resp = new Response('', { status: 200 })
    const result = await (service as any).parseResponse(resp, cfg)
    expect(result.success).toBe(false)
    expect(result.error).toContain('空响应')
  })

  it('non-OK JSON error → friendly message + appended upstream detail', async () => {
    const service = await makeService()
    const body = JSON.stringify({ error: { message: 'channel 3 upstream timeout' } })
    const resp = new Response(body, { status: 503, headers: { 'Content-Type': 'application/json' } })
    const result = await (service as any).parseResponse(resp, cfg)
    expect(result.success).toBe(false)
    expect(result.error).toContain('503')
    expect(result.error).toContain('channel 3 upstream timeout')
  })

  it('non-OK with non-JSON body → status + raw snippet (no SyntaxError)', async () => {
    const service = await makeService()
    const resp = new Response('Too Many Requests - rate limited by edge', { status: 429 })
    const result = await (service as any).parseResponse(resp, cfg)
    expect(result.success).toBe(false)
    expect(result.error).not.toContain('Unexpected token')
    // 429 友好提示 + 原始片段
    expect(result.error).toMatch(/频繁|额度/)
    expect(result.error).toContain('rate limited by edge')
  })

  it('OK JSON without images → includes raw body snippet for diagnosis', async () => {
    const service = await makeService()
    const resp = new Response(JSON.stringify({ weird: 'shape', no: 'images' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const result = await (service as any).parseResponse(resp, cfg)
    expect(result.success).toBe(false)
    expect(result.error).toContain('未能从响应中提取图片')
    expect(result.error).toContain('weird')
  })

  it('OK JSON with image URL → success', async () => {
    const service = await makeService()
    const resp = new Response(JSON.stringify({ data: [{ url: 'https://x/y.png' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const result = await (service as any).parseResponse(resp, cfg)
    expect(result.success).toBe(true)
    expect(result.images).toEqual(['https://x/y.png'])
  })
})
