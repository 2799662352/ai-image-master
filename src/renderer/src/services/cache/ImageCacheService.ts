/**
 * ImageCacheService - 图片缓存服务
 * 
 * 负责 Flux 图片的缓存管理，包括：
 * - 过期缓存清理
 * - 历史记录缓存映射更新
 * - 缓存 URL 获取
 */

export interface CachedImageInfo {
  /** 原始 URL */
  originalUrl: string
  /** 缓存 URL 或 Base64 数据 */
  cachedData: string
  /** 缓存时间戳 */
  timestamp: number
  /** 过期时间 (ms) */
  expiresIn?: number
}

export interface HistoryRecord {
  id: string
  urls?: string[]
  cachedUrls?: string[]
  cacheTimestamp?: number
}

export interface ImageCacheConfig {
  /** 缓存过期时间 (ms)，默认 24 小时 */
  defaultExpiry?: number
  /** 需要缓存的 URL 模式 */
  cachePatterns?: string[]
  /**
   * 本地 Map 软上限 — 防止长时间生图后 Map 无界增长 (此前只靠 TTL,
   * 在单次会话内仍然可以累积几千条占内存)。默认 500 条, 满了就 FIFO
   * 丢最老的(Map 自身按插入顺序保留 key)。
   */
  maxEntries?: number
  /** API 实例引用 */
  apiInstance?: {
    cleanupExpiredCache?: () => void
    getCachedImage?: (url: string) => string | null
  }
  /** 加载历史记录回调 */
  loadHistory?: () => HistoryRecord[]
  /** 保存历史记录回调 */
  saveHistory?: (history: HistoryRecord[]) => void
  /** 刷新历史显示回调 */
  refreshHistoryDisplay?: () => void
  /** 获取当前 Tab */
  getCurrentTab?: () => string
}

type CacheUpdateCallback = (originalUrls: string[], cachedUrls: string[]) => void

const DEFAULT_CONFIG: Required<Omit<ImageCacheConfig, 'apiInstance' | 'loadHistory' | 'saveHistory' | 'refreshHistoryDisplay' | 'getCurrentTab'>> = {
  defaultExpiry: 24 * 60 * 60 * 1000, // 24 hours
  cachePatterns: ['bfl.ai', 'flux-kontext'],
  maxEntries: 500
}

/**
 * ImageCacheService 类
 */
export class ImageCacheService {
  private config: ImageCacheConfig
  private localCache: Map<string, CachedImageInfo> = new Map()
  private updateCallbacks: CacheUpdateCallback[] = []
  private initialized = false

  // 监听器必须挂在 this 上 — 此前 init() 里写匿名箭头函数,
  // destroy() 没办法 removeEventListener('fluxImagesCached', sameRef),
  // 导致整个 service 实例被 window 持有, 永远不会 GC。
  private readonly boundHandleCachedEvent: EventListener

  constructor(config: ImageCacheConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.boundHandleCachedEvent = ((event: CustomEvent<{
      originalUrls: string[]
      cachedUrls: string[]
    }>) => {
      const { originalUrls, cachedUrls } = event.detail
      console.log('[ImageCacheService] 收到图片缓存完成事件', { originalUrls, cachedUrls })
      this.addToLocalCache(originalUrls, cachedUrls)
      this.updateHistoryWithCachedImages(originalUrls, cachedUrls)
      this.notifyUpdate(originalUrls, cachedUrls)
    }) as EventListener
  }

  /**
   * 初始化缓存服务
   */
  init(): void {
    if (this.initialized) return

    console.log('[ImageCacheService] 初始化图片缓存服务...')

    // 清理过期缓存
    this.cleanupExpired()

    // 监听缓存完成事件 — 用 constructor 里 bind 好的同一引用,
    // destroy 才能用同一引用 removeEventListener。
    window.addEventListener('fluxImagesCached', this.boundHandleCachedEvent)

    this.initialized = true
    console.log('[ImageCacheService] 初始化完成')
  }
  
  /**
   * 注册缓存更新回调
   */
  onCacheUpdate(callback: CacheUpdateCallback): () => void {
    this.updateCallbacks.push(callback)
    return () => {
      const index = this.updateCallbacks.indexOf(callback)
      if (index > -1) {
        this.updateCallbacks.splice(index, 1)
      }
    }
  }
  
  /**
   * 清理过期缓存
   */
  cleanupExpired(): void {
    const api = this.config.apiInstance || (window as any).aiImageAPI
    
    if (api?.cleanupExpiredCache) {
      api.cleanupExpiredCache()
      console.log('[ImageCacheService] 已清理过期缓存')
    }
    
    // 清理本地 Map 缓存
    const now = Date.now()
    const expiry = this.config.defaultExpiry || DEFAULT_CONFIG.defaultExpiry
    
    for (const [key, info] of this.localCache.entries()) {
      const itemExpiry = info.expiresIn || expiry
      if (now - info.timestamp > itemExpiry) {
        this.localCache.delete(key)
      }
    }
  }
  
  /**
   * 添加到本地缓存。每次插入后调用 trimCache 控制软上限,
   * 这是和此前最大的差别 — 没有这个 trim, Map 会无界增长。
   */
  private addToLocalCache(originalUrls: string[], cachedUrls: string[]): void {
    const now = Date.now()

    originalUrls.forEach((url, index) => {
      if (cachedUrls[index]) {
        // 如果 key 已存在, 先 delete 再 set, 让它移到 Map 的"最新"位置;
        // Map 按插入顺序遍历, 这样 trimCache 的 FIFO 才是 LRU 而不是 FIFO。
        if (this.localCache.has(url)) this.localCache.delete(url)
        this.localCache.set(url, {
          originalUrl: url,
          cachedData: cachedUrls[index],
          timestamp: now
        })
      }
    })

    this.trimCache()
  }

  /**
   * 把 localCache 砍到不超过 maxEntries 条, 多余的从最老开始丢。
   * Map 的迭代顺序就是插入顺序, 配合 addToLocalCache 的 delete-then-set
   * 实现近似 LRU 语义(新写入的一定在尾部, 老的在头部)。
   */
  private trimCache(): void {
    const max = this.config.maxEntries ?? DEFAULT_CONFIG.maxEntries
    while (this.localCache.size > max) {
      const oldestKey = this.localCache.keys().next().value
      if (oldestKey === undefined) break
      this.localCache.delete(oldestKey)
    }
  }
  
  /**
   * 更新历史记录中的缓存图片映射
   */
  updateHistoryWithCachedImages(originalUrls: string[], cachedUrls: string[]): void {
    try {
      const loadHistory = this.config.loadHistory
      const saveHistory = this.config.saveHistory
      
      if (!loadHistory || !saveHistory) {
        console.log('[ImageCacheService] 未配置历史记录回调，跳过更新')
        return
      }
      
      const history = loadHistory()
      if (!Array.isArray(history)) return
      
      let updated = false
      
      // 从最新记录开始遍历
      for (let i = history.length - 1; i >= 0; i--) {
        const record = history[i]
        if (record.urls && Array.isArray(record.urls)) {
          // 检查是否有匹配的 URL
          const hasMatching = record.urls.some(url => originalUrls.includes(url))
          if (hasMatching) {
            // 添加缓存信息
            record.cachedUrls = cachedUrls
            record.cacheTimestamp = Date.now()
            updated = true
            console.log('[ImageCacheService] 更新历史记录缓存信息:', record.id)
            break // 只更新最新的匹配记录
          }
        }
      }
      
      if (updated) {
        saveHistory(history)
        
        // 如果当前在历史页面，刷新显示
        const currentTab = this.config.getCurrentTab?.()
        if (currentTab === 'history') {
          this.config.refreshHistoryDisplay?.()
        }
      }
    } catch (error) {
      console.warn('[ImageCacheService] 更新历史记录缓存失败:', error)
    }
  }
  
  /**
   * 获取图片显示 URL（优先使用缓存）
   */
  getDisplayUrl(originalUrl: string, cachedUrls?: string[]): string {
    // 1. 如果有传入的缓存 URL 列表，优先使用
    if (cachedUrls && cachedUrls.length > 0) {
      return cachedUrls[0]
    }
    
    // 2. 检查本地 Map 缓存
    const localCached = this.localCache.get(originalUrl)
    if (localCached) {
      return localCached.cachedData
    }
    
    // 3. 如果是需要缓存的 URL 模式，检查 API 缓存
    if (this.shouldCache(originalUrl)) {
      const api = this.config.apiInstance || (window as any).aiImageAPI
      const cachedData = api?.getCachedImage?.(originalUrl)
      if (cachedData) {
        return cachedData
      }
    }
    
    // 4. 回退到原始 URL
    return originalUrl
  }
  
  /**
   * 判断 URL 是否需要缓存
   */
  shouldCache(url: string): boolean {
    const patterns = this.config.cachePatterns || DEFAULT_CONFIG.cachePatterns
    return patterns.some(pattern => url.includes(pattern))
  }
  
  /**
   * 手动添加缓存
   */
  addCache(originalUrl: string, cachedData: string, expiresIn?: number): void {
    if (this.localCache.has(originalUrl)) this.localCache.delete(originalUrl)
    this.localCache.set(originalUrl, {
      originalUrl,
      cachedData,
      timestamp: Date.now(),
      expiresIn
    })
    this.trimCache()
  }
  
  /**
   * 获取缓存信息
   */
  getCacheInfo(originalUrl: string): CachedImageInfo | null {
    return this.localCache.get(originalUrl) || null
  }
  
  /**
   * 清除指定 URL 的缓存
   */
  clearCache(originalUrl: string): boolean {
    return this.localCache.delete(originalUrl)
  }
  
  /**
   * 清除所有缓存
   */
  clearAllCache(): void {
    this.localCache.clear()
    console.log('[ImageCacheService] 已清除所有本地缓存')
  }
  
  /**
   * 获取缓存统计
   */
  getStats(): {
    count: number
    oldestTimestamp: number | null
    newestTimestamp: number | null
  } {
    const entries = Array.from(this.localCache.values())
    
    if (entries.length === 0) {
      return { count: 0, oldestTimestamp: null, newestTimestamp: null }
    }
    
    const timestamps = entries.map(e => e.timestamp)
    
    return {
      count: entries.length,
      oldestTimestamp: Math.min(...timestamps),
      newestTimestamp: Math.max(...timestamps)
    }
  }
  
  /**
   * 通知缓存更新
   */
  private notifyUpdate(originalUrls: string[], cachedUrls: string[]): void {
    for (const callback of this.updateCallbacks) {
      try {
        callback(originalUrls, cachedUrls)
      } catch (error) {
        console.warn('[ImageCacheService] 缓存更新回调失败:', error)
      }
    }
  }
  
  /**
   * 销毁服务 — 必须先把 window 上的监听摘掉, 否则 service 实例被
   * window 持有, 永远无法 GC; 监听器闭包里又持有 this, 形成保留链。
   */
  destroy(): void {
    if (this.initialized) {
      window.removeEventListener('fluxImagesCached', this.boundHandleCachedEvent)
    }
    this.localCache.clear()
    this.updateCallbacks = []
    this.initialized = false
  }
}

// 单例实例
let imageCacheServiceInstance: ImageCacheService | null = null

/**
 * 获取 ImageCacheService 单例
 */
export function getImageCacheService(config?: ImageCacheConfig): ImageCacheService {
  if (!imageCacheServiceInstance) {
    imageCacheServiceInstance = new ImageCacheService(config)
  }
  return imageCacheServiceInstance
}

/**
 * 创建新的 ImageCacheService 实例 (仅用于测试)
 */
export function createImageCacheService(config?: ImageCacheConfig): ImageCacheService {
  imageCacheServiceInstance = new ImageCacheService(config)
  return imageCacheServiceInstance
}
