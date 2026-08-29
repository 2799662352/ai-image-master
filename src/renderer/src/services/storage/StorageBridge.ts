// src/renderer/src/services/storage/StorageBridge.ts
/**
 * 存储桥接层
 * 自动检测 Electron 环境，使用本地文件存储；否则使用 localStorage
 */

import type { ElectronAPI } from '@/types'

export interface StorageResult {
  success: boolean
  url?: string
  localPath?: string
  error?: string
}

export interface StorageInfo {
  imageCount: number
  totalSize: number
  storagePath: string
  /**
   * 可选是因为**主进程从不回这个字段**:`get-storage-info` 只返回
   * imageCount / totalSize / storagePath(src/main/index.ts)。只有下面浏览器
   * 分支自己合成的那份带 `isElectron: false`。声明成必填等于对调用方撒谎 ——
   * Electron 下拿到的其实是 undefined。要判环境请用 isElectronMode()。
   */
  isElectron?: boolean
}

export interface HistoryItem {
  id: number | string
  prompt?: string
  model?: string
  timestamp?: string
  imageUrl?: string
  images?: string[]
  urls?: string[]  // 新的多图字段
  [key: string]: any
}

export class StorageBridge {
  private isElectron: boolean
  private imageCache: Map<string, string>
  private cachedStoragePath: string | null

  constructor() {
    this.isElectron = window.electronAPI?.isElectron === true
    this.imageCache = new Map()
    this.cachedStoragePath = null
    
    console.log(`📦 存储模式: ${this.isElectron ? 'Electron 本地文件' : '浏览器 localStorage'}`)
    
    if (this.isElectron) {
      this.initStoragePath()
    }
  }

  private async initStoragePath(): Promise<void> {
    try {
      const info = await window.electronAPI!.getStorageInfo()
      this.cachedStoragePath = info.storagePath
      console.log(`📂 存储路径: ${this.cachedStoragePath}`)
    } catch (e) {
      console.error('获取存储路径失败:', e)
    }
  }

  getStoragePathSync(): string | null {
    return this.cachedStoragePath
  }

  /**
   * 保存图片
   */
  async saveImage(base64Data: string, id: string): Promise<StorageResult> {
    if (this.isElectron) {
      const filename = `${id}.png`
      const result = await window.electronAPI!.saveImage(base64Data, filename)
      if (result.success) {
        this.imageCache.set(id, base64Data)
        return { success: true, url: `electron://${filename}`, localPath: result.path }
      }
      return { success: false, error: result.error }
    } else {
      // 浏览器模式：仅缓存，不存 localStorage (太大)
      this.imageCache.set(id, base64Data)
      return { success: true, url: base64Data }
    }
  }

  /**
   * 读取图片
   */
  async readImage(urlOrId: string): Promise<string | null> {
    // 已是 base64，直接返回
    if (urlOrId?.startsWith('data:image')) {
      return urlOrId
    }

    // Electron 格式
    if (urlOrId?.startsWith('electron://')) {
      const filename = urlOrId.replace('electron://', '')
      const id = filename.replace(/\.\w+$/, '')
      
      // 先查缓存
      if (this.imageCache.has(id)) {
        return this.imageCache.get(id) || null
      }
      
      if (this.isElectron) {
        const data = await window.electronAPI!.readImage(filename)
        if (data) {
          this.imageCache.set(id, data)
        }
        return data
      }
    }

    // 其他 URL (R2 等)
    return urlOrId
  }

  /**
   * 删除图片
   */
  async deleteImage(urlOrId: string): Promise<StorageResult> {
    if (urlOrId?.startsWith('electron://')) {
      const filename = urlOrId.replace('electron://', '')
      const id = filename.replace(/\.\w+$/, '')
      this.imageCache.delete(id)
      
      if (this.isElectron) {
        return await window.electronAPI!.deleteImage(filename)
      }
    }
    return { success: true }
  }

  /**
   * 保存历史记录
   */
  async saveHistory(history: HistoryItem[]): Promise<StorageResult> {
    if (this.isElectron) {
      const historyWithRefs = await Promise.all(history.map(async (item) => {
        const newItem = { ...item }
        
        // 处理 imageUrl
        if (item.imageUrl?.startsWith('data:image')) {
          const result = await this.saveImage(item.imageUrl, `img_${item.id}`)
          if (result.success) {
            newItem.imageUrl = result.url
          }
        }
        
        // 处理多图 images (旧字段)
        if (item.images?.length) {
          newItem.images = await Promise.all(item.images.map(async (img, idx) => {
            if (img?.startsWith('data:image')) {
              const result = await this.saveImage(img, `img_${item.id}_${idx}`)
              return result.success ? result.url! : img
            }
            return img
          }))
        }
        
        // 处理 urls 字段 - 移除 base64，保留云端 URL
        // 注意: 不保存为本地文件 (electron://)，因为 CSP 会阻止加载
        // R2 上传由 HistoryDataService 处理，这里只做清理
        if (item.urls?.length) {
          newItem.urls = item.urls.map((url: string) => {
            // 保留有效的云端 URL（R2、https 等）
            if (url && !url.startsWith('data:image') && !url.startsWith('pending:')) {
              return url
            }
            // base64 和 pending 占位符标记为已移除
            if (url?.startsWith('data:image') && url.length > 1000) {
              return '[base64-removed]'
            }
            return url
          })
        }
        
        // 上传中的记录需要保留 originalUrls，便于应用重启后恢复上传
        const shouldKeepOriginalUrls =
          newItem.uploading === true &&
          Array.isArray(newItem.originalUrls) &&
          newItem.originalUrls.length > 0
        if (!shouldKeepOriginalUrls && newItem.originalUrls) {
          delete newItem.originalUrls
        }

        // P0 闪退修复(2026-07-09): referenceImages 超过 1MB 的 data: 条目
        // 在跨 IPC 前就地替换。新写入的 refs 已被 HistoryDataService 缩成
        // 640px JPEG(几十 KB)不受影响; 这里兜的是旧版本落盘的原始大图 —
        // 老记录每次全量保存都会原样跨 IPC(结构化克隆数百 MB)→ 主进程
        // stringify OOM。替换后首次保存即完成一次性清洗。
        if (Array.isArray(newItem.referenceImages) && newItem.referenceImages.length > 0) {
          newItem.referenceImages = newItem.referenceImages.map((ref: string) =>
            typeof ref === 'string' && ref.startsWith('data:') && ref.length > 1024 * 1024
              ? '[base64-removed]'
              : ref
          )
        }

        return newItem
      }))
      
      return await window.electronAPI!.saveHistory(historyWithRefs)
    } else {
      // 浏览器模式: 存 localStorage，但不存 base64
      try {
        const historyWithoutBase64 = history.map(item => {
          const newItem = { ...item }
          if (newItem.imageUrl?.startsWith('data:image') && newItem.imageUrl.length > 1000) {
            newItem.imageUrl = '[base64-removed]'
          }
          if (newItem.images?.length) {
            newItem.images = newItem.images.map(img => 
              img?.startsWith('data:image') && img.length > 1000 ? '[base64-removed]' : img
            )
          }
          // 处理 urls 字段 - 重要！
          if (newItem.urls?.length) {
            newItem.urls = newItem.urls.map((url: string) => 
              url?.startsWith('data:image') && url.length > 1000 ? '[base64-removed]' : url
            )
          }
          // 上传中的记录需要保留 originalUrls，便于恢复上传
          const shouldKeepOriginalUrls =
            newItem.uploading === true &&
            Array.isArray(newItem.originalUrls) &&
            newItem.originalUrls.length > 0
          if (!shouldKeepOriginalUrls && newItem.originalUrls) {
            delete newItem.originalUrls
          }
          return newItem
        })
        localStorage.setItem('ai_image_history', JSON.stringify(historyWithoutBase64))
        return { success: true }
      } catch (e) {
        console.error('localStorage 保存失败:', e)
        try {
          const trimmed = history.slice(0, 10).map(item => ({
            id: item.id,
            prompt: item.prompt,
            model: item.model,
            timestamp: item.timestamp
          }))
          localStorage.setItem('ai_image_history', JSON.stringify(trimmed))
        } catch (e2) {
          console.error('无法保存历史记录')
        }
        return { success: false, error: (e as Error).message }
      }
    }
  }

  /**
   * 加载历史记录
   */
  async loadHistory(): Promise<HistoryItem[]> {
    if (this.isElectron) {
      const history = await window.electronAPI!.loadHistory()
      return history || []
    } else {
      try {
        const data = localStorage.getItem('ai_image_history')
        return data ? JSON.parse(data) : []
      } catch (e) {
        console.error('读取历史记录失败:', e)
        return []
      }
    }
  }

  /**
   * 获取存储状态信息
   */
  async getStorageInfo(): Promise<StorageInfo> {
    if (this.isElectron) {
      return await window.electronAPI!.getStorageInfo()
    } else {
      let total = 0
      for (const key in localStorage) {
        if (Object.prototype.hasOwnProperty.call(localStorage, key)) {
          total += localStorage[key].length * 2 // UTF-16
        }
      }
      return {
        imageCount: this.imageCache.size,
        totalSize: total,
        storagePath: 'localStorage',
        isElectron: false
      }
    }
  }

  /**
   * 导出图片到用户选择的目录
   */
  async exportImageToPath(base64Data: string, suggestedName: string): Promise<StorageResult> {
    if (this.isElectron) {
      const targetDir = await window.electronAPI!.selectSavePath()
      if (targetDir) {
        return await window.electronAPI!.exportImage(base64Data, targetDir, suggestedName)
      }
      return { success: false, error: '用户取消' }
    } else {
      const link = document.createElement('a')
      link.href = base64Data
      link.download = suggestedName
      link.click()
      return { success: true }
    }
  }

  /**
   * 打开文件所在目录
   */
  async openFilePath(path: string): Promise<void> {
    if (this.isElectron && path) {
      await window.electronAPI!.openPath(path)
    }
  }

  /**
   * 检查是否为 Electron 环境
   */
  isElectronMode(): boolean {
    return this.isElectron
  }

  /**
   * 清除图片缓存
   */
  clearCache(): void {
    this.imageCache.clear()
  }
}

// 单例实例
let storageBridgeInstance: StorageBridge | null = null

/**
 * 获取 StorageBridge 单例实例
 */
export function getStorageBridge(): StorageBridge {
  if (!storageBridgeInstance) {
    storageBridgeInstance = new StorageBridge()
  }
  return storageBridgeInstance
}

/**
 * 创建新的 StorageBridge 实例
 */
export function createStorageBridge(): StorageBridge {
  return new StorageBridge()
}

/**
 * 重置单例（仅用于测试）
 */
export function resetStorageBridge(): void {
  storageBridgeInstance = null
}

// ========================================
// V16.2 B1 - 过渡期 window 暴露
// V16.3 - 添加废弃警告
// ========================================

declare global {
  interface Window {
    storageBridge: StorageBridge
    storageBridgeTS: StorageBridge
    StorageBridgeTS: typeof StorageBridge
  }
}

// 是否已显示过废弃警告 (避免重复输出)
let deprecationWarningShown = false

/**
 * 初始化并暴露到 window（过渡期）
 * V16.3: 添加废弃警告，推荐使用 Services.get('storage') 或 import { getStorageBridge }
 */
export function initStorageBridgeGlobal(): StorageBridge {
  const bridge = getStorageBridge()

  // 过渡期: 暴露到 window (带废弃警告)
  if (typeof window !== 'undefined') {
    // 使用 Object.defineProperty 添加废弃警告 getter
    Object.defineProperty(window, 'storageBridge', {
      get() {
        if (!deprecationWarningShown && process.env.NODE_ENV !== 'production') {
          console.warn(
            '[DEPRECATED] window.storageBridge 已废弃。' +
            '请使用 Services.get("storage") 或 import { getStorageBridge } from "@/services/storage"'
          )
          deprecationWarningShown = true
        }
        return bridge
      },
      configurable: true
    })
    
    // storageBridgeTS 保持直接访问 (过渡期)
    window.storageBridgeTS = bridge
    window.StorageBridgeTS = StorageBridge
  }

  console.log('[V16.3] StorageBridge TypeScript 版本已加载 (废弃警告已启用)')

  return bridge
}
