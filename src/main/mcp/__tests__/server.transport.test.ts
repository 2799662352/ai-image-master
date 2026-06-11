import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserWindow } from 'electron'
import { startCatimationMcpServer, type McpRuntime } from '../server'
import { CATIMATION_MCP_HOST, CATIMATION_MCP_TOKEN_HEADER } from '../config'

/**
 * Transport-liveness regressions for the "生成图片后经常卡住" incident
 * (2026-06-12, codex log forensics):
 *
 *  1. Node's default `server.keepAliveTimeout` is 5s. rmcp (codex's Rust MCP
 *     client) pools connections; when the server closes an idle socket at the
 *     exact moment the client reuses it, the send fails and rmcp's worker
 *     quits FATALLY — the in-flight `generate_images` result is lost and the
 *     turn hangs forever (nodejs/node#52649 race). Long image renders make
 *     the 5s idle window a near-certainty.
 *  2. We only registered POST /mcp. rmcp's GET (common SSE stream) and DELETE
 *     (session teardown) hit Express's HTML 404 — observed in every session
 *     as "fail to get common stream: 404" / "fail to delete session: 404".
 *  3. Unknown-session requests returned 400. Per the MCP spec they MUST get
 *     404 so the client knows to re-initialize a fresh session — 400 leaves
 *     rmcp permanently wedged after any transport drop.
 */

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length > 0) {
    try { await cleanup.pop()!() } catch { /* best-effort */ }
  }
})

const fakeWin = {} as BrowserWindow

async function bootServer(): Promise<NonNullable<McpRuntime> & { baseUrl: string }> {
  const runtime = await startCatimationMcpServer(fakeWin, 0)
  if (!runtime) throw new Error('failed to boot MCP server for test')
  cleanup.push(() => new Promise<void>((resolve) => runtime.httpServer.close(() => resolve())))
  return { ...runtime, baseUrl: `http://${CATIMATION_MCP_HOST}:${runtime.port}/mcp` }
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'transport-test', version: '0' },
    },
  })
}

async function openSession(baseUrl: string, token: string): Promise<string> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      [CATIMATION_MCP_TOKEN_HEADER]: token,
    },
    body: initializeBody(),
  })
  expect(res.status).toBe(200)
  const sessionId = res.headers.get('mcp-session-id')
  expect(sessionId).toBeTruthy()
  // Drain/cancel the body so the socket is released.
  await res.body?.cancel()
  return sessionId as string
}

describe('catimation MCP transport liveness', () => {
  it('disables the 5s keep-alive idle timeout and the 300s request timeout', async () => {
    const { httpServer } = await bootServer()
    // keepAliveTimeout=0 keeps idle pooled sockets open forever — eliminates
    // the close-vs-reuse race that fatally kills rmcp's worker mid-render.
    expect(httpServer.keepAliveTimeout).toBe(0)
    // requestTimeout=0 so a long-lived tool-call POST (SSE response held open
    // for minutes while an image renders) is never destroyed by Node.
    expect(httpServer.requestTimeout).toBe(0)
  })

  it('returns 404 (not 400) for an unknown session so rmcp re-initializes', async () => {
    const { baseUrl, token } = await bootServer()
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        [CATIMATION_MCP_TOKEN_HEADER]: token,
        'mcp-session-id': 'expired-session-id',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })
    expect(res.status).toBe(404)
    // JSON (parseable by rmcp), not Express's HTML error page.
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('serves the GET common SSE stream for a live session (was Express HTML 404)', async () => {
    const { baseUrl, token } = await bootServer()
    const sessionId = await openSession(baseUrl, token)

    const res = await fetch(baseUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        [CATIMATION_MCP_TOKEN_HEADER]: token,
        'mcp-session-id': sessionId,
      },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    await res.body?.cancel()
  })

  it('handles DELETE session teardown instead of HTML 404', async () => {
    const { baseUrl, token } = await bootServer()
    const sessionId = await openSession(baseUrl, token)

    const res = await fetch(baseUrl, {
      method: 'DELETE',
      headers: {
        [CATIMATION_MCP_TOKEN_HEADER]: token,
        'mcp-session-id': sessionId,
      },
    })
    expect(res.status).toBeLessThan(404)
  })

  it('returns 404 for GET/DELETE with an unknown session', async () => {
    const { baseUrl, token } = await bootServer()
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await fetch(baseUrl, {
        method,
        headers: {
          Accept: 'text/event-stream',
          [CATIMATION_MCP_TOKEN_HEADER]: token,
          'mcp-session-id': 'gone',
        },
      })
      expect(res.status, method).toBe(404)
      expect(res.headers.get('content-type'), method).toContain('application/json')
    }
  })
})
