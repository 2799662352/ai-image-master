import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dialog } from 'electron'
import { AgentManager } from '../AgentManager'
import type { IAgentBackend } from '../types'
import type { CodexSessionConfig } from '../../../types/agent'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
  dialog: {
    showMessageBox: vi.fn(),
  },
}))

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mgr-session-test-'))
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false })
})

afterEach(async () => {
  vi.clearAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

/**
 * NOTE on defaults: DEFAULT_CODEX_SESSION_CONFIG is intentionally
 * `never`/`danger-full-access`/`live` (commit 2500249 — the app runs codex
 * fully autonomous by default). The unsafe-confirmation dialog is
 * EDGE-triggered: it only fires when a patch moves a field from a safe value
 * to an unsafe one, so tests that exercise the dialog must first downgrade
 * to safe values (a safe patch never prompts).
 */
describe('AgentManager session config updates', () => {
  it('merges a safe patch and returns updated status', async () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })

    const status = await mgr.setSessionConfigPatch({
      sandboxMode: 'read-only',
      webSearch: 'disabled',
    })

    expect(status).toMatchObject({
      sandboxMode: 'read-only',
      approvalPolicy: 'never', // untouched by the patch — stays at the default
      webSearch: 'disabled',
    })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('confirms newly unsafe values before applying them', async () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })
    // Downgrade to safe values first — the defaults are already unsafe, so a
    // direct unsafe patch would be a no-op edge and never prompt.
    await mgr.setSessionConfigPatch({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      webSearch: 'disabled',
    })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()

    const status = await mgr.setSessionConfigPatch({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      webSearch: 'live',
    })

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(status).toMatchObject({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      webSearch: 'live',
    })
  })

  it('throws and preserves config when an unsafe confirmation is cancelled', async () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })
    await mgr.setSessionConfigPatch({ approvalPolicy: 'on-request' })

    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await expect(mgr.setSessionConfigPatch({ approvalPolicy: 'never' }))
      .rejects.toThrow('session config change cancelled')

    expect(mgr.getSessionStatus().approvalPolicy).toBe('on-request')
  })

  it('rejects invalid patches before mutating status', async () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })

    await expect(mgr.setSessionConfigPatch({ approvalPolicy: 'on-failure' }))
      .rejects.toThrow(/approvalPolicy/i)

    expect(mgr.getSessionStatus().approvalPolicy).toBe('never')
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('propagates accepted patches to the running backend for future threads', async () => {
    const backend = {
      async start() {},
      async stop() {},
      async *send() {},
      async cancel() {},
      isHealthy() { return true },
      setSessionConfig: vi.fn(),
    } satisfies IAgentBackend & { setSessionConfig: (patch: Partial<CodexSessionConfig>) => void }
    const mgr = new AgentManager({ userDataDir: tmpDir, backend })

    await mgr.setSessionConfigPatch({ webSearch: 'disabled' })

    expect(backend.setSessionConfig).toHaveBeenCalledWith({ webSearch: 'disabled' })
  })

  it('propagates setAllowedRoots changes to the running backend and returns a clone', async () => {
    const root = await fs.mkdtemp(path.join(tmpDir, 'workspace-'))
    const backend = {
      async start() {},
      async stop() {},
      async *send() {},
      async cancel() {},
      isHealthy() { return true },
      setSessionConfig: vi.fn(),
    } satisfies IAgentBackend & { setSessionConfig: (patch: Partial<CodexSessionConfig>) => void }
    const mgr = new AgentManager({ userDataDir: tmpDir, backend })

    const returned = await mgr.setAllowedRoots([root])
    returned.push(path.join(root, 'mutated'))

    expect(backend.setSessionConfig).toHaveBeenCalledWith({ writableRoots: [path.resolve(root)] })
    expect(mgr.getSessionStatus().writableRoots).toEqual([path.resolve(root)])
  })
})
