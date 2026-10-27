import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'

/** 与 responsesCompatibilityProxy.test.ts 同样的理由:汇合点自带防抖定时器,这里不需要它。 */
vi.mock('../../services/auth/platformSpend', () => ({
  notePlatformSpend: () => undefined,
}))
import {
  startAnthropicMessagesBridge,
  startResponsesCompatibilityProxy,
} from '../responsesCompatibilityProxy'
import { STALE_TOOL_IMAGE_PLACEHOLDER_PREFIX } from '../staleToolImages'

/** 一轮「模型调了工具 → 工具回了一张图」,图里带一个可检索的编号标记。 */
function toolTurn(index: number): Array<Record<string, unknown>> {
  const callId = `call_${index}`
  return [
    { type: 'function_call', call_id: callId, name: 'view_image', arguments: JSON.stringify({ path: `/uploads/shot-${index}.png` }) },
    {
      type: 'function_call_output',
      call_id: callId,
      output: [
        { type: 'input_text', text: `shot ${index}` },
        { type: 'input_image', image_url: `data:image/png;base64,MARK${index}MARK${'A'.repeat(64)}` },
      ],
    },
  ]
}

function inputWithToolImages(count: number): Array<Record<string, unknown>> {
  const turns = Array.from({ length: count }, (_, i) => toolTurn(i)).flat()
  return [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续看下一张' }] },
    ...turns,
  ]
}

describe('stale tool images across the HTTP boundary', () => {
  it('forwards old tool images as placeholders and keeps the recent ones intact (Responses bridge)', async () => {
    let seen: unknown
    const server = createServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      seen = JSON.parse(raw)
      response.statusCode = 200
      response.setHeader('content-type', 'application/json')
      response.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const proxy = await startResponsesCompatibilityProxy(`http://127.0.0.1:${port}/v1`)
    try {
      await fetch(`${proxy.baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 8 张:超出窗口 2 张,按块淘汰 → 最老的 3 张换占位,留 5 张。
        body: JSON.stringify({ model: 'qwen3.8-max', stream: true, input: inputWithToolImages(8) }),
      })

      const wire = JSON.stringify(seen)
      for (const old of [0, 1, 2]) expect(wire).not.toContain(`MARK${old}MARK`)
      for (const recent of [3, 4, 5, 6, 7]) expect(wire).toContain(`MARK${recent}MARK`)
      expect(wire.split(STALE_TOOL_IMAGE_PLACEHOLDER_PREFIX)).toHaveLength(3 + 1)
      // 占位带着来源:模型知道那一步看的是哪个文件,要看可以再开一次。
      for (const old of [0, 1, 2]) expect(wire).toContain(`source: /uploads/shot-${old}.png`)
      expect(wire).not.toContain('source: /uploads/shot-3.png')
      // 文字部分、调用配对都还在:模型看得到「那一步取过图」。
      expect(wire).toContain('shot 0')
      expect(wire).toContain('"call_id":"call_0"')
    } finally {
      await proxy.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('applies the same eviction before the Anthropic Messages translation', async () => {
    let seen: unknown
    const server = createServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      seen = JSON.parse(raw)
      response.statusCode = 200
      response.setHeader('content-type', 'text/event-stream')
      response.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: { id: 'msg_1', model: 'claude-opus-5', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } },
        })}\n\n`,
      )
      response.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const bridge = await startAnthropicMessagesBridge(`http://127.0.0.1:${port}/v1`)
    try {
      const response = await fetch(`${bridge.baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-key' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          stream: true,
          instructions: 'You are a helpful assistant.',
          input: inputWithToolImages(8),
        }),
      })
      await response.text()

      // Messages 翻译器本身就不带工具结果里的图(保留的几张在上游也只剩文字),
      // 所以这里只证明一件事:淘汰发生在翻译之前、同一段信封里,占位文字走到了上游。
      const wire = JSON.stringify(seen)
      for (let i = 0; i < 8; i += 1) expect(wire).not.toContain(`MARK${i}MARK`)
      expect(wire.split(STALE_TOOL_IMAGE_PLACEHOLDER_PREFIX)).toHaveLength(3 + 1)
      expect(wire).toContain('source: /uploads/shot-0.png')
      expect(wire).toContain('shot 7')
    } finally {
      await bridge.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
