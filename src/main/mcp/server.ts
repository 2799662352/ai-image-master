import { createMcpExpressApp } from '@modelcontextprotocol/express'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { McpServer, isInitializeRequest } from '@modelcontextprotocol/server'
import type { BrowserWindow } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import type { AddressInfo, Server } from 'node:net'
import type { Express } from 'express'
import { CATIMATION_MCP_HOST, CATIMATION_MCP_PORT, CATIMATION_MCP_TOKEN_HEADER } from './config'
import { ToolRouter } from './ToolRouter'
import { registerTools } from './tools'

export interface McpRuntime {
  port: number
  token: string
  router: ToolRouter
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
export function listenOnPort(app: Express, host: string, port: number): Promise<{ server: Server; port: number }> {
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
  const router = new ToolRouter(win)
  const server = new McpServer({ name: 'catimation', version: '1.0.0' })
  registerTools(server, router)

  const app = createMcpExpressApp({ host: CATIMATION_MCP_HOST })
  app.use((req, res, next) => {
    if (req.headers[CATIMATION_MCP_TOKEN_HEADER] !== token) {
      res.status(401).send('unauthorized')
      return
    }
    next()
  })

  const transports = new Map<string, NodeStreamableHTTPServerTransport>()
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
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
      return
    }

    res.status(400).json({ error: 'Invalid request' })
  })

  // Bind strategy (see openai/codex#11269 for upstream precedent):
  //   1. Try the configured fixed port (predictable URL during dev/debug).
  //   2. If the OS rejects with EACCES/EADDRINUSE/EADDRNOTAVAIL — most often
  //      because Hyper-V/WSL2/Docker silently reserved the port at the OS
  //      level — retry with port 0 to let the OS pick a free ephemeral one.
  //   3. If even that fails (extremely unusual), log and return null so the
  //      app can boot without the MCP tool surface instead of hard-crashing
  //      the main process.
  let bound: { port: number } | null = null
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
  return { port: bound.port, token, router }
}
