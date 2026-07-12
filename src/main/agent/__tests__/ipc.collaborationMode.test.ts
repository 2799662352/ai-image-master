import type {
  AgentCollaborationCapabilitiesResult,
  AgentCollaborationModeUpdatePayload,
  AgentCollaborationModeUpdateResult,
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
    getCollaborationCapabilitiesRpc: vi.fn<
      (model: string) => Promise<AgentCollaborationCapabilitiesResult>
    >(),
    updateCollaborationModeRpc: vi.fn<
      (payload: AgentCollaborationModeUpdatePayload) => Promise<AgentCollaborationModeUpdateResult>
    >(),
  }
}

const router = { handleRendererResponse: vi.fn() }

function getHandler(channel: string): IpcHandler | undefined {
  return (
    ipcMain as unknown as {
      __getHandler: (registeredChannel: string) => IpcHandler | undefined
    }
  ).__getHandler(channel)
}

const VALID_UPDATE: AgentCollaborationModeUpdatePayload = {
  threadId: 'thread-1',
  mode: 'plan',
  model: 'gpt-5.5',
  defaultReasoningEffort: 'max',
  planReasoningEffort: 'xhigh',
  requestVersion: 7,
}

describe('registerAgentIpc collaboration mode handlers', () => {
  let manager: ReturnType<typeof makeManager>

  beforeEach(() => {
    ;(ipcMain as unknown as { __reset: () => void }).__reset()
    manager = makeManager()
    registerAgentIpc(
      () =>
        Promise.resolve(
          manager as unknown as Awaited<ReturnType<Parameters<typeof registerAgentIpc>[0]>>,
        ),
      () => router as unknown as ReturnType<Parameters<typeof registerAgentIpc>[1]>,
    )
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('registers capabilities and forwards the model with the exact result envelope', async () => {
    const expected: AgentCollaborationCapabilitiesResult = {
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['low', 'medium', 'high', 'xhigh'],
        source: 'codex',
      },
    }
    manager.getCollaborationCapabilitiesRpc.mockResolvedValue(expected)

    const handler = getHandler('agent:collaboration-capabilities')
    expect(handler).toBeTypeOf('function')
    const result = await handler!({}, 'gpt-5.5')

    expect(manager.getCollaborationCapabilitiesRpc).toHaveBeenCalledWith('gpt-5.5')
    expect(result).toBe(expected)
  })

  it.each([undefined, null, 42, '', '   '])(
    'rejects invalid capabilities model %j without calling the manager',
    async (model) => {
      const result = await getHandler('agent:collaboration-capabilities')!({}, model)

      expect(result).toEqual({
        ok: false,
        error: expect.stringMatching(/model.*non-empty string/i),
      })
      expect(manager.getCollaborationCapabilitiesRpc).not.toHaveBeenCalled()
    },
  )

  it('registers update and forwards the validated payload with the exact result envelope', async () => {
    const expected: AgentCollaborationModeUpdateResult = {
      ok: true,
      data: { compatibility: 'immediate', requestVersion: 7 },
    }
    manager.updateCollaborationModeRpc.mockResolvedValue(expected)

    const handler = getHandler('agent:collaboration-update')
    expect(handler).toBeTypeOf('function')
    const result = await handler!({}, VALID_UPDATE)

    expect(manager.updateCollaborationModeRpc).toHaveBeenCalledWith(VALID_UPDATE)
    expect(result).toBe(expected)
  })

  it.each([
    ['payload', null, 0],
    ['payload', [], 0],
    ['threadId', { ...VALID_UPDATE, threadId: '  ' }, 7],
    ['model', { ...VALID_UPDATE, model: '' }, 7],
    ['mode', { ...VALID_UPDATE, mode: 'chat' }, 7],
    ['planReasoningEffort', { ...VALID_UPDATE, planReasoningEffort: 'ultra' }, 7],
    ['defaultReasoningEffort', { ...VALID_UPDATE, defaultReasoningEffort: 'auto' }, 7],
    ['defaultReasoningEffort', { ...VALID_UPDATE, defaultReasoningEffort: 'ultra' }, 7],
    ['defaultReasoningEffort', { ...VALID_UPDATE, defaultReasoningEffort: 'future-level' }, 7],
    ['defaultReasoningEffort', { ...VALID_UPDATE, defaultReasoningEffort: 1 }, 7],
    ['requestVersion', { ...VALID_UPDATE, requestVersion: Number.POSITIVE_INFINITY }, 0],
    ['requestVersion', { ...VALID_UPDATE, requestVersion: -1 }, 0],
    ['requestVersion', { ...VALID_UPDATE, requestVersion: 1.5 }, 1.5],
  ])(
    'returns a normal error envelope for invalid %s',
    async (field, payload, expectedRequestVersion) => {
      const result = await getHandler('agent:collaboration-update')!({}, payload)

      expect(result).toEqual({
        ok: false,
        error: expect.stringMatching(new RegExp(field, 'i')),
        requestVersion: expectedRequestVersion,
      })
      expect(manager.updateCollaborationModeRpc).not.toHaveBeenCalled()
    },
  )

  it.each(['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'accepts planReasoningEffort %s',
    async (planReasoningEffort) => {
      const payload = { ...VALID_UPDATE, planReasoningEffort }
      const expected: AgentCollaborationModeUpdateResult = {
        ok: true,
        data: { compatibility: 'next-turn', requestVersion: 7 },
      }
      manager.updateCollaborationModeRpc.mockResolvedValue(expected)

      const result = await getHandler('agent:collaboration-update')!({}, payload)

      expect(manager.updateCollaborationModeRpc).toHaveBeenCalledWith(payload)
      expect(result).toBe(expected)
    },
  )

  it('allows defaultReasoningEffort to be omitted', async () => {
    const { defaultReasoningEffort: _omitted, ...payload } = VALID_UPDATE
    const expected: AgentCollaborationModeUpdateResult = {
      ok: true,
      data: { compatibility: 'immediate', requestVersion: 7 },
    }
    manager.updateCollaborationModeRpc.mockResolvedValue(expected)

    const result = await getHandler('agent:collaboration-update')!({}, payload)

    expect(manager.updateCollaborationModeRpc).toHaveBeenCalledWith(payload)
    expect(result).toBe(expected)
  })
})
