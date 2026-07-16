import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { resolveProviderChannel } from '../gatewayModelRouting'
import {
  flattenNamespaceTools,
  shouldStartResponsesCompatibilityProxy,
  startProviderCompatibilityProxies,
  restoreNamespaceToolCalls,
  startResponsesCompatibilityProxy,
} from '../responsesCompatibilityProxy'

describe('Responses namespace compatibility', () => {
  it('flattens proprietary namespace tools and preserves official Responses tools', () => {
    const request = {
      model: 'grok-4.5',
      input: [
        {
          type: 'function_call',
          call_id: 'call-1',
          namespace: 'multi_agent_v1',
          name: 'spawn_agent',
          arguments: '{}',
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'shell',
          description: 'Run a command.',
          parameters: { type: 'object' },
        },
        {
          type: 'namespace',
          name: 'multi_agent_v1',
          description: 'Manage subagents.',
          tools: [
            {
              type: 'function',
              name: 'spawn_agent',
              description: 'Spawn a subagent.',
              parameters: { type: 'object' },
            },
          ],
        },
        {
          type: 'web_search',
          external_web_access: true,
          indexed_web_access: false,
          search_context_size: 'medium',
        },
        {
          type: 'mcp',
          server_label: 'docs',
          server_url: 'https://example.com/mcp',
        },
      ],
    }

    const result = flattenNamespaceTools(request)

    expect(result.body).toMatchObject({
      input: [
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'multi_agent_v1__spawn_agent',
          arguments: '{}',
        },
      ],
      tools: [
        { type: 'function', name: 'shell' },
        { type: 'function', name: 'multi_agent_v1__spawn_agent' },
        { type: 'web_search' },
        { type: 'mcp', server_label: 'docs' },
      ],
    })
    expect(result.body.input[0]).not.toHaveProperty('namespace')
    expect(result.body.tools[2]).toEqual({
      type: 'web_search',
      search_context_size: 'medium',
    })
    expect(result.bindings).toEqual([
      {
        flatName: 'multi_agent_v1__spawn_agent',
        namespace: 'multi_agent_v1',
        name: 'spawn_agent',
      },
    ])
    expect(request.tools[1]).toHaveProperty('type', 'namespace')
  })

  it('restores namespace identity on nested function-call response items', () => {
    const event = {
      type: 'response.completed',
      response: {
        output: [
          {
            type: 'function_call',
            call_id: 'call-1',
            name: 'multi_agent_v1__spawn_agent',
            arguments: '{}',
          },
        ],
      },
    }

    const restored = restoreNamespaceToolCalls(event, [
      {
        flatName: 'multi_agent_v1__spawn_agent',
        namespace: 'multi_agent_v1',
        name: 'spawn_agent',
      },
    ])

    expect(restored).toEqual({
      type: 'response.completed',
      response: {
        output: [
          {
            type: 'function_call',
            call_id: 'call-1',
            namespace: 'multi_agent_v1',
            name: 'spawn_agent',
            arguments: '{}',
          },
        ],
      },
    })
    expect(event.response.output[0]).not.toHaveProperty('namespace')
  })

  it('flattens prior namespace calls even when the next request has no tools', () => {
    const result = flattenNamespaceTools({
      model: 'grok-4.5',
      input: [
        {
          type: 'function_call',
          call_id: 'call-1',
          namespace: 'multi_agent_v1',
          name: 'spawn_agent',
          arguments: '{}',
        },
      ],
      tools: [],
    })

    expect(result.body.input[0]).toEqual({
      type: 'function_call',
      call_id: 'call-1',
      name: 'multi_agent_v1__spawn_agent',
      arguments: '{}',
    })
    expect(result.bindings).toEqual([
      {
        flatName: 'multi_agent_v1__spawn_agent',
        namespace: 'multi_agent_v1',
        name: 'spawn_agent',
      },
    ])
  })

  it('translates streamed namespace calls across the HTTP boundary', async () => {
    let upstreamRequest: Record<string, unknown> | undefined
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      upstreamRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const event = JSON.stringify({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'multi_agent_v1__spawn_agent',
          arguments: '{"prompt":"中文"}',
        },
      })
      const encodedEvent = Buffer.from(`data: ${event}\n\n`)
      const splitAt = encodedEvent.indexOf(Buffer.from('中')) + 1
      response.statusCode = 200
      response.setHeader('content-type', 'text/event-stream')
      response.write(encodedEvent.subarray(0, splitAt))
      await new Promise((resolve) => setTimeout(resolve, 10))
      response.end(encodedEvent.subarray(splitAt))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as AddressInfo).port
    const proxy = await startResponsesCompatibilityProxy(
      `http://127.0.0.1:${upstreamPort}/v1`,
    )

    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'grok-4.5',
          stream: true,
          tools: [
            {
              type: 'namespace',
              name: 'multi_agent_v1',
              tools: [
                {
                  type: 'function',
                  name: 'spawn_agent',
                  parameters: { type: 'object' },
                },
              ],
            },
            { type: 'web_search' },
          ],
        }),
      })
      const body = await response.text()

      expect(upstreamRequest).toMatchObject({
        tools: [
          { type: 'function', name: 'multi_agent_v1__spawn_agent' },
          { type: 'web_search' },
        ],
      })
      expect(body).toContain('"namespace":"multi_agent_v1"')
      expect(body).toContain('"name":"spawn_agent"')
      expect(body).toContain('中文')
      expect(body).not.toContain('"name":"multi_agent_v1__spawn_agent"')
    } finally {
      await proxy.close()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it('starts compatibility proxies only for channels with a bridge policy', () => {
    expect(
      shouldStartResponsesCompatibilityProxy(
        resolveProviderChannel('apiyi-grok'),
      ),
    ).toBe(true)
    expect(
      shouldStartResponsesCompatibilityProxy(
        resolveProviderChannel('rightcode-standard'),
      ),
    ).toBe(false)
  })

  it('rewrites bridged Provider URLs and leaves native providers untouched', async () => {
    const qwenBaseUrl = 'http://175.178.198.17:3000/v1'
    const group = await startProviderCompatibilityProxies([
      resolveProviderChannel('apiyi-grok'),
      {
        id: 'qwen',
        name: 'Qwen Understanding',
        baseUrl: qwenBaseUrl,
        envKey: 'MIAU_API_KEY',
        compatibilityPolicy: 'none',
      },
    ])

    try {
      expect(group.providers).toEqual([
        expect.objectContaining({
          id: 'apiyi-grok',
          baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/),
        }),
        expect.objectContaining({
          id: 'qwen',
          baseUrl: qwenBaseUrl,
        }),
      ])
    } finally {
      await group.close()
    }
  })
})
