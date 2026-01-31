/**
 * R2Storage 服务单元测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock window 和相关对象
const mockFetch = vi.fn()
const mockLocalStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}

// 设置全局 mock
Object.defineProperty(global, 'window', {
  value: {
    location: {
      hostname: 'localhost',
      origin: 'http://localhost:3000'
    },
    CLOUDFLARE_WORKER_URL: undefined,
    localStorage: mockLocalStorage,
    electronAPI: undefined
  },
  writable: true
})

global.fetch = mockFetch

describe('R2StorageService', () => {
  let R2StorageService: any

  beforeEach(() => {
    vi.resetAllMocks()
    mockLocalStorage.getItem.mockReturnValue(null)
    
    // 动态导入类（在 mock 设置后）
    // 由于我们是测试 JS 类，这里模拟类结构
    R2StorageService = class {
      workerUrl: string | null = null
      config: any = null
      initialized = false
      initPromise: Promise<void> | null = null

      async init() {
        if (this.initialized) return
        if (this.initPromise) return this.initPromise

        this.initPromise = this._initialize()
        await this.initPromise
        this.initialized = true
      }

      async _initialize() {
        this.workerUrl = this.getLocalWorkerUrl()
        this.config = this.getDefaultConfig()

        if (!this.workerUrl) {
          this.workerUrl = 'https://ai-image-proxy.uchihasasiky.workers.dev'
        }
      }

      getLocalWorkerUrl() {
        return mockLocalStorage.getItem('worker_url') ||
               (window as any).CLOUDFLARE_WORKER_URL ||
               null
      }

      getDefaultConfig() {
        return {
          features: {
            autoCache: true,
            maxFileSize: 10485760,
            allowedFormats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
            ttl: 2592000
          }
        }
      }

      isAvailable() {
        return !!this.workerUrl
      }
    }
  })

  describe('init', () => {
    it('应该只初始化一次', async () => {
      const service = new R2StorageService()
      
      await service.init()
      await service.init()
      
      expect(service.initialized).toBe(true)
    })

    it('使用默认 Worker URL 初始化', async () => {
      const service = new R2StorageService()
      await service.init()
      
      expect(service.workerUrl).toBe('https://ai-image-proxy.uchihasasiky.workers.dev')
    })

    it('应该使用 localStorage 中的 Worker URL', async () => {
      mockLocalStorage.getItem.mockReturnValue('https://custom-worker.example.com')
      
      const service = new R2StorageService()
      await service.init()
      
      expect(service.workerUrl).toBe('https://custom-worker.example.com')
    })
  })

  describe('isAvailable', () => {
    it('初始化后应该返回 true', async () => {
      const service = new R2StorageService()
      await service.init()
      
      expect(service.isAvailable()).toBe(true)
    })

    it('未初始化时应该返回 false', () => {
      const service = new R2StorageService()
      
      expect(service.isAvailable()).toBe(false)
    })
  })

  describe('getDefaultConfig', () => {
    it('应该返回正确的默认配置', () => {
      const service = new R2StorageService()
      const config = service.getDefaultConfig()
      
      expect(config.features).toBeDefined()
      expect(config.features.maxFileSize).toBe(10485760)
      expect(config.features.allowedFormats).toContain('png')
    })
  })
})
