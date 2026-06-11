import { randomBytes } from 'node:crypto'
import { createServer, type Server as NetServer, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type { McpServer, Transport, JSONRPCMessage } from '@modelcontextprotocol/server'
import { getCodexResourceRoot } from '../agent/paths'
import { CATIMATION_MCP_HOST } from './config'

/**
 * stdio-bridge listener for the catimation MCP server.
 *
 * codex spawns `resources/catimation-bridge/index.js` as a plain stdio MCP
 * server; that bridge connects HERE over TCP loopback and pipes bytes
 * verbatim. So this file is the Electron-side half of:
 *
 *   codex ──stdio──> bridge process ──TCP 127.0.0.1──> SocketServerTransport
 *     ──> McpServer (one PER CONNECTION, sharing one ToolRouter) ──> ToolRouter
 *
 * Why this exists: codex's rmcp streamable-HTTP client wedged repeatedly on
 * minutes-long `generate_image` calls (keep-alive close-vs-reuse races,
 * session-404 wedges — see server.ts). Even after hardening the HTTP side,
 * a confirmed live failure remained: the render finished but the result
 * never reached codex. Pipes + a loopback socket whose BOTH ends are our
 * code remove the third-party HTTP client from the critical path entirely.
 *
 * Wire contract (mirrored in resources/catimation-bridge/index.js):
 *  - first line on a new connection = the per-app-session token; anything
 *    else → socket destroyed.
 *  - everything after is newline-delimited JSON-RPC, both directions.
 */

/** First-line token handshake must fit comfortably in this many bytes. */
const MAX_HANDSHAKE_BUFFER = 4096

/**
 * Newline-delimited JSON-RPC over a net.Socket — identical framing to the
 * SDK's own stdio transport, but server-side over TCP loopback. One instance
 * per bridge connection; the McpServer treats each as an independent session.
 */
export class SocketServerTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  sessionId?: string

  private buffer: string
  private started = false

  /**
   * @param socket  authenticated socket (token line already consumed)
   * @param initial leftover bytes that arrived in the same chunk as the
   *                token line — must be replayed ahead of new data
   */
  constructor(
    private readonly socket: Socket,
    initial = '',
  ) {
    this.buffer = initial
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      this.drain()
    })
    this.socket.on('error', (err: Error) => this.onerror?.(err))
    this.socket.on('close', () => this.onclose?.())
    // The listener paused the socket after the token handshake so no bytes
    // could be emitted while ownership moved over to this transport.
    this.socket.resume()
    // Replay anything that rode in with the token line.
    this.drain()
  }

  private drain(): void {
    let newlineAt = this.buffer.indexOf('\n')
    while (newlineAt >= 0) {
      // trim() also strips a trailing \r so \r\n framing works.
      const line = this.buffer.slice(0, newlineAt).trim()
      this.buffer = this.buffer.slice(newlineAt + 1)
      if (line.length > 0) {
        try {
          this.onmessage?.(JSON.parse(line) as JSONRPCMessage)
        } catch (err) {
          this.onerror?.(err instanceof Error ? err : new Error(String(err)))
        }
      }
      newlineAt = this.buffer.indexOf('\n')
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) {
        reject(new Error('bridge socket already closed'))
        return
      }
      this.socket.write(`${JSON.stringify(message)}\n`, (err) => (err ? reject(err) : resolve()))
    })
  }

  async close(): Promise<void> {
    this.socket.destroy()
    this.onclose?.()
  }
}

export interface BridgeRuntime {
  port: number
  token: string
  close: () => Promise<void>
}

/**
 * Start the TCP loopback listener that bridge processes dial into. Binds an
 * ephemeral port on 127.0.0.1 only; auth is the random per-app-session token
 * (same trust model as the HTTP listener's header token).
 *
 * Multiple concurrent connections are allowed — codex spawns one bridge
 * process for the main agent AND one per subagent thread, so several live
 * connections are the NORM, not an edge case. Each connection gets its OWN
 * `McpServer` instance from `createServerInstance`.
 *
 * Why per-connection instances are load-bearing: the SDK's `Protocol` is a
 * single-transport state machine — `connect()` does `this._transport =
 * transport`, and `_onrequest` routes the response to whatever
 * `this._transport` points at WHEN THE REQUEST ARRIVES. With one shared
 * server, the moment a second bridge (subagent) connected it overwrote
 * `_transport`, so the response to the FIRST connection's in-flight
 * `generate_image` was written to the SECOND connection's socket — codex
 * waited forever on the right socket while the result went down the wrong
 * one. (Same root cause as the old HTTP-session wedge.) One server per
 * connection makes response routing trivially correct, mirroring the SDK's
 * own multi-session examples.
 */
export function startCatimationBridgeListener(
  createServerInstance: () => McpServer,
): Promise<BridgeRuntime | null> {
  const token = randomBytes(32).toString('hex')

  const netServer: NetServer = createServer((socket) => {
    socket.setNoDelay(true)
    let handshake = ''
    const onData = (chunk: Buffer): void => {
      handshake += chunk.toString('utf8')
      const newlineAt = handshake.indexOf('\n')
      if (newlineAt < 0) {
        if (handshake.length > MAX_HANDSHAKE_BUFFER) socket.destroy()
        return
      }
      // Pause BEFORE detaching: a flowing socket with zero 'data' listeners
      // silently drops bytes, and the transport only attaches its own
      // listener inside start() (called by server.connect, async).
      socket.pause()
      socket.off('data', onData)

      const presented = handshake.slice(0, newlineAt).trim()
      const leftover = handshake.slice(newlineAt + 1)
      if (presented !== token) {
        socket.destroy()
        return
      }

      const transport = new SocketServerTransport(socket, leftover)
      // Dedicated McpServer per connection (see doc comment above). The
      // instance stays alive exactly as long as the socket: transport →
      // onmessage closure → server, and the socket owns the transport.
      const server = createServerInstance()
      void server.connect(transport).catch((err) => {
        console.error('[mcp-bridge] failed to attach bridge session:', err)
        socket.destroy()
      })
    }
    socket.on('data', onData)
    // Pre-auth socket errors (port scanners, dying bridges) are non-events.
    socket.on('error', () => {})
  })

  return new Promise((resolve) => {
    netServer.once('error', (err) => {
      console.error('[mcp-bridge] listener failed to bind; stdio bridge disabled this session:', err)
      resolve(null)
    })
    netServer.listen(0, CATIMATION_MCP_HOST, () => {
      const addr = netServer.address() as AddressInfo | null
      if (!addr || typeof addr === 'string') {
        netServer.close()
        resolve(null)
        return
      }
      resolve({
        port: addr.port,
        token,
        close: () =>
          new Promise<void>((res) => {
            netServer.close(() => res())
          }),
      })
    })
  })
}

/**
 * Absolute path to the bridge entry script codex will spawn. Mirrors
 * `getApiyiMcpEntryPath` (same extraResources layout):
 *
 * Packaged: <resourcesPath>/catimation-bridge/index.js
 * Dev:      <appPath>/resources/catimation-bridge/index.js
 */
export function getCatimationBridgeEntryPath(options: {
  appPath: string
  isPackaged: boolean
  resourcesPath?: string
}): string {
  return path.join(getCodexResourceRoot(options), 'catimation-bridge', 'index.js')
}
