import type {
  AgentModelContextApplyPayload,
  AgentModelContextApplyResult,
  AgentModelContextSnapshotResult,
  AgentModelSelectionRecoveryResult,
  AgentModelSettingsCatalogResult,
} from '../../types/agent'
import type { ElectronAPI } from '../index'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeAllListeners: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: electronMocks.exposeInMainWorld,
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeAllListeners: electronMocks.removeAllListeners,
    removeListener: electronMocks.removeListener,
    send: electronMocks.send,
  },
  webUtils: {
    getPathForFile: vi.fn(() => ''),
  },
}))

import '../index'

function getExposedApi(): ElectronAPI {
  return (window as unknown as { electronAPI: ElectronAPI }).electronAPI
}

describe('preload model settings API', () => {
  beforeEach(() => {
    electronMocks.invoke.mockReset()
  })

  it('maps catalog and context snapshot reads to their safe invoke channels', async () => {
    const catalog: AgentModelSettingsCatalogResult = {
      ok: true,
      data: { provider: 'apiyi', source: 'fallback', models: [] },
    }
    const snapshot: AgentModelContextSnapshotResult = {
      ok: true,
      data: {
        modelContextWindow: 200_000,
        modelAutoCompactTokenLimit: 180_000,
        recoveryRequired: false,
      },
    }
    electronMocks.invoke
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce(snapshot)

    await expect(getExposedApi().agent.getModelSettingsCatalog()).resolves.toBe(catalog)
    await expect(getExposedApi().agent.getModelContextConfig()).resolves.toBe(snapshot)
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, 'agent:model-settings-catalog')
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, 'agent:model-context-get')
  })

  it('maps apply to the exact payload and never adds compact configuration', async () => {
    const payload: AgentModelContextApplyPayload = {
      threadId: 'thread-1',
      model: 'gpt-5.6-sol',
      contextWindow: 1_000_000,
      requestVersion: 12,
    }
    const expected: AgentModelContextApplyResult = {
      ok: true,
      data: {
        model: payload.model,
        contextWindow: payload.contextWindow,
        autoCompactTokenLimit: 900_000,
        threadRestored: true,
        requestVersion: payload.requestVersion,
      },
    }
    electronMocks.invoke.mockResolvedValueOnce(expected)

    await expect(getExposedApi().agent.applyModelContext(payload)).resolves.toBe(expected)
    expect(electronMocks.invoke).toHaveBeenCalledWith('agent:model-context-apply', payload)
    expect(electronMocks.invoke.mock.calls[0][1]).not.toHaveProperty(
      'modelAutoCompactTokenLimit',
    )
  })

  it('maps explicit model-selection recovery to its safe invoke channel', async () => {
    const expected: AgentModelSelectionRecoveryResult = {
      ok: true,
      recoveryRequired: false,
      snapshot: null,
    }
    electronMocks.invoke.mockResolvedValueOnce(expected)

    await expect(
      getExposedApi().agent.recoverModelSelection(),
    ).resolves.toBe(expected)
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      'agent:model-selection-recover',
    )
  })
})
