import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => '/app', isPackaged: false } }))

import { DockerMcpGatewayService } from '../dockerMcpGateway'

/**
 * Build a fake ChildProcess that mimics the bits the service touches:
 * stdout/stderr streams, kill(), and 'exit' event.
 */
function makeFakeChild(opts: { exitCode?: number | null; stdoutLines?: string[]; stderrLines?: string[] } = {}) {
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })
  const proc = new EventEmitter() as any
  proc.stdout = stdout
  proc.stderr = stderr
  proc.pid = 12345
  proc.killed = false
  proc.kill = vi.fn((signal?: string) => {
    proc.killed = true
    queueMicrotask(() => proc.emit('exit', opts.exitCode ?? 0, signal ?? null))
    return true
  })
  // Helper to push lines into stdout from tests
  proc._emitStdout = (line: string) => stdout.push(line)
  proc._emitStderr = (line: string) => stderr.push(line)
  proc._exit = (code: number | null = 0) => proc.emit('exit', code, null)
  return proc
}

describe('DockerMcpGatewayService', () => {
  let svc: DockerMcpGatewayService
  let spawnFactory: ReturnType<typeof vi.fn>

  beforeEach(() => {
    spawnFactory = vi.fn()
    svc = new DockerMcpGatewayService({
      spawnFactory: spawnFactory as any,
      binaryPath: '/app/resources/docker-mcp/win32-x64/docker-mcp.exe',
    })
  })

  afterEach(async () => {
    await svc.stop().catch(() => {})
  })

  describe('checkInstalled', () => {
    it('returns installed=true when `docker mcp --version` exits 0', async () => {
      const child = makeFakeChild()
      spawnFactory.mockReturnValueOnce(child)

      const promise = svc.checkInstalled()
      child._emitStdout('Docker MCP plugin v0.10.0\n')
      // Real child_process emits 'data' before 'exit'; flush a tick so our
      // Readable mock matches that ordering.
      await new Promise((r) => setImmediate(r))
      child._exit(0)

      const res = await promise
      expect(res.installed).toBe(true)
      expect(res.version).toContain('0.10')
      expect(spawnFactory).toHaveBeenCalledWith(
        '/app/resources/docker-mcp/win32-x64/docker-mcp.exe',
        ['--version'],
        expect.any(Object),
      )
    })

    it('returns installed=false when docker mcp exits non-zero', async () => {
      const child = makeFakeChild()
      spawnFactory.mockReturnValueOnce(child)

      const promise = svc.checkInstalled()
      child._emitStderr('docker: \'mcp\' is not a docker command\n')
      child._exit(1)

      const res = await promise
      expect(res.installed).toBe(false)
      expect(res.error).toBeDefined()
    })

    it('returns installed=false when docker itself is missing (spawn ENOENT)', async () => {
      const child = makeFakeChild()
      spawnFactory.mockReturnValueOnce(child)

      const promise = svc.checkInstalled()
      const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      child.emit('error', err)

      const res = await promise
      expect(res.installed).toBe(false)
      expect(res.error).toMatch(/ENOENT|not found|docker/i)
    })
  })

  describe('start / stop / status', () => {
    it('spawns gateway with --port + --transport sse and resolves once ready marker is seen', async () => {
      const child = makeFakeChild()
      spawnFactory.mockReturnValueOnce(child)

      const startPromise = svc.start({ port: 8811, profile: 'default' })
      // Simulate the gateway's startup banner
      child._emitStderr('time=2026-01-01 INFO listening on http://0.0.0.0:8811\n')
      const status = await startPromise

      expect(spawnFactory).toHaveBeenCalledWith(
        '/app/resources/docker-mcp/win32-x64/docker-mcp.exe',
        ['gateway', 'run', '--port', '8811', '--transport', 'sse', '--profile', 'default'],
        expect.any(Object),
      )
      expect(status.running).toBe(true)
      expect(status.port).toBe(8811)
      expect(status.pid).toBe(12345)
      expect(svc.getStatus().running).toBe(true)
    })

    it('rejects if the gateway exits before reaching ready', async () => {
      const child = makeFakeChild({ exitCode: 1 })
      spawnFactory.mockReturnValueOnce(child)

      const startPromise = svc.start({ port: 8811, profile: 'default' })
      child._emitStderr('error: profile not found\n')
      child._exit(1)

      await expect(startPromise).rejects.toThrow(/exited|profile not found/i)
      expect(svc.getStatus().running).toBe(false)
    })

    it('rejects if start times out', async () => {
      const child = makeFakeChild()
      spawnFactory.mockReturnValueOnce(child)

      const startPromise = svc.start({ port: 8811, profile: 'default', readyTimeoutMs: 50 })
      // Don't emit anything -- let it time out
      await expect(startPromise).rejects.toThrow(/timeout|timed out/i)
      // Service should have killed the child to avoid leaking it
      expect(child.kill).toHaveBeenCalled()
    })

    it('stop() kills the running gateway and clears status', async () => {
      const child = makeFakeChild()
      spawnFactory.mockReturnValueOnce(child)

      const startPromise = svc.start({ port: 8811, profile: 'default' })
      child._emitStderr('listening on http://0.0.0.0:8811\n')
      await startPromise

      await svc.stop()
      expect(child.kill).toHaveBeenCalled()
      expect(svc.getStatus().running).toBe(false)
    })

    it('start() while already running stops the previous instance first', async () => {
      const first = makeFakeChild()
      const second = makeFakeChild()
      spawnFactory.mockReturnValueOnce(first).mockReturnValueOnce(second)

      const p1 = svc.start({ port: 8811, profile: 'default' })
      first._emitStderr('listening on http://0.0.0.0:8811\n')
      await p1

      const p2 = svc.start({ port: 8812, profile: 'default' })
      second._emitStderr('listening on http://0.0.0.0:8812\n')
      await p2

      expect(first.kill).toHaveBeenCalled()
      expect(svc.getStatus().port).toBe(8812)
    })
  })

  describe('addServersToProfile', () => {
    it('imports a freshly-built profile yaml via `docker mcp profile import`', async () => {
      const child = makeFakeChild()
      spawnFactory.mockReturnValueOnce(child)

      const promise = svc.addServersToProfile('catimation-fix', ['mcp/sequentialthinking', 'mcp/dockerhub'])
      child._exit(0)
      await promise

      expect(spawnFactory).toHaveBeenCalledTimes(1)
      const [cmd, args] = spawnFactory.mock.calls[0]
      expect(cmd).toBe('/app/resources/docker-mcp/win32-x64/docker-mcp.exe')
      expect(args.slice(0, 3)).toEqual(['profile', 'create', '--name'])
      expect(args).toContain('catimation-fix')
      // Each server should be added via --server docker://<image>
      expect(args).toContain('docker://mcp/sequentialthinking')
      expect(args).toContain('docker://mcp/dockerhub')
    })

    it('rejects when the profile create command fails', async () => {
      const child = makeFakeChild()
      spawnFactory.mockReturnValueOnce(child)

      const promise = svc.addServersToProfile('catimation-fix', ['mcp/x'])
      child._emitStderr('error: profile already exists\n')
      child._exit(1)

      await expect(promise).rejects.toThrow(/profile already exists|exited 1/i)
    })
  })
})
