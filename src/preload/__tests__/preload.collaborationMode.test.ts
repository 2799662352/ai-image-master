import type {
  AgentCollaborationCapabilitiesResult,
  AgentCollaborationModeUpdatePayload,
  AgentCollaborationModeUpdateResult,
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

describe('preload collaboration mode API', () => {
  beforeEach(() => {
    electronMocks.invoke.mockReset()
  })

  it('invokes the collaboration capabilities channel with the model', async () => {
    const expected: AgentCollaborationCapabilitiesResult = {
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['low', 'medium', 'high', 'xhigh'],
        source: 'codex',
      },
    }
    electronMocks.invoke.mockResolvedValueOnce(expected)

    const result = await getExposedApi().agent.getCollaborationCapabilities('gpt-5.5')

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      'agent:collaboration-capabilities',
      'gpt-5.5',
    )
    expect(result).toBe(expected)
  })

  it('invokes the collaboration update channel with the exact payload', async () => {
    const payload: AgentCollaborationModeUpdatePayload = {
      threadId: 'thread-1',
      mode: 'plan',
      model: 'gpt-5.5',
      defaultReasoningEffort: 'high',
      planReasoningEffort: 'auto',
      requestVersion: 9,
    }
    const expected: AgentCollaborationModeUpdateResult = {
      ok: true,
      data: { compatibility: 'immediate', requestVersion: 9 },
    }
    electronMocks.invoke.mockResolvedValueOnce(expected)

    const result = await getExposedApi().agent.updateCollaborationMode(payload)

    expect(electronMocks.invoke).toHaveBeenCalledWith('agent:collaboration-update', payload)
    expect(result).toBe(expected)
  })
})
