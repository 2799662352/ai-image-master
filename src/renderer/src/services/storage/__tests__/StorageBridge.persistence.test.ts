import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getStorageBridge, resetStorageBridge } from '../index'

describe('StorageBridge saveHistory persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStorageBridge()
    ;(window as any).electronAPI = {
      isElectron: true,
      saveHistory: vi.fn().mockResolvedValue({ success: true }),
      getStorageInfo: vi.fn().mockResolvedValue({ storagePath: '/tmp' }),
      saveImage: vi.fn().mockResolvedValue({ success: true, path: '/tmp/a.png' })
    }
  })

  it('keeps originalUrls for uploading records', async () => {
    const bridge = getStorageBridge()
    const history = [
      {
        id: 1,
        prompt: 'pending upload',
        urls: ['pending:1'],
        originalUrls: ['data:image/png;base64,test'],
        uploading: true
      }
    ]

    await bridge.saveHistory(history as any)

    const saveHistoryMock = (window as any).electronAPI.saveHistory
    expect(saveHistoryMock).toHaveBeenCalledTimes(1)
    const payload = saveHistoryMock.mock.calls[0][0]
    expect(payload[0].originalUrls).toEqual(['data:image/png;base64,test'])
  })
})
