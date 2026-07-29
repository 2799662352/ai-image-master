import { app, utilityProcess, type UtilityProcess } from 'electron'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { ensureSchemaViaConnection } from './ensureSchema'
import { PRISMA_POOL_MAX } from './pgliteLimits'
import {
  isPgliteAbortedError,
  isResetAllowedNow,
  moveCorruptDataDir,
  recordResetAttempt,
} from './pgliteRecovery'
import type { AgentNotice } from '../../types/agent'

let prisma: PrismaClient | null = null
let pgliteChild: UtilityProcess | null = null

const PGLITE_PORT = 5433
const PGLITE_HOST = '127.0.0.1'
const PGLITE_CONNECTION = `postgresql://postgres:postgres@${PGLITE_HOST}:${PGLITE_PORT}/postgres`

// Reset circuit breaker: at most 4 auto-recoveries per rolling 24h to keep us
// out of an infinite Aborted→reset→Aborted loop if the WASM itself is broken
// or a hardware fault is corrupting fresh dirs too. Hand-tuned: low enough
// to surface a real persistent failure, high enough to forgive an upgrade
// path that crashes a couple of times during rollout.
const PGLITE_RESET_MAX = 4
const PGLITE_RESET_WINDOW_MS = 24 * 60 * 60 * 1000
const RESET_MARKER_FILENAME = '.pglite-reset-attempts.json'

/**
 * One-shot startup notice produced by the PGlite recovery branch (rebuilt
 * dataDir or fell back to ephemeral). Consumed by `main/index.ts` once the
 * AgentManager is up so it can be surfaced through the existing notice
 * stream — we deliberately don't persist it across restarts because a stale
 * "database was reset" banner would only confuse the user later.
 */
let pendingStartupNotice: AgentNotice | null = null

export function consumeStartupNotice(): AgentNotice | null {
  const notice = pendingStartupNotice
  pendingStartupNotice = null
  return notice
}

export async function canConnect(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    let settled = false

    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

export async function resolveDatabaseUrl(): Promise<string> {
  const envUrl = process.env.CATIMATION_AGENT_DATABASE_URL
  if (envUrl) return envUrl

  if (await canConnect(5432)) {
    return 'postgresql://sorauser:sora_password_2024@127.0.0.1:5432/soraui'
  }

  return startEmbeddedPGlite()
}

/**
 * Spawn (or reuse) a `utilityProcess` running PGlite + PGLiteSocketServer.
 *
 * Why utilityProcess and not the main thread:
 *   - PGlite's socket server shares the host's event loop. When the main
 *     process is busy with synchronous work (e.g. hashing large attachments
 *     before we shipped streaming ingest), Prisma's wire heartbeats time out
 *     and reads/writes fail with `Server has closed the connection`.
 *   - utilityProcess gives the DB its own V8 isolate and event loop, so even
 *     a stalled main process can't kill the wire protocol mid-query.
 *
 * Why utilityProcess and not child_process.fork:
 *   - Electron's docs explicitly recommend utilityProcess for sandboxing and
 *     lifecycle integration ("prefer the UtilityProcess API over Node.js
 *     child_process.fork", process-model.md).
 *
 * Recovery from upstream PGlite #884 / #794 (open, PR #892 in flight):
 *   - Emscripten NODEFS aborts with `RuntimeError: Aborted()` when the
 *     dataDir is in a state PGlite can't reopen. Most often happens when
 *     the previous process didn't shut down cleanly: installer overwrite,
 *     force-quit, hard crash, or the dual-instance corruption pathway.
 *   - We catch the abort, move the dataDir aside to `pgdata.corrupted-<ISO>`
 *     (preserved for forensics or restore once upstream lands a real fix),
 *     and try once more on a fresh dir. Both attempts share the same
 *     PGLite port — the worker dies before binding the socket on Aborted,
 *     so there's no TIME_WAIT to dodge.
 *   - If that retry also fails, OR the rolling-window breaker is tripped
 *     (≥ {@link PGLITE_RESET_MAX} resets inside {@link PGLITE_RESET_WINDOW_MS}),
 *     we fall back to an ephemeral `pgdata-ephemeral-<pid>` dir so the app
 *     stays usable for the current session even though nothing persists.
 *     This mirrors openai/codex#11435's "per-process unique session
 *     directories" suggestion as a last-resort liveness path.
 *
 * @see docs/superpowers/specs/2026-05-11-attachment-streaming-design.md (Phase C)
 * @see https://github.com/electric-sql/pglite/issues/884
 * @see https://github.com/electric-sql/pglite/issues/794
 * @see https://github.com/electric-sql/pglite/pull/892
 * @see https://github.com/openai/codex/issues/11435
 */
export async function startEmbeddedPGlite(): Promise<string> {
  if (pgliteChild) return PGLITE_CONNECTION

  const userDataDir = app.getPath('userData')
  const dataDir = path.join(userDataDir, 'pgdata')
  const markerPath = path.join(userDataDir, RESET_MARKER_FILENAME)

  // Worker bundle lives next to this file in the build output. In dev,
  // `npm run dev` runs `scripts/build-pglite-worker.mjs` first which emits
  // `dist/main/pgliteWorker.js`. In a packaged build the bundle lives at
  // `app.asar/dist/main/pgliteWorker.js`. Either way `__dirname` resolves
  // to the directory holding both files.
  const workerPath = path.join(__dirname, 'pgliteWorker.js')

  // Preflight: utilityProcess.fork on a missing file exits with code 1 and
  // surfaces no useful diagnostics — which is exactly what the original
  // "exited (code 1) before becoming ready" bug looked like in dev when the
  // worker hadn't been built. Fail fast with a recovery hint instead.
  if (!fs.existsSync(workerPath)) {
    throw new Error(
      `PGlite worker bundle not found at ${workerPath}. ` +
        `Run \`npm run build:pglite-worker\` (or just re-run \`npm run dev\` — ` +
        `it builds the worker first now).`,
    )
  }

  // Attempt 1: the happy path — open the existing dataDir.
  try {
    const child = await spawnPgliteWorker({ workerPath, dataDir })
    pgliteChild = child
    return PGLITE_CONNECTION
  } catch (firstErr) {
    if (!isPgliteAbortedError(firstErr)) {
      throw firstErr
    }

    // The upstream #884 / #794 footgun. Try one auto-recovery if we still
    // have budget on the rolling-window breaker.
    const decision = isResetAllowedNow({
      markerPath,
      now: () => new Date(),
      maxResets: PGLITE_RESET_MAX,
      windowMs: PGLITE_RESET_WINDOW_MS,
    })

    if (!decision.allowed) {
      // Breaker tripped. Don't even attempt the rebuild — it likely failed
      // last time too. Skip straight to ephemeral so the app stays usable
      // and the user gets a clear message about what just happened.
      console.warn(
        `[pglite] reset breaker tripped (${decision.recentResets} recent resets ≥ ${PGLITE_RESET_MAX}). Falling back to ephemeral dataDir.`,
      )
      return await startEphemeralPGlite({
        workerPath,
        baseDataDir: dataDir,
        initialErr: firstErr,
        retryErr: null,
      })
    }

    // Move the corrupt dir aside (best-effort: a hard rename failure means
    // we can't safely recover and should bubble up).
    let backupPath: string | null = null
    try {
      backupPath = moveCorruptDataDir({ dataDir, now: () => new Date() })
    } catch (mvErr) {
      throw new Error(
        `PGlite data dir corruption detected (PGlite #884) but moving it ` +
          `aside failed: ${describeError(mvErr)}. ` +
          `Original error: ${describeError(firstErr)}`,
      )
    }
    recordResetAttempt({
      markerPath,
      now: () => new Date(),
      windowMs: PGLITE_RESET_WINDOW_MS,
    })
    console.warn(
      `[pglite] auto-recovery: moved corrupt dataDir aside → ${backupPath}. ` +
        `Original error: ${describeError(firstErr)}`,
    )

    // Attempt 2: same dir name, freshly empty — initdb will fire.
    try {
      const child = await spawnPgliteWorker({ workerPath, dataDir })
      pgliteChild = child
      pendingStartupNotice = {
        id: `pglite-reset-${Date.now()}`,
        kind: 'pgliteReset',
        level: 'warning',
        message: backupPath
          ? `数据库目录无法打开（PGlite #884 已知 bug），已自动重建。旧数据备份在：${backupPath}`
          : '数据库目录无法打开，已自动重建空目录。',
        details: { backupPath, reason: 'aborted-recovered', stage: 'rebuild' },
      }
      return PGLITE_CONNECTION
    } catch (retryErr) {
      console.error(
        `[pglite] auto-recovery retry also failed. Falling back to ephemeral. retryErr=${describeError(retryErr)}`,
      )
      return await startEphemeralPGlite({
        workerPath,
        baseDataDir: dataDir,
        initialErr: firstErr,
        retryErr,
      })
    }
  }
}

/**
 * Last-resort liveness path: open a process-private `pgdata-ephemeral-<pid>`
 * directory so the app keeps working even when both the original dataDir AND
 * the freshly-rebuilt one fail to come up. Nothing persists across restart;
 * the user is told via {@link pendingStartupNotice}.
 */
async function startEphemeralPGlite(opts: {
  workerPath: string
  baseDataDir: string
  initialErr: unknown
  retryErr: unknown | null
}): Promise<string> {
  const { workerPath, baseDataDir, initialErr, retryErr } = opts
  const ephemeralDir = `${baseDataDir}-ephemeral-${process.pid}`

  // Clear any leftover ephemeral dir from a previous run with the same PID
  // (rare but possible after PID wraparound). Best-effort.
  try {
    fs.rmSync(ephemeralDir, { recursive: true, force: true })
  } catch {
    // ignore — fresh fork will fail loudly if the dir is locked
  }

  try {
    const child = await spawnPgliteWorker({ workerPath, dataDir: ephemeralDir })
    pgliteChild = child
    pendingStartupNotice = {
      id: `pglite-ephemeral-${Date.now()}`,
      kind: 'pgliteReset',
      level: 'warning',
      message: retryErr
        ? '数据库无法初始化（PGlite 上游 bug），自动重建也失败。已切换到临时模式：本次会话不会保存到磁盘。建议退出应用、手动删除 %APPDATA%\\<app>\\pgdata 后再启动。'
        : `数据库自动恢复触发次数过多（24h 内 ≥ ${PGLITE_RESET_MAX} 次），已切换到临时模式：本次会话不会保存到磁盘。`,
      details: {
        ephemeralDir,
        reason: retryErr ? 'aborted-rebuild-failed' : 'breaker-tripped',
        stage: 'ephemeral',
      },
    }
    return PGLITE_CONNECTION
  } catch (ephemeralErr) {
    // Even ephemeral failed → genuinely unable to bring PGlite up. Give the
    // caller a single composite error with all three failure sites so logs
    // are actionable.
    throw new Error(
      `PGlite cannot start. ` +
        `Initial error: ${describeError(initialErr)}. ` +
        (retryErr ? `Retry error: ${describeError(retryErr)}. ` : '') +
        `Ephemeral fallback error: ${describeError(ephemeralErr)}.`,
    )
  }
}

interface SpawnOpts {
  workerPath: string
  dataDir: string
}

/**
 * Fork the PGlite utilityProcess worker, send the `start` message, and wait
 * for either `ready` (success) or `error` / unexpected `exit` / 30s timeout
 * (failure). Captures stderr so failure messages carry the actual reason
 * instead of just "exited (code 1)".
 *
 * Caller owns the returned UtilityProcess and is responsible for assigning
 * it to {@link pgliteChild} or shutting it down on a different code path.
 */
async function spawnPgliteWorker(opts: SpawnOpts): Promise<UtilityProcess> {
  const { workerPath, dataDir } = opts

  // Capture stderr so worker startup failures (initdb crash, missing native
  // binary, port conflict, etc.) carry the actual reason instead of just an
  // opaque "exited (code 1)" message.
  const child = utilityProcess.fork(workerPath, [], {
    serviceName: 'CatimationPGliteWorker',
    stdio: 'pipe',
  })

  const stderrChunks: string[] = []
  const MAX_STDERR_BYTES = 4096
  let stderrBytes = 0
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    if (stderrBytes >= MAX_STDERR_BYTES) return
    const remaining = MAX_STDERR_BYTES - stderrBytes
    const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk
    stderrChunks.push(slice)
    stderrBytes += slice.length
  })
  // Forward stdout for ongoing observability — useful when the worker logs
  // socket-listening confirmation or shutdown progress.
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk)
  })

  function formatStderrTail(): string {
    const tail = stderrChunks.join('').trim()
    if (!tail) return ''
    return ` Worker stderr tail:\n${tail}`
  }

  // Wait for the worker to confirm the socket server is listening before we
  // hand the connection back to Prisma. 30s ceiling — generous to absorb
  // first-time initdb on slow machines but fail fast if the binary is broken.
  // Failure modes (timeout / unexpected exit / explicit `error` message) all
  // kill the worker before rejecting so we never leak a half-started child
  // back to the caller's recovery branch.
  await new Promise<void>((resolve, reject) => {
    const onExit = (code: number | null): void => {
      cleanup()
      reject(
        new Error(
          `PGlite worker exited (code ${code}) before becoming ready.` +
            formatStderrTail(),
        ),
      )
    }
    const onMessage = (msg: unknown): void => {
      if (!msg || typeof msg !== 'object') return
      const payload = msg as { type?: string; error?: string }
      if (payload.type === 'ready') {
        cleanup()
        resolve()
        return
      }
      if (payload.type === 'error') {
        cleanup()
        reject(
          new Error(
            `PGlite worker error: ${payload.error ?? 'unknown'}.` +
              formatStderrTail(),
          ),
        )
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      try {
        child.kill()
      } catch {
        // already gone — ignore
      }
      reject(new Error(`PGlite worker startup timeout (30s).` + formatStderrTail()))
    }, 30_000)
    function cleanup(): void {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
    }
    child.on('message', onMessage)
    child.on('exit', onExit)
    child.postMessage({ type: 'start', dataDir, port: PGLITE_PORT, host: PGLITE_HOST })
  }).catch((err) => {
    // Make absolutely sure we don't leak a half-started worker if the wait
    // path rejects. Caller's recovery branch will spawn a fresh one.
    try {
      child.kill()
    } catch {
      // already gone — ignore
    }
    throw err
  })

  return child
}

function describeError(err: unknown): string {
  if (err == null) return 'unknown'
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

export async function getPrisma(): Promise<PrismaClient> {
  if (!prisma) {
    const databaseUrl = await resolveDatabaseUrl()
    process.env.DATABASE_URL = databaseUrl
    // Bootstrap the agent schema BEFORE Prisma touches it. Idempotent — uses
    // `to_regclass('"AgentThread"')` to no-op when tables already exist.
    // Runs against whatever DB resolveDatabaseUrl picked (embedded PGlite on
    // 5433, external sora-postgres on 5432, or env-overridden URL).
    await ensureSchemaViaConnection(databaseUrl)
    prisma = new PrismaClient({
      // 池子刻意收到 PRISMA_POOL_MAX(=1)。PGlite 是单连接库、查询在它那侧串行,
      // 多开连接换不来吞吐,只会让并发查询去撞 socket server 的连接上限并被掐断
      // (P1017 的由来)。并发改为在池子里客户端侧排队。见 pgliteLimits.ts。
      adapter: new PrismaPg({ connectionString: databaseUrl, max: PRISMA_POOL_MAX }),
    })
  }

  return prisma
}

export async function shutdownDatabase(): Promise<void> {
  await prisma?.$disconnect().catch(() => undefined)
  prisma = null

  if (pgliteChild) {
    const child = pgliteChild
    pgliteChild = null
    try {
      child.postMessage({ type: 'shutdown' })
    } catch {
      // Worker may have already exited — fall through to await.
    }
    await new Promise<void>((resolve) => {
      // Hard 5s ceiling so app quit can't hang on a stuck worker.
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // ignore — already gone
        }
        resolve()
      }, 5_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}