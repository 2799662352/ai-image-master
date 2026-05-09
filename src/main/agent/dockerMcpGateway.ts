import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'

import { app } from 'electron'

import { getCodexResourceRoot } from './paths'
import { resolveDockerMcpBinary } from './dockerMcpGatewayPath'

/**
 * Workaround for openai/codex#19425 (and dupes #20771/#21406/#21654/#21789/#21881).
 *
 * Symptom: When Codex spawns a stdio MCP server via `[mcp_servers.X]`, it
 * receives `tools/list` correctly but never registers those tools onto the
 * thread's tool surface. Result: red dots, "服务器未导出工具".
 *
 * The bug only affects the stdio→thread registration path. URL-based MCP
 * servers go through `rmcp` HTTP and work fine (proven in the wild by
 * `[mcp_servers.context7] url = "https://mcp.context7.com/mcp"`).
 *
 * Fix shape: convert N failing `[mcp_servers.X]` docker entries into one
 * `[mcp_servers.docker_gw] url = "http://127.0.0.1:8811/sse"` entry, and
 * run `docker mcp gateway run --port 8811 --transport sse` as a sidecar
 * process owned by this service. The gateway internally manages the docker
 * containers, but Codex only sees one HTTP endpoint -- bypassing the bug.
 *
 * Lifecycle: this service spawns/kills the gateway. Tests inject a fake
 * spawnFactory so we don't shell out during unit runs.
 */

export interface DockerMcpGatewayOptions {
  spawnFactory?: typeof nodeSpawn
  /** Absolute path to the docker-mcp binary. When null, falls back to `docker mcp` CLI. */
  binaryPath?: string | null
  /** Default port we listen on. */
  defaultPort?: number
  /** ms to wait for the gateway's "listening" line before failing. */
  defaultReadyTimeoutMs?: number
}

export interface CheckInstalledResult {
  installed: boolean
  version?: string
  error?: string
}

export interface GatewayStatus {
  running: boolean
  port: number | null
  pid: number | null
  profile: string | null
}

export interface StartArgs {
  port: number
  profile: string
  readyTimeoutMs?: number
}

const READY_PATTERN = /listening on|started on|server ready|address.*:\d+/i

export class DockerMcpGatewayService {
  private readonly spawnFactory: typeof nodeSpawn
  private readonly binaryPath: string | null
  private readonly defaultReadyTimeoutMs: number
  private child: ChildProcess | null = null
  private port: number | null = null
  private profile: string | null = null

  constructor(options: DockerMcpGatewayOptions = {}) {
    this.spawnFactory = options.spawnFactory ?? nodeSpawn
    this.binaryPath = options.binaryPath ?? null
    this.defaultReadyTimeoutMs = options.defaultReadyTimeoutMs ?? 15_000
  }

  private get cmd(): string {
    return this.binaryPath ?? 'docker'
  }

  private buildArgs(subArgs: string[]): string[] {
    if (this.binaryPath) {
      return subArgs.filter((a) => a !== 'mcp')
    }
    return subArgs
  }

  /**
   * Run `docker mcp --version` once. Used to gate the renderer's
   * "Fix Docker MCPs" banner -- if the plugin isn't installed we surface
   * install instructions rather than a confusing failure.
   */
  async checkInstalled(): Promise<CheckInstalledResult> {
    return new Promise<CheckInstalledResult>((resolve) => {
      let stdoutBuf = ''
      let stderrBuf = ''
      let settled = false
      const settle = (res: CheckInstalledResult) => {
        if (settled) return
        settled = true
        resolve(res)
      }

      let proc: ChildProcess
      try {
        proc = this.spawnFactory(this.cmd, this.buildArgs(['mcp', '--version']), { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        settle({ installed: false, error: err instanceof Error ? err.message : String(err) })
        return
      }

      proc.stdout?.on('data', (chunk) => { stdoutBuf += chunk.toString() })
      proc.stderr?.on('data', (chunk) => { stderrBuf += chunk.toString() })
      proc.on('error', (err: NodeJS.ErrnoException) => {
        // ENOENT = `docker` itself missing.
        if (err.code === 'ENOENT') {
          settle({ installed: false, error: 'docker not found in PATH (ENOENT). Install Docker Desktop first.' })
        } else {
          settle({ installed: false, error: err.message })
        }
      })
      proc.on('exit', (code) => {
        if (code === 0) {
          settle({ installed: true, version: stdoutBuf.trim() || stderrBuf.trim() })
        } else {
          settle({
            installed: false,
            error: stderrBuf.trim() || stdoutBuf.trim() || `docker mcp --version exited ${code}`,
          })
        }
      })
    })
  }

  /**
   * Build a Docker MCP profile that contains the given image references.
   * Equivalent to running:
   *   docker mcp profile create --name <profileName> --server docker://X --server docker://Y
   * Caller is expected to have already chosen a fresh `profileName` (we don't
   * try to reconcile with existing profiles here -- the orchestrator wipes
   * the previous one first if needed).
   */
  async addServersToProfile(profileName: string, imageRefs: string[]): Promise<void> {
    const args = ['mcp', 'profile', 'create', '--name', profileName]
    for (const ref of imageRefs) {
      args.push('--server', `docker://${ref}`)
    }

    return new Promise<void>((resolve, reject) => {
      let stderrBuf = ''
      let proc: ChildProcess
      try {
        proc = this.spawnFactory(this.cmd, this.buildArgs(args), { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        reject(err)
        return
      }
      proc.stderr?.on('data', (chunk) => { stderrBuf += chunk.toString() })
      proc.on('error', reject)
      proc.on('exit', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(stderrBuf.trim() || `docker mcp profile create exited ${code}`))
        }
      })
    })
  }

  /**
   * Spawn the gateway as a sidecar. Resolves when the gateway prints the
   * "listening" banner (typically <2s) or rejects on early exit / timeout.
   * If a previous instance is still running, it is stopped first so callers
   * can reuse `start()` to switch ports/profiles atomically.
   */
  async start(args: StartArgs): Promise<GatewayStatus> {
    if (this.child) {
      await this.stop()
    }

    const readyTimeoutMs = args.readyTimeoutMs ?? this.defaultReadyTimeoutMs
    const cmdArgs = [
      'mcp', 'gateway', 'run',
      '--port', String(args.port),
      '--transport', 'sse',
      '--profile', args.profile,
    ]

    let proc: ChildProcess
    try {
      proc = this.spawnFactory(this.cmd, this.buildArgs(cmdArgs), { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err))
    }

    this.child = proc
    this.port = args.port
    this.profile = args.profile

    return new Promise<GatewayStatus>((resolve, reject) => {
      let settled = false
      let stderrBuf = ''
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        fn()
      }
      const onLine = (chunk: Buffer | string) => {
        const text = chunk.toString()
        stderrBuf += text
        if (READY_PATTERN.test(text)) {
          settle(() => resolve(this.getStatus()))
        }
      }
      proc.stdout?.on('data', onLine)
      proc.stderr?.on('data', onLine)
      proc.on('error', (err) => {
        settle(() => {
          this.child = null
          this.port = null
          this.profile = null
          reject(err instanceof Error ? err : new Error(String(err)))
        })
      })
      proc.on('exit', (code) => {
        settle(() => {
          this.child = null
          this.port = null
          this.profile = null
          reject(new Error(stderrBuf.trim() || `docker mcp gateway exited ${code}`))
        })
      })
      const timeout = setTimeout(() => {
        if (settled) return
        try { proc.kill('SIGTERM') } catch { /* swallow -- best-effort */ }
        settle(() => {
          this.child = null
          this.port = null
          this.profile = null
          reject(new Error(`docker mcp gateway start timed out after ${readyTimeoutMs}ms`))
        })
      }, readyTimeoutMs)
    })
  }

  /**
   * Gracefully stop the sidecar. Idempotent.
   */
  async stop(): Promise<void> {
    const proc = this.child
    if (!proc) return
    this.child = null
    this.port = null
    this.profile = null

    return new Promise<void>((resolve) => {
      const cleanup = () => resolve()
      proc.once('exit', cleanup)
      try {
        proc.kill('SIGTERM')
      } catch {
        // Already gone. Resolve next tick to keep the API async-shaped.
        queueMicrotask(cleanup)
        return
      }
      // Hard kill after 3s if SIGTERM didn't take.
      setTimeout(() => {
        if (!proc.killed) {
          try { proc.kill('SIGKILL') } catch { /* swallow */ }
        }
      }, 3_000)
    })
  }

  getStatus(): GatewayStatus {
    return {
      running: this.child !== null,
      port: this.port,
      pid: this.child?.pid ?? null,
      profile: this.profile,
    }
  }
}

/**
 * Singleton wrapper so the IPC layer and the cleanup hook share one
 * instance without having to thread it through every constructor.
 */
let singleton: DockerMcpGatewayService | null = null
export function getDockerMcpGatewayService(): DockerMcpGatewayService {
  if (!singleton) {
    const resourceRoot = getCodexResourceRoot({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    })
    const binaryPath = resolveDockerMcpBinary(resourceRoot)
    singleton = new DockerMcpGatewayService({ binaryPath })
  }
  return singleton
}

/** Test-only helper to swap in a mock instance. Never use in product code. */
export function __setDockerMcpGatewayServiceForTests(svc: DockerMcpGatewayService | null) {
  singleton = svc
}
