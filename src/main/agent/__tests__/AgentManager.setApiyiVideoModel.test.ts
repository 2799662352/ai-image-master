import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentManager } from '../AgentManager'

function makeFakeBackend() {
  return {
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
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mgr-apiyi-model-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe('AgentManager.setApiyiVideoModel', () => {
  it('persists the model id and adds GEMINI_MODEL to env when apiKey is already set', async () => {
    const backend = makeFakeBackend()
    const mgr = new AgentManager({ userDataDir: tmpDir })
    ;(mgr as any).backend = backend

    // Seed an apiKey first so the entry will be enabled.
    await mgr.setApiyiVideoKey('sk-existing')
    backend.batchWriteConfig.mockClear()

    const result = await mgr.setApiyiVideoModel('gemini-2.5-pro')

    expect(result).toEqual({ ok: true })

    expect(backend.batchWriteConfig).toHaveBeenCalledTimes(1)
    const writtenEntry = vi.mocked(backend.batchWriteConfig).mock.calls[0][0][0]
    expect(writtenEntry).toMatchObject({
      keyPath: 'mcp_servers.apiyi',
      mergeStrategy: 'replace',
      value: {
        enabled: true,
        env: { APIYI_API_KEY: 'sk-existing', GEMINI_MODEL: 'gemini-2.5-pro' },
      },
    })
    expect(vi.mocked(backend.batchWriteConfig).mock.calls[0][1]).toBe(true)

    const providersRaw = await fs.readFile(path.join(tmpDir, 'codex-providers.json'), 'utf8')
    const providers = JSON.parse(providersRaw)
    expect(providers.apiKeys['apiyi-video-model']).toBe('gemini-2.5-pro')
    expect(providers.apiKeys['apiyi-video']).toBe('sk-existing')
  })

  it('clears GEMINI_MODEL when modelId is empty (falls back to apiyi-mcp default)', async () => {
    const backend = makeFakeBackend()
    const mgr = new AgentManager({ userDataDir: tmpDir })
    ;(mgr as any).backend = backend

    await mgr.setApiyiVideoKey('sk-key')
    await mgr.setApiyiVideoModel('gemini-2.5-pro')
    backend.batchWriteConfig.mockClear()

    const result = await mgr.setApiyiVideoModel('   ')

    expect(result).toEqual({ ok: true })
    const writtenEntry = vi.mocked(backend.batchWriteConfig).mock.calls[0][0][0]
    expect(writtenEntry).toMatchObject({
      value: {
        enabled: true,
        env: { APIYI_API_KEY: 'sk-key' },
      },
    })
    expect((writtenEntry as any).value.env.GEMINI_MODEL).toBeUndefined()

    const providers = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'codex-providers.json'), 'utf8'),
    )
    expect(providers.apiKeys['apiyi-video-model']).toBeUndefined()
  })

  it('without apiKey: model is persisted but env stays empty (MCP disabled)', async () => {
    const backend = makeFakeBackend()
    const mgr = new AgentManager({ userDataDir: tmpDir })
    ;(mgr as any).backend = backend

    const result = await mgr.setApiyiVideoModel('gemini-2.5-flash')

    expect(result).toEqual({ ok: true })
    const writtenEntry = vi.mocked(backend.batchWriteConfig).mock.calls[0][0][0]
    expect(writtenEntry).toMatchObject({
      value: {
        enabled: false,
        env: {},
      },
    })

    const providers = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'codex-providers.json'), 'utf8'),
    )
    expect(providers.apiKeys['apiyi-video-model']).toBe('gemini-2.5-flash')
  })

  it('backend throws → model still persisted, returns ok:false', async () => {
    const backend = makeFakeBackend()
    backend.batchWriteConfig.mockRejectedValue(new Error('disk full'))
    const mgr = new AgentManager({ userDataDir: tmpDir })
    ;(mgr as any).backend = backend

    const result = await mgr.setApiyiVideoModel('gemini-2.5-pro')

    expect(result.ok).toBe(false)
    expect((result as any).error).toContain('disk full')

    const providers = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'codex-providers.json'), 'utf8'),
    )
    expect(providers.apiKeys['apiyi-video-model']).toBe('gemini-2.5-pro')
  })
})
