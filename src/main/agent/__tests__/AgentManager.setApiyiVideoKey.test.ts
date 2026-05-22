import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentManager } from '../AgentManager'

function makeFakeBackend() {
  const backend = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendUserMessage: vi.fn(),
    cancel: vi.fn(),
    onEvent: vi.fn(),
    onApprovalRequest: vi.fn(),
    onMcpNotification: vi.fn(),
    respondToApproval: vi.fn(),
    setSessionConfig: vi.fn(),
    setAllowedRoots: vi.fn(),
    listMcpServers: vi.fn().mockResolvedValue({}),
    readConfig: vi.fn().mockResolvedValue({ config: {} }),
    batchWriteConfig: vi.fn().mockResolvedValue(undefined),
    writeConfigValue: vi.fn(),
    reloadMcpServers: vi.fn().mockResolvedValue(undefined),
    mcpOAuthLogin: vi.fn(),
    mcpToolCall: vi.fn(),
  }
  return backend
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mgr-apiyi-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe('AgentManager.setApiyiVideoKey', () => {
  it('happy path: non-empty key persists, enables MCP entry, and seeds default GEMINI_MODEL', async () => {
    const backend = makeFakeBackend()
    const mgr = new AgentManager({ userDataDir: tmpDir })
    ;(mgr as any).backend = backend

    const result = await mgr.setApiyiVideoKey('sk-live-abc123')

    expect(result).toEqual({ ok: true })

    expect(backend.batchWriteConfig).toHaveBeenCalledTimes(1)
    const writtenEntry = vi.mocked(backend.batchWriteConfig).mock.calls[0][0][0]
    expect(writtenEntry).toMatchObject({
      keyPath: 'mcp_servers.apiyi',
      mergeStrategy: 'replace',
      value: {
        command: process.execPath,
        args: [expect.stringMatching(/apiyi-mcp[\\/]dist[\\/]index\.js$/)],
        enabled: true,
        env: {
          // Required so Electron's process.execPath runs the child as a pure
          // Node process; without it Chromium startup pollutes stdout and
          // breaks MCP stdio framing (root cause of the "ready + 0 tools"
          // regression we hit on v4.3.16).
          ELECTRON_RUN_AS_NODE: '1',
          APIYI_API_KEY: 'sk-live-abc123',
          // apiyiMcpLauncher defaults to gemini-3.5-flash when no
          // apiyi-video-model is set in providers, so the UI picker label
          // always matches what the apiyi-mcp child actually runs.
          GEMINI_MODEL: 'gemini-3.5-flash',
        },
      },
    })
    expect(vi.mocked(backend.batchWriteConfig).mock.calls[0][1]).toBe(true)

    const providersRaw = await fs.readFile(
      path.join(tmpDir, 'codex-providers.json'),
      'utf8',
    )
    const providers = JSON.parse(providersRaw)
    expect(providers.apiKeys['apiyi-video']).toBe('sk-live-abc123')
  })

  it('empty/whitespace key disables MCP entry', async () => {
    const backend = makeFakeBackend()
    const mgr = new AgentManager({ userDataDir: tmpDir })
    ;(mgr as any).backend = backend

    const result = await mgr.setApiyiVideoKey('   ')

    expect(result).toEqual({ ok: true })

    expect(backend.batchWriteConfig).toHaveBeenCalledTimes(1)
    const writtenEntry = vi.mocked(backend.batchWriteConfig).mock.calls[0][0][0]
    expect(writtenEntry).toMatchObject({
      keyPath: 'mcp_servers.apiyi',
      mergeStrategy: 'replace',
      value: {
        enabled: false,
        // ELECTRON_RUN_AS_NODE is always present even on disabled entries,
        // so any future enabling that bypasses setApiyiVideoKey still spawns
        // through the node path.
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    })

    const providersRaw = await fs.readFile(
      path.join(tmpDir, 'codex-providers.json'),
      'utf8',
    )
    const providers = JSON.parse(providersRaw)
    expect(providers.apiKeys['apiyi-video']).toBeUndefined()
  })

  it('backend throws → providers.json keeps the key, returns ok:false', async () => {
    const backend = makeFakeBackend()
    backend.batchWriteConfig.mockRejectedValue(new Error('disk full'))
    const mgr = new AgentManager({ userDataDir: tmpDir })
    ;(mgr as any).backend = backend

    const result = await mgr.setApiyiVideoKey('sk-fail')

    expect(result.ok).toBe(false)
    expect((result as any).error).toContain('disk full')

    const providersRaw = await fs.readFile(
      path.join(tmpDir, 'codex-providers.json'),
      'utf8',
    )
    const providers = JSON.parse(providersRaw)
    expect(providers.apiKeys['apiyi-video']).toBe('sk-fail')
  })
})
