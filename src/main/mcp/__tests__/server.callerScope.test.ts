import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { startCatimationMcpServer, type McpRuntime } from '../server'
import { CATIMATION_MCP_HOST, CATIMATION_MCP_OWNER_HEADER, CATIMATION_MCP_TOKEN_HEADER } from '../config'
import type { AgentToolRequest } from '../../../types/agent'
import type { CodexToolCaller, ToolThreadResolution } from '../toolCaller'

/**
 * End to end through the REAL MCP server and SDK: an HTTP `tools/call` carrying
 * codex's `_meta` → the tool handler → `ToolRouter` → the request the renderer
 * receives.
 *
 * Why not just unit-test the pieces: the caller travels from the SDK's request
 * context into an AsyncLocalStorage scope that the router reads several awaits
 * later. Whether that scope survives the SDK's own dispatch (its promise
 * chains, its schema validation) is exactly the thing a unit test with a fake
 * server cannot show.
 *
 * `director_capture` / `canvas_snapshot` are the sharp cases: they save their
 * export as a chat attachment, and their tool files never forwarded the caller
 * — so until now the renderer could only ever file the export under whichever
 * chat was open.
 */

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length > 0) {
    try { await cleanup.pop()!() } catch { /* best-effort */ }
  }
})

interface Harness {
  runtime: NonNullable<McpRuntime>
  baseUrl: string
  /** Requests the "renderer" received, in order. */
  sent: AgentToolRequest[]
  resolver: ReturnType<typeof vi.fn>
}

async function boot(
  resolve: (caller: CodexToolCaller) => ToolThreadResolution | undefined,
): Promise<Harness> {
  const sent: AgentToolRequest[] = []
  let runtimeRef: NonNullable<McpRuntime> | null = null
  const win = {
    webContents: {
      // Stand in for the renderer: record the request, answer it at once.
      send: (_channel: string, request: AgentToolRequest) => {
        sent.push(request)
        queueMicrotask(() =>
          runtimeRef?.router.handleRendererResponse({ id: request.id, ok: true, result: { ok: true } }),
        )
      },
    },
  } as unknown as BrowserWindow

  const runtime = await startCatimationMcpServer(win, 0)
  if (!runtime) throw new Error('failed to boot MCP server for test')
  runtimeRef = runtime
  cleanup.push(() => new Promise<void>((done) => runtime.httpServer.close(() => done())))

  const resolver = vi.fn(resolve)
  runtime.router.setThreadResolver(resolver)
  return { runtime, baseUrl: `http://${CATIMATION_MCP_HOST}:${runtime.port}/mcp`, sent, resolver }
}

async function post(
  h: Harness,
  sessionId: string | null,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  return fetch(h.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      [CATIMATION_MCP_TOKEN_HEADER]: h.runtime.token,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(extraHeaders ?? {}),
    },
    body: JSON.stringify(body),
  })
}

async function openSession(h: Harness, extraHeaders?: Record<string, string>): Promise<string> {
  const res = await post(h, null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'caller-scope-test', version: '0' },
    },
  }, extraHeaders)
  expect(res.status).toBe(200)
  const sessionId = res.headers.get('mcp-session-id')
  await res.body?.cancel()
  if (!sessionId) throw new Error('no mcp-session-id')
  const ack = await post(h, sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' })
  await ack.body?.cancel()
  return sessionId
}

let nextId = 10

async function callTool(
  h: Harness,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
): Promise<void> {
  const res = await post(h, sessionId, {
    jsonrpc: '2.0',
    id: nextId++,
    method: 'tools/call',
    params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
  })
  expect(res.status).toBe(200)
  // The response (JSON or a one-event SSE stream) only completes once the tool
  // handler has returned — reading it to the end is how we wait for the call.
  const text = await res.text()
  expect(text, `${name} should not fail`).not.toContain('"isError":true')
}

/** `_meta` exactly as codex 0.169.0 sends it (see scripts/smoke-mcp-thread-meta.ts). */
const plainMeta = (thread: string): Record<string, unknown> => ({
  threadId: thread,
  sessionId: thread,
  'x-codex-turn-metadata': { thread_id: thread, session_id: thread },
})
const subagentMeta = (child: string, parent: string): Record<string, unknown> => ({
  threadId: child,
  sessionId: parent,
  'x-codex-turn-metadata': { thread_id: child, session_id: parent, parent_thread_id: parent },
})

const ownThreadOnly = (map: Record<string, string>) =>
  (caller: CodexToolCaller): ToolThreadResolution | undefined => {
    const hit = caller.threadId ? map[caller.threadId] : undefined
    return hit ? { threadId: hit, via: 'live' } : undefined
  }

describe('real MCP server: a tool call is attributed to the chat that made it', () => {
  it.each([
    ['director_capture', { mode: 'view' }],
    ['canvas_snapshot', {}],
  ])('%s — a tool that never forwarded its caller — reaches the renderer with the caller\'s chat', async (tool, args) => {
    const h = await boot(ownThreadOnly({ 'codex-A': 'db-chat-A' }))
    const session = await openSession(h)

    await callTool(h, session, tool, args, plainMeta('codex-A'))

    const request = h.sent.find((r) => r.toolName === tool)
    expect(request, `${tool} should have been delegated to the renderer`).toBeDefined()
    expect(request!.threadId).toBe('db-chat-A')
  })

  it('two chats calling the same tool through one server each get their own chat', async () => {
    const h = await boot(ownThreadOnly({ 'codex-A': 'db-chat-A', 'codex-B': 'db-chat-B' }))
    const session = await openSession(h)

    await Promise.all([
      callTool(h, session, 'director_capture', { mode: 'view', height: 111 }, plainMeta('codex-A')),
      callTool(h, session, 'director_capture', { mode: 'view', height: 222 }, plainMeta('codex-B')),
    ])

    const byHeight = new Map(h.sent.map((r) => [r.params.height, r.threadId]))
    expect(byHeight.get(111)).toBe('db-chat-A')
    expect(byHeight.get(222)).toBe('db-chat-B')
  })

  it('a sub-agent\'s call carries its parent to the resolver', async () => {
    const h = await boot((caller) =>
      caller.ancestorThreadIds.includes('codex-parent') ? { threadId: 'db-parent-chat', via: 'ancestor' } : undefined,
    )
    const session = await openSession(h)

    await callTool(h, session, 'director_capture', { mode: 'view' }, subagentMeta('codex-child', 'codex-parent'))

    expect(h.resolver).toHaveBeenCalledWith({ threadId: 'codex-child', ancestorThreadIds: ['codex-parent'] })
    expect(h.sent[0].threadId).toBe('db-parent-chat')
  })

  it('a caller no chat owns reaches the renderer with NO thread id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const h = await boot(() => undefined)
      const session = await openSession(h)

      await callTool(h, session, 'director_capture', { mode: 'view' }, plainMeta('codex-stranger'))

      expect(h.sent).toHaveLength(1)
      expect('threadId' in h.sent[0]).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('a call without any `_meta` is not attributed — and the resolver is not even asked', async () => {
    const h = await boot(() => ({ threadId: 'should-not-be-used', via: 'live' }))
    const session = await openSession(h)

    await callTool(h, session, 'director_capture', { mode: 'view' })

    expect(h.resolver).not.toHaveBeenCalled()
    expect('threadId' in h.sent[0]).toBe(false)
  })

  it('HTTP session pinned via x-catimation-thread-id attributes calls even when `_meta` is absent', async () => {
    const h = await boot((caller) =>
      caller.pinnedThreadId ? { threadId: caller.pinnedThreadId, via: 'pinned' } : undefined,
    )
    const sessionA = await openSession(h, { [CATIMATION_MCP_OWNER_HEADER]: 'db-http-A' })
    const sessionB = await openSession(h, { [CATIMATION_MCP_OWNER_HEADER]: 'db-http-B' })
    const sessionBad = await openSession(h, { [CATIMATION_MCP_OWNER_HEADER]: 'bad id' })

    await Promise.all([
      callTool(h, sessionA, 'director_capture', { mode: 'view', height: 101 }),
      callTool(h, sessionB, 'director_capture', { mode: 'view', height: 202 }),
      callTool(h, sessionBad, 'director_capture', { mode: 'view', height: 303 }),
    ])

    const byHeight = new Map(h.sent.map((r) => [r.params.height, r]))
    expect(byHeight.get(101)?.threadId).toBe('db-http-A')
    expect(byHeight.get(202)?.threadId).toBe('db-http-B')
    expect('threadId' in byHeight.get(303)!).toBe(false)
    expect(h.resolver).toHaveBeenCalledWith({ ancestorThreadIds: [], pinnedThreadId: 'db-http-A' })
    expect(h.resolver).toHaveBeenCalledWith({ ancestorThreadIds: [], pinnedThreadId: 'db-http-B' })
  })
})
