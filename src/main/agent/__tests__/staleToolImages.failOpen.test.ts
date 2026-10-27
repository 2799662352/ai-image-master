import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../services/auth/platformSpend', () => ({
  notePlatformSpend: () => undefined,
}))
// 淘汰模块出任何问题,都不能把用户的请求打断:桥要原样转发。
vi.mock('../staleToolImages', () => ({
  evictStaleToolImages: () => {
    throw new Error('boom')
  },
}))
import { startResponsesCompatibilityProxy } from '../responsesCompatibilityProxy'

describe('stale tool image eviction fails open', () => {
  it('forwards the request untouched when eviction throws', async () => {
    let seen: unknown
    const server = createServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      seen = JSON.parse(raw)
      response.statusCode = 200
      response.setHeader('content-type', 'application/json')
      response.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const proxy = await startResponsesCompatibilityProxy(`http://127.0.0.1:${port}/v1`)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const input = [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] },
        {
          type: 'function_call_output',
          call_id: 'call_0',
          output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
        },
      ]
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3.8-max', stream: false, input }),
      })

      expect(response.status).toBe(200)
      expect((seen as { input: unknown[] }).input).toEqual(input)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      await proxy.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
