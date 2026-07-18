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

  it('strips null-valued fields from replayed input items (xAI 422 regression)', () => {
    // Codex serializes replayed reasoning history as `"content": null` /
    // `"encrypted_content": null`. xAI's untagged ModelInput enum rejects
    // `content: null` with HTTP 422; omitting the field is accepted. Diagnosed
    // live against right.codes/grok — second turn always failed.
    const request = {
      model: 'grok-4.5',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: '1+1=?' }] },
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'simple math' }],
          content: null,
          encrypted_content: null,
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '1+1=2。' }],
        },
        { role: 'user', content: [{ type: 'input_text', text: '你是谁' }] },
      ],
    }

    const result = flattenNamespaceTools(request)
    const reasoning = result.body.input[1] as Record<string, unknown>

    expect(reasoning).toEqual({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'simple math' }],
    })
    expect(reasoning).not.toHaveProperty('content')
    expect(reasoning).not.toHaveProperty('encrypted_content')
    // Non-null fields on every other item survive untouched.
    expect(result.body.input[2]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '1+1=2。' }],
    })
    // The original request object is not mutated.
    expect(request.input[1]).toHaveProperty('content', null)
  })

  it('keeps non-null reasoning payloads (encrypted content round-trip) intact', () => {
    const request = {
      model: 'grok-4.5',
      input: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 's' }],
          encrypted_content: 'opaque-blob',
          content: [{ type: 'reasoning_text', text: 'raw' }],
        },
      ],
    }

    const result = flattenNamespaceTools(request)

    expect(result.body.input[0]).toEqual({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 's' }],
      encrypted_content: 'opaque-blob',
      content: [{ type: 'reasoning_text', text: 'raw' }],
    })
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

  it('keeps idle keep-alive sockets open longer than the Codex client pool', async () => {
    // Node's http.Server defaults keepAliveTimeout to 5s while codex-rs
    // (reqwest/hyper) reuses pooled connections for ~90s. With the default,
    // the proxy closes the idle socket first and the SECOND turn of a Grok
    // conversation dies with ECONNRESET ("apiyi grok 只能对话一句就卡住").
    // The server must outlive the client pool so the client always closes
    // first; headersTimeout must exceed keepAliveTimeout to avoid the
    // request-start race on a reused socket.
    const upstream = createServer((_request, response) => {
      response.statusCode = 200
      response.end('{}')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as AddressInfo).port
    const proxy = await startResponsesCompatibilityProxy(
      `http://127.0.0.1:${upstreamPort}/v1`,
    )
    try {
      expect(proxy.keepAliveTimeoutMs).toBeGreaterThanOrEqual(120_000)
      expect(proxy.headersTimeoutMs).toBeGreaterThan(proxy.keepAliveTimeoutMs)
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
    // rightcode-grok is xAI-backed too: it needs the same input-null sanitize
    // (422 ModelInput on second turns) and benefits from namespace flattening
    // so subagent tools stay callable instead of being stripped upstream.
    expect(
      shouldStartResponsesCompatibilityProxy(
        resolveProviderChannel('rightcode-grok'),
      ),
    ).toBe(true)
    expect(
      shouldStartResponsesCompatibilityProxy(
        resolveProviderChannel('rightcode-standard'),
      ),
    ).toBe(false)
  })

  it('force-bridges any xAI-family channel even when its policy says none', () => {
    // Never-regress guard: upstream codex WONTFIXed the `content: null`
    // serialization (openai/codex#11834 — "report it to the provider"), so a
    // future Grok channel added without the bridge policy would reintroduce
    // the second-turn 422. Model-family inference makes the bridge automatic.
    expect(
      shouldStartResponsesCompatibilityProxy({
        id: 'custom-grok',
        name: 'Custom Grok',
        baseUrl: 'https://example.com/v1',
        envKey: 'OPENAI_API_KEY',
        model: 'grok-4.5',
        compatibilityPolicy: 'none',
      }),
    ).toBe(true)
    expect(
      shouldStartResponsesCompatibilityProxy({
        id: 'custom-grok-allowed',
        name: 'Custom Grok (allowedModels only)',
        baseUrl: 'https://example.com/v1',
        envKey: 'OPENAI_API_KEY',
        allowedModels: ['grok-4.5'],
        compatibilityPolicy: 'none',
      }),
    ).toBe(true)
    // Non-xAI channels with policy 'none' stay proxy-free.
    expect(
      shouldStartResponsesCompatibilityProxy({
        id: 'custom-openai',
        name: 'Custom OpenAI',
        baseUrl: 'https://example.com/v1',
        envKey: 'OPENAI_API_KEY',
        model: 'gpt-5.5',
        compatibilityPolicy: 'none',
      }),
    ).toBe(false)
  })

  it('bridges every builtin xAI-family channel (preset drift guard)', () => {
    for (const channelId of ['apiyi-grok', 'rightcode-grok']) {
      expect(
        shouldStartResponsesCompatibilityProxy(resolveProviderChannel(channelId)),
        `builtin channel ${channelId} must run through the compatibility bridge`,
      ).toBe(true)
    }
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
