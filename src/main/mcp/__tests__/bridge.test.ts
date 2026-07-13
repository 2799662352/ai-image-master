import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserWindow } from 'electron'
import { startCatimationMcpServer, type McpRuntime } from '../server'
import { CATIMATION_MCP_HOST } from '../config'
import { imageTaskManager } from '../tools/imageTaskRegistry'

/**
 * stdio-bridge transport tests — the Plan-B cutover after the hardened
 * streamable-HTTP transport STILL dropped a confirmed-successful
 * `generate_image` result on the floor (2026-06-12: render finished, image
 * saved, codex never saw the response and the turn hung).
 *
 * Covered here:
 *  1. The TCP listener boots alongside the HTTP listener and accepts a
 *     token-authenticated newline-JSON MCP session (initialize → tools/list).
 *  2. A wrong token gets the socket destroyed before any MCP bytes flow.
 *  3. END-TO-END: the real `resources/catimation-bridge/index.js` script is
 *     spawned with plain node (exactly how codex spawns it), and a JSON-RPC
 *     initialize round-trips stdio → bridge → TCP → McpServer and back.
 */

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length > 0) {
    try {
      await cleanup.pop()!()
    } catch {
      /* best-effort */
    }
  }
})

const fakeWin = {} as BrowserWindow

async function bootServer(): Promise<NonNullable<McpRuntime>> {
  const runtime = await startCatimationMcpServer(fakeWin, 0)
  if (!runtime) throw new Error('failed to boot MCP server for test')
  cleanup.push(() => new Promise<void>((resolve) => runtime.httpServer.close(() => resolve())))
  if (runtime.bridge) cleanup.push(() => runtime.bridge!.close())
  return runtime
}

function initializeLine(id = 1): string {
  return `${JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'bridge-test', version: '0' },
    },
  })}\n`
}

/** Collect newline-delimited JSON from a socket until a message with `id` arrives. */
function waitForResponse(
  readLine: (handler: (line: string) => void) => void,
  id: number,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for response id=${id}`)), timeoutMs)
    readLine((line) => {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>
        if (msg.id === id) {
          clearTimeout(timer)
          resolve(msg)
        }
      } catch {
        /* ignore non-JSON noise */
      }
    })
  })
}

/** Adapt a socket into a per-line callback feed. */
function lineFeed(socket: Socket): (handler: (line: string) => void) => void {
  let buffer = ''
  const handlers: Array<(line: string) => void> = []
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let idx = buffer.indexOf('\n')
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line) for (const h of handlers) h(line)
      idx = buffer.indexOf('\n')
    }
  })
  return (handler) => handlers.push(handler)
}

describe('catimation stdio bridge listener', () => {
  it('boots alongside the HTTP listener and serves an MCP session over raw TCP', async () => {
    const runtime = await bootServer()
    expect(runtime.bridge).not.toBeNull()
    expect(runtime.bridge!.port).toBeGreaterThan(0)
    expect(runtime.bridge!.token).toMatch(/^[0-9a-f]{64}$/)

    const socket = connect({ host: CATIMATION_MCP_HOST, port: runtime.bridge!.port })
    cleanup.push(() => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })

    const onLine = lineFeed(socket)
    // Token line + initialize in ONE write — exercises the leftover-buffer
    // handoff from the auth handler into SocketServerTransport.
    socket.write(runtime.bridge!.token + '\n' + initializeLine(1))
    const init = await waitForResponse(onLine, 1)
    expect(init).toHaveProperty('result')
    expect((init.result as Record<string, unknown>).serverInfo).toMatchObject({ name: 'catimation' })

    // initialized notification, then a real request: tools must be served.
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    const tools = await waitForResponse(onLine, 2)
    const names = ((tools.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name)
    expect(names).toContain('generate_image')
  })

  it('routes an in-flight tool result back to ITS OWN connection even after a second bridge connects (the 2026-06-12 hang)', async () => {
    // Reproduces the live failure: codex's main agent held connection A with
    // an in-flight generate_image; codex spawned a SECOND bridge (subagent)
    // → connection B. With one shared McpServer, connect(B) overwrote
    // `_transport`, so A's response was written to B's socket and codex hung
    // forever. Per-connection server instances must keep routing correct.
    const runtime = await bootServer()

    let releaseTool: (value: unknown) => void = () => {}
    const gate = new Promise<unknown>((resolve) => {
      releaseTool = resolve
    })
    // Intercept generate_image in-main so the test controls completion timing
    // (no renderer in this harness anyway).
    runtime.router.registerMain('generate_image', async (params) => {
      const result = await gate
      imageTaskManager.applyUpdate({
        taskId: String(params.__taskId),
        kind: 'single',
        status: 'succeeded',
        result,
      })
      return { accepted: true }
    })

    const dial = async (): Promise<{ socket: Socket; onLine: (h: (line: string) => void) => void }> => {
      const socket = connect({ host: CATIMATION_MCP_HOST, port: runtime.bridge!.port })
      cleanup.push(() => socket.destroy())
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      return { socket, onLine: lineFeed(socket) }
    }

    // Connection A: full MCP handshake (codex main agent).
    const a = await dial()
    a.socket.write(runtime.bridge!.token + '\n' + initializeLine(1))
    await waitForResponse(a.onLine, 1)
    a.socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

    // Connection B handshakes next (codex subagent bridge). With a SHARED
    // server this overwrote `_transport`, so any LATER request arriving on A
    // captured B as its reply transport.
    const b = await dial()
    const strayOnB: string[] = []
    b.onLine((line) => strayOnB.push(line))
    b.socket.write(runtime.bridge!.token + '\n' + initializeLine(2))
    await waitForResponse(b.onLine, 2)

    // NOW the main agent issues its tool call on A — after B exists.
    a.socket.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'generate_image', arguments: { prompt: 'routing test' } },
      })}\n`,
    )
    // Give the request a beat to be in-flight before releasing it.
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Finish the tool. The response MUST come back on A.
    releaseTool({ ok: true, count: 1, paths: [] })
    const result = await waitForResponse(a.onLine, 11)
    expect(result).toHaveProperty('result')
    const text = JSON.stringify(result)
    expect(text).toContain('generate_image DONE')

    // And B must never have seen a message with A's request id.
    const leaked = strayOnB.some((line) => {
      try {
        return (JSON.parse(line) as { id?: unknown }).id === 11
      } catch {
        return false
      }
    })
    expect(leaked).toBe(false)
  })

  it('destroys the connection on a wrong token before any MCP bytes flow', async () => {
    const runtime = await bootServer()
    const socket = connect({ host: CATIMATION_MCP_HOST, port: runtime.bridge!.port })
    cleanup.push(() => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })

    const closed = new Promise<void>((resolve) => socket.once('close', resolve))
    socket.write('not-the-token\n' + initializeLine(1))
    await expect(
      Promise.race([
        closed.then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('alive'), 3000)),
      ]),
    ).resolves.toBe('closed')
  })

  it('END-TO-END: the real bridge script pipes stdio JSON-RPC through to the McpServer', async () => {
    const runtime = await bootServer()
    expect(runtime.bridge).not.toBeNull()

    // Same layout codex uses: plain node + the committed bridge script + env.
    const bridgeScript = path.resolve(__dirname, '../../../../resources/catimation-bridge/index.js')
    const child = spawn(process.execPath, [bridgeScript], {
      env: {
        ...process.env,
        CATIMATION_BRIDGE_PORT: String(runtime.bridge!.port),
        CATIMATION_BRIDGE_TOKEN: runtime.bridge!.token,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    cleanup.push(() => {
      child.kill()
    })
    const stderr: string[] = []
    child.stderr.on('data', (c: Buffer) => stderr.push(c.toString()))

    let buffer = ''
    const handlers: Array<(line: string) => void> = []
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) for (const h of handlers) h(line)
        idx = buffer.indexOf('\n')
      }
    })

    child.stdin.write(initializeLine(7))
    const init = await waitForResponse((h) => handlers.push(h), 7, 10_000).catch((err) => {
      throw new Error(`${err.message}; bridge stderr: ${stderr.join('')}`)
    })
    expect(init).toHaveProperty('result')
    expect((init.result as Record<string, unknown>).serverInfo).toMatchObject({ name: 'catimation' })

    // codex shutting down = stdin EOF → bridge must exit 0 (not hang).
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    child.stdin.end()
    await expect(
      Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('hung'), 5000))]),
    ).resolves.toBe(0)
  })
})
