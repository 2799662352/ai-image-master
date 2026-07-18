import type {
  AgentModelSelectionApplyPayload,
  AgentModelSelectionApplyResult,
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
    getGatewaysSnapshotRpc: vi.fn(),
    setActiveGatewayRpc: vi.fn(),
    setGatewayApiKeyRpc: vi.fn(),
    applyModelSelectionRpc: vi.fn<
      (payload: AgentModelSelectionApplyPayload) => Promise<AgentModelSelectionApplyResult>
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

const VALID_SELECTION: AgentModelSelectionApplyPayload = {
  gatewayId: 'rightcode',
  modelId: 'grok-4.5',
  contextWindow: 1_000_000,
  catalogRevision: 'catalog-1',
  requestVersion: 7,
}

describe('registerAgentIpc Gateway and model-selection handlers', () => {
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

  it('reads the existing user-facing Gateway snapshot through the Gateway channel', async () => {
    const snapshot = {
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
    manager.getGatewaysSnapshotRpc.mockResolvedValue(snapshot)

    await expect(getHandler('agent:get-gateways')({})).resolves.toEqual({
      ok: true,
      ...snapshot,
    })
    expect(manager.getGatewaysSnapshotRpc).toHaveBeenCalledOnce()
  })

  it('validates and forwards Gateway mutations to the existing AgentManager API', async () => {
    const activation = { ok: true as const, activeId: 'rightcode', providerGeneration: 2 }
    const keyUpdate = { ok: true as const, activeId: 'rightcode', providerGeneration: 3 }
    manager.setActiveGatewayRpc.mockResolvedValue(activation)
    manager.setGatewayApiKeyRpc.mockResolvedValue(keyUpdate)

    await expect(getHandler('agent:set-active-gateway')({}, 'rightcode')).resolves.toBe(
      activation,
    )
    await expect(
      getHandler('agent:set-gateway-api-key')({}, 'rightcode', 'sk-secret'),
    ).resolves.toBe(keyUpdate)
    expect(manager.setActiveGatewayRpc).toHaveBeenCalledWith('rightcode')
    expect(manager.setGatewayApiKeyRpc).toHaveBeenCalledWith('rightcode', 'sk-secret')

    await expect(getHandler('agent:set-active-gateway')({}, '')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/non-empty/i),
    })
    await expect(
      getHandler('agent:set-gateway-api-key')({}, 'rightcode', 42),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/key.*string/i),
    })
    expect(manager.setActiveGatewayRpc).toHaveBeenCalledOnce()
    expect(manager.setGatewayApiKeyRpc).toHaveBeenCalledOnce()
  })

  it('applies one authoritative model-selection payload', async () => {
    const confirmed = {
      gatewayId: 'rightcode',
      channelId: 'rightcode-grok',
      modelId: 'grok-4.5',
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
      catalogRevision: 'catalog-1',
      backendEpoch: 2,
      threadRestored: false,
      requestVersion: 7,
    }
    const expected: AgentModelSelectionApplyResult = { ok: true, data: confirmed }
    manager.applyModelSelectionRpc.mockResolvedValue(expected)

    await expect(
      getHandler('agent:model-selection-apply')({}, VALID_SELECTION),
    ).resolves.toEqual(expected)
    expect(manager.applyModelSelectionRpc).toHaveBeenCalledTimes(1)
    expect(manager.applyModelSelectionRpc).toHaveBeenCalledWith(VALID_SELECTION)
  })

  it.each([
    ['missing payload', undefined],
    ['blank gateway', { ...VALID_SELECTION, gatewayId: ' ' }],
    ['blank model', { ...VALID_SELECTION, modelId: '' }],
    ['invalid context', { ...VALID_SELECTION, contextWindow: 0 }],
    ['blank catalog revision', { ...VALID_SELECTION, catalogRevision: '' }],
    ['invalid request version', { ...VALID_SELECTION, requestVersion: -1 }],
  ])('returns an error envelope for %s without calling AgentManager', async (_label, payload) => {
    await expect(
      getHandler('agent:model-selection-apply')({}, payload),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.any(String),
    })
    expect(manager.applyModelSelectionRpc).not.toHaveBeenCalled()
  })
})
