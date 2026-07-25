// src/renderer/src/features/history/HistoryDataService.ts
/**
 * 历史记录数据服务
 * 处理 R2 云存储集成、Base64 图片处理、存储空间监控
 * 扩展 HistoryManager 的功能
 * V16.3 - 使用直接导入替代 window 全局变量
 */

import { HistoryManager, HistoryItem, HistoryManagerConfig, getHistoryManager } from './HistoryManager'
import { getStorageBridge, StorageBridge } from '../../services/storage'
import { getR2StorageService, R2StorageService } from '../../services/r2-storage'
import { thumbnailRefsForHistory } from '../../utils/imageResources'

export interface StorageStats {
  historySize: string
  historyCount: number
  totalSize: string
  estimatedLimit: number
  r2Enabled: boolean
  storageMode: 'cloud' | 'local'
  usagePercent: number
}

export interface HistoryDataServiceConfig extends Partial<HistoryManagerConfig> {
  autoMigrateThreshold: number // 存储使用率触发自动迁移的阈值 (0-100)
  migrationBatchSize: number // 每次自动迁移的记录数
  migrationDelay: number // 自动迁移延迟时间 (ms)
}

export type UploadProgressCallback = (completed: number, total: number) => void

const DEFAULT_CONFIG: HistoryDataServiceConfig = {
  autoMigrateThreshold: 70,
  migrationBatchSize: 10,
  migrationDelay: 3000
}

export class HistoryDataService {
  private historyManager: HistoryManager
  private config: HistoryDataServiceConfig
  private r2Storage: R2StorageService | null = null
  private storageBridge: StorageBridge | null = null
  private initialized = false

  constructor(config?: Partial<HistoryDataServiceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.historyManager = getHistoryManager(config)
  }

  /**
   * 初始化服务
   * V16.3: 使用直接导入替代 window 全局变量
   */
  async init(): Promise<void> {
    if (this.initialized) return

    // V16.3: 使用直接导入获取服务
    this.storageBridge = getStorageBridge()
    this.r2Storage = getR2StorageService()

    // 初始化底层 HistoryManager
    await this.historyManager.init(this.storageBridge, this.r2Storage)

    // 恢复未完成的上传任务（例如应用重启后）
    this.resumePendingUploads()

    // 初始化 R2 上传监听器
    this.initR2UploadListener()

    // 延迟执行自动迁移检查
    if (this.config.autoMigrateThreshold > 0) {
      setTimeout(() => this.checkAndMigrate(), this.config.migrationDelay)
    }

    this.initialized = true
    console.log('[HistoryDataService] 初始化完成')
  }

  /**
   * 恢复未完成上传任务
   */
  private resumePendingUploads(): void {
    const history = this.historyManager.getAll()
    const pendingItems = history.filter((item) => {
      const hasPendingPlaceholder = Array.isArray(item.urls) && item.urls.some((url) => url.startsWith('pending:'))
      const hasRecoverableSource = Array.isArray(item.originalUrls) && item.originalUrls.length > 0
      return item.uploading === true && hasPendingPlaceholder && hasRecoverableSource
    })

    if (pendingItems.length === 0) return

    console.log(`[HistoryDataService] 检测到 ${pendingItems.length} 条未完成上传记录，开始恢复...`)
    pendingItems.forEach((item) => {
      // 不阻塞初始化流程，后台恢复上传
      void this.uploadBase64ToR2(item as HistoryItem, item.originalUrls as string[])
    })
  }

  /**
   * 添加历史记录 (支持 Base64 图片自动上传到 R2)
   *
   * `extras` 可选: 携带 referenceImages 等"非主结果但需要持久化"的字段。
   * 老调用方不传依然兼容; 新功能(重新编辑)读这里恢复参考图。
   */
  async addToHistory(
    type: string,
    prompt: string,
    urls: string[],
    ratio?: string,
    model?: string,
    extras?: { referenceImages?: string[] }
  ): Promise<HistoryItem | null> {
    // 检测是否有 base64 数据需要上传
    const hasBase64 = urls.some(url => url.startsWith('data:image'))

    // 创建占位符 URLs（如果是 base64，暂时不保存完整数据）
    const placeholderUrls = urls.map(url => {
      if (url.startsWith('data:image')) {
        return `pending:${Date.now()}${Math.random()}`
      }
      return url
    })

    // P0 闪退修复(2026-07-09): 参考图不再逐字复制原始 base64 进 history。
    // 一批 16 张参考图 × 数 MB × 每张结果各复制一份, 是 history 数组膨胀
    // → 全量保存链 (IPC 结构化克隆 + JSON.stringify + 落盘) OOM 的主要来源。
    // 压成 640px JPEG dataURL(重编辑回灌当参考图足够), http URL 原样保留;
    // 同一批共享的 refs 数组按引用缓存, 整批只压一次。
    const rawRefs = extras?.referenceImages
    const referenceImages =
      rawRefs && rawRefs.length > 0 ? await thumbnailRefsForHistory(rawRefs) : undefined

    const historyItem: Partial<HistoryItem> = {
      id: Date.now(),
      type,
      prompt,
      urls: placeholderUrls,
      originalUrls: hasBase64 ? urls : undefined,
      ratio,
      model,
      // 参考图(已缩图化)持久化进 history item。重新编辑按钮会从这里把
      // 它们回灌到 useGenerateStore.referenceImages。
      // 空数组 / undefined 都不写, 节省存储 + 让 UI 判 "有没有 refs" 简单。
      referenceImages,
      timestamp: new Date().toISOString(),
      uploading: hasBase64,
      r2Storage: false
    }

    // 先添加记录（不含 base64）
    const savedItem = await this.historyManager.add(historyItem)

    // 如果有 base64 数据，异步处理上传
    if (hasBase64) {
      this.uploadBase64ToR2(savedItem, urls)
    }

    return savedItem
  }

  /**
   * 异步上传 Base64 图片到 R2
   */
  private async uploadBase64ToR2(historyItem: HistoryItem, originalUrls: string[]): Promise<void> {
    if (!this.r2Storage) {
      // R2 不可用，直接保存 base64
      await this.historyManager.update(historyItem.id, {
        urls: originalUrls,
        uploading: false,
        originalUrls: undefined
      })
      return
    }

    try {
      await this.r2Storage.init()
      
      if (!this.r2Storage.isAvailable()) {
        // R2 不可用，保存 base64
        await this.historyManager.update(historyItem.id, {
          urls: originalUrls,
          uploading: false,
          originalUrls: undefined
        })
        return
      }

      console.log('[HistoryDataService] 开始上传历史记录图片到 R2...')

      // 批量上传到 R2
      const r2Urls = await this.r2Storage.batchProcess(originalUrls)

      // 更新历史记录
      await this.historyManager.update(historyItem.id, {
        urls: r2Urls,
        uploading: false,
        r2Storage: true,
        originalUrls: undefined
      })

      console.log('[HistoryDataService] 历史记录已更新为 R2 URLs')

      // 触发 r2UploadComplete 事件，通知 GeneratePage 更新上传指示器
      window.dispatchEvent(new CustomEvent('r2UploadComplete', {
        detail: {
          originalUrls,
          r2Urls
        }
      }))

      // 触发上传成功事件，通知 HistoryPage 显示反馈
      window.dispatchEvent(new CustomEvent('historyUploadSuccess', {
        detail: {
          itemId: historyItem.id,
          imageCount: r2Urls.length
        }
      }))
    } catch (error) {
      console.error('[HistoryDataService] 上传到 R2 失败:', error)

      // 上传失败，保存原始 base64
      await this.historyManager.update(historyItem.id, {
        urls: originalUrls,
        uploading: false,
        originalUrls: undefined
      })
    }
  }

  /**
   * 初始化 R2 上传监听器
   */
  private initR2UploadListener(): void {
    window.addEventListener('r2UploadComplete', (event: CustomEvent) => {
      const { originalUrls, r2Urls } = event.detail
      this.handleR2UploadComplete(originalUrls, r2Urls)
    })
  }

  /**
   * 处理 R2 上传完成事件
   */
  private async handleR2UploadComplete(originalUrls: string[], r2Urls: string[]): Promise<void> {
    const history = this.historyManager.getAll()
    let updated = false

    for (const item of history) {
      // 处理占位符 URLs 的情况
      if (item.uploading && item.originalUrls) {
        const newUrls: string[] = []
        let allUploaded = true

        for (let i = 0; i < item.originalUrls.length; i++) {
          const originalUrl = item.originalUrls[i]
          const uploadedIndex = originalUrls.indexOf(originalUrl)
          
          if (uploadedIndex !== -1 && r2Urls[uploadedIndex]) {
            newUrls[i] = r2Urls[uploadedIndex]
          } else {
            newUrls[i] = originalUrl
            allUploaded = false
          }
        }

        if (allUploaded) {
          await this.historyManager.update(item.id, {
            urls: newUrls,
            uploading: false,
            r2Storage: true,
            originalUrls: undefined
          })
          updated = true
        }
      } else if (item.urls && Array.isArray(item.urls)) {
        // 处理已有的普通 URLs
        const newUrls = [...item.urls]
        let itemUpdated = false

        for (let i = 0; i < item.urls.length; i++) {
          const imgUrl = item.urls[i]
          const originalIndex = originalUrls.indexOf(imgUrl)
          
          if (originalIndex !== -1 && r2Urls[originalIndex]) {
            newUrls[i] = r2Urls[originalIndex]
            itemUpdated = true
          }
        }

        if (itemUpdated) {
          await this.historyManager.update(item.id, {
            urls: newUrls,
            r2Storage: true
          })
          updated = true
        }
      }
    }

    if (updated) {
      console.log('[HistoryDataService] 历史记录已更新为 R2 URL')
    }
  }

  /**
   * 检查存储使用率并自动迁移
   */
  async checkAndMigrate(): Promise<void> {
    if (!this.r2Storage) {
      console.log('[HistoryDataService] R2 存储服务未加载，跳过自动迁移')
      return
    }

    try {
      await this.r2Storage.init()
    } catch (err) {
      console.warn('[HistoryDataService] R2 存储初始化失败:', err)
      return
    }

    if (!this.r2Storage.isAvailable()) {
      console.log('[HistoryDataService] R2 存储不可用，跳过自动迁移')
      return
    }

    const stats = this.getStorageStats()
    
    if (stats.usagePercent > this.config.autoMigrateThreshold) {
      console.log(`[HistoryDataService] 存储使用率 ${stats.usagePercent.toFixed(1)}%，开始自动迁移...`)
      await this.migrateToCloud(this.config.migrationBatchSize)
    }
  }

  /**
   * 迁移本地 Base64 数据到云端
   */
  async migrateToCloud(batchSize = 10): Promise<number> {
    if (!this.r2Storage?.isAvailable?.()) {
      console.log('[HistoryDataService] R2 不可用，无法迁移')
      return 0
    }

    const history = this.historyManager.getAll()
    
    // 找出需要迁移的记录（含有 base64 且未上传到 R2）
    const itemsToMigrate = history
      .filter(item =>
        !item.r2Storage &&
        !item.uploading &&
        item.urls?.some(url => url.startsWith('data:'))
      )
      .slice(-batchSize) // 取最旧的记录

    if (itemsToMigrate.length === 0) {
      console.log('[HistoryDataService] 没有需要迁移的记录')
      return 0
    }

    console.log(`[HistoryDataService] 自动迁移 ${itemsToMigrate.length} 条历史记录到云端...`)

    let migratedCount = 0

    for (const item of itemsToMigrate) {
      try {
        const base64Urls = item.urls!.filter(url => url.startsWith('data:'))
        const r2Urls = await this.r2Storage.batchProcess(base64Urls)

        const updatedUrls = item.urls!.map(url => {
          const index = base64Urls.indexOf(url)
          if (index !== -1 && r2Urls[index]) {
            return r2Urls[index]
          }
          return url
        })

        await this.historyManager.update(item.id, {
          urls: updatedUrls,
          r2Storage: true,
          uploading: false,
          originalUrls: undefined
        })

        migratedCount++
        console.log(`[HistoryDataService] 历史记录 ${item.id} 已迁移到云端`)
      } catch (error) {
        console.error(`[HistoryDataService] 自动迁移记录 ${item.id} 失败:`, error)
      }
    }

    console.log(`[HistoryDataService] 自动迁移完成，共迁移 ${migratedCount} 条`)
    return migratedCount
  }

  /**
   * 获取存储统计信息
   */
  getStorageStats(): StorageStats {
    const historyStr = localStorage.getItem('ai_image_history') || '[]'
    const historySizeKB = (historyStr.length / 1024).toFixed(2)
    const history = this.historyManager.getAll()

    // 计算所有 localStorage 的大小
    let totalSize = 0
    for (const key in localStorage) {
      if (Object.prototype.hasOwnProperty.call(localStorage, key)) {
        totalSize += localStorage[key].length
      }
    }
    const totalSizeKB = (totalSize / 1024).toFixed(2)
    const estimatedLimit = 5120 // localStorage 通常限制为 5MB

    // 检查 R2 存储状态
    const r2Enabled = this.r2Storage?.isAvailable?.() ?? false

    return {
      historySize: historySizeKB,
      historyCount: history.length,
      totalSize: totalSizeKB,
      estimatedLimit,
      r2Enabled,
      storageMode: r2Enabled ? 'cloud' : 'local',
      usagePercent: (parseFloat(totalSizeKB) / estimatedLimit) * 100
    }
  }

  /**
   * 更新历史记录的缓存图片 URL
   */
  async updateWithCachedImages(originalUrls: string[], cachedUrls: string[]): Promise<boolean> {
    const history = this.historyManager.getAll()

    // 从最新的记录开始查找
    for (let i = 0; i < history.length; i++) {
      const record = history[i]
      
      if (record.urls && Array.isArray(record.urls)) {
        const hasMatching = record.urls.some(url => originalUrls.includes(url))
        
        if (hasMatching) {
          await this.historyManager.update(record.id, {
            cachedUrls,
            cacheTimestamp: Date.now()
          } as Partial<HistoryItem>)
          
          console.log('[HistoryDataService] 更新历史记录缓存信息:', record.id)
          return true
        }
      }
    }

    return false
  }

  /**
   * 获取图片显示 URL（优先使用缓存）
   */
  getDisplayUrl(originalUrl: string, cachedUrls?: string[]): string {
    // 如果有缓存 URL，优先使用缓存
    if (cachedUrls && cachedUrls.length > 0) {
      return cachedUrls[0]
    }

    // 如果是 flux-kontext 的 URL，检查是否有本地缓存
    if (originalUrl.includes('bfl.ai') && window.aiImageAPI?.getCachedImage) {
      const cachedData = window.aiImageAPI.getCachedImage(originalUrl)
      if (cachedData) {
        return cachedData
      }
    }

    return originalUrl
  }

  /**
   * 清理旧历史记录
   */
  async clearOldHistory(keepCount = 10): Promise<number> {
    return this.historyManager.clear(keepCount)
  }

  /**
   * 获取底层 HistoryManager 实例
   */
  getManager(): HistoryManager {
    return this.historyManager
  }

  /**
   * 代理方法：获取所有历史记录
   */
  getAll(): HistoryItem[] {
    return this.historyManager.getAll()
  }

  /**
   * 代理方法：根据 ID 获取历史记录
   */
  getById(id: number | string): HistoryItem | undefined {
    return this.historyManager.getById(id)
  }

  /**
   * 代理方法：搜索历史记录
   */
  search(query: string): HistoryItem[] {
    return this.historyManager.search(query)
  }

  /**
   * 代理方法：删除历史记录
   */
  async delete(id: number | string): Promise<boolean> {
    return this.historyManager.delete(id)
  }

  /**
   * 代理方法：监听变更
   */
  onChange(callback: (history: HistoryItem[], action: string) => void): () => void {
    return this.historyManager.onChange(callback)
  }
}

// 单例
let instance: HistoryDataService | null = null

export function getHistoryDataService(config?: Partial<HistoryDataServiceConfig>): HistoryDataService {
  if (!instance) {
    instance = new HistoryDataService(config)
  }
  return instance
}

export function createHistoryDataService(config?: Partial<HistoryDataServiceConfig>): HistoryDataService {
  return new HistoryDataService(config)
}

// 扩展 Window 类型。
//
// storageBridge / r2Storage 刻意不在这里声明 —— 它们由暴露自己的那个服务声明
// (StorageBridge.ts / R2StorageService.ts),那里是具体类。这里曾经也声明过一份
// `?: any`,同一属性两处不一致就报 TS2687(修饰符)+ TS2717(类型)。
declare global {
  interface Window {
    aiImageAPI?: any
  }

  interface WindowEventMap {
    r2UploadComplete: CustomEvent<{ originalUrls: string[]; r2Urls: string[] }>
    fluxImagesCached: CustomEvent<{ originalUrls: string[]; cachedUrls: string[] }>
  }
}
