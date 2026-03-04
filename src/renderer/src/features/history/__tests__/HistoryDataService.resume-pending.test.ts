import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHistoryDataService } from '../HistoryDataService'
import { getStorageBridge, resetStorageBridge } from '../../../services/storage'
import { getR2StorageService, resetR2StorageService } from '../../../services/r2-storage'

describe('HistoryDataService resume pending uploads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStorageBridge()
    resetR2StorageService()
    ;(window as any).electronAPI = {
      isElectron: true,
      saveHistory: vi.fn().mockResolvedValue({ success: true }),
      loadHistory: vi.fn().mockResolvedValue([]),
      getStorageInfo: vi.fn().mockResolvedValue({ storagePath: '/tmp' }),
      saveImage: vi.fn().mockResolvedValue({ success: true, path: '/tmp/a.png' })
    }
  })

  it('resumes pending uploads during init', async () => {
    const base64Url = 'data:image/png;base64,test'
    const storageBridge = getStorageBridge()
    vi.spyOn(storageBridge, 'loadHistory').mockResolvedValue([
      {
        id: 42,
        type: 'generate',
        prompt: 'resume pending',
        urls: ['pending:42'],
        originalUrls: [base64Url],
        uploading: true,
        timestamp: new Date().toISOString()
      } as any
    ])
    vi.spyOn(storageBridge, 'saveHistory').mockResolvedValue({ success: true } as any)

    const r2Storage = getR2StorageService()
    vi.spyOn(r2Storage, 'init').mockResolvedValue()
    vi.spyOn(r2Storage, 'isAvailable').mockReturnValue(true)
    const batchProcessSpy = vi.spyOn(r2Storage, 'batchProcess').mockResolvedValue([
      'https://r2.example.com/img.png'
    ])

    const service = createHistoryDataService({ autoMigrateThreshold: 0 })
    await service.init()
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(batchProcessSpy).toHaveBeenCalledWith([base64Url])
  })
})
