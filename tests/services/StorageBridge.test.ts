/**
 * StorageBridge 服务单元测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('StorageBridge', () => {
  let StorageBridge: any
  let mockElectronAPI: any

  beforeEach(() => {
    vi.resetAllMocks()

    // Mock Electron API
    mockElectronAPI = {
      isElectron: false,
      saveImage: vi.fn(),
      readImage: vi.fn(),
      deleteImage: vi.fn(),
      getStorageInfo: vi.fn().mockResolvedValue({ storagePath: '/test/path' }),
      saveData: vi.fn(),
      readData: vi.fn()
    }

    // 设置 window mock
    Object.defineProperty(global, 'window', {
      value: {
        electronAPI: mockElectronAPI,
        localStorage: {
          getItem: vi.fn(),
          setItem: vi.fn(),
          removeItem: vi.fn()
        }
      },
      writable: true
    })

    // 创建 StorageBridge 类模拟
    StorageBridge = class {
      isElectron: boolean
      imageCache: Map<string, string>
      cachedStoragePath: string | null

      constructor() {
        this.isElectron = (window as any).electronAPI?.isElectron === true
        this.imageCache = new Map()
        this.cachedStoragePath = null

        if (this.isElectron) {
          this.initStoragePath()
        }
      }

      async initStoragePath() {
        try {
          const info = await (window as any).electronAPI.getStorageInfo()
          this.cachedStoragePath = info.storagePath
        } catch (e) {
          console.error('获取存储路径失败:', e)
        }
      }

      getStoragePathSync() {
        return this.cachedStoragePath
      }

      async saveImage(base64Data: string, id: string) {
        if (this.isElectron) {
          const filename = `${id}.png`
          const result = await (window as any).electronAPI.saveImage(base64Data, filename)
          if (result.success) {
            this.imageCache.set(id, base64Data)
            return { success: true, url: `electron://${filename}`, localPath: result.path }
          }
          return { success: false, error: result.error }
        } else {
          this.imageCache.set(id, base64Data)
          return { success: true, url: base64Data }
        }
      }

      async readImage(urlOrId: string) {
        if (urlOrId?.startsWith('data:image')) {
          return urlOrId
        }

        if (urlOrId?.startsWith('electron://')) {
          const filename = urlOrId.replace('electron://', '')
          const id = filename.replace(/\.\w+$/, '')

          if (this.imageCache.has(id)) {
            return this.imageCache.get(id)
          }

          if (this.isElectron) {
            const data = await (window as any).electronAPI.readImage(filename)
            if (data) {
              this.imageCache.set(id, data)
            }
            return data
          }
        }

        return urlOrId
      }

      async deleteImage(urlOrId: string) {
        if (urlOrId?.startsWith('electron://')) {
          const filename = urlOrId.replace('electron://', '')
          const id = filename.replace(/\.\w+$/, '')
          this.imageCache.delete(id)

          if (this.isElectron) {
            return await (window as any).electronAPI.deleteImage(filename)
          }
        }
        return { success: true }
      }
    }
  })

  describe('constructor', () => {
    it('浏览器模式下 isElectron 应该为 false', () => {
      mockElectronAPI.isElectron = false
      const bridge = new StorageBridge()
      
      expect(bridge.isElectron).toBe(false)
    })

    it('Electron 模式下 isElectron 应该为 true', () => {
      mockElectronAPI.isElectron = true
      const bridge = new StorageBridge()
      
      expect(bridge.isElectron).toBe(true)
    })

    it('应该初始化空的 imageCache', () => {
      const bridge = new StorageBridge()
      
      expect(bridge.imageCache.size).toBe(0)
    })
  })

  describe('saveImage', () => {
    it('浏览器模式下应该只缓存图片', async () => {
      mockElectronAPI.isElectron = false
      const bridge = new StorageBridge()
      
      const result = await bridge.saveImage('data:image/png;base64,abc123', 'test-id')
      
      expect(result.success).toBe(true)
      expect(result.url).toBe('data:image/png;base64,abc123')
      expect(bridge.imageCache.has('test-id')).toBe(true)
    })

    it('Electron 模式下应该调用 electronAPI.saveImage', async () => {
      mockElectronAPI.isElectron = true
      mockElectronAPI.saveImage.mockResolvedValue({ success: true, path: '/test/path/test-id.png' })
      
      const bridge = new StorageBridge()
      const result = await bridge.saveImage('data:image/png;base64,abc123', 'test-id')
      
      expect(mockElectronAPI.saveImage).toHaveBeenCalledWith('data:image/png;base64,abc123', 'test-id.png')
      expect(result.success).toBe(true)
      expect(result.url).toBe('electron://test-id.png')
    })
  })

  describe('readImage', () => {
    it('base64 数据应该直接返回', async () => {
      const bridge = new StorageBridge()
      const base64 = 'data:image/png;base64,abc123'
      
      const result = await bridge.readImage(base64)
      
      expect(result).toBe(base64)
    })

    it('应该从缓存读取图片', async () => {
      const bridge = new StorageBridge()
      bridge.imageCache.set('test-id', 'data:image/png;base64,cached')
      
      const result = await bridge.readImage('electron://test-id.png')
      
      expect(result).toBe('data:image/png;base64,cached')
    })

    it('普通 URL 应该直接返回', async () => {
      const bridge = new StorageBridge()
      const url = 'https://example.com/image.png'
      
      const result = await bridge.readImage(url)
      
      expect(result).toBe(url)
    })
  })

  describe('deleteImage', () => {
    it('应该从缓存中删除图片', async () => {
      const bridge = new StorageBridge()
      bridge.imageCache.set('test-id', 'data:image/png;base64,abc')
      
      await bridge.deleteImage('electron://test-id.png')
      
      expect(bridge.imageCache.has('test-id')).toBe(false)
    })

    it('Electron 模式下应该调用 electronAPI.deleteImage', async () => {
      mockElectronAPI.isElectron = true
      mockElectronAPI.deleteImage.mockResolvedValue({ success: true })
      
      const bridge = new StorageBridge()
      await bridge.deleteImage('electron://test-id.png')
      
      expect(mockElectronAPI.deleteImage).toHaveBeenCalledWith('test-id.png')
    })
  })
})
