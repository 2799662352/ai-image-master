import { app, utilityProcess, type UtilityProcess } from 'electron'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { ensureSchemaViaConnection } from './ensureSchema'
import { PRISMA_POOL_ACQUIRE_TIMEOUT_MS, PRISMA_POOL_MAX } from './pgliteLimits'
import { RESPAWN_WINDOW_MS, planDbFailure, takeRespawnSlot } from './pgliteSupervisor'
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

/**
 * 会话中途产生的数据库通知（worker 死掉又被拉起）没法走
 * {@link consumeStartupNotice} —— 那条通道在启动时只被读一次。main/index.ts 在
 * 窗口就绪后把这个 sink 接到 `agent:event`。
 *
 * 接线之前（启动早期）产生的通知退回 {@link pendingStartupNotice}，仍会随启动那次
 * flush 送达，不丢。
 */
let noticeSink: ((notice: AgentNotice) => void) | null = null

export function setDatabaseNoticeSink(sink: ((notice: AgentNotice) => void) | null): void {
  noticeSink = sink
}

function emitDbNotice(notice: AgentNotice): void {
  if (noticeSink) {
    try {
      noticeSink(notice)
      return
    } catch (err) {
      console.warn('[db] notice sink threw, falling back to startup notice:', err)
    }
  }
  pendingStartupNotice = notice
}

/** 本会话历次重生的时间戳，喂给 shouldRespawn 的滚动窗口。 */
let respawnHistory: number[] = []
/** shutdownDatabase 已经在收尾 —— 此时 worker 退出是意料之中，不要重生。 */
let intentionalShutdown = false
/** 正在重生:worker 的 exit 与后续查询的报错会同时到，别重复拉起。 */
let respawning: Promise<void> | null = null

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

  // 懒恢复路径也必须过熔断。worker 死过之后 pgliteChild 是 null,于是后续**每一次**
  // getPrisma 都会走到这里;若只在 recoverFromWorkerDeath 里查熔断,一个怎么都起不来
  // 的 worker 会被每条查询各 fork 一次 —— 正是熔断要防的事。首次启动 history 为空,
  // 这一段整体跳过,行为与从前一致。
  if (respawnHistory.length > 0) {
    const slot = takeRespawnSlot(respawnHistory, Date.now())
    respawnHistory = slot.history
    if (!slot.allowed) {
      throw new Error(
        `本地数据库反复异常退出(${Math.round(RESPAWN_WINDOW_MS / 60_000)} 分钟内 ${slot.recent} 次),`
          + '已停止自动恢复。请重启应用。',
      )
    }
  }

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
    superviseWorker(child, { workerPath, dataDir })
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
      superviseWorker(child, { workerPath, dataDir })
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
    superviseWorker(child, { workerPath, dataDir: ephemeralDir })
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
 * 盯着一个**已经 ready** 的 worker，死了就把它拉起来。
 *
 * `spawnPgliteWorker` 里那个 `on('exit')` 只活在启动等待期（`ready` 一到
 * `cleanup()` 就摘掉）。没有这个函数的话，worker 之后崩掉就没人知道 ——
 * 本会话所有 Prisma 调用全废到用户重启应用，线上表现就是「重启一下就好了」。
 */
function superviseWorker(child: UtilityProcess, opts: SpawnOpts): void {
  child.once('exit', (code: number | null) => {
    if (intentionalShutdown) return
    // shutdownDatabase 会先把 pgliteChild 置空再让 worker 退出;若这里看到的
    // 已经不是当前那个孩子,说明它已被换掉或正在收尾,不该插手。
    if (pgliteChild !== child) return
    pgliteChild = null
    console.warn(`[pglite] worker exited unexpectedly (code ${code}) — attempting recovery`)
    void recoverFromWorkerDeath(opts)
  })
}

/**
 * 数据库报错之后顺手确认一下 socket server 还在不在。
 *
 * 只处理**能明确判定**的那一种坏法:**进程还活着,但端口已经不接了**。那说明
 * socket server 没了(worker 的 exit 钩子不会触发,因为进程没退),此时杀掉它交给
 * 监管重生是安全的 —— 端口都关了,不可能还有查询在正常跑。
 *
 * **刻意不做「静默即判死」。** PGlite 执行查询时会阻塞 worker 的事件循环,所以一次
 * 合法的长事务同样不会回应任何探测。按静默去杀 = 把正在跑的真实事务毁掉。「卡住
 * 但端口还在」因此留给 30s 的池超时兜(报错、降级、用户可继续),不自动杀 ——
 * 误杀的代价比多等一次大。
 *
 * 单飞 + 冷却:一批查询同时失败时只探一次。
 */
let socketProbe: Promise<void> | null = null
let lastProbeAt = 0
const PROBE_COOLDOWN_MS = 10_000

function checkSocketServerAlive(): Promise<void> {
  if (socketProbe) return socketProbe
  const now = Date.now()
  if (now - lastProbeAt < PROBE_COOLDOWN_MS) return Promise.resolve()
  lastProbeAt = now

  socketProbe = (async () => {
    const child = pgliteChild
    if (!child) return // 已经死了/正在重生,监管那条路会处理
    if (await canConnect(PGLITE_PORT, PGLITE_HOST)) return // 端口还在,不擅自动手

    console.warn('[pglite] worker process alive but port is closed — killing so supervision respawns')
    try {
      // kill 会触发 exit,superviseWorker 接住并走重生(含熔断)。
      child.kill()
    } catch (err) {
      console.warn('[pglite] kill failed:', describeError(err))
    }
  })().finally(() => {
    socketProbe = null
  })
  return socketProbe
}

/**
 * 重生专用的 spawn:先给端口一点释放时间,失败再等久一点重试一次。
 *
 * 与启动时那次 spawn 的区别在于**前一个进程刚刚还在监听 5433**。启动时的重建路径
 * 有句注释说「worker 在 Aborted 时还没绑 socket,所以没有 TIME_WAIT 要躲」——那条
 * 前提在这里不成立:崩掉的这个是绑过并且正在服务的。Windows 上紧接着重绑同一端口
 * 拿到 EADDRINUSE 是真实存在的,所以给一小段缓冲。
 *
 * 两次尝试合起来只记一次重生(熔断计数在调用方),因为它们是同一次恢复。
 */
async function spawnWithPortGrace(opts: SpawnOpts): Promise<UtilityProcess> {
  await delay(300)
  try {
    return await spawnPgliteWorker(opts)
  } catch (err) {
    console.warn(`[pglite] respawn attempt 1 failed (${describeError(err)}) — retrying once`)
    await delay(1_500)
    return spawnPgliteWorker(opts)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * worker 意外退出后的恢复：丢掉旧的 Prisma 客户端（它的池子里全是死连接），
 * 重生 worker，再让下一次 `getPrisma()` 建一个新池连上去。
 *
 * 熔断由 {@link shouldRespawn} 管：一直起不来就停手并如实告诉用户要重启，
 * 而不是无限 fork。
 */
async function recoverFromWorkerDeath(opts: SpawnOpts): Promise<void> {
  if (respawning) return respawning
  respawning = (async () => {
    // 池子里握着的都是断掉的 socket。$disconnect 之后置空,下一次 getPrisma
    // 会连同新池一起重建 —— 否则重生成功了,查询仍然打在旧池的死连接上。
    await prisma?.$disconnect().catch(() => undefined)
    prisma = null

    const now = Date.now()
    const slot = takeRespawnSlot(respawnHistory, now)
    respawnHistory = slot.history
    if (!slot.allowed) {
      console.error(`[pglite] respawn breaker tripped (${slot.recent} in window) — giving up`)
      emitDbNotice({
        id: `pglite-respawn-giveup-${now}`,
        kind: 'pgliteReset',
        level: 'warning',
        message: '本地数据库反复异常退出，已停止自动恢复。聊天仍可继续，但历史不会保存 —— 请重启应用。',
      })
      return
    }

    try {
      const child = await spawnWithPortGrace(opts)
      pgliteChild = child
      superviseWorker(child, opts)
      console.warn('[pglite] worker respawned')
      emitDbNotice({
        id: `pglite-respawned-${now}`,
        kind: 'pgliteReset',
        level: 'info',
        message: '本地数据库刚异常退出并已自动恢复，无需重启应用。',
      })
    } catch (err) {
      console.error('[pglite] respawn failed:', describeError(err))
      emitDbNotice({
        id: `pglite-respawn-failed-${now}`,
        kind: 'pgliteReset',
        level: 'warning',
        message: `本地数据库异常退出且自动恢复失败(${describeError(err)})。聊天仍可继续,但历史不会保存 —— 请重启应用。`,
      })
    }
  })().finally(() => {
    respawning = null
  })
  return respawning
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
    const client = new PrismaClient({
      // 池子刻意收到 PRISMA_POOL_MAX(=1)。PGlite 是单连接库、查询在它那侧串行,
      // 多开连接换不来吞吐,只会让并发查询去撞 socket server 的连接上限并被掐断
      // (P1017 的由来)。并发改为在池子里客户端侧排队。见 pgliteLimits.ts。
      adapter: new PrismaPg({
        connectionString: databaseUrl,
        max: PRISMA_POOL_MAX,
        // 池队列必须有界:pg 默认无限等,PGlite 卡住(而非崩溃)时调用方会从
        // 「快速报错」退化成「永远不 resolve」,try/catch 抓不住。见 pgliteLimits.ts。
        connectionTimeoutMillis: PRISMA_POOL_ACQUIRE_TIMEOUT_MS,
      }),
    })

    // worker 崩掉的那一瞬,已经在飞的查询会拿到「连接没了」。worker 会被监管钩子
    // 拉起来,但那条查询已经失败了 —— 用户看到的就是一次没来由的报错。
    //
    // **只重试读。** 连接断在响应途中时,写有没有落库是不确定的,重试一个其实已经
    // 提交的 create 会产生重复记录(重复的聊天消息、重复的附件行)。判定见
    // pgliteSupervisor.isRetryableOperation。
    //
    // 只加 query 扩展、不加任何新方法,所以扩展后的客户端与 PrismaClient 结构一致,
    // 这个断言不会骗到调用方(Prisma 的 $extends 在类型上返回另一个类型,但运行时
    // 形状不变)。
    prisma = client.$extends({
      query: {
        $allOperations: async ({ operation, args, query }) => {
          try {
            return await query(args)
          } catch (err) {
            const plan = planDbFailure(err, operation)
            if (plan.probeWorker) void checkSocketServerAlive()
            if (!plan.retry) throw err
            // 给监管钩子一点时间把 worker 拉起来再重试一次
            await delay(1_000)
            return query(args)
          }
        },
      },
    }) as unknown as PrismaClient
  }

  return prisma
}

export async function shutdownDatabase(): Promise<void> {
  // 先立旗:worker 接下来的退出是我们要求的,监管钩子不该把它当成崩溃去重生。
  intentionalShutdown = true
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