import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { buildCodexLaunchArgs, resolveCodexSessionConfig, type CodexProviderConfig } from './codexLaunch'
import { mergeCodexConfigs } from './codexConfigMerge'
import { appendAuditLog, atomicWriteFile } from './codexConfigStore'
import { CodexProtocolClient, mapServerNotification } from './CodexProtocolClient'
import { createAgentLogStream } from './logger'
import { getCodexResourceRoot, resolveCodexBinary } from './paths'
import { pickFreePort } from './ports'
import type {
  AgentStreamEvent,
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexSessionConfig,
  CodexThreadDetail,
  CodexThreadSummary,
  CodexWorkspacePaths,
} from '../../types/agent'
import type { AgentInput, IAgentBackend } from './types'

export { mapServerNotification }

const KILL_GRACE_MS = 2_000
const STARTUP_LOG_TAIL = 8_000
const DEFAULT_SPAWN_CONNECT_TIMEOUT_MS = 10_000

export interface CodexLocalBackendOptions {
  /**
   * Override to bypass the spawn step and connect to an existing WebSocket
   * (used by tests against a fake `codex app-server`). When set, no child
   * process is created and `isHealthy` only inspects the WS state.
   */
  wsUrl?: string
  /**
   * Resource directory containing the bundled `codex/<platform>-<arch>/`
   * subtree. When set (and `wsUrl` is NOT set), `start()` skips the Electron
   * `app.getAppPath()` lookup and uses this path directly. Used by the
   * standalone probe script and any future non-Electron contexts (CI smoke
   * tests, etc.) that need to exercise the backend end-to-end without
   * running inside Electron.
   */
  resourceRoot?: string
  /**
   * Resolves the user's OpenAI API key at spawn time. When it returns a
   * non-empty trimmed string, the value is forwarded to the spawned `codex`
   * binary via `OPENAI_API_KEY`. When it returns `undefined`/empty, no
   * `OPENAI_API_KEY` is forwarded — even if it exists in the parent process
   * env — so callers can rely on an explicit key path.
   */
  getApiKey?: () => string | undefined
  /**
   * Test seam for the `child_process.spawn` call in the spawn-mode branch.
   * Defaults to Node's `spawn`. Tests inject a stub that records the call
   * (notably the `env` arg) and returns an `EventEmitter`-shaped child.
   */
  spawnFactory?: typeof spawn
  /**
   * Connect timeout forwarded to `CodexProtocolClient` in the spawn-mode
   * branch. Defaults to 10s in production. Tests can shrink this so an
   * unreachable spawn fails fast without affecting the wsUrl branch.
   */
  connectTimeoutMs?: number
  /**
   * Custom OpenAI-compatible provider config. Forwarded to
   * `buildCodexLaunchArgs` so the spawned `codex app-server` connects to the
   * configured `base_url` (e.g. API易) instead of `api.openai.com`. When
   * omitted, Codex uses its built-in `openai` provider — which requires a
   * direct OpenAI key.
   */
  provider?: CodexProviderConfig
  sessionConfig?: Partial<CodexSessionConfig>
  onApprovalRequest?: (request: CodexApprovalRequest) => void
  onMcpNotification?: (event: AgentStreamEvent) => void
}

type SpawnedCodexClient = {
  proc: ChildProcess
  client: CodexProtocolClient
}

/**
 * Build the env passed to the spawned `codex` binary. Pulls every var from
 * `baseEnv` and only sets `OPENAI_API_KEY` when `apiKey` has a non-empty
 * trimmed value; otherwise it strips any pre-existing `OPENAI_API_KEY` so
 * the spawned process cannot accidentally inherit a stale key.
 */
export function buildCodexSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  apiKey: string | undefined,
  codexHome?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  const trimmed = apiKey?.trim() ?? ''
  if (trimmed) env.OPENAI_API_KEY = trimmed
  else delete env.OPENAI_API_KEY
  if (codexHome) env.CODEX_HOME = codexHome
  return env
}

export async function rebuildRuntimeConfig(paths: CodexWorkspacePaths): Promise<void> {
  const [personal, workspace] = await Promise.all([
    fs.readFile(paths.personalConfigToml, 'utf8').catch(() => ''),
    fs.readFile(paths.workspaceConfigToml, 'utf8').catch(() => ''),
  ])
  const merged = mergeCodexConfigs({ personalToml: personal, workspaceToml: workspace })
  await atomicWriteFile(paths.runtimeConfigToml, merged)
}

export class CodexLocalBackend implements IAgentBackend {
  private proc: ChildProcess | null = null
  private client: CodexProtocolClient | null = null
  private readonly options: CodexLocalBackendOptions
  private readonly wsUrlOverride: string | undefined
  private readonly resourceRootOverride: string | undefined
  private sessionConfig: CodexSessionConfig
  private configDirty = false
  private codexHome: string | undefined

  constructor(options: CodexLocalBackendOptions = {}) {
    this.options = options
    this.wsUrlOverride = options.wsUrl
    this.resourceRootOverride = options.resourceRoot
    this.sessionConfig = resolveCodexSessionConfig(options.sessionConfig)
  }

  async start(): Promise<void> {
    if (this.wsUrlOverride) {
      this.client = await this.startWsClient(this.wsUrlOverride)
      return
    }

    const started = await this.startSpawnedClient()
    this.proc = started.proc
    this.client = started.client
  }

  private async startWsClient(url: string): Promise<CodexProtocolClient> {
    const client = new CodexProtocolClient({
      url,
      clientInfo: { name: 'catimation', version: '0.0.0' },
      sessionConfig: this.sessionConfig,
      connectTimeoutMs: 5_000,
      onApprovalRequest: this.options.onApprovalRequest,
      onMcpNotification: this.options.onMcpNotification,
    })
    await client.start()
    return client
  }

  private async startSpawnedClient(): Promise<SpawnedCodexClient> {
    const port = await pickFreePort(4222)
    const listenUrl = `ws://127.0.0.1:${port}`
    const resourceRoot = this.resourceRootOverride ?? getCodexResourceRoot({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    })
    const bin = resolveCodexBinary(resourceRoot)
    const log: NodeJS.WritableStream = this.resourceRootOverride
      ? process.stderr
      : createAgentLogStream('codex')
    const recentOutput = new RingBuffer(STARTUP_LOG_TAIL)
    const captureOutput = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      recentOutput.push(text)
    }

    const apiKey = this.options.getApiKey?.()
    const env = buildCodexSpawnEnv(process.env, apiKey, this.codexHome)
    const spawnFactory = this.options.spawnFactory ?? spawn
    const proc = spawnFactory(
      bin,
      buildCodexLaunchArgs({
        listenUrl,
        provider: this.options.provider,
        sessionConfig: this.sessionConfig,
      }),
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      },
    )

    proc.stdout?.on('data', captureOutput)
    proc.stderr?.on('data', captureOutput)
    proc.stdout?.pipe(log, { end: false })
    proc.stderr?.pipe(log, { end: false })

    let startupPhase = true
    const earlyExit = new Promise<never>((_, reject) => {
      proc.once('error', (error) => {
        log.write(`[codex process error] ${error.message}\n`)
        if (startupPhase) reject(new Error(`Codex spawn failed: ${error.message}`))
      })
      proc.once('exit', (code, signal) => {
        log.write(`[codex exited] code=${code} signal=${signal ?? ''}\n`)
        if (startupPhase) {
          const tail = recentOutput.read().slice(-STARTUP_LOG_TAIL)
          reject(new Error(
            `Codex exited before initialize completed (code=${code} signal=${signal ?? 'none'})` +
              (tail ? `\n--- recent output ---\n${tail}` : ''),
          ))
        } else {
          client.stop().catch(() => { /* ignore */ })
        }
      })
    })
    earlyExit.catch(() => { /* swallow when startupPhase=false */ })

    const client = new CodexProtocolClient({
      url: listenUrl,
      clientInfo: { name: 'catimation', version: '0.0.0' },
      sessionConfig: this.sessionConfig,
      connectTimeoutMs: this.options.connectTimeoutMs ?? DEFAULT_SPAWN_CONNECT_TIMEOUT_MS,
      onLog: (line) => log.write(line + '\n'),
      onApprovalRequest: this.options.onApprovalRequest,
      onMcpNotification: this.options.onMcpNotification,
    })

    try {
      await Promise.race([client.start(), earlyExit])
    } catch (error) {
      startupPhase = false
      await client.stop().catch(() => { /* ignore */ })
      await this.killProcessInstance(proc)
      throw error
    } finally {
      startupPhase = false
    }
    return { proc, client }
  }

  async stop(): Promise<void> {
    const client = this.client
    const proc = this.proc
    this.client = null
    this.proc = null
    if (client) {
      await client.stop().catch(() => { /* ignore */ })
    }
    await this.killProcessInstance(proc)
  }

  async applyConfigChange(paths: CodexWorkspacePaths): Promise<void> {
    await rebuildRuntimeConfig(paths)
    this.configDirty = true
  }

  isConfigDirty(): boolean {
    return this.configDirty
  }

  async restartCodex(paths: CodexWorkspacePaths): Promise<void> {
    await rebuildRuntimeConfig(paths)
    this.codexHome = path.dirname(paths.runtimeConfigToml)
    this.configDirty = true

    if (this.client?.hasInFlightWork()) return

    if (this.wsUrlOverride) {
      await this.stop()
      await this.start()
      this.configDirty = false
      await this.auditRestart(paths)
      return
    }

    const oldClient = this.client
    const oldProc = this.proc
    const replacement = await this.startSpawnedClient()
    this.proc = replacement.proc
    this.client = replacement.client

    if (oldClient) {
      await oldClient.stop().catch(() => { /* ignore */ })
    }
    await this.killProcessInstance(oldProc)
    this.configDirty = false

    await this.auditRestart(paths)
  }

  private async auditRestart(paths: CodexWorkspacePaths): Promise<void> {
    try {
      await appendAuditLog(paths.auditLogPath, {
        tsIso: new Date().toISOString(),
        action: 'codex.restart',
        ok: true,
      })
    } catch {
      // Audit logging is best-effort and must not block a local restart.
    }
  }

  send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
    if (!this.client) {
      throw new Error('CodexLocalBackend.send called before start')
    }
    return this.client.send(threadId, input)
  }

  async cancel(threadId: string): Promise<void> {
    if (!this.client) return
    await this.client.cancel(threadId)
  }

  async listThreads(): Promise<CodexThreadSummary[]> {
    if (!this.client) throw new Error('CodexLocalBackend.listThreads called before start')
    return this.client.listThreads()
  }

  async readThread(threadId: string): Promise<CodexThreadDetail> {
    if (!this.client) throw new Error('CodexLocalBackend.readThread called before start')
    return this.client.readThread(threadId)
  }

  async forkThread(threadId: string): Promise<CodexThreadSummary> {
    if (!this.client) throw new Error('CodexLocalBackend.forkThread called before start')
    return this.client.forkThread(threadId)
  }

  respondToApprovalResponse(response: CodexApprovalResponse): void {
    if (!this.client) throw new Error('CodexLocalBackend.respondToApprovalResponse called before start')
    this.client.respondToServerRequest(response)
  }

  isHealthy(): boolean {
    if (!this.client?.isOpen()) return false
    if (this.wsUrlOverride) return true
    return this.proc !== null && this.proc.exitCode === null
  }

  setSessionConfig(patch: Partial<CodexSessionConfig>): void {
    this.sessionConfig = resolveCodexSessionConfig({
      ...this.sessionConfig,
      ...patch,
      writableRoots: patch.writableRoots ? [...patch.writableRoots] : [...this.sessionConfig.writableRoots],
    })
    this.client?.setSessionConfig(patch)
  }

  async listMcpServers(params?: unknown): Promise<unknown> {
    if (!this.client) throw new Error('CodexLocalBackend.listMcpServers called before start')
    return this.client.listMcpServers(params as any)
  }

  async batchWriteConfig(edits: unknown[], reloadUserConfig?: boolean): Promise<void> {
    if (!this.client) throw new Error('CodexLocalBackend.batchWriteConfig called before start')
    await this.client.batchWriteConfig(edits as any[], reloadUserConfig)
  }

  async writeConfigValue(keyPath: string, value: unknown): Promise<void> {
    if (!this.client) throw new Error('CodexLocalBackend.writeConfigValue called before start')
    await this.client.writeConfigValue(keyPath, value)
  }

  async readConfig(): Promise<{ config: Record<string, unknown> }> {
    if (!this.client) throw new Error('CodexLocalBackend.readConfig called before start')
    return this.client.readConfig()
  }

  async reloadMcpServers(): Promise<void> {
    if (!this.client) throw new Error('CodexLocalBackend.reloadMcpServers called before start')
    await this.client.reloadMcpServers()
  }

  async mcpOAuthLogin(name: string): Promise<{ authorization_url: string }> {
    if (!this.client) throw new Error('CodexLocalBackend.mcpOAuthLogin called before start')
    return this.client.mcpOAuthLogin(name)
  }

  private async killProcessInstance(proc: ChildProcess | null): Promise<void> {
    if (!proc) return
    if (proc.exitCode !== null) return

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      proc.once('exit', finish)

      try { proc.kill('SIGTERM') } catch { /* already dead */ }

      const killTimer = setTimeout(() => {
        if (proc.exitCode !== null) return
        try { proc.kill('SIGKILL') } catch { /* already dead */ }
      }, KILL_GRACE_MS)
      killTimer.unref?.()
    })
  }
}

class RingBuffer {
  private chunks: string[] = []
  private size = 0

  constructor(private readonly maxSize: number) {}

  push(text: string): void {
    this.chunks.push(text)
    this.size += text.length
    while (this.size > this.maxSize && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.size -= dropped.length
    }
  }

  read(): string {
    return this.chunks.join('')
  }
}
