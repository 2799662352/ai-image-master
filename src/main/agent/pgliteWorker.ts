/**
 * PGlite + PGLiteSocketServer running inside an Electron `utilityProcess`.
 *
 * Why: PGlite is an embedded Postgres that listens on a localhost TCP socket.
 * When it lives in the same Node thread as the main process, any long sync
 * task on the main thread (large file hashing, sync fs ops, render IPC
 * pile-ups) starves PGlite's socket — Prisma's wire protocol then surfaces
 * the starvation as `Server has closed the connection`. By isolating PGlite
 * in a utilityProcess we get a dedicated event loop and the database stays
 * responsive even when the main process is briefly busy.
 *
 * Lifecycle:
 *   parent → worker: { type: 'start', dataDir, port }   (once on boot)
 *   worker → parent: { type: 'ready' }                  (server listening)
 *   parent → worker: { type: 'shutdown' }               (on app quit)
 *   worker → parent: { type: 'closed' } then exit(0)
 *
 * Errors are reported via `{ type: 'error', error: string }` and lead to
 * the worker exiting with a non-zero code so the parent can decide whether
 * to retry or surface the failure.
 *
 * @see docs/superpowers/specs/2026-05-11-attachment-streaming-design.md (Phase C)
 * @see https://www.electronjs.org/docs/latest/api/utility-process
 */

import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { PGLITE_MAX_CONNECTIONS } from './pgliteLimits'

type StartMessage = { type: 'start'; dataDir: string; port: number; host?: string }
type ShutdownMessage = { type: 'shutdown' }
type IncomingMessage = StartMessage | ShutdownMessage

interface ParentPort {
  on(event: 'message', listener: (data: unknown) => void): void
  once(event: 'message', listener: (data: unknown) => void): void
  postMessage(value: unknown): void
}

// utilityProcess exposes `process.parentPort` as the bidirectional channel
// back to the parent. Cast off the global `Process` shape — node's @types
// don't know about `parentPort` here.
const parentPort: ParentPort | undefined = (process as unknown as { parentPort?: ParentPort })
  .parentPort

if (!parentPort) {
  console.error('[pgliteWorker] no parentPort — this script must run under Electron utilityProcess')
  process.exit(2)
}

let db: PGlite | null = null
let server: PGLiteSocketServer | null = null
let shuttingDown = false

async function start(msg: StartMessage): Promise<void> {
  try {
    db = await PGlite.create(msg.dataDir)
    server = new PGLiteSocketServer({
      db,
      host: msg.host ?? '127.0.0.1',
      port: msg.port,
      // 必须显式给:上游运行时默认是 1,第二条连接会被写一句裸文本
      // 「Too many connections」后掐断,客户端看到的就是 P1017。见 pgliteLimits.ts。
      maxConnections: PGLITE_MAX_CONNECTIONS,
    })
    await server.start()
    parentPort!.postMessage({ type: 'ready', port: msg.port })
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    parentPort!.postMessage({ type: 'error', error: message })
    process.exit(1)
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await server?.stop()
  } catch (err) {
    console.warn('[pgliteWorker] server.stop failed:', err)
  }
  try {
    await db?.close()
  } catch (err) {
    console.warn('[pgliteWorker] db.close failed:', err)
  }
  parentPort!.postMessage({ type: 'closed' })
  process.exit(0)
}

parentPort.on('message', (raw) => {
  // utilityProcess wraps the payload in `{ data: ... }` on its way through
  // the message channel, but the Electron docs example accesses `message`
  // directly. Be tolerant of both shapes.
  const data = (raw as { data?: IncomingMessage }).data ?? (raw as IncomingMessage)
  if (!data || typeof data !== 'object' || !('type' in data)) return

  if (data.type === 'start') {
    void start(data)
    return
  }
  if (data.type === 'shutdown') {
    void shutdown()
    return
  }
})

// If the parent dies before sending shutdown, at least try to clean up the
// data dir lock before the OS kills us. Best-effort.
process.on('exit', () => {
  // We cannot await inside 'exit'. PGlite's close() flushes the WAL but at
  // this stage we just rely on PGlite's crash recovery — Postgres handles
  // it on next start.
})
