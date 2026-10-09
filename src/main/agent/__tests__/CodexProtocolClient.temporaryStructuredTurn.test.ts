import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { CodexProtocolClient, type CodexProtocolClientOptions } from '../CodexProtocolClient'
import type { TemporaryStructuredTurnRequest } from '../types'

/**
 * Hidden structured requests (thread titles) mirror the upstream TUI's
 * `temporary_structured_request.rs` @ rust-v0.161.0: read the effective config
 * first and fail closed, start an ephemeral read-only thread with every MCP
 * server and built-in tool family disabled, run one turn constrained by an
 * output schema, interrupt it on timeout, and always detach the thread.
 */

type TurnBehavior = 'complete' | 'hang' | 'fail' | 'interaction'

interface FakeOptions {
  configReadFails?: boolean
  sandboxType?: string
  turn?: TurnBehavior
}

interface FakeCodexServer {
  url: string
  received: any[]
  close: () => Promise<void>
}

const TEMP_THREAD = 'tmp-1'
const TEMP_TURN = 'turn-t'

async function startFakeCodexServer(options: FakeOptions = {}): Promise<FakeCodexServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port
  const received: any[] = []
  let activeSocket: WebSocket | null = null

  wss.on('connection', (ws) => {
    activeSocket = ws
    const reply = (id: unknown, result: unknown): void => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
    }
    const notify = (method: string, params: unknown): void => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
    }
    const completeTurn = (status: string): void => {
      notify('turn/completed', { threadId: TEMP_THREAD, turn: { id: TEMP_TURN, status } })
    }
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      received.push(msg)
      if (msg.id === undefined || msg.method === undefined) return
      switch (msg.method) {
        case 'initialize':
          reply(msg.id, { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' })
          return
        case 'config/read':
          if (options.configReadFails) {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'config read failed' } }))
            return
          }
          reply(msg.id, {
            config: {
              model: 'gpt-5.5',
              mcp_servers: { catimation: { url: 'http://127.0.0.1:1/mcp' }, apiyi: { command: 'node' } },
            },
            origins: {},
          })
          return
        case 'thread/start':
          reply(msg.id, {
            thread: { id: TEMP_THREAD, preview: '', cwd: msg.params.cwd },
            model: msg.params.model,
            modelProvider: msg.params.modelProvider ?? 'openai',
            cwd: msg.params.cwd,
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            sandbox: { type: options.sandboxType ?? 'readOnly' },
          })
          return
        case 'turn/start':
          setTimeout(() => {
            reply(msg.id, { turn: { id: TEMP_TURN, status: 'inProgress' } })
            const behavior = options.turn ?? 'complete'
            if (behavior === 'hang') return
            if (behavior === 'fail') {
              completeTurn('failed')
              return
            }
            if (behavior === 'interaction') {
              ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: 900,
                method: 'item/commandExecution/requestApproval',
                params: { threadId: TEMP_THREAD, turnId: TEMP_TURN, itemId: 'cmd-1' },
              }))
              notify('item/agentMessage/delta', {
                threadId: TEMP_THREAD, turnId: 'turn-stale', itemId: 'stale', delta: 'late',
              })
            }
            notify('item/agentMessage/delta', {
              threadId: TEMP_THREAD, turnId: TEMP_TURN, itemId: 'msg-1', delta: '{"title":',
            })
            notify('item/agentMessage/delta', {
              threadId: TEMP_THREAD, turnId: TEMP_TURN, itemId: 'msg-1', delta: '"Fix login bug"}',
            })
            notify('thread/tokenUsage/updated', {
              threadId: TEMP_THREAD,
              turnId: TEMP_TURN,
              tokenUsage: {
                total: { inputTokens: 1200, cachedInputTokens: 0, outputTokens: 12, reasoningOutputTokens: 0, totalTokens: 1212 },
                last: { inputTokens: 1200, cachedInputTokens: 0, outputTokens: 12, reasoningOutputTokens: 0, totalTokens: 1212 },
              },
            })
            completeTurn('completed')
          }, 20)
          return
        case 'turn/interrupt':
          reply(msg.id, {})
          return
        case 'thread/unsubscribe':
          reply(msg.id, { status: 'unsubscribed' })
          return
        default:
          reply(msg.id, {})
      }
    })
  })

  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    async close() {
      try { activeSocket?.close() } catch { /* ignore */ }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

function titleRequest(overrides: Partial<TemporaryStructuredTurnRequest> = {}): TemporaryStructuredTurnRequest {
  return {
    threadSource: 'thread_title',
    model: 'qwen3.8-flash',
    modelProvider: 'apiyi-qwen',
    cwd: 'D:/work',
    prompt: 'Generate a title\n\nUser prompt:\n修复登录页',
    outputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    ...overrides,
  }
}

function sent(server: FakeCodexServer, method: string): any[] {
  return server.received.filter((m) => m.method === method)
}

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const DISABLED_FEATURES = [
  'apps', 'code_mode', 'code_mode_only', 'context_management', 'current_time_reminder',
  'deferred_executor', 'enable_fanout', 'goals', 'hooks', 'image_generation', 'memories',
  'multi_agent', 'multi_agent_v2', 'plugins', 'request_permissions_tool', 'shell_snapshot',
  'shell_tool', 'standalone_web_search', 'token_budget', 'tool_suggest', 'unified_exec', 'view_image',
]

describe('CodexProtocolClient.runTemporaryStructuredTurn', () => {
  let server: FakeCodexServer | null = null
  let client: CodexProtocolClient | null = null

  async function connect(fake: FakeOptions = {}, options: Partial<CodexProtocolClientOptions> = {}): Promise<CodexProtocolClient> {
    server = await startFakeCodexServer(fake)
    client = new CodexProtocolClient({ url: server.url, clientInfo: { name: 't', version: '0' }, ...options })
    await client.start()
    return client
  }

  afterEach(async () => {
    await client?.stop()
    client = null
    await server?.close()
    server = null
  })

  it('reads the effective MCP servers first, then starts an ephemeral read-only thread with every tool off', async () => {
    const c = await connect({}, { experimentalApi: true })

    await c.runTemporaryStructuredTurn(titleRequest())

    const methods = server!.received.map((m) => m.method)
    expect(methods.indexOf('config/read')).toBeLessThan(methods.indexOf('thread/start'))
    expect(sent(server!, 'config/read')[0].params).toEqual({ includeLayers: false, cwd: 'D:/work' })

    const params = sent(server!, 'thread/start')[0].params
    expect(params).toMatchObject({
      model: 'qwen3.8-flash',
      modelProvider: 'apiyi-qwen',
      cwd: 'D:/work',
      ephemeral: true,
      threadSource: 'thread_title',
      sandbox: 'read-only',
      dynamicTools: [],
      environments: [],
      selectedCapabilityRoots: [],
      runtimeWorkspaceRoots: [],
    })
    expect('approvalPolicy' in params).toBe(false)
    for (const feature of DISABLED_FEATURES) {
      expect(params.config[`features.${feature}`], feature).toBe(false)
    }
    expect(params.config).toMatchObject({
      'cloud.skills.enabled': false,
      'skills.include_instructions': false,
      'tools.experimental_request_user_input.enabled': false,
      'tools.update_plan.enabled': false,
      web_search: 'disabled',
      default_permissions: ':read-only',
      'mcp_servers.catimation.enabled': false,
      'mcp_servers.apiyi.enabled': false,
    })
  })

  it('leaves the experimental-only thread/start fields out when the experimental API is off', async () => {
    const c = await connect()

    await c.runTemporaryStructuredTurn(titleRequest({ modelProvider: undefined }))

    const params = sent(server!, 'thread/start')[0].params
    for (const field of ['dynamicTools', 'environments', 'selectedCapabilityRoots', 'runtimeWorkspaceRoots', 'modelProvider']) {
      expect(field in params, field).toBe(false)
    }
  })

  it('returns the last agent message with its usage, then detaches the thread', async () => {
    const c = await connect()
    const req = titleRequest()

    const result = await c.runTemporaryStructuredTurn(req)

    expect(result.text).toBe('{"title":"Fix login bug"}')
    expect(result.usage?.inputTokens).toBe(1200)
    const turnStart = sent(server!, 'turn/start')[0].params
    expect(turnStart).toEqual({
      threadId: TEMP_THREAD,
      input: [{ type: 'text', text: req.prompt, text_elements: [] }],
      outputSchema: req.outputSchema,
    })
    await waitUntil(() => sent(server!, 'thread/unsubscribe').length > 0)
    expect(sent(server!, 'thread/unsubscribe')[0].params).toEqual({ threadId: TEMP_THREAD })
  })

  it('fails closed when the effective config cannot be read', async () => {
    const c = await connect({ configReadFails: true })

    await expect(c.runTemporaryStructuredTurn(titleRequest())).rejects.toThrow(/config read failed/)
    expect(sent(server!, 'thread/start')).toHaveLength(0)
  })

  it('refuses a thread that did not start read-only', async () => {
    const c = await connect({ sandboxType: 'dangerFullAccess' })

    await expect(c.runTemporaryStructuredTurn(titleRequest())).rejects.toThrow(/read-only/)
    expect(sent(server!, 'turn/start')).toHaveLength(0)
    expect(sent(server!, 'thread/unsubscribe')[0]?.params).toEqual({ threadId: TEMP_THREAD })
  })

  it('times out, interrupts the hidden turn and detaches', async () => {
    const c = await connect({ turn: 'hang' })

    await expect(c.runTemporaryStructuredTurn(titleRequest({ timeoutMs: 150 }))).rejects.toThrow(/timed out/)
    expect(sent(server!, 'turn/interrupt')[0]?.params).toEqual({ threadId: TEMP_THREAD, turnId: TEMP_TURN })
    expect(sent(server!, 'thread/unsubscribe')[0]?.params).toEqual({ threadId: TEMP_THREAD })
  })

  it('rejects a turn that ended without completing', async () => {
    const c = await connect({ turn: 'fail' })

    await expect(c.runTemporaryStructuredTurn(titleRequest())).rejects.toThrow(/failed/)
    expect(sent(server!, 'thread/unsubscribe')[0]?.params).toEqual({ threadId: TEMP_THREAD })
  })

  it('does not count as in-flight work, so it never blocks a provider switch', async () => {
    const c = await connect({ turn: 'hang' })

    const pending = c.runTemporaryStructuredTurn(titleRequest({ timeoutMs: 400 }))
    const settled = pending.catch((error: unknown) => error)
    await waitUntil(() => sent(server!, 'turn/start').length > 0)
    await new Promise((r) => setTimeout(r, 60))

    expect(c.hasInFlightWork()).toBe(false)
    expect(c.hasActiveTurns()).toBe(false)
    expect(await settled).toBeInstanceOf(Error)
  })

  it('declines interaction requests and keeps its events away from sub-agent routing', async () => {
    const approvals: unknown[] = []
    const unrouted: unknown[] = []
    const c = await connect({ turn: 'interaction' }, {
      onApprovalRequest: (request) => approvals.push(request),
      onUnroutedEvent: (event) => unrouted.push(event),
    })

    const result = await c.runTemporaryStructuredTurn(titleRequest())

    expect(result.text).toBe('{"title":"Fix login bug"}')
    expect(approvals).toEqual([])
    expect(unrouted).toEqual([])
    const answer = server!.received.find((m) => m.id === 900 && m.method === undefined)
    expect(answer?.result).toBeDefined()
  })
})
