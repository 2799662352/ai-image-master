#!/usr/bin/env node
'use strict'

/**
 * catimation stdio↔socket bridge.
 *
 * Spawned BY codex as a stdio MCP server (`mcp_servers.catimation.command`).
 * It does NOT implement any MCP logic itself — it is a dumb byte pipe:
 *
 *   codex (stdio, newline-delimited JSON-RPC)
 *     │ stdin / stdout
 *     ▼
 *   this process
 *     │ TCP loopback (same framing, verbatim bytes)
 *     ▼
 *   Electron main process (SocketServerTransport → McpServer → ToolRouter)
 *
 * Why it exists: codex's rmcp streamable-HTTP client repeatedly wedged on
 * long-lived `generate_image` calls (keep-alive races, session 404 wedges —
 * see src/main/mcp/server.ts history). Pipes have none of those failure
 * modes, and if either side dies the other notices IMMEDIATELY instead of
 * hanging a turn forever.
 *
 * Contract with the Electron side (src/main/mcp/bridge.ts):
 *  - env CATIMATION_BRIDGE_PORT — TCP port of the loopback listener.
 *  - env CATIMATION_BRIDGE_TOKEN — per-app-session secret; sent as the very
 *    first line on the socket before any JSON-RPC bytes. Wrong/missing token
 *    → the app destroys the socket and we exit non-zero.
 *  - After the token line, the socket carries raw newline-delimited JSON-RPC
 *    in both directions. `_meta` (codex thread ids) passes through untouched.
 *
 * Zero npm dependencies on purpose: this file ships verbatim inside
 * `resources/catimation-bridge/` (extraResources) and must run on a bare
 * system `node` OR Electron-as-Node (ELECTRON_RUN_AS_NODE=1) without any
 * install step.
 */

const net = require('node:net')

const port = Number(process.env.CATIMATION_BRIDGE_PORT || '')
const token = process.env.CATIMATION_BRIDGE_TOKEN || ''

function fail(code, reason) {
  try {
    process.stderr.write(`[catimation-bridge] ${reason}\n`)
  } catch {
    /* stderr already gone — nothing left to report to */
  }
  process.exit(code)
}

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  fail(2, `invalid CATIMATION_BRIDGE_PORT: ${JSON.stringify(process.env.CATIMATION_BRIDGE_PORT)}`)
}
if (!token) {
  fail(2, 'missing CATIMATION_BRIDGE_TOKEN')
}

const socket = net.connect({ host: '127.0.0.1', port })
// JSON-RPC messages are latency-sensitive request/response pairs; never let
// Nagle batch a tool result behind 40ms of nothing.
socket.setNoDelay(true)
// The whole point of this bridge is "no timeouts on our leg" — an image
// render legitimately keeps the pipe silent for minutes.
socket.setKeepAlive(true, 30_000)

// Exit policies — keep them blunt so codex always learns the truth fast:
//  - app side closed/errored → exit(1). codex marks the server dead and the
//    current tool call fails VISIBLY instead of hanging the turn.
//  - codex closed our stdin → mirror the shutdown, exit(0).
socket.on('error', (err) => fail(1, `socket error: ${err && err.message ? err.message : String(err)}`))
socket.on('close', () => fail(1, 'connection closed by app'))
process.stdin.on('error', () => fail(0, 'stdin error (codex side closed)'))
process.stdin.on('end', () => {
  socket.end()
  process.exit(0)
})
process.stdout.on('error', () => fail(0, 'stdout closed (codex side gone)'))

socket.on('connect', () => {
  socket.write(`${token}\n`)
  process.stdin.pipe(socket, { end: true })
  socket.pipe(process.stdout)
})
