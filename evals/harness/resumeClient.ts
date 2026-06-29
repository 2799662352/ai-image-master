/**
 * Shared harness for the Codex `thread/resume` CRASH-CONTINUITY path — the fix
 * behind "闪退后同一对话无法连续对话". A thread minted by one `codex app-server`
 * generation must survive that process dying and be re-openable by a FRESH
 * generation so the conversation continues from disk.
 *
 * Everything talks raw JSON-RPC over WebSocket so it INDEPENDENTLY verifies the
 * wire method names/shapes against the real bundled binary (it never routes
 * through our own `CodexProtocolClient`) AND reads the model's reply straight
 * from the raw `item/completed#agentMessage` notification — bypassing the
 * gateway-specific delta-dedup in our notification router (apiyi streams a
 * partial delta then the full text only in `completed`, so a reconstructed
 * delta stream is unreliable).
 *
 * Two reusable runners:
 *   - {@link runResumeCore}   OFFLINE  — proves resume is wired + fails gracefully
 *   - {@link runResumeRecall} ONLINE   — proves real context recall across restart
 *
 * Consumed by `evals/scenarios/thread_resume_recall.eval.ts` (repeatable suite)
 * and `scripts/smoke-codex-resume.ts` (standalone CLI).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { buildCodexLaunchArgs, type CodexProviderConfig } from '../../src/main/agent/codexLaunch'

export const CONNECT_TIMEOUT_MS = 15_000
export const RPC_TIMEOUT_MS = 20_000
export const TURN_TIMEOUT_MS = 90_000
export const DEFAULT_SECRET = 'BANANA-42'

export type Logger = (msg: string) => void

const noop: Logger = () => undefined

export async function killProc(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null) return
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve())
    try {
      proc.kill('SIGTERM')
    } catch {
      /* already dead */
    }
    const t = setTimeout(() => {
      if (proc.exitCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* dead */
        }
      }
    }, 2_000)
    t.unref?.()
  })
}

export interface SpawnOpts {
  provider?: CodexProviderConfig
  apiKey?: string
  log?: Logger
}

/** Spawn the real bundled codex app-server with the production launch args. */
export function spawnCodexAppServer(
  binaryPath: string,
  listenUrl: string,
  codexHome: string,
  opts: SpawnOpts = {},
): ChildProcess {
  const log = opts.log ?? noop
  const args = buildCodexLaunchArgs({ listenUrl, provider: opts.provider })
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome }
  if (opts.provider && opts.apiKey) env[opts.provider.envKey] = opts.apiKey
  log(
    `spawn ${path.basename(binaryPath)} app-server --listen ${listenUrl}` +
      (opts.provider ? ` (provider=${opts.provider.id}, model=${opts.provider.model ?? '<gateway default>'})` : ''),
  )
  const proc = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
  proc.stdout?.on('data', () => {
    /* swallow */
  })
  proc.stderr?.on('data', () => {
    /* swallow */
  })
  return proc
}

type NotificationHandler = (method: string, params: Record<string, unknown>) => void

/** Minimal raw JSON-RPC/WS client (independent of our CodexProtocolClient). */
export class RawClient {
  private ws: WebSocket | null = null
  private id = 0
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  onNotification: NotificationHandler | null = null

  async connect(url: string): Promise<void> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    for (;;) {
      try {
        await this.openOnce(url)
        return
      } catch (err) {
        if (Date.now() > deadline) throw new Error(`WS connect timeout: ${url} (${(err as Error).message})`)
        await new Promise((r) => setTimeout(r, 250))
      }
    }
  }

  private openOnce(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url)
      const onErr = (e: Error): void => {
        ws.removeAllListeners()
        try {
          ws.close()
        } catch {
          /* */
        }
        reject(e)
      }
      ws.once('error', onErr)
      ws.once('open', () => {
        ws.removeListener('error', onErr)
        ws.on('message', (data) => this.onMessage(String(data)))
        this.ws = ws
        resolve()
      })
    })
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number
      result?: unknown
      error?: { message: string }
      method?: string
      params?: Record<string, unknown>
    }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.method !== undefined) {
      // Notification (or server request); we only observe, never answer.
      this.onNotification?.(msg.method, msg.params ?? {})
      return
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
  }

  rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('WS not open'))
    const id = ++this.id
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC ${method} timed out`))
      }, RPC_TIMEOUT_MS)
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  notify(method: string, params: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', { clientInfo: { name: 'resume-harness', version: '0.0.0' }, capabilities: null })
    this.notify('initialized', {})
  }

  /**
   * Run one turn on `threadId` and return the model's final assistant text, read
   * straight from raw `item/completed#agentMessage` notifications (the
   * gateway-agnostic source of truth). Resolves on `turn/completed`.
   */
  runTurn(threadId: string, text: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let answer = ''
      const timer = setTimeout(() => {
        this.onNotification = null
        reject(new Error('turn timed out'))
      }, TURN_TIMEOUT_MS)
      this.onNotification = (method, params) => {
        if (params.threadId !== threadId) return
        if (method === 'item/completed') {
          const item = params.item as { type?: string; text?: string } | undefined
          if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.length > 0) {
            answer = item.text
          }
        } else if (method === 'turn/completed') {
          clearTimeout(timer)
          this.onNotification = null
          resolve(answer)
        } else if (method === 'turn/failed' || method === 'error') {
          clearTimeout(timer)
          this.onNotification = null
          reject(new Error(`turn failed: ${JSON.stringify(params).slice(0, 200)}`))
        }
      }
      this.rpc('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] }).catch((err) => {
        clearTimeout(timer)
        this.onNotification = null
        reject(err)
      })
    })
  }

  close(): void {
    try {
      this.ws?.close()
    } catch {
      /* */
    }
    this.ws = null
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('client closed'))
    }
    this.pending.clear()
  }
}

export async function findRolloutFor(codexHome: string, threadId: string): Promise<string | null> {
  const root = path.join(codexHome, 'sessions')
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue
      if (e.name.includes(threadId)) return full
      try {
        const head = (await fs.readFile(full, 'utf8')).slice(0, 4_000)
        if (head.includes(threadId)) return full
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

/**
 * A "method not found / unsupported" error means the binary lacks `thread/resume`
 * entirely — that would break the crash-continuity premise (hard FAIL). Any other
 * (domain) error — e.g. "no rollout found" for a thread that was never persisted —
 * means the method IS wired and failed GRACEFULLY, the safe-fallback contract.
 */
export function isMethodMissingError(message: string): boolean {
  return /method not found|unknown method|unsupported method|no such method|not implemented/i.test(message)
}

function threadStartParams(cwd: string, model?: string): Record<string, unknown> {
  return {
    ...(model ? { model } : {}),
    cwd,
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    config: { web_search: 'live', sandbox_workspace_write: { writable_roots: [] } },
  }
}

export interface ResumeCoreOptions {
  binaryPath: string
  cwd: string
  portA?: number
  portB?: number
  log?: Logger
}

export interface ResumeCoreResult {
  threadId: string
  rolloutPersisted: boolean
  resumeOutcome: 'resolved' | 'graceful-error'
  resumeError?: string
}

/**
 * OFFLINE: prove `thread/resume` is a real, wired method on the bundled binary
 * that fails GRACEFULLY (never "method not found", never a hang) when a thread
 * isn't on disk. A zero-turn thread can't be persisted offline, so happy-path
 * recall is covered by {@link runResumeRecall}. Throws iff the method is missing.
 */
export async function runResumeCore(options: ResumeCoreOptions): Promise<ResumeCoreResult> {
  const log = options.log ?? noop
  const portA = options.portA ?? 7611
  const portB = options.portB ?? 7612
  const urlA = `ws://127.0.0.1:${portA}`
  const urlB = `ws://127.0.0.1:${portB}`
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-resume-core-'))
  let procA: ChildProcess | null = null
  let procB: ChildProcess | null = null
  const a = new RawClient()
  const b = new RawClient()
  try {
    procA = spawnCodexAppServer(options.binaryPath, urlA, codexHome, { log })
    await a.connect(urlA)
    await a.initialize()
    log('A: initialize OK (thread/start + thread/resume RPCs exist)')
    const started = await a.rpc<{ thread: { id: string } }>('thread/start', threadStartParams(options.cwd))
    const threadId = started.thread.id
    log(`A: thread/start OK → threadId=${threadId}`)

    let rollout: string | null = null
    for (let i = 0; i < 8 && !rollout; i++) {
      rollout = await findRolloutFor(codexHome, threadId)
      if (!rollout) await new Promise((r) => setTimeout(r, 250))
    }
    const rolloutPersisted = rollout !== null
    log(
      rolloutPersisted
        ? `A: rollout persisted on disk → ${path.basename(rollout!)}`
        : 'A: zero-turn thread NOT persisted to disk (rollout is written on first turn — expected)',
    )

    a.close()
    await killProc(procA)
    procA = null
    log('A: app-server killed (simulates 闪退 — its in-memory thread is gone)')

    procB = spawnCodexAppServer(options.binaryPath, urlB, codexHome, { log })
    await b.connect(urlB)
    await b.initialize()
    log('B: initialize OK (fresh generation, empty in-memory threads)')

    let resumeOutcome: 'resolved' | 'graceful-error'
    let resumeError: string | undefined
    try {
      const resumed = await b.rpc<{ thread?: { id?: string } }>('thread/resume', { threadId })
      const resumedId = resumed?.thread?.id
      if (resumedId && resumedId !== threadId) {
        throw new Error(`resume returned a different thread id (${resumedId} != ${threadId})`)
      }
      resumeOutcome = 'resolved'
      log(`B: thread/resume RESOLVED → reopened dead generation's thread from disk (id=${resumedId ?? threadId})`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isMethodMissingError(message)) {
        throw new Error(`binary has no usable thread/resume: ${message}`)
      }
      resumeOutcome = 'graceful-error'
      resumeError = message
      log(`B: thread/resume returned a graceful domain error (RPC wired, safe-fallback path): "${message}"`)
    }

    return { threadId, rolloutPersisted, resumeOutcome, resumeError }
  } finally {
    a.close()
    b.close()
    await killProc(procA)
    await killProc(procB)
    await fs.rm(codexHome, { recursive: true, force: true }).catch(() => undefined)
  }
}

export interface ResumeRecallOptions {
  binaryPath: string
  provider: CodexProviderConfig
  apiKey: string
  model: string
  cwd: string
  secret?: string
  portA?: number
  portB?: number
  log?: Logger
}

export interface ResumeRecallResult {
  threadId: string
  secret: string
  ackAnswer: string
  recallAnswer: string
  recalled: boolean
}

/**
 * ONLINE: the true end-to-end proof — a real turn establishes a secret token
 * (which PERSISTS the rollout), the app-server is killed (simulated 闪退), a
 * FRESH app-server `thread/resume`s the same thread from disk, and a follow-up
 * turn must recall the token. `recalled` is true iff the reply echoes the secret.
 */
export async function runResumeRecall(options: ResumeRecallOptions): Promise<ResumeRecallResult> {
  const log = options.log ?? noop
  const secret = options.secret ?? DEFAULT_SECRET
  const portA = options.portA ?? 7621
  const portB = options.portB ?? 7622
  const urlA = `ws://127.0.0.1:${portA}`
  const urlB = `ws://127.0.0.1:${portB}`
  const { provider, apiKey, model } = options
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-resume-mem-'))
  let procA: ChildProcess | null = null
  let procB: ChildProcess | null = null
  const a = new RawClient()
  const b = new RawClient()
  try {
    // ── Generation A: establish context (a real turn PERSISTS the rollout) ──
    procA = spawnCodexAppServer(options.binaryPath, urlA, codexHome, { provider, apiKey, log })
    await a.connect(urlA)
    await a.initialize()
    const started = await a.rpc<{ thread: { id: string } }>('thread/start', threadStartParams(options.cwd, model))
    const threadId = started.thread.id
    log(`A: thread/start → ${threadId}`)
    const ackAnswer = await a.runTurn(
      threadId,
      `Remember this exact token for later: SECRET=${secret}. Reply only with the word noted.`,
    )
    log(`A: context established (reply: "${ackAnswer.trim().slice(0, 40)}")`)

    a.close()
    await killProc(procA)
    procA = null
    log('A: app-server killed (simulated 闪退)')

    // ── Generation B: a fresh process resumes the thread and must recall it ──
    procB = spawnCodexAppServer(options.binaryPath, urlB, codexHome, { provider, apiKey, log })
    await b.connect(urlB)
    await b.initialize()
    log('B: initialize OK (fresh generation)')
    await b.rpc('thread/resume', { threadId })
    log('B: thread/resume RESOLVED → conversation reloaded from disk')
    const recallAnswer = await b.runTurn(
      threadId,
      'What was the exact SECRET token I asked you to remember? Reply with just the token.',
    )
    log(`B: recall answer = "${recallAnswer.trim()}"`)

    const recalled = recallAnswer.toLowerCase().includes(secret.toLowerCase())
    return { threadId, secret, ackAnswer, recallAnswer, recalled }
  } finally {
    a.close()
    b.close()
    await killProc(procA)
    await killProc(procB)
    await fs.rm(codexHome, { recursive: true, force: true }).catch(() => undefined)
  }
}
