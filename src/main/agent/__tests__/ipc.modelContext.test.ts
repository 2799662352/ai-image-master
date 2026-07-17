import type {
  AgentModelContextApplyPayload,
  AgentModelContextApplyResult,
  AgentModelContextSnapshotResult,
  AgentModelSelectionRecoveryResult,
  AgentModelSettingsCatalogResult,
} from '../../../types/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const listeners = new Map<string, Set<unknown>>()
  return {
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        if (handlers.has(channel)) {
          throw new Error(`Attempted to register a second handler for '${channel}'`)
        }
        handlers.set(channel, handler)
      },
      removeHandler: (channel: string) => handlers.delete(channel),
      on: (channel: string, handler: unknown) => {
        const set = listeners.get(channel) ?? new Set<unknown>()
        set.add(handler)
        listeners.set(channel, set)
      },
      removeAllListeners: (channel: string) => listeners.delete(channel),
      __getHandler: (channel: string) => handlers.get(channel),
      __reset: () => {
        handlers.clear()
        listeners.clear()
      },
    },
  }
})

import { ipcMain } from 'electron'
import { registerAgentIpc } from '../ipc'

type IpcHandler = (...args: unknown[]) => unknown

function makeManager() {
  return {
    getModelSettingsCatalogRpc: vi.fn<() => Promise<AgentModelSettingsCatalogResult>>(),
    getModelContextConfigRpc: vi.fn<() => Promise<AgentModelContextSnapshotResult>>(),
    applyModelContextRpc: vi.fn<
      (payload: AgentModelContextApplyPayload) => Promise<AgentModelContextApplyResult>
    >(),
    recoverModelSelectionRpc: vi.fn<
      () => Promise<AgentModelSelectionRecoveryResult>
    >(),
  }
}

function getHandler(channel: string): IpcHandler {
  const handler = (
    ipcMain as unknown as {
      __getHandler: (registeredChannel: string) => IpcHandler | undefined
    }
  ).__getHandler(channel)
  if (!handler) throw new Error(`Missing IPC handler ${channel}`)
  return handler
}

const VALID_APPLY: AgentModelContextApplyPayload = {
  threadId: 'thread-1',
  model: 'gpt-5.6-sol',
  contextWindow: 1_000_000,
  requestVersion: 7,
}

describe('registerAgentIpc model settings handlers', () => {
  let manager: ReturnType<typeof makeManager>

  beforeEach(() => {
    ;(ipcMain as unknown as { __reset: () => void }).__reset()
    manager = makeManager()
    registerAgentIpc(
      () =>
        Promise.resolve(
          manager as unknown as Awaited<ReturnType<Parameters<typeof registerAgentIpc>[0]>>,
        ),
      () => ({ handleRendererResponse: vi.fn() }) as never,
    )
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('registers catalog and context snapshot channels and forwards exact envelopes', async () => {
    const catalog: AgentModelSettingsCatalogResult = {
      ok: true,
      data: { provider: 'rightcode', source: 'codex', models: [] },
    }
    const snapshot: AgentModelContextSnapshotResult = {
      ok: true,
      data: {
        modelContextWindow: 372_000,
        modelAutoCompactTokenLimit: 334_800,
        recoveryRequired: true,
        recoveryError: 'forward restart failed; rollback restart failed',
      },
    }
    manager.getModelSettingsCatalogRpc.mockResolvedValue(catalog)
    manager.getModelContextConfigRpc.mockResolvedValue(snapshot)

    await expect(getHandler('agent:model-settings-catalog')({})).resolves.toBe(catalog)
    await expect(getHandler('agent:model-context-get')({})).resolves.toBe(snapshot)
    expect(manager.getModelSettingsCatalogRpc).toHaveBeenCalledOnce()
    expect(manager.getModelContextConfigRpc).toHaveBeenCalledOnce()
  })

  it('forwards a valid 1M apply payload without deriving compact in renderer IPC', async () => {
    const expected: AgentModelContextApplyResult = {
      ok: true,
      data: {
        model: 'gpt-5.6-sol',
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
        threadRestored: true,
        requestVersion: 7,
      },
    }
    manager.applyModelContextRpc.mockResolvedValue(expected)

    await expect(getHandler('agent:model-context-apply')({}, VALID_APPLY)).resolves.toBe(expected)
    expect(manager.applyModelContextRpc).toHaveBeenCalledWith(VALID_APPLY)
    expect(manager.applyModelContextRpc.mock.calls[0][0]).not.toHaveProperty(
      'modelAutoCompactTokenLimit',
    )
  })

  it('forwards the explicit model-selection recovery command unchanged', async () => {
    const expected: AgentModelSelectionRecoveryResult = {
      ok: false,
      error: '模型恢复需等待当前请求或回合结束。',
      stage: 'busy',
      retryable: true,
      recoveryRequired: true,
    }
    manager.recoverModelSelectionRpc.mockResolvedValue(expected)

    await expect(
      getHandler('agent:model-selection-recover')({}),
    ).resolves.toBe(expected)
    expect(manager.recoverModelSelectionRpc).toHaveBeenCalledOnce()
  })

  it.each([500_000, 1_000_000])(
    'forwards the %i Grok context candidate for authoritative Provider validation',
    async (contextWindow) => {
      const payload: AgentModelContextApplyPayload = {
        ...VALID_APPLY,
        model: 'grok-4.5',
        contextWindow,
      }
      const expected: AgentModelContextApplyResult = {
        ok: true,
        data: {
          model: payload.model,
          contextWindow,
          autoCompactTokenLimit: Math.floor(contextWindow * 0.9),
          threadRestored: false,
          requestVersion: payload.requestVersion,
        },
      }
      manager.applyModelContextRpc.mockResolvedValue(expected)

      await expect(
        getHandler('agent:model-context-apply')({}, payload),
      ).resolves.toBe(expected)
      expect(manager.applyModelContextRpc).toHaveBeenCalledWith(payload)
    },
  )

  it.each([
    ['non-object null', null],
    ['array', []],
    ['date', new Date()],
    ['blank model', { ...VALID_APPLY, model: '  ' }],
    ['negative context', { ...VALID_APPLY, contextWindow: -1 }],
    ['fractional context', { ...VALID_APPLY, contextWindow: 372_000.5 }],
    ['NaN context', { ...VALID_APPLY, contextWindow: Number.NaN }],
    ['unsupported context', { ...VALID_APPLY, contextWindow: 371_999 }],
    ['negative requestVersion', { ...VALID_APPLY, requestVersion: -1 }],
    ['fractional requestVersion', { ...VALID_APPLY, requestVersion: 1.5 }],
    ['unsafe requestVersion', { ...VALID_APPLY, requestVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ['invalid threadId', { ...VALID_APPLY, threadId: '' }],
    ['renderer compact field', { ...VALID_APPLY, modelAutoCompactTokenLimit: 900_000 }],
    ['extra function', { ...VALID_APPLY, onComplete: () => undefined }],
  ])('rejects invalid %s without calling Manager', async (_label, payload) => {
    await expect(getHandler('agent:model-context-apply')({}, payload)).rejects.toThrow()
    expect(manager.applyModelContextRpc).not.toHaveBeenCalled()
  })

  it('rejects symbol-keyed payloads without calling Manager', async () => {
    const payload = { ...VALID_APPLY, [Symbol('danger')]: true }

    await expect(getHandler('agent:model-context-apply')({}, payload)).rejects.toThrow()
    expect(manager.applyModelContextRpc).not.toHaveBeenCalled()
  })
})
