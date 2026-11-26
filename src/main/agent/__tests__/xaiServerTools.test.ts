import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  XAI_INSTRUCTIONS_MARKER,
  hasInjectedXaiServerTools,
  injectXaiServerTools,
  stripInjectedXaiServerTools,
  xaiServerToolsFromSessionConfig,
  type XaiServerToolsSettings,
} from '../xaiServerTools'
import { startResponsesCompatibilityProxy } from '../responsesCompatibilityProxy'

type Body = Record<string, unknown>

const WEB_SEARCH = { type: 'web_search' }
const FUNCTION_TOOL = { type: 'function', name: 'shell', parameters: { type: 'object' } }

function grokBody(overrides: Body = {}): Body {
  return {
    model: 'grok-4.7',
    instructions: 'You are Codex.',
    tools: [FUNCTION_TOOL, WEB_SEARCH],
    input: [],
    ...overrides,
  }
}

const OFF: XaiServerToolsSettings = { xSearch: false, codeInterpreter: false, remoteMcp: [] }
const ALL_ON: XaiServerToolsSettings = {
  xSearch: true,
  codeInterpreter: true,
  remoteMcp: [{ label: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' }],
}

function types(body: Body): unknown[] {
  return (body.tools as Array<Record<string, unknown>>).map((tool) => tool.type)
}

describe('injectXaiServerTools', () => {
  it('adds x_search, code_interpreter and every remote MCP in a stable order', () => {
    const body = grokBody()
    const injected = injectXaiServerTools(body, ALL_ON)
    expect(injected).toEqual(['x_search', 'code_interpreter', 'mcp'])
    expect(types(body)).toEqual(['function', 'web_search', 'x_search', 'code_interpreter', 'mcp'])
    expect((body.tools as unknown[])[4]).toEqual({
      type: 'mcp',
      server_label: 'deepwiki',
      server_url: 'https://mcp.deepwiki.com/mcp',
      // 文档:默认会返回审批请求;codex 没有处理它的通道,必须自动放行
      require_approval: 'never',
    })
  })

  it('leaves the body byte-identical when nothing is enabled or settings are missing', () => {
    for (const settings of [OFF, null, undefined]) {
      const body = grokBody()
      const before = JSON.stringify(body)
      expect(injectXaiServerTools(body, settings)).toEqual([])
      expect(JSON.stringify(body)).toBe(before)
    }
  })

  it.each(['gpt-5.5', 'qwen3.8-max', 'gemini-4-neon', 'deepseek-v4-pro', 'claude-opus-5'])(
    'never touches a non-xAI model (%s) even with everything enabled',
    (model) => {
      const body = grokBody({ model })
      const before = JSON.stringify(body)
      expect(injectXaiServerTools(body, ALL_ON)).toEqual([])
      expect(JSON.stringify(body)).toBe(before)
    },
  )

  it('applies to every grok slug', () => {
    for (const model of ['grok-4.5', 'grok-4.6', 'grok-4.7']) {
      const body = grokBody({ model })
      expect(injectXaiServerTools(body, { ...OFF, codeInterpreter: true })).toEqual(['code_interpreter'])
    }
  })

  it('x_search follows web search: no web_search tool in the request = no x_search', () => {
    const body = grokBody({ tools: [FUNCTION_TOOL] })
    expect(injectXaiServerTools(body, { ...OFF, xSearch: true })).toEqual([])
    expect(types(body)).toEqual(['function'])
  })

  it('code_interpreter and MCP do not depend on web search', () => {
    const body = grokBody({ tools: [FUNCTION_TOOL] })
    expect(injectXaiServerTools(body, ALL_ON)).toEqual(['code_interpreter', 'mcp'])
  })

  it('does nothing for requests with no tools array (e.g. hidden title / memory turns)', () => {
    for (const tools of [undefined, []]) {
      const body = grokBody()
      if (tools === undefined) delete body.tools
      else body.tools = tools
      const before = JSON.stringify(body)
      expect(injectXaiServerTools(body, ALL_ON)).toEqual([])
      expect(JSON.stringify(body)).toBe(before)
    }
  })

  it('is idempotent: injecting twice does not duplicate tools or the instructions note', () => {
    const body = grokBody()
    injectXaiServerTools(body, ALL_ON)
    const once = JSON.stringify(body)
    expect(injectXaiServerTools(body, ALL_ON)).toEqual([])
    expect(JSON.stringify(body)).toBe(once)
    expect((body.instructions as string).split(XAI_INSTRUCTIONS_MARKER)).toHaveLength(2)
  })

  it('drops remote MCP entries that fail validation (hand-edited config file)', () => {
    const body = grokBody()
    const injected = injectXaiServerTools(body, {
      ...OFF,
      remoteMcp: [
        { label: 'plain', url: 'http://example.com/mcp' },
        { label: 'local', url: 'https://localhost/mcp' },
        { label: 'private', url: 'https://10.1.2.3/mcp' },
        { label: 'creds', url: 'https://u:p@example.com/mcp' },
        { label: '9bad', url: 'https://example.com/mcp' },
        { label: 'ok', url: 'https://ok.example.com/mcp' },
      ],
    })
    expect(injected).toEqual(['mcp'])
    const mcp = (body.tools as Array<Record<string, unknown>>).filter((tool) => tool.type === 'mcp')
    expect(mcp.map((tool) => tool.server_label)).toEqual(['ok'])
  })

  it('caps remote MCP at the documented limit', () => {
    const remoteMcp = Array.from({ length: 9 }, (_, i) => ({
      label: `s${i}`,
      url: `https://s${i}.example.com/mcp`,
    }))
    const body = grokBody()
    injectXaiServerTools(body, { ...OFF, remoteMcp })
    expect((body.tools as Array<Record<string, unknown>>).filter((tool) => tool.type === 'mcp')).toHaveLength(5)
  })

  it('does not add a second MCP entry for a label already in the request', () => {
    const body = grokBody({ tools: [FUNCTION_TOOL, WEB_SEARCH, { type: 'mcp', server_label: 'deepwiki', server_url: 'https://x.example.com/mcp' }] })
    expect(injectXaiServerTools(body, { ...OFF, remoteMcp: ALL_ON.remoteMcp })).toEqual([])
  })

  describe('instructions note', () => {
    it('appends a note that only mentions the injected tools', () => {
      const body = grokBody()
      injectXaiServerTools(body, { ...OFF, codeInterpreter: true })
      const text = body.instructions as string
      expect(text.startsWith('You are Codex.\n\n')).toBe(true)
      expect(text).toContain(XAI_INSTRUCTIONS_MARKER)
      expect(text).toContain('code_interpreter')
      // 必须讲清「看不到本机文件」,否则模型会把沙箱里的运行当成本机已改好
      expect(text).toContain('看不到用户本机')
      expect(text).not.toContain('x_search')
      expect(text).not.toContain('远程 MCP')
    })

    it('names the MCP labels it injected', () => {
      const body = grokBody()
      injectXaiServerTools(body, { ...OFF, remoteMcp: ALL_ON.remoteMcp })
      expect(body.instructions).toContain('deepwiki')
    })

    it('creates the instructions when the request had none', () => {
      const body = grokBody()
      delete body.instructions
      injectXaiServerTools(body, { ...OFF, codeInterpreter: true })
      expect((body.instructions as string).startsWith(XAI_INSTRUCTIONS_MARKER)).toBe(true)
    })
  })
})

describe('stripInjectedXaiServerTools', () => {
  it('is the exact inverse of injection (tools and instructions)', () => {
    const original = grokBody()
    const injected = grokBody()
    injectXaiServerTools(injected, ALL_ON)
    expect(hasInjectedXaiServerTools(injected)).toBe(true)
    expect(stripInjectedXaiServerTools(injected)).toEqual(original)
  })

  it('removes an injected-only instructions field entirely', () => {
    const injected = grokBody()
    delete injected.instructions
    injectXaiServerTools(injected, { ...OFF, codeInterpreter: true })
    expect('instructions' in stripInjectedXaiServerTools(injected)).toBe(false)
  })

  it('does not mutate its input', () => {
    const injected = grokBody()
    injectXaiServerTools(injected, ALL_ON)
    const snapshot = JSON.stringify(injected)
    stripInjectedXaiServerTools(injected)
    expect(JSON.stringify(injected)).toBe(snapshot)
  })

  it('leaves a request with nothing injected untouched', () => {
    const plain = grokBody()
    expect(hasInjectedXaiServerTools(plain)).toBe(false)
    expect(stripInjectedXaiServerTools(plain)).toEqual(plain)
  })
})

describe('xaiServerToolsFromSessionConfig', () => {
  it('returns null when nothing is enabled so the bridge can skip the whole step', () => {
    expect(xaiServerToolsFromSessionConfig({ grokXSearch: false, grokCodeInterpreter: false, grokRemoteMcp: [] })).toBeNull()
  })

  it('maps each switch independently', () => {
    expect(xaiServerToolsFromSessionConfig({ grokXSearch: true, grokCodeInterpreter: false, grokRemoteMcp: [] }))
      .toEqual({ xSearch: true, codeInterpreter: false, remoteMcp: [] })
    expect(xaiServerToolsFromSessionConfig({ grokXSearch: false, grokCodeInterpreter: true, grokRemoteMcp: [] }))
      .toEqual({ xSearch: false, codeInterpreter: true, remoteMcp: [] })
    const remoteMcp = [{ label: 'a', url: 'https://a.example.com/mcp' }]
    expect(xaiServerToolsFromSessionConfig({ grokXSearch: false, grokCodeInterpreter: false, grokRemoteMcp: remoteMcp }))
      .toEqual({ xSearch: false, codeInterpreter: false, remoteMcp })
  })

  it('tolerates a config object from an older build that lacks the fields', () => {
    expect(xaiServerToolsFromSessionConfig({} as never)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 经真实 HTTP 边界的桥接行为
// ---------------------------------------------------------------------------

interface FakeUpstream {
  baseUrl: string
  bodies: Body[]
  close: () => Promise<void>
}

/**
 * 记录每条到达的请求体;`statusFor` 决定回什么(默认 200)。
 * 回 200 时给一个最小的 JSON 响应,够桥走完非流式分支。
 */
async function startUpstream(statusFor: (body: Body, index: number) => number = () => 200): Promise<FakeUpstream> {
  const bodies: Body[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Body
      const index = bodies.push(body) - 1
      const status = statusFor(body, index)
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.end(status === 200
        ? JSON.stringify({ id: 'resp_1', status: 'completed', output: [] })
        : JSON.stringify({ error: { message: `upstream said ${status}` } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

async function post(baseUrl: string, body: Body): Promise<{ status: number; text: string }> {
  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}

/** codex 真实会发的 web_search 形状(带 xAI 不认的字段,桥会先去掉)。 */
function codexBody(model = 'grok-4.7'): Body {
  return grokBody({
    model,
    tools: [FUNCTION_TOOL, { type: 'web_search', external_web_access: true }],
  })
}

describe('bridge: xAI server tools over HTTP', () => {
  it('injects the enabled tools into a grok request (after the web_search cleanup)', async () => {
    const upstream = await startUpstream()
    const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, { xaiServerTools: () => ALL_ON })
    try {
      const reply = await post(proxy.baseUrl, codexBody())
      expect(reply.status).toBe(200)
      const seen = upstream.bodies[0]
      expect(seen.tools).toEqual([
        FUNCTION_TOOL,
        { type: 'web_search' }, // external_web_access 已被既有逻辑剥掉
        { type: 'x_search' },
        { type: 'code_interpreter' },
        { type: 'mcp', server_label: 'deepwiki', server_url: 'https://mcp.deepwiki.com/mcp', require_approval: 'never' },
      ])
      expect(seen.instructions).toContain(XAI_INSTRUCTIONS_MARKER)
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it('forwards exactly what it did before when the option is not passed', async () => {
    const upstream = await startUpstream()
    const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl)
    try {
      await post(proxy.baseUrl, codexBody())
      expect(upstream.bodies[0].tools).toEqual([FUNCTION_TOOL, { type: 'web_search' }])
      expect(upstream.bodies[0].instructions).toBe('You are Codex.')
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it('does not touch a Qwen request that goes through the same bridge', async () => {
    const upstream = await startUpstream()
    const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, { xaiServerTools: () => ALL_ON })
    try {
      await post(proxy.baseUrl, codexBody('qwen3.8-max'))
      expect(upstream.bodies[0].tools).toEqual([FUNCTION_TOOL, { type: 'web_search' }])
      expect(upstream.bodies[0].instructions).toBe('You are Codex.')
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it('reads the settings per request, so a toggle applies to the very next message', async () => {
    const upstream = await startUpstream()
    let settings: XaiServerToolsSettings | null = null
    const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, { xaiServerTools: () => settings })
    try {
      await post(proxy.baseUrl, codexBody())
      settings = { ...OFF, codeInterpreter: true }
      await post(proxy.baseUrl, codexBody())
      settings = null
      await post(proxy.baseUrl, codexBody())
      expect(types(upstream.bodies[0])).toEqual(['function', 'web_search'])
      expect(types(upstream.bodies[1])).toEqual(['function', 'web_search', 'code_interpreter'])
      expect(types(upstream.bodies[2])).toEqual(['function', 'web_search'])
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it('a throwing settings reader never turns the request into an error', async () => {
    const upstream = await startUpstream()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, {
      xaiServerTools: () => { throw new Error('boom') },
    })
    try {
      const reply = await post(proxy.baseUrl, codexBody())
      expect(reply.status).toBe(200)
      expect(types(upstream.bodies[0])).toEqual(['function', 'web_search'])
    } finally {
      warn.mockRestore()
      await proxy.close()
      await upstream.close()
    }
  })

  describe('fallback when the gateway rejects the injected tools', () => {
    const rejectInjected = (body: Body): number => (hasInjectedXaiServerTools(body) ? 400 : 200)

    it('retries once without the injected tools and hands the client the good answer', async () => {
      const upstream = await startUpstream(rejectInjected)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, { xaiServerTools: () => ALL_ON })
      try {
        const reply = await post(proxy.baseUrl, codexBody())
        expect(reply.status).toBe(200)
        expect(upstream.bodies).toHaveLength(2)
        expect(hasInjectedXaiServerTools(upstream.bodies[0])).toBe(true)
        expect(hasInjectedXaiServerTools(upstream.bodies[1])).toBe(false)
        // 重发的请求也要去掉我们追加的说明,否则模型被告知有一堆实际没有的工具
        expect(upstream.bodies[1].instructions).toBe('You are Codex.')
        expect(upstream.bodies[1].tools).toEqual([FUNCTION_TOOL, { type: 'web_search' }])
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
        await proxy.close()
        await upstream.close()
      }
    })

    it('also falls back on 422 (xAI-style deserialization errors)', async () => {
      const upstream = await startUpstream((body) => (hasInjectedXaiServerTools(body) ? 422 : 200))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, { xaiServerTools: () => ALL_ON })
      try {
        expect((await post(proxy.baseUrl, codexBody())).status).toBe(200)
        expect(upstream.bodies).toHaveLength(2)
      } finally {
        warn.mockRestore()
        await proxy.close()
        await upstream.close()
      }
    })

    it('stops injecting for the same settings after a successful fallback (no wasted round trip per turn)', async () => {
      const upstream = await startUpstream(rejectInjected)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, { xaiServerTools: () => ALL_ON })
      try {
        await post(proxy.baseUrl, codexBody())
        expect(upstream.bodies).toHaveLength(2)
        await post(proxy.baseUrl, codexBody())
        await post(proxy.baseUrl, codexBody())
        // 后两条各只打一次,而且都不带注入内容
        expect(upstream.bodies).toHaveLength(4)
        expect(hasInjectedXaiServerTools(upstream.bodies[2])).toBe(false)
        expect(hasInjectedXaiServerTools(upstream.bodies[3])).toBe(false)
      } finally {
        warn.mockRestore()
        await proxy.close()
        await upstream.close()
      }
    })

    it('tries again once the user changes the settings', async () => {
      const upstream = await startUpstream(rejectInjected)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      let settings: XaiServerToolsSettings = ALL_ON
      const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, { xaiServerTools: () => settings })
      try {
        await post(proxy.baseUrl, codexBody())
        settings = { ...OFF, codeInterpreter: true }
        await post(proxy.baseUrl, codexBody())
        // 设置变了 → 重新尝试注入(先带工具失败一次,再回退)
        const latest = upstream.bodies.slice(2)
        expect(latest).toHaveLength(2)
        expect(hasInjectedXaiServerTools(latest[0])).toBe(true)
        expect(hasInjectedXaiServerTools(latest[1])).toBe(false)
      } finally {
        warn.mockRestore()
        await proxy.close()
        await upstream.close()
      }
    })

    it('expires the "rejected" memory after the TTL', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const upstream = await startUpstream(rejectInjected)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, { xaiServerTools: () => ALL_ON })
      try {
        await post(proxy.baseUrl, codexBody())
        expect(upstream.bodies).toHaveLength(2)
        vi.setSystemTime(Date.now() + 16 * 60 * 1000)
        await post(proxy.baseUrl, codexBody())
        // 过期后重新尝试注入:又是「带工具失败 + 回退」两次
        expect(upstream.bodies).toHaveLength(4)
        expect(hasInjectedXaiServerTools(upstream.bodies[2])).toBe(true)
      } finally {
        vi.useRealTimers()
        warn.mockRestore()
        await proxy.close()
        await upstream.close()
      }
    })

    it('passes a 400 straight through when nothing was injected (not our error)', async () => {
      const upstream = await startUpstream(() => 400)
      // 联网搜索关了 → x_search 不会注入 → 请求里没有我们的东西
      const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, {
        xaiServerTools: () => ({ ...OFF, xSearch: true }),
      })
      try {
        const reply = await post(proxy.baseUrl, grokBody({ tools: [FUNCTION_TOOL] }))
        expect(reply.status).toBe(400)
        expect(reply.text).toContain('upstream said 400')
        expect(upstream.bodies).toHaveLength(1)
      } finally {
        await proxy.close()
        await upstream.close()
      }
    })

    it('hands back the clean request\'s error when the retry fails too, and does not remember it', async () => {
      const upstream = await startUpstream((body) => (hasInjectedXaiServerTools(body) ? 400 : 401))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, { xaiServerTools: () => ALL_ON })
      try {
        const first = await post(proxy.baseUrl, codexBody())
        expect(first.status).toBe(401)
        expect(upstream.bodies).toHaveLength(2)
        // 重发也失败 → 不能记成「上游拒绝了注入」,下一条仍要正常带工具
        await post(proxy.baseUrl, codexBody())
        expect(hasInjectedXaiServerTools(upstream.bodies[2])).toBe(true)
      } finally {
        warn.mockRestore()
        await proxy.close()
        await upstream.close()
      }
    })

    it('does not retry server errors (5xx) — that would double-bill a transient failure', async () => {
      const upstream = await startUpstream((body) => (hasInjectedXaiServerTools(body) ? 500 : 200))
      const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, { xaiServerTools: () => ALL_ON })
      try {
        const reply = await post(proxy.baseUrl, codexBody())
        expect(reply.status).toBe(500)
        expect(upstream.bodies).toHaveLength(1)
      } finally {
        await proxy.close()
        await upstream.close()
      }
    })

    it('does not retry a non-xAI model (nothing was injected for it)', async () => {
      const upstream = await startUpstream(() => 400)
      const proxy = await startResponsesCompatibilityProxy(upstream.baseUrl, { xaiServerTools: () => ALL_ON })
      try {
        const reply = await post(proxy.baseUrl, codexBody('qwen3.8-max'))
        expect(reply.status).toBe(400)
        expect(upstream.bodies).toHaveLength(1)
      } finally {
        await proxy.close()
        await upstream.close()
      }
    })
  })
})
