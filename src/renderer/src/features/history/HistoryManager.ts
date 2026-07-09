// src/renderer/src/features/history/HistoryManager.ts
/**
 * 历史记录管理器
 * 处理图片生成历史的存储、检索和管理
 * V16.3 - 使用直接导入替代 window 全局变量
 */

import type { StorageResult, HistoryItem as BaseHistoryItem } from '@/services/storage'
import { getStorageBridge, StorageBridge } from '@/services/storage'
import { getR2StorageService, R2StorageService } from '@/services/r2-storage'

export interface HistoryMetadata {
  r2Keys?: string[]
  storageMode?: 'cloud' | 'local'
  savedAt?: number
  [key: string]: any
}

export interface HistoryItem extends BaseHistoryItem {
  type?: string
  ratio?: string
  resolution?: string
  urls?: string[]
  uploading?: boolean
  originalUrls?: string[]
  r2Storage?: boolean
  metadata?: HistoryMetadata
}

export interface HistoryManagerConfig {
  maxLocalHistory: number
  maxCloudHistory: number
  storageKey: string
  autoMigrate: boolean
}

export type HistoryChangeCallback = (history: HistoryItem[], action: string) => void

const DEFAULT_CONFIG: HistoryManagerConfig = {
  // 2026-07-09: 30 → 120。此前 item 里可能内嵌整张 base64(几十 MB), 30 条
  // 就是保存链的极限; 现在主结果只存 cos/http URL、参考图缩成 640px JPEG,
  // 单条 ≤ 几百 KB, 上限可以放开。批量页一批就产几十条, 30 条上限会让
  // 用户觉得"历史记录丢了"(其实是被 enforceLimit 顶掉)。
  maxLocalHistory: 120,
  maxCloudHistory: 200,
  storageKey: 'ai_image_history',
  autoMigrate: true
}

export class HistoryManager {
  private history: HistoryItem[] = []
  private config: HistoryManagerConfig
  private onChangeCallbacks: Set<HistoryChangeCallback>
  private storageBridge: StorageBridge | null = null
  private r2Storage: R2StorageService | null = null
  private initialized = false

  constructor(config?: Partial<HistoryManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.onChangeCallbacks = new Set()
  }

  /**
   * 初始化历史管理器
   * V16.3: 使用直接导入替代 window 全局变量
   */
  async init(storageBridge?: StorageBridge | null, r2Storage?: R2StorageService | null): Promise<void> {
    if (this.initialized) return

    // V16.3: 使用直接导入获取服务
    this.storageBridge = storageBridge || getStorageBridge()
    this.r2Storage = r2Storage || getR2StorageService()

    try {
      const history = await this.load()
      this.history = history

      if (this.config.autoMigrate) {
        await this.autoMigrate()
      }

      this.initialized = true
      console.log(`[HistoryManager] 初始化完成，已加载 ${this.history.length} 条记录`)
      // 通知所有订阅者(React useHistoryData 等)数据已就位
      // 修复:重启后 #history 页因 init 不广播而停留在空列表,直到用户生成新记录才一次性出现全部
      this.notifyChange('init')
    } catch (error) {
      console.error('[HistoryManager] 初始化失败:', error)
      this.history = []
      this.initialized = true
      this.notifyChange('init')
    }
  }

  /**
   * 加载历史记录
   */
  async load(): Promise<HistoryItem[]> {
    if (this.storageBridge) {
      return await this.storageBridge.loadHistory()
    }

    try {
      const data = localStorage.getItem(this.config.storageKey)
      return data ? JSON.parse(data) : []
    } catch (error) {
      console.error('[HistoryManager] 加载失败:', error)
      return []
    }
  }

  /**
   * 保存历史记录
   */
  async save(): Promise<StorageResult> {
    if (this.storageBridge) {
      return await this.storageBridge.saveHistory(this.history)
    }

    try {
      // 移除大型 base64 数据
      const historyToSave = this.history.map(item => {
        const newItem = { ...item }
        if (newItem.imageUrl?.startsWith('data:image') && newItem.imageUrl.length > 1000) {
          newItem.imageUrl = '[base64-removed]'
        }
        if (newItem.urls?.length) {
          newItem.urls = newItem.urls.map(url =>
            url?.startsWith('data:image') && url.length > 1000 ? '[base64-removed]' : url
          )
        }
        return newItem
      })

      localStorage.setItem(this.config.storageKey, JSON.stringify(historyToSave))
      return { success: true }
    } catch (error) {
      console.error('[HistoryManager] 保存失败:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * 添加历史记录
   */
  async add(item: Partial<HistoryItem>): Promise<HistoryItem> {
    const historyItem: HistoryItem = {
      id: item.id ?? Date.now(),
      timestamp: item.timestamp ?? new Date().toISOString(),
      ...item,
      metadata: {
        ...item.metadata,
        savedAt: Date.now(),
        storageMode: this.isCloudEnabled() ? 'cloud' : 'local'
      }
    }

    // 如果有 URLs，提取 R2 键值
    if (historyItem.urls && this.r2Storage?.isR2Url) {
      const r2Keys: string[] = []
      for (const url of historyItem.urls) {
        if (this.r2Storage.isR2Url(url)) {
          const key = this.r2Storage.extractR2Key?.(url)
          if (key) r2Keys.push(key)
        }
      }
      if (r2Keys.length > 0) {
        historyItem.metadata = { ...historyItem.metadata, r2Keys }
      }
    }

    // 添加到数组开头
    this.history.unshift(historyItem)

    // 限制历史记录数量
    await this.enforceLimit()

    // 保存
    await this.save()

    // 通知变更
    this.notifyChange('add')

    return historyItem
  }

  /**
   * 删除历史记录
   */
  async delete(id: number | string): Promise<boolean> {
    const index = this.history.findIndex(item => item.id === id)
    if (index === -1) return false

    const item = this.history[index]

    // 删除云端图片
    if (this.r2Storage?.isAvailable?.() && item.metadata?.r2Keys?.length) {
      try {
        await this.r2Storage.batchDelete(item.metadata.r2Keys)
      } catch (error) {
        console.warn('[HistoryManager] 删除云端图片失败:', error)
      }
    }

    // 从数组中移除
    this.history.splice(index, 1)

    // 保存
    await this.save()

    // 通知变更
    this.notifyChange('delete')

    return true
  }

  /**
   * 清空历史记录
   */
  async clear(keepCount = 0): Promise<number> {
    const oldCount = this.history.length
    if (oldCount <= keepCount) return 0

    const itemsToDelete = this.history.slice(keepCount)

    // 删除云端图片
    if (this.r2Storage?.isAvailable?.()) {
      const keysToDelete: string[] = []
      for (const item of itemsToDelete) {
        if (item.metadata?.r2Keys) {
          keysToDelete.push(...item.metadata.r2Keys)
        }
      }
      if (keysToDelete.length > 0) {
        try {
          await this.r2Storage.batchDelete(keysToDelete)
        } catch (error) {
          console.warn('[HistoryManager] 批量删除云端图片失败:', error)
        }
      }
    }

    // 保留指定数量
    this.history = this.history.slice(0, keepCount)

    // 保存
    await this.save()

    // 通知变更
    this.notifyChange('clear')

    return oldCount - keepCount
  }

  /**
   * 获取历史记录
   */
  getAll(): HistoryItem[] {
    return [...this.history]
  }

  /**
   * 获取指定记录
   */
  getById(id: number | string): HistoryItem | undefined {
    return this.history.find(item => item.id === id)
  }

  /**
   * 搜索历史记录
   */
  search(query: string): HistoryItem[] {
    const lowerQuery = query.toLowerCase()
    return this.history.filter(item =>
      item.prompt?.toLowerCase().includes(lowerQuery) ||
      item.model?.toLowerCase().includes(lowerQuery) ||
      item.type?.toLowerCase().includes(lowerQuery)
    )
  }

  /**
   * 获取历史记录数量
   */
  count(): number {
    return this.history.length
  }

  /**
   * 更新历史记录
   */
  async update(id: number | string, updates: Partial<HistoryItem>): Promise<boolean> {
    const index = this.history.findIndex(item => item.id === id)
    if (index === -1) return false

    this.history[index] = { ...this.history[index], ...updates }
    await this.save()
    this.notifyChange('update')

    return true
  }

  /**
   * 限制历史记录数量
   */
  private async enforceLimit(): Promise<void> {
    const maxHistory = this.isCloudEnabled()
      ? this.config.maxCloudHistory
      : this.config.maxLocalHistory

    if (this.history.length <= maxHistory) return

    const itemsToDelete = this.history.slice(maxHistory)

    // 删除超出部分的云端图片
    if (this.r2Storage?.isAvailable?.()) {
      const keysToDelete: string[] = []
      for (const item of itemsToDelete) {
        if (item.metadata?.r2Keys) {
          keysToDelete.push(...item.metadata.r2Keys)
        }
      }
      if (keysToDelete.length > 0) {
        try {
          await this.r2Storage.batchDelete(keysToDelete)
        } catch (error) {
          console.warn('[HistoryManager] 删除超出记录失败:', error)
        }
      }
    }

    this.history = this.history.slice(0, maxHistory)
  }

  /**
   * 自动迁移历史记录格式
   */
  private async autoMigrate(): Promise<void> {
    let migrated = false

    for (const item of this.history) {
      // 添加缺失的元数据
      if (!item.metadata) {
        item.metadata = {
          savedAt: Date.now(),
          storageMode: 'local'
        }
        migrated = true
      }

      // 迁移 imageUrl 到 urls
      if (item.imageUrl && !item.urls) {
        item.urls = [item.imageUrl]
        migrated = true
      }
    }

    if (migrated) {
      await this.save()
      console.log('[HistoryManager] 历史记录格式已迁移')
    }
  }

  /**
   * 检查云存储是否可用
   */
  private isCloudEnabled(): boolean {
    return !!this.r2Storage?.isAvailable?.()
  }

  /**
   * 获取存储信息
   */
  getStorageInfo(): {
    count: number
    maxHistory: number
    storageMode: 'cloud' | 'local'
    cloudEnabled: boolean
  } {
    return {
      count: this.history.length,
      maxHistory: this.isCloudEnabled()
        ? this.config.maxCloudHistory
        : this.config.maxLocalHistory,
      storageMode: this.isCloudEnabled() ? 'cloud' : 'local',
      cloudEnabled: this.isCloudEnabled()
    }
  }

  /**
   * 监听历史变更
   */
  onChange(callback: HistoryChangeCallback): () => void {
    this.onChangeCallbacks.add(callback)
    return () => this.onChangeCallbacks.delete(callback)
  }

  /**
   * 通知变更
   */
  private notifyChange(action: string): void {
    this.onChangeCallbacks.forEach(cb => cb(this.history, action))
  }

  /**
   * 导出历史记录
   */
  export(): string {
    return JSON.stringify(this.history, null, 2)
  }

  /**
   * 导入历史记录
   */
  async import(data: string, merge = true): Promise<number> {
    try {
      const imported: HistoryItem[] = JSON.parse(data)
      
      if (!Array.isArray(imported)) {
        throw new Error('Invalid history data format')
      }

      if (merge) {
        // 合并，避免重复
        const existingIds = new Set(this.history.map(item => item.id))
        const newItems = imported.filter(item => !existingIds.has(item.id))
        this.history.push(...newItems)
        await this.enforceLimit()
        await this.save()
        this.notifyChange('import')
        return newItems.length
      } else {
        // 替换
        this.history = imported
        await this.enforceLimit()
        await this.save()
        this.notifyChange('import')
        return imported.length
      }
    } catch (error) {
      console.error('[HistoryManager] 导入失败:', error)
      throw error
    }
  }
}

// 创建单例
let instance: HistoryManager | null = null

export function getHistoryManager(config?: Partial<HistoryManagerConfig>): HistoryManager {
  if (!instance) {
    instance = new HistoryManager(config)
  }
  return instance
}

export function createHistoryManager(config?: Partial<HistoryManagerConfig>): HistoryManager {
  return new HistoryManager(config)
}
