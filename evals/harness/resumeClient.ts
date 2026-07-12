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
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { seedApiyiMcpEntry } from '../../src/main/agent/apiyiMcpSeed'
import { buildCodexLaunchArgs, type CodexProviderConfig } from '../../src/main/agent/codexLaunch'
import { seedCinematographyKbMcpEntry } from '../../src/main/agent/cinematographyKbMcpSeed'

export const CONNECT_TIMEOUT_MS = 15_000
export const RPC_TIMEOUT_MS = 20_000
export const TURN_TIMEOUT_MS = 90_000
export const DEFAULT_SECRET = 'BANANA-42'

export type Logger = (msg: string) => void

const noop: Logger = () => undefined

async function allocateFreeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not resolve an ephemeral loopback port'))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

export async function allocateFreeLoopbackPorts(
  count: number,
  excluded: readonly number[] = [],
): Promise<number[]> {
  if (!Number.isSafeInteger(count) || count <= 0 || count > 16) {
    throw new TypeError('Port count must be a positive safe integer no greater than 16')
  }

  const ports = new Set(excluded)
  const initialSize = ports.size
  while (ports.size < initialSize + count) {
    ports.add(await allocateFreeLoopbackPort())
  }
  return [...ports].slice(initialSize)
}

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
  offline?: boolean
}

const SENSITIVE_ENV_KEY =
  /(?:^|[_-])(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:[_-]|$)/i

export function buildResumeSpawnEnv(
  codexHome: string,
  opts: SpawnOpts = {},
  baseEnv: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, CODEX_HOME: codexHome }
  if (opts.offline) {
    for (const key of Object.keys(env)) {
      if (SENSITIVE_ENV_KEY.test(key)) delete env[key]
    }
  } else if (opts.provider && opts.apiKey) {
    env[opts.provider.envKey] = opts.apiKey
  }
  return env
}

/**
 * Mirror the production boot seeds required by buildCodexLaunchArgs' dotted
 * MCP overrides. A standalone harness starts with an empty CODEX_HOME, so
 * those overrides otherwise synthesize transport-less entries and Codex exits
 * with `invalid transport` before the WebSocket can bind.
 */
export async function prepareResumeCodexHome(
  codexHome: string,
  resourceRoot: string,
): Promise<void> {
  const personalConfigToml = path.join(codexHome, 'config.toml')
  await seedApiyiMcpEntry({
    personalConfigToml,
    entryPath: path.join(resourceRoot, 'apiyi-mcp', 'dist', 'index.js'),
    command: process.execPath,
  })
  await seedCinematographyKbMcpEntry({
    personalConfigToml,
    entryPath: path.join(resourceRoot, 'cinematography-kb-mcp', 'index.js'),
    command: process.execPath,
  })
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
  const env = buildResumeSpawnEnv(codexHome, opts)
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

export async function waitForPersistedRollout(
  codexHome: string,
  threadId: string,
  options: {
    timeoutMs?: number
    pollIntervalMs?: number
  } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const pollIntervalMs = options.pollIntervalMs ?? 100
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    const rolloutPath = await findRolloutFor(codexHome, threadId)
    if (rolloutPath) {
      try {
        if ((await fs.stat(rolloutPath)).size > 0) return rolloutPath
      } catch {
        // The writer may be between creating and replacing the rollout.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  throw new Error(`rollout was not persisted for thread ${threadId}`)
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
  resumeOutcome: 'resolved'
}

export function assertResumedThreadId(
  response: { thread?: { id?: string } },
  expectedThreadId: string,
): asserts response is { thread: { id: string } } {
  const resumedThreadId = response.thread?.id
  if (!resumedThreadId) {
    throw new Error('thread/resume did not return a thread id')
  }
  if (resumedThreadId !== expectedThreadId) {
    throw new Error(
      `resume returned a different thread id (${resumedThreadId} != ${expectedThreadId})`,
    )
  }
}

/**
 * OFFLINE: start a turn without credentials so Codex writes the user message
 * and session metadata before provider authentication fails, then prove a fresh
 * app-server generation can strictly resume that persisted thread.
 */
export async function runResumeCore(options: ResumeCoreOptions): Promise<ResumeCoreResult> {
  const log = options.log ?? noop
  const fixedPorts = [options.portA, options.portB].filter(
    (port): port is number => port !== undefined,
  )
  const allocatedPorts = fixedPorts.length < 2
    ? await allocateFreeLoopbackPorts(2 - fixedPorts.length, fixedPorts)
    : []
  const portA = options.portA ?? allocatedPorts.shift()!
  const portB = options.portB ?? allocatedPorts.shift()!
  const urlA = `ws://127.0.0.1:${portA}`
  const urlB = `ws://127.0.0.1:${portB}`
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-resume-core-'))
  const resourceRoot = path.resolve(path.dirname(options.binaryPath), '..', '..')
  let procA: ChildProcess | null = null
  let procB: ChildProcess | null = null
  const a = new RawClient()
  const b = new RawClient()
  try {
    await prepareResumeCodexHome(codexHome, resourceRoot)
    procA = spawnCodexAppServer(options.binaryPath, urlA, codexHome, {
      log,
      offline: true,
    })
    await a.connect(urlA)
    await a.initialize()
    log('A: initialize OK (thread/start + thread/resume RPCs exist)')
    const started = await a.rpc<{ thread: { id: string } }>('thread/start', threadStartParams(options.cwd))
    const threadId = started.thread.id
    log(`A: thread/start OK → threadId=${threadId}`)
    await a.rpc('turn/start', {
      threadId,
      input: [{
        type: 'text',
        text: 'Persist this offline resume smoke thread.',
        text_elements: [],
      }],
    })
    const rollout = await waitForPersistedRollout(codexHome, threadId)
    const rolloutPersisted = true
    log(`A: rollout persisted on disk → ${path.basename(rollout)}`)

    a.close()
    await killProc(procA)
    procA = null
    log('A: app-server killed (simulates 闪退 — its in-memory thread is gone)')

    procB = spawnCodexAppServer(options.binaryPath, urlB, codexHome, {
      log,
      offline: true,
    })
    await b.connect(urlB)
    await b.initialize()
    log('B: initialize OK (fresh generation, empty in-memory threads)')

    try {
      const resumed = await b.rpc<{ thread?: { id?: string } }>('thread/resume', { threadId })
      assertResumedThreadId(resumed, threadId)
      log(`B: thread/resume RESOLVED → reopened dead generation's thread from disk (id=${resumed.thread.id})`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isMethodMissingError(message)) {
        throw new Error(`binary has no usable thread/resume: ${message}`)
      }
      throw new Error(`persisted thread failed to resume: ${message}`)
    }

    return { threadId, rolloutPersisted, resumeOutcome: 'resolved' }
  } finally {
    a.close()
    b.close()
    await killProc(procA)
    await killProc(procB)
    await fs.rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    }).catch((error) => {
      log(`cleanup deferred for ${codexHome}: ${error instanceof Error ? error.message : String(error)}`)
    })
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
  const fixedPorts = [options.portA, options.portB].filter(
    (port): port is number => port !== undefined,
  )
  const allocatedPorts = fixedPorts.length < 2
    ? await allocateFreeLoopbackPorts(2 - fixedPorts.length, fixedPorts)
    : []
  const portA = options.portA ?? allocatedPorts.shift()!
  const portB = options.portB ?? allocatedPorts.shift()!
  const urlA = `ws://127.0.0.1:${portA}`
  const urlB = `ws://127.0.0.1:${portB}`
  const { provider, apiKey, model } = options
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-resume-mem-'))
  const resourceRoot = path.resolve(path.dirname(options.binaryPath), '..', '..')
  let procA: ChildProcess | null = null
  let procB: ChildProcess | null = null
  const a = new RawClient()
  const b = new RawClient()
  try {
    await prepareResumeCodexHome(codexHome, resourceRoot)
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
    await fs.rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    }).catch((error) => {
      log(`cleanup deferred for ${codexHome}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
