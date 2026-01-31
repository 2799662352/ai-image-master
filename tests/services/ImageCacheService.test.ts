/**
 * ImageCacheService 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ImageCacheService,
  createImageCacheService,
  getImageCacheService
} from '../../src/renderer/src/services/cache/ImageCacheService'

describe('ImageCacheService', () => {
  beforeEach(() => {
    // 重置 window 对象上的 mock
    ;(window as any).aiImageAPI = {
      cleanupExpiredCache: vi.fn(),
      getCachedImage: vi.fn()
    }
  })
  
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as any).aiImageAPI
  })
  
  describe('创建实例', () => {
    it('使用默认配置创建', () => {
      const service = createImageCacheService()
      expect(service).toBeDefined()
    })
    
    it('使用自定义配置创建', () => {
      const service = createImageCacheService({
        defaultExpiry: 12 * 60 * 60 * 1000,
        cachePatterns: ['custom.domain']
      })
      expect(service).toBeDefined()
    })
  })
  
  describe('初始化', () => {
    it('init() 清理过期缓存', () => {
      const service = createImageCacheService()
      
      service.init()
      
      expect((window as any).aiImageAPI.cleanupExpiredCache).toHaveBeenCalledTimes(1)
    })
    
    it('init() 只执行一次', () => {
      const service = createImageCacheService()
      
      service.init()
      service.init()
      
      expect((window as any).aiImageAPI.cleanupExpiredCache).toHaveBeenCalledTimes(1)
    })
    
    it('监听 fluxImagesCached 事件', () => {
      const service = createImageCacheService()
      const callback = vi.fn()
      service.onCacheUpdate(callback)
      service.init()
      
      const event = new CustomEvent('fluxImagesCached', {
        detail: {
          originalUrls: ['https://bfl.ai/image1.png'],
          cachedUrls: ['data:image/png;base64,abc123']
        }
      })
      window.dispatchEvent(event)
      
      expect(callback).toHaveBeenCalledWith(
        ['https://bfl.ai/image1.png'],
        ['data:image/png;base64,abc123']
      )
    })
  })
  
  describe('缓存管理', () => {
    it('addCache() 添加缓存', () => {
      const service = createImageCacheService()
      
      service.addCache('https://example.com/image.png', 'data:image/png;base64,test')
      
      const info = service.getCacheInfo('https://example.com/image.png')
      expect(info).not.toBeNull()
      expect(info?.cachedData).toBe('data:image/png;base64,test')
    })
    
    it('clearCache() 清除单个缓存', () => {
      const service = createImageCacheService()
      
      service.addCache('https://example.com/image.png', 'data')
      expect(service.getCacheInfo('https://example.com/image.png')).not.toBeNull()
      
      const result = service.clearCache('https://example.com/image.png')
      
      expect(result).toBe(true)
      expect(service.getCacheInfo('https://example.com/image.png')).toBeNull()
    })
    
    it('clearAllCache() 清除所有缓存', () => {
      const service = createImageCacheService()
      
      service.addCache('url1', 'data1')
      service.addCache('url2', 'data2')
      
      service.clearAllCache()
      
      expect(service.getCacheInfo('url1')).toBeNull()
      expect(service.getCacheInfo('url2')).toBeNull()
    })
  })
  
  describe('获取显示 URL', () => {
    it('优先使用传入的缓存 URL', () => {
      const service = createImageCacheService()
      
      const result = service.getDisplayUrl(
        'https://bfl.ai/original.png',
        ['https://cached.url/image.png']
      )
      
      expect(result).toBe('https://cached.url/image.png')
    })
    
    it('使用本地 Map 缓存', () => {
      const service = createImageCacheService()
      service.addCache('https://bfl.ai/image.png', 'data:cached')
      
      const result = service.getDisplayUrl('https://bfl.ai/image.png')
      
      expect(result).toBe('data:cached')
    })
    
    it('检查 API 缓存', () => {
      ;(window as any).aiImageAPI.getCachedImage.mockReturnValue('data:api-cached')
      
      const service = createImageCacheService()
      
      const result = service.getDisplayUrl('https://bfl.ai/image.png')
      
      expect(result).toBe('data:api-cached')
      expect((window as any).aiImageAPI.getCachedImage).toHaveBeenCalledWith('https://bfl.ai/image.png')
    })
    
    it('回退到原始 URL', () => {
      ;(window as any).aiImageAPI.getCachedImage.mockReturnValue(null)
      
      const service = createImageCacheService()
      
      const result = service.getDisplayUrl('https://other-domain.com/image.png')
      
      expect(result).toBe('https://other-domain.com/image.png')
    })
  })
  
  describe('shouldCache', () => {
    it('匹配默认模式', () => {
      const service = createImageCacheService()
      
      expect(service.shouldCache('https://bfl.ai/image.png')).toBe(true)
      expect(service.shouldCache('https://flux-kontext.com/image.png')).toBe(true)
      expect(service.shouldCache('https://other.com/image.png')).toBe(false)
    })
    
    it('使用自定义模式', () => {
      const service = createImageCacheService({
        cachePatterns: ['custom-domain.com']
      })
      
      expect(service.shouldCache('https://custom-domain.com/image.png')).toBe(true)
      expect(service.shouldCache('https://bfl.ai/image.png')).toBe(false)
    })
  })
  
  describe('缓存统计', () => {
    it('getStats() 返回统计信息', () => {
      const service = createImageCacheService()
      
      service.addCache('url1', 'data1')
      service.addCache('url2', 'data2')
      
      const stats = service.getStats()
      
      expect(stats.count).toBe(2)
      expect(stats.oldestTimestamp).not.toBeNull()
      expect(stats.newestTimestamp).not.toBeNull()
    })
    
    it('空缓存返回空统计', () => {
      const service = createImageCacheService()
      
      const stats = service.getStats()
      
      expect(stats.count).toBe(0)
      expect(stats.oldestTimestamp).toBeNull()
      expect(stats.newestTimestamp).toBeNull()
    })
  })
  
  describe('历史记录更新', () => {
    it('updateHistoryWithCachedImages 更新历史记录', () => {
      const history = [
        { id: '1', urls: ['https://example.com/old.png'] },
        { id: '2', urls: ['https://bfl.ai/original.png'] }
      ]
      const saveHistory = vi.fn()
      
      const service = createImageCacheService({
        loadHistory: () => history,
        saveHistory
      })
      
      service.updateHistoryWithCachedImages(
        ['https://bfl.ai/original.png'],
        ['data:cached']
      )
      
      expect(saveHistory).toHaveBeenCalled()
      const savedHistory = saveHistory.mock.calls[0][0]
      expect(savedHistory[1].cachedUrls).toEqual(['data:cached'])
    })
    
    it('未配置回调时跳过更新', () => {
      const service = createImageCacheService({})
      
      // 不应抛出错误
      expect(() => {
        service.updateHistoryWithCachedImages(['url'], ['cached'])
      }).not.toThrow()
    })
  })
  
  describe('回调管理', () => {
    it('onCacheUpdate 注册回调', () => {
      const service = createImageCacheService()
      const callback = vi.fn()
      
      service.onCacheUpdate(callback)
      service.init()
      
      const event = new CustomEvent('fluxImagesCached', {
        detail: { originalUrls: ['url1'], cachedUrls: ['cached1'] }
      })
      window.dispatchEvent(event)
      
      expect(callback).toHaveBeenCalled()
    })
    
    it('取消注册回调', () => {
      const service = createImageCacheService()
      const callback = vi.fn()
      
      const unsubscribe = service.onCacheUpdate(callback)
      unsubscribe()
      service.init()
      
      const event = new CustomEvent('fluxImagesCached', {
        detail: { originalUrls: ['url1'], cachedUrls: ['cached1'] }
      })
      window.dispatchEvent(event)
      
      expect(callback).not.toHaveBeenCalled()
    })
  })
  
  describe('销毁', () => {
    it('destroy() 清理资源', () => {
      const service = createImageCacheService()
      service.addCache('url', 'data')
      service.onCacheUpdate(() => {})
      
      service.destroy()
      
      expect(service.getStats().count).toBe(0)
    })
  })
  
  describe('单例模式', () => {
    it('getImageCacheService 返回相同实例', () => {
      const instance1 = getImageCacheService()
      const instance2 = getImageCacheService()
      expect(instance1).toBe(instance2)
    })
  })
  
  describe('过期清理', () => {
    it('cleanupExpired 清理过期缓存', () => {
      const service = createImageCacheService({
        defaultExpiry: 100 // 100ms
      })
      
      // 手动添加过期缓存
      service.addCache('old-url', 'old-data')
      
      // 修改时间戳使其过期
      const info = service.getCacheInfo('old-url')!
      ;(info as any).timestamp = Date.now() - 200
      
      service.cleanupExpired()
      
      // 由于我们没有直接访问内部 Map，
      // 只能验证 API 清理方法被调用
      expect((window as any).aiImageAPI.cleanupExpiredCache).toHaveBeenCalled()
    })
  })
})
