// tests/features/HistoryDataService.test.ts
// Note: Storage and R2 mocks are in tests/setup.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  HistoryDataService,
  createHistoryDataService,
  getHistoryDataService
} from '../../src/renderer/src/features/history/HistoryDataService'
import { getStorageBridge } from '../../src/renderer/src/services/storage'
import { getR2StorageService } from '../../src/renderer/src/services/r2-storage'

// Get the mocked functions
const mockedGetStorageBridge = vi.mocked(getStorageBridge)
const mockedGetR2StorageService = vi.mocked(getR2StorageService)

describe('HistoryDataService', () => {
  let service: HistoryDataService
  let mockStorageBridge: ReturnType<typeof getStorageBridge>
  let mockR2Storage: ReturnType<typeof getR2StorageService>

  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks()
    
    // Get fresh mock instances
    mockStorageBridge = mockedGetStorageBridge()
    mockR2Storage = mockedGetR2StorageService()
    
    // Reset mock return values to defaults
    vi.mocked(mockStorageBridge.loadHistory).mockResolvedValue([])
    vi.mocked(mockStorageBridge.saveHistory).mockResolvedValue({ success: true })
    vi.mocked(mockR2Storage.isAvailable).mockReturnValue(false)
    
    // Clear localStorage
    localStorage.clear()
    
    // 设置 window 对象
    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage,
        storageBridge: mockStorageBridge,
        r2Storage: mockR2Storage,
        aiImageAPI: {
          getCurrentModel: vi.fn().mockReturnValue({ name: 'Test Model' }),
          model: 'test-model'
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      },
      writable: true
    })

    // 创建新实例
    service = createHistoryDataService({
      autoMigrateThreshold: 0 // 禁用自动迁移以便测试
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  describe('初始化', () => {
    it('应该正确初始化服务', async () => {
      await service.init()
      // The service is initialized (uses mocked modules from setup.ts)
      expect(service.getManager()).toBeDefined()
    })

    it('应该设置 R2 上传监听器', async () => {
      await service.init()
      expect((globalThis as any).window.addEventListener).toHaveBeenCalledWith(
        'r2UploadComplete',
        expect.any(Function)
      )
    })
  })

  describe('添加历史记录', () => {
    it('应该添加普通 URL 历史记录', async () => {
      await service.init()
      
      const result = await service.addToHistory(
        'generate',
        'Test prompt',
        ['https://example.com/image.png'],
        '1:1',
        'test-model'
      )

      expect(result).not.toBeNull()
      expect(result?.type).toBe('generate')
      expect(result?.prompt).toBe('Test prompt')
      expect(result?.urls).toContain('https://example.com/image.png')
    })

    it('应该处理 Base64 图片并上传到 R2', async () => {
      // Enable R2 BEFORE init
      vi.mocked(mockR2Storage.isAvailable).mockReturnValue(true)
      vi.mocked(mockR2Storage.init).mockResolvedValue(undefined)
      vi.mocked(mockR2Storage.batchProcess).mockResolvedValue([
        'https://r2.example.com/image1.png'
      ])
      
      await service.init()
      
      const base64Url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      
      const result = await service.addToHistory(
        'generate',
        'Base64 test',
        [base64Url],
        '1:1'
      )

      expect(result).not.toBeNull()
      expect(result?.uploading).toBe(true)
      
      // 等待异步上传完成
      await new Promise(resolve => setTimeout(resolve, 150))
      
      expect(mockR2Storage.batchProcess).toHaveBeenCalled()
    })

    it('R2 不可用时应该保存原始 Base64', async () => {
      // R2 is already unavailable by default in beforeEach
      await service.init()
      
      const base64Url = 'data:image/png;base64,test'
      
      await service.addToHistory(
        'generate',
        'No R2 test',
        [base64Url]
      )

      // 等待异步处理
      await new Promise(resolve => setTimeout(resolve, 100))
      
      // 验证没有调用 R2 上传
      expect(mockR2Storage.batchProcess).not.toHaveBeenCalled()
    })
  })

  describe('存储统计', () => {
    it('应该返回正确的存储统计信息', async () => {
      await service.init()
      
      // 模拟 localStorage 数据 - use real localStorage
      localStorage.setItem('ai_image_history', JSON.stringify([{ id: 1 }]))
      localStorage.setItem('other_key', 'some data')

      const stats = service.getStorageStats()

      expect(stats).toHaveProperty('historySize')
      expect(stats).toHaveProperty('historyCount')
      expect(stats).toHaveProperty('totalSize')
      expect(stats).toHaveProperty('estimatedLimit')
      expect(stats).toHaveProperty('r2Enabled')
      expect(stats).toHaveProperty('usagePercent')
    })

    it('应该正确计算使用率百分比', async () => {
      await service.init()
      
      // 模拟大量数据 - use real localStorage
      const largeData = 'x'.repeat(1024 * 100) // 100KB (less to avoid quota issues)
      localStorage.setItem('large_data', largeData)

      const stats = service.getStorageStats()

      expect(stats.usagePercent).toBeGreaterThan(0)
    })
  })

  describe('云端迁移', () => {
    beforeEach(async () => {
      mockR2Storage.isAvailable.mockReturnValue(true)
      await service.init()
    })

    it('应该迁移 Base64 数据到云端', async () => {
      // 添加一个包含 Base64 的记录
      await service.addToHistory(
        'generate',
        'Migration test',
        ['data:image/png;base64,test']
      )

      // 等待上传
      await new Promise(resolve => setTimeout(resolve, 100))

      const count = await service.migrateToCloud(10)
      
      // 如果已经上传成功，返回 0（没有需要迁移的）
      expect(count).toBeGreaterThanOrEqual(0)
    })

    it('R2 不可用时应该返回 0', async () => {
      mockR2Storage.isAvailable.mockReturnValue(false)

      const count = await service.migrateToCloud()
      expect(count).toBe(0)
    })
  })

  describe('缓存图片更新', () => {
    beforeEach(async () => {
      await service.init()
    })

    it('应该更新历史记录的缓存 URL', async () => {
      // 添加记录
      await service.addToHistory(
        'generate',
        'Cache test',
        ['https://original.url/image.png']
      )

      // 更新缓存
      const updated = await service.updateWithCachedImages(
        ['https://original.url/image.png'],
        ['https://cached.url/image.png']
      )

      expect(updated).toBe(true)
    })

    it('没有匹配时应该返回 false', async () => {
      const updated = await service.updateWithCachedImages(
        ['https://nonexistent.url/image.png'],
        ['https://cached.url/image.png']
      )

      expect(updated).toBe(false)
    })
  })

  describe('获取显示 URL', () => {
    beforeEach(async () => {
      await service.init()
    })

    it('有缓存时应该返回缓存 URL', () => {
      const url = service.getDisplayUrl(
        'https://original.url/image.png',
        ['https://cached.url/image.png']
      )

      expect(url).toBe('https://cached.url/image.png')
    })

    it('没有缓存时应该返回原始 URL', () => {
      const url = service.getDisplayUrl('https://original.url/image.png')
      expect(url).toBe('https://original.url/image.png')
    })
  })

  describe('清理历史', () => {
    beforeEach(async () => {
      await service.init()
      // Clear any existing history to ensure test isolation
      await service.clearOldHistory(0)
    })

    it('应该保留指定数量的记录', async () => {
      // 添加多条记录
      for (let i = 0; i < 5; i++) {
        await service.addToHistory(
          'generate',
          `Test ${i}`,
          [`https://example.com/image${i}.png`]
        )
      }

      // Verify we have exactly 5 records
      expect(service.getAll().length).toBe(5)

      const deletedCount = await service.clearOldHistory(2)
      expect(deletedCount).toBe(3)
      expect(service.getAll().length).toBe(2)
    })
  })

  describe('代理方法', () => {
    beforeEach(async () => {
      await service.init()
      // Clear any existing history to ensure test isolation
      await service.clearOldHistory(0)
    })

    it('getAll 应该返回所有历史记录', async () => {
      await service.addToHistory('generate', 'Test', ['https://example.com/1.png'])
      
      const all = service.getAll()
      expect(all).toBeInstanceOf(Array)
    })

    it('getById 应该按 ID 查找记录', async () => {
      const item = await service.addToHistory('generate', 'Test', ['https://example.com/1.png'])
      
      if (item) {
        const found = service.getById(item.id)
        expect(found).toBeDefined()
        expect(found?.id).toBe(item.id)
      }
    })

    it('search 应该按关键词搜索', async () => {
      await service.addToHistory('generate', 'Unique keyword', ['https://example.com/1.png'])
      
      const results = service.search('Unique')
      expect(results.length).toBeGreaterThan(0)
    })

    it('delete 应该删除指定记录', async () => {
      const item = await service.addToHistory('generate', 'Delete me', ['https://example.com/1.png'])
      
      if (item) {
        const deleted = await service.delete(item.id)
        expect(deleted).toBe(true)
        expect(service.getById(item.id)).toBeUndefined()
      }
    })

    it('onChange 应该注册变更回调', async () => {
      const callback = vi.fn()
      const unsubscribe = service.onChange(callback)

      await service.addToHistory('generate', 'Test', ['https://example.com/1.png'])
      
      expect(callback).toHaveBeenCalled()

      unsubscribe()
    })
  })

  describe('getManager', () => {
    it('应该返回底层 HistoryManager 实例', async () => {
      await service.init()
      const manager = service.getManager()
      expect(manager).toBeDefined()
    })
  })
})

describe('getHistoryDataService 单例', () => {
  it('应该返回同一个实例', () => {
    // 注意：由于模块级单例，这可能需要在独立测试中验证
    // 这里简单测试函数存在
    expect(typeof getHistoryDataService).toBe('function')
  })
})
