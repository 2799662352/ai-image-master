import { createMcpExpressApp } from '@modelcontextprotocol/express'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { McpServer, isInitializeRequest } from '@modelcontextprotocol/server'
import type { BrowserWindow } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Express, Request, Response } from 'express'
import { CATIMATION_MCP_HOST, CATIMATION_MCP_PORT, CATIMATION_MCP_TOKEN_HEADER } from './config'
import { startCatimationBridgeListener, type BridgeRuntime } from './bridge'
import { ToolRouter } from './ToolRouter'
import { CATIMATION_SERVER_INSTRUCTIONS } from './serverInstructions'
import { setToolTelemetrySink } from './toolTelemetry'
import { createToolCallTelemetrySink } from './toolTelemetrySink'
import { registerTools } from './tools'

export interface McpRuntime {
  port: number
  token: string
  router: ToolRouter
  /**
   * The bound Node HTTP server. Exposed so callers/tests can close it and so
   * its keep-alive/request timeouts (configured for long-lived MCP tool
   * calls) are observable.
   */
  httpServer: HttpServer
  /**
   * TCP loopback listener for the stdio bridge (resources/catimation-bridge).
   * This is the PREFERRED codex transport — the HTTP listener above remains
   * for external clients (e.g. a user-level Cursor `mcp.json` pointing at
   * `http://127.0.0.1:7842/mcp`). Null when the bridge listener failed to
   * bind, in which case codex falls back to streamable HTTP.
   */
  bridge: BridgeRuntime | null
}

/**
 * Race-free bind helper. Resolves once the OS confirms we got the requested
 * port (or an ephemeral one when port=0); rejects with the bind error
 * otherwise.
 *
 * Wrapping `app.listen` in a Promise is necessary because Node's net Server
 * surfaces failures via the `'error'` event, which — if left unhandled —
 * crashes the main process (this is exactly the crash dialog reported on
 * Windows machines where Hyper-V/WSL2 had reserved 7842 at the OS level
 * even though no process was actually using it).
 *
 * Exported for unit tests so the fallback policy can be exercised in
 * isolation from `startCatimationMcpServer`.
 */
export function listenOnPort(app: Express, host: string, port: number): Promise<{ server: HttpServer; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host)
    const onError = (err: Error & { code?: string }) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      const addr = server.address() as AddressInfo | null
      // `addr` should never be null here because we just got 'listening', but
      // node's typings allow it (e.g. unix sockets). Bail loudly if so — the
      // caller can fall back to ephemeral or surface the error.
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('mcp listen: address() returned no port info'))
        return
      }
      resolve({ server, port: addr.port })
    }
    server.once('error', onError)
    server.once('listening', onListening)
  })
}

function isPortBindError(err: unknown): err is NodeJS.ErrnoException {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  // EACCES — Windows OS-level port exclusion (Hyper-V/WSL2/Docker) or
  // Unix privileged port. EADDRINUSE — another process is actually
  // listening. Both should trigger a fallback to ephemeral.
  return code === 'EACCES' || code === 'EADDRINUSE' || code === 'EADDRNOTAVAIL'
}

export async function startCatimationMcpServer(
  win: BrowserWindow,
  port = CATIMATION_MCP_PORT
): Promise<McpRuntime | null> {
  const token = randomBytes(32).toString('hex')
  // 埋点的落盘端在这里装 —— toolTelemetry 自己不碰 electron,不装就是不记,
  // 所以单测与渲染端引用它既不会写盘也不需要 mock。
  setToolTelemetrySink(createToolCallTelemetrySink())
  const router = new ToolRouter(win)

  // One McpServer instance PER CONNECTION/SESSION, all sharing this router.
  // The SDK's Protocol is a single-transport state machine: `connect()` sets
  // `this._transport`, and responses go to whatever `_transport` points at
  // when the request arrives. Sharing one instance across sessions meant a
  // second connection (codex subagent bridge, codex HTTP re-init, external
  // Cursor client) silently stole response routing from the first — the
  // first session's in-flight tool result was written to the wrong peer and
  // codex hung forever. Per-session instances are the SDK's own documented
  // multi-session pattern; registering the handful of tools per session is
  // cheap (no I/O, just closures over the shared router).
  const createServerInstance = (): McpServer => {
    // `instructions` 装跨工具的选择关系与并发边界 —— 单个工具的 description 说不全
    // 这些,而 codex 官方文档明确要求 server 作者用这个字段承载它们。
    const server = new McpServer(
      { name: 'catimation', version: '1.0.0' },
      { instructions: CATIMATION_SERVER_INSTRUCTIONS },
    )
    registerTools(server, router)
    return server
  }

  const app = createMcpExpressApp({ host: CATIMATION_MCP_HOST })
  app.use((req, res, next) => {
    if (req.headers[CATIMATION_MCP_TOKEN_HEADER] !== token) {
      res.status(401).send('unauthorized')
      return
    }
    next()
  })

  const transports = new Map<string, NodeStreamableHTTPServerTransport>()

  // Per the MCP streamable-HTTP spec, an unknown/expired session MUST get
  // HTTP 404 — that status is the signal that tells the client (codex's rmcp)
  // to re-initialize a FRESH session and recover. Anything else (our old 400,
  // or Express's HTML 404 for unrouted GET/DELETE) leaves rmcp permanently
  // wedged after a transport drop: every later tool call fails with
  // "Unexpected content type" / "session expired" and the turn hangs.
  const sessionNotFound = (res: Response): void => {
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: null,
    })
  }

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body)
      return
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => transports.set(sid, transport),
      })
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId)
      }
      // Fresh per-session instance — see createServerInstance for why.
      await createServerInstance().connect(transport)
      await transport.handleRequest(req, res, req.body)
      return
    }

    if (sessionId) {
      sessionNotFound(res)
      return
    }
    res.status(400).json({ error: 'Invalid request' })
  })

  // GET = the client's server→client SSE "common stream"; DELETE = explicit
  // session teardown. Both are part of the streamable-HTTP lifecycle. We only
  // routed POST before, so rmcp logged "fail to get common stream: 404" on
  // every session and teardown DELETEs bounced off Express's HTML 404.
  const handleSessionRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res)
      return
    }
    sessionNotFound(res)
  }
  app.get('/mcp', handleSessionRequest)
  app.delete('/mcp', handleSessionRequest)

  // Bind strategy (see openai/codex#11269 for upstream precedent):
  //   1. Try the configured fixed port (predictable URL during dev/debug).
  //   2. If the OS rejects with EACCES/EADDRINUSE/EADDRNOTAVAIL — most often
  //      because Hyper-V/WSL2/Docker silently reserved the port at the OS
  //      level — retry with port 0 to let the OS pick a free ephemeral one.
  //   3. If even that fails (extremely unusual), log and return null so the
  //      app can boot without the MCP tool surface instead of hard-crashing
  //      the main process.
  let bound: { server: HttpServer; port: number } | null = null
  try {
    bound = await listenOnPort(app, CATIMATION_MCP_HOST, port)
  } catch (err) {
    if (isPortBindError(err)) {
      console.warn(
        `[mcp] failed to bind ${CATIMATION_MCP_HOST}:${port} (${(err as NodeJS.ErrnoException).code}) — falling back to ephemeral port. ` +
          `On Windows this typically means Hyper-V/WSL2/Docker Desktop reserved the port range at the OS level; ` +
          `inspect with: netsh interface ipv4 show excludedportrange protocol=tcp`,
      )
      try {
        bound = await listenOnPort(app, CATIMATION_MCP_HOST, 0)
      } catch (err2) {
        console.error('[mcp] ephemeral fallback also failed; MCP server disabled this session:', err2)
        return null
      }
    } else {
      console.error('[mcp] unexpected listen error; MCP server disabled this session:', err)
      return null
    }
  }

  // Loopback-only server hosting MINUTES-long tool calls (image renders hold
  // the POST open while the SSE response waits for the result):
  //  - keepAliveTimeout=0: never close idle pooled sockets. Node's 5s default
  //    races rmcp's connection reuse — the server closes the socket exactly
  //    as the client sends on it, the send fails, and rmcp's worker quits
  //    FATALLY, orphaning the in-flight generate_images result ("经常卡住",
  //    nodejs/node#52649). On 127.0.0.1 idle sockets cost nothing.
  //  - requestTimeout=0: disable Node 18+'s 300s whole-request timer so a
  //    long-lived tool-call exchange is never destroyed mid-render.
  bound.server.keepAliveTimeout = 0
  bound.server.requestTimeout = 0

  // stdio-bridge listener (ephemeral loopback TCP); each bridge connection
  // gets its own McpServer instance from the factory. codex talks to the
  // bridge over stdio pipes — its rmcp HTTP client (and every
  // keep-alive/session failure mode that came with it) leaves the critical
  // path. The HTTP listener above stays up for external clients.
  const bridge = await startCatimationBridgeListener(createServerInstance)

  return { port: bound.port, token, router, httpServer: bound.server, bridge }
}
