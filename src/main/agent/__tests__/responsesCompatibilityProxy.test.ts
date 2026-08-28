import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { resolveProviderChannel } from '../gatewayModelRouting'
import {
  flattenNamespaceTools,
  resolveCompatibilityBridge,
  shouldStartResponsesCompatibilityProxy,
  startAnthropicMessagesBridge,
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
    // live against rightapi.ai/grok — second turn always failed.
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

  it('drops replayed reasoning/compaction items carrying foreign encrypted content', () => {
    // Cross-channel switch (GPT thread continued on grok): history replays
    // OpenAI-encrypted `encrypted_content` blobs that xAI cannot decrypt →
    // "Could not decrypt the provided encrypted_content" (openai/codex
    // #17541). Upstream guidance (#25290): remove the WHOLE item — blanking
    // just the field turns the failure into "Missing required parameter".
    // xAI itself never emits encrypted_content (verified via live capture:
    // grok replay always has `encrypted_content: null`), so any non-empty
    // blob on a bridged channel is provider-foreign by construction.
    const request = {
      model: 'grok-4.5',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 's' }],
          encrypted_content: 'gAAAA-opaque-openai-blob',
          content: null,
        },
        {
          type: 'compaction',
          encrypted_content: 'gAAAA-opaque-compaction-blob',
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello' }],
        },
        { role: 'user', content: [{ type: 'input_text', text: '1' }] },
      ],
    }

    const result = flattenNamespaceTools(request)

    expect(result.body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }],
      },
      { role: 'user', content: [{ type: 'input_text', text: '1' }] },
    ])
    // The original request object is not mutated.
    expect(request.input).toHaveLength(5)
  })

  it('keeps reasoning items without encrypted content (null-stripped) in place', () => {
    const request = {
      model: 'grok-4.5',
      input: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 's' }],
          encrypted_content: null,
          content: [{ type: 'reasoning_text', text: 'raw' }],
        },
      ],
    }

    const result = flattenNamespaceTools(request)

    expect(result.body.input).toEqual([
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 's' }],
        content: [{ type: 'reasoning_text', text: 'raw' }],
      },
    ])
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
    const qwenBaseUrl = 'https://miauapi.13797248455.xyz/v1'
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

  /**
   * The sibling Channels a Gateway registers as extra providers (Plan B
   * per-thread routing) go through this same call, so a Claude Channel reached
   * via `thread/start.modelProvider` must be bridged too. Leaving it on the raw
   * Anthropic base URL would make codex POST Responses payloads at a Messages
   * endpoint and fail every turn on that thread.
   */
  it('bridges each mixed-family channel onto its own loopback port', async () => {
    const claudeChannel = resolveProviderChannel('rightcode-claude')
    const group = await startProviderCompatibilityProxies([
      resolveProviderChannel('rightcode-grok'),
      claudeChannel,
    ])

    try {
      const [grok, claude] = group.providers
      expect(grok.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
      expect(claude.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
      expect(claude.baseUrl).not.toBe(claudeChannel.baseUrl)
      expect(new URL(claude.baseUrl).port).not.toBe(new URL(grok.baseUrl).port)
    } finally {
      await group.close()
    }
  })
})

interface CapturedUpstreamCall {
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown>
}

/**
 * Fake Anthropic Messages endpoint that records the call it receives and
 * replies with a minimal but well-formed Messages SSE stream.
 */
async function startFakeMessagesUpstream(): Promise<{
  baseUrl: string
  calls: CapturedUpstreamCall[]
  close: () => Promise<void>
}> {
  const calls: CapturedUpstreamCall[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    calls.push({
      path: request.url ?? '/',
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    })
    response.statusCode = 200
    response.setHeader('content-type', 'text/event-stream')
    for (const event of [
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          model: 'claude-opus-5',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 11, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '你好' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 3 },
      },
      { type: 'message_stop' },
    ]) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/**
 * agent 聊天走平台余额。
 *
 * codex 自己带的是用户自填的 Miau Key,而 `qwen3.8-max` 那一路打的就是 Miau 网关,
 * 所以平台池的钱同样付得了它 —— 用户登录之后不该还要为聊天单独填一枚 key。
 *
 * 这一组守的是两件事,第二件比第一件重要得多。
 */
describe('平台余额组头', () => {
  async function startCapturingUpstream(): Promise<{
    baseUrl: string
    headers: () => Record<string, string>
    close: () => Promise<void>
  }> {
    let seen: Record<string, string> = {}
    const server = createServer((request, response) => {
      seen = Object.fromEntries(
        Object.entries(request.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')]),
      )
      response.statusCode = 200
      response.setHeader('content-type', 'application/json')
      response.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    return {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      headers: () => seen,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  it('上游是网关时,用平台整份头顶掉 codex 自带的 Key', async () => {
    const upstream = await startCapturingUpstream()
    const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, {
      platformHeaders: () => ({
        Authorization: 'Bearer sk-platform',
        'X-Platform-User-Id': 'user-1',
        'X-Project-Id': '345',
      }),
    })
    try {
      await fetch(`${proxy.baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer sk-user-own' },
        body: '{}',
      })
      const h = upstream.headers()
      expect(h.authorization).toBe('Bearer sk-platform')
      expect(h['x-platform-user-id']).toBe('user-1')
      expect(h['x-project-id']).toBe('345')
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  /**
   * 🧬 变异点:把 `CodexLocalBackend.gatewayPlatformHeadersFor` 里的 origin 判定删掉
   * (改成只看有没有 token),线上就会把平台影子 token 发给 rightcode-claude /
   * grok / deepseek 那几个**别家**的代理 —— 那是凭据外泄,与出网注入器的 host
   * 白名单是同一条纪律。
   *
   * 这里用「resolver 回 null」代表「上游不是网关」,守的是代理这一侧:
   * 回 null 时必须**原样透传** codex 自带的 Key,不能自作主张动它。
   */
  it('resolver 回 null 时原样透传 codex 自带的 Key', async () => {
    const upstream = await startCapturingUpstream()
    const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, {
      platformHeaders: () => null,
    })
    try {
      await fetch(`${proxy.baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer sk-user-own' },
        body: '{}',
      })
      const h = upstream.headers()
      expect(h.authorization).toBe('Bearer sk-user-own')
      expect(h['x-platform-user-id']).toBeUndefined()
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it('不传这个选项时行为与上线前逐字节相同', async () => {
    const upstream = await startCapturingUpstream()
    const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl)
    try {
      await fetch(`${proxy.baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer sk-user-own' },
        body: '{}',
      })
      expect(upstream.headers().authorization).toBe('Bearer sk-user-own')
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })
})

describe('Anthropic Messages bridge', () => {
  it('bridges Claude channels, including ones whose preset forgot to say so', () => {
    expect(resolveCompatibilityBridge(resolveProviderChannel('rightcode-claude')))
      .toBe('anthropic-messages')
    // Never-regress guard, mirroring the xAI one: an Anthropic endpoint has no
    // /responses route at all, so an unbridged Claude channel cannot even
    // complete one turn. A missing policy must not be able to cause that.
    expect(resolveCompatibilityBridge({
      id: 'custom-claude',
      name: 'Custom Claude',
      baseUrl: 'https://example.com/v1',
      envKey: 'OPENAI_API_KEY',
      model: 'claude-opus-5',
      compatibilityPolicy: 'none',
    })).toBe('anthropic-messages')
    // Anthropic wins over the namespace bridge: the wire protocol has to be
    // translated before tool shape matters.
    expect(resolveCompatibilityBridge({
      id: 'mislabeled-claude',
      name: 'Mislabeled Claude',
      baseUrl: 'https://example.com/v1',
      envKey: 'OPENAI_API_KEY',
      allowedModels: ['claude-sonnet-5'],
      compatibilityPolicy: 'responses-namespace-bridge',
    })).toBe('anthropic-messages')
  })

  it('translates a Responses turn into a Messages call and streams the reply back', async () => {
    const upstream = await startFakeMessagesUpstream()
    const bridge = await startAnthropicMessagesBridge(upstream.baseUrl)

    try {
      const response = await fetch(`${bridge.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sk-test-key',
        },
        body: JSON.stringify({
          model: 'claude-opus-5',
          stream: true,
          // Codex's per-conversation cache hint. The translator reads its mere
          // presence as consent to emit Anthropic cache breakpoints, which is
          // the bridge's default because reads bill at a tenth of input.
          prompt_cache_key: 'thread-abc',
          instructions: 'You are a helpful assistant.',
          input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
          tools: [
            {
              type: 'namespace',
              name: 'multi_agent_v1',
              tools: [
                { type: 'function', name: 'spawn_agent', parameters: { type: 'object' } },
              ],
            },
          ],
        }),
      })
      const body = await response.text()

      expect(upstream.calls).toHaveLength(1)
      const [call] = upstream.calls
      // Base URL ending in /v1 must be extended to the Messages route.
      expect(call.path).toBe('/v1/messages')
      // Anthropic auth shape, not the Bearer header Codex sends.
      expect(call.headers['x-api-key']).toBe('sk-test-key')
      expect(call.headers.authorization).toBeUndefined()
      expect(call.headers['anthropic-version']).toBeDefined()
      // Messages requires an explicit output budget; Responses has none.
      expect(call.body).toMatchObject({
        model: 'claude-opus-5',
        messages: [{ role: 'user' }],
        max_tokens: expect.any(Number),
      })
      // Namespace tools survive as callable flat functions.
      expect(JSON.stringify(call.body)).toContain('multi_agent_v1__spawn_agent')
      // Caching on by default: the stable system prefix carries a breakpoint so
      // later turns bill it as a read rather than fresh input.
      expect(call.body.system).toMatchObject([
        { cache_control: { type: 'ephemeral' } },
      ])
      // `prompt_cache_key` itself is a Responses-only field with no Messages
      // equivalent — it must be consumed, not forwarded.
      expect(call.body).not.toHaveProperty('prompt_cache_key')

      // Codex only understands Responses events coming back.
      expect(body).toContain('response.created')
      expect(body).toContain('response.completed')
      expect(body).toContain('你好')
    } finally {
      await bridge.close()
      await upstream.close()
    }
  })

  it('emits no cache breakpoints when a channel opts out', async () => {
    // The library gates breakpoint insertion on `prompt_cache_key` alone, so
    // dropping the field is the only way to opt out. Channels do that when the
    // pool bills the 1.25x write and never serves the 0.1x read, where
    // breakpoints are a pure surcharge.
    const upstream = await startFakeMessagesUpstream()
    const bridge = await startAnthropicMessagesBridge(upstream.baseUrl, {
      promptCacheBreakpoints: false,
    })

    try {
      await fetch(`${bridge.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sk-test-key',
        },
        body: JSON.stringify({
          model: 'claude-opus-5',
          stream: true,
          prompt_cache_key: 'thread-abc',
          instructions: 'You are a helpful assistant.',
          input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
        }),
      })

      expect(upstream.calls).toHaveLength(1)
      const [call] = upstream.calls
      expect(JSON.stringify(call.body)).not.toContain('cache_control')
      expect(call.body).not.toHaveProperty('prompt_cache_key')
    } finally {
      await bridge.close()
      await upstream.close()
    }
  })

  it('carries each channel\'s own cache decision through the proxy group', async () => {
    // The decision lives on the channel preset, so it has to survive the hop
    // from preset to running bridge — the two shipped Claude channels disagree,
    // and silently collapsing them onto one default is a billing bug either way.
    expect(resolveProviderChannel('rightcode-claude').promptCacheBreakpoints).toBe(false)
    expect(resolveProviderChannel('apiyi-claude').promptCacheBreakpoints).toBe(true)
  })

  it('refuses non-/responses routes instead of forwarding them as Messages calls', async () => {
    // Everything reaching this loopback origin is Responses traffic by
    // construction; a stray path (a probe, or a future codex route) must fail
    // visibly here rather than being rewritten into a Messages POST upstream.
    const upstream = await startFakeMessagesUpstream()
    const bridge = await startAnthropicMessagesBridge(upstream.baseUrl)

    try {
      const response = await fetch(`${bridge.baseUrl}/models`)
      expect(response.status).toBe(404)
      expect(upstream.calls).toHaveLength(0)
    } finally {
      await bridge.close()
      await upstream.close()
    }
  })

  it('rewrites the Claude channel base URL onto its loopback bridge', async () => {
    const group = await startProviderCompatibilityProxies([
      resolveProviderChannel('rightcode-claude'),
    ])
    try {
      expect(group.providers[0]).toEqual(expect.objectContaining({
        id: 'rightcode-claude',
        // Path segment preserved so Codex's base_url shape is unchanged.
        baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/claude-sale\/v1$/),
        supportsMemories: false,
      }))
    } finally {
      await group.close()
    }
  })
})
