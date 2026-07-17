import type {
  AgentModelSelectionApplyPayload,
  AgentModelSelectionApplyResult,
} from '../../types/agent'
import type { ElectronAPI } from '../index'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeAllListeners: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}))

vi.mock('electron', () => ({
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

const APPLY_PAYLOAD: AgentModelSelectionApplyPayload = {
  gatewayId: 'rightcode',
  modelId: 'grok-4.5',
  contextWindow: 1_000_000,
  catalogRevision: 'catalog-1',
  requestVersion: 7,
}

describe('preload Gateway and model-selection API', () => {
  beforeEach(() => {
    electronMocks.invoke.mockReset()
  })

  it('maps Gateway snapshot reads and mutations to their safe invoke channels', async () => {
    const snapshot = {
      ok: true,
      builtins: [{
        id: 'apiyi',
        name: 'API Yi',
        baseUrl: 'https://api.apiyi.com/v1',
        envKey: 'OPENAI_API_KEY',
      }],
      custom: [],
      activeId: 'apiyi',
      apiKeys: {},
    }
    const activation = { ok: true, activeId: 'rightcode', providerGeneration: 2 }
    const keyUpdate = { ok: true, activeId: 'rightcode', providerGeneration: 3 }
    electronMocks.invoke
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(activation)
      .mockResolvedValueOnce(keyUpdate)

    await expect(getExposedApi().agent.getGateways()).resolves.toBe(snapshot)
    await expect(getExposedApi().agent.setActiveGateway('rightcode')).resolves.toBe(activation)
    await expect(
      getExposedApi().agent.setGatewayApiKey('rightcode', 'sk-secret'),
    ).resolves.toBe(keyUpdate)

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, 'agent:get-gateways')
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      2,
      'agent:set-active-gateway',
      'rightcode',
    )
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      3,
      'agent:set-gateway-api-key',
      'rightcode',
      'sk-secret',
    )
  })

  it('maps one authoritative model-selection payload unchanged', async () => {
    const expected: AgentModelSelectionApplyResult = {
      ok: true,
      data: {
        gatewayId: 'rightcode',
        channelId: 'rightcode-grok',
        modelId: 'grok-4.5',
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
        catalogRevision: 'catalog-1',
        backendEpoch: 2,
        threadRestored: false,
        requestVersion: 7,
      },
    }
    electronMocks.invoke.mockResolvedValueOnce(expected)

    await expect(
      getExposedApi().agent.applyModelSelection(APPLY_PAYLOAD),
    ).resolves.toBe(expected)
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      'agent:model-selection-apply',
      APPLY_PAYLOAD,
    )
  })
})
