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

describe('preload 自定义网关通道', () => {
  beforeEach(() => {
    electronMocks.invoke.mockReset()
  })

  it('setCustomGateway 走 agent:set-custom-gateway,载荷原样交给主进程', async () => {
    electronMocks.invoke.mockResolvedValueOnce({ ok: true, changed: true })

    const state = { active: true, url: 'https://gw.example.com' }
    await expect(getExposedApi().agent.setCustomGateway(state)).resolves.toEqual({
      ok: true,
      changed: true,
    })

    expect(electronMocks.invoke).toHaveBeenCalledWith('agent:set-custom-gateway', state)
  })
})
