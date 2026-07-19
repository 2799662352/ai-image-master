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

  it('exposes the batch-2 tuning defaults in the status snapshot', () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })

    const status = mgr.getSessionStatus()
    expect(status.modelVerbosity).toBe('default')
    expect(status.persistedDefaults).toBe(false)
  })

  it('applies without persisting by default: a fresh manager reverts to factory defaults', async () => {
    const first = new AgentManager({ userDataDir: tmpDir })
    await first.setSessionConfigPatch({ webSearch: 'disabled', modelVerbosity: 'high' })
    expect(first.getSessionStatus().webSearch).toBe('disabled')

    const second = new AgentManager({ userDataDir: tmpDir })
    expect(second.getSessionStatus().webSearch).toBe('live')
    expect(second.getSessionStatus().modelVerbosity).toBe('default')
  })

  it('persists the config when persist=true and restores it on the next boot', async () => {
    const first = new AgentManager({ userDataDir: tmpDir })
    const status = await first.setSessionConfigPatch(
      { webSearch: 'disabled', modelVerbosity: 'high' },
      { persist: true },
    )
    expect(status.persistedDefaults).toBe(true)

    const second = new AgentManager({ userDataDir: tmpDir })
    const restored = second.getSessionStatus()
    expect(restored.webSearch).toBe('disabled')
    expect(restored.modelVerbosity).toBe('high')
    expect(restored.persistedDefaults).toBe(true)
  })

  it('persist=true snapshots the FULL current config, not only the incoming patch', async () => {
    const first = new AgentManager({ userDataDir: tmpDir })
    await first.setSessionConfigPatch({ personality: 'pragmatic' }) // in-memory only
    await first.setSessionConfigPatch({ webSearch: 'disabled' }, { persist: true })

    const second = new AgentManager({ userDataDir: tmpDir })
    const restored = second.getSessionStatus()
    expect(restored.personality).toBe('pragmatic')
    expect(restored.webSearch).toBe('disabled')
  })

  it('resetSessionConfigToFactory clears persistence and restores factory defaults without a dialog', async () => {
    const backend = {
      async start() {},
      async stop() {},
      async *send() {},
      async cancel() {},
      isHealthy() { return true },
      setSessionConfig: vi.fn(),
    } satisfies IAgentBackend & { setSessionConfig: (patch: Partial<CodexSessionConfig>) => void }
    const root = await fs.mkdtemp(path.join(tmpDir, 'workspace-'))
    const mgr = new AgentManager({ userDataDir: tmpDir, backend })
    await mgr.setAllowedRoots([root])
    await mgr.setSessionConfigPatch({ webSearch: 'disabled', sandboxMode: 'read-only' }, { persist: true })
    vi.mocked(dialog.showMessageBox).mockClear()

    const status = await mgr.resetSessionConfigToFactory()

    // Restoring the SHIPPED defaults is exempt from the unsafe-edge dialog
    // (same exemption as boot), even though they are the unsafe values.
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(status.webSearch).toBe('live')
    expect(status.sandboxMode).toBe('danger-full-access')
    expect(status.persistedDefaults).toBe(false)
    // Workspace-derived roots survive the factory reset.
    expect(status.writableRoots).toEqual([path.resolve(root)])
    expect(backend.setSessionConfig).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ writableRoots: expect.anything() }),
    )

    const second = new AgentManager({ userDataDir: tmpDir })
    expect(second.getSessionStatus().webSearch).toBe('live')
    expect(second.getSessionStatus().persistedDefaults).toBe(false)
  })
})
