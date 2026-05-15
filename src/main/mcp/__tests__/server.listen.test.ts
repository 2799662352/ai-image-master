import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type AddressInfo, type Server } from 'node:net'
import express from 'express'
import type { BrowserWindow } from 'electron'
import { listenOnPort, startCatimationMcpServer } from '../server'
import { CATIMATION_MCP_HOST } from '../config'

/**
 * Covers the listener-bind hardening added for the Windows EACCES crash:
 *
 *   1. `listenOnPort` happy path returns the actual bound port.
 *   2. `listenOnPort` surfaces bind errors (EADDRINUSE / EACCES) instead of
 *      crashing the process — verifies our Promise wrapper actually catches
 *      the 'error' event the way `app.listen` used to leak uncaught.
 *   3. `startCatimationMcpServer` falls back to an ephemeral port when the
 *      configured fixed port is already taken (simulated by pre-binding it
 *      with raw `net.createServer`, no Hyper-V required).
 */

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length > 0) {
    try { await cleanup.pop()!() } catch {}
  }
})

function holdPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const blocker = createServer()
    blocker.unref()
    blocker.once('error', reject)
    blocker.listen(port, CATIMATION_MCP_HOST, () => resolve(blocker))
  })
}

async function closeServer(s: Server): Promise<void> {
  await new Promise<void>((resolve) => s.close(() => resolve()))
}

describe('mcp/server listenOnPort', () => {
  it('resolves with the actual port when binding ephemeral (port=0)', async () => {
    const app = express()
    const { server, port } = await listenOnPort(app, CATIMATION_MCP_HOST, 0)
    cleanup.push(() => closeServer(server))
    expect(port).toBeGreaterThan(0)
    expect((server.address() as AddressInfo).port).toBe(port)
  })

  it('rejects with EADDRINUSE when the port is already taken', async () => {
    const blocker = await holdPort(0)
    const blockedPort = (blocker.address() as AddressInfo).port
    cleanup.push(() => closeServer(blocker))

    const app = express()
    await expect(
      listenOnPort(app, CATIMATION_MCP_HOST, blockedPort),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
})

describe('startCatimationMcpServer fallback', () => {
  // `BrowserWindow` is opaque to ToolRouter (it just stores the ref), so an
  // empty object cast is enough for a unit test that never sends IPC.
  const fakeWin = {} as BrowserWindow

  it('returns a runtime when binding an ephemeral port directly', async () => {
    const runtime = await startCatimationMcpServer(fakeWin, 0)
    expect(runtime).not.toBeNull()
    expect(runtime!.port).toBeGreaterThan(0)
    expect(runtime!.token).toMatch(/^[0-9a-f]{64}$/)
    expect(runtime!.router).toBeDefined()
    // (No server handle exposed to close; the test process exits soon enough
    //  and `unref()` would race the `app.listen` internals — skip cleanup.)
  })

  it('falls back to an ephemeral port when the requested port is occupied', async () => {
    const blocker = await holdPort(0)
    const blockedPort = (blocker.address() as AddressInfo).port
    cleanup.push(() => closeServer(blocker))

    const runtime = await startCatimationMcpServer(fakeWin, blockedPort)

    expect(runtime).not.toBeNull()
    // OS picked something ≠ the blocked port — i.e. fallback ran.
    expect(runtime!.port).toBeGreaterThan(0)
    expect(runtime!.port).not.toBe(blockedPort)
  })
})
