// src/renderer/src/services/PageStateManager.ts
// TypeScript 版本的页面状态管理器
// V16.3 - 使用直接导入替代 window 全局变量

import { getStorageBridge, StorageBridge } from './storage'

export interface PageStateConfig {
  maxImageSize: number
  maxImagesPerPage: number
  storagePrefix: string
  version: string
}

export interface StateWithMeta<T = any> {
  version: string
  timestamp: number
  pageId: string
  data: T
}

export interface ReferenceImage {
  base64: string | null
  name?: string
  _savedToFile?: boolean
  _originalSize?: number
  _oversized?: boolean
  _loadFailed?: boolean
}

export interface PageState {
  referenceImages?: ReferenceImage[]
  batchReferenceImages?: ReferenceImage[]
  [key: string]: any
}

export class PageStateManager {
  private isElectron: boolean
  private stateCache: Map<string, StateWithMeta>
  private saveDebounceTimers: Map<string, number>
  private defaultDebounceMs: number
  private config: PageStateConfig

  constructor() {
    this.isElectron = window.electronAPI?.isElectron === true
    this.stateCache = new Map()
    this.saveDebounceTimers = new Map()
    this.defaultDebounceMs = 1000

    this.config = {
      maxImageSize: 500 * 1024,
      maxImagesPerPage: 5,
      storagePrefix: 'pageState_',
      version: '1.1.0'
    }

    console.log(`📦 PageStateManager 初始化: ${this.isElectron ? 'Electron 模式' : '浏览器模式'}`)
  }

  saveState(pageId: string, state: PageState, debounceMs: number = this.defaultDebounceMs): void {
    if (this.saveDebounceTimers.has(pageId)) {
      clearTimeout(this.saveDebounceTimers.get(pageId))
    }

    const timer = window.setTimeout(() => {
      this._doSaveState(pageId, state)
      this.saveDebounceTimers.delete(pageId)
    }, debounceMs)

    this.saveDebounceTimers.set(pageId, timer)
  }

  saveStateImmediate(pageId: string, state: PageState): void {
    if (this.saveDebounceTimers.has(pageId)) {
      clearTimeout(this.saveDebounceTimers.get(pageId))
      this.saveDebounceTimers.delete(pageId)
    }

    const stateWithMeta: StateWithMeta = {
      version: this.config.version,
      timestamp: Date.now(),
      pageId: pageId,
      data: state
    }
    this.stateCache.set(pageId, stateWithMeta)

    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => this._doSaveState(pageId, state), { timeout: 500 })
    } else {
      setTimeout(() => this._doSaveState(pageId, state), 0)
    }
  }

  private async _doSaveState(pageId: string, state: PageState): Promise<void> {
    try {
      const processedState = await this._processStateForStorage(pageId, state)

      const stateWithMeta: StateWithMeta = {
        version: this.config.version,
        timestamp: Date.now(),
        pageId: pageId,
        data: processedState
      }

      this.stateCache.set(pageId, stateWithMeta)

      if (this.isElectron && window.electronAPI) {
        await window.electronAPI.savePageState(pageId, stateWithMeta)
      } else {
        const key = this.config.storagePrefix + pageId
        localStorage.setItem(key, JSON.stringify(stateWithMeta))
      }

      console.log(`💾 页面状态已保存: ${pageId}`)
    } catch (error) {
      console.error(`❌ 保存页面状态失败 (${pageId}):`, error)
    }
  }

  async loadState(pageId: string): Promise<PageState | null> {
    try {
      if (this.stateCache.has(pageId)) {
        const cached = this.stateCache.get(pageId)!
        console.log(`📖 从缓存加载页面状态: ${pageId}`)
        return cached.data
      }

      let stateWithMeta: StateWithMeta | null = null

      if (this.isElectron && window.electronAPI) {
        stateWithMeta = await window.electronAPI.loadPageState(pageId)
      } else {
        const key = this.config.storagePrefix + pageId
        const stored = localStorage.getItem(key)
        if (stored) {
          stateWithMeta = JSON.parse(stored)
        }
      }

      if (stateWithMeta) {
        if (stateWithMeta.version !== this.config.version) {
          console.warn(`⚠️ 页面状态版本不匹配 (${pageId}), 将清除旧数据`)
          await this.clearState(pageId)
          return null
        }

        const processedData = await this._processStateForLoad(stateWithMeta.data)
        this.stateCache.set(pageId, { ...stateWithMeta, data: processedData })
        console.log(`📖 页面状态已加载: ${pageId}`)
        return processedData
      }

      return null
    } catch (error) {
      console.error(`❌ 加载页面状态失败 (${pageId}):`, error)
      return null
    }
  }

  async clearState(pageId: string): Promise<void> {
    try {
      // V16.3: 使用直接导入替代 window.storageBridge
      const storageBridge = getStorageBridge()
      if (this.isElectron && storageBridge) {
        let stateToClean: PageState | null = null

        if (this.stateCache.has(pageId)) {
          stateToClean = this.stateCache.get(pageId)?.data || null
        } else if (window.electronAPI) {
          const storedState = await window.electronAPI.loadPageState(pageId)
          stateToClean = storedState?.data || null
        }

        if (stateToClean) {
          await this._cleanupLocalImages(stateToClean)
        }
      }

      this.stateCache.delete(pageId)

      if (this.isElectron && window.electronAPI) {
        await window.electronAPI.clearPageState(pageId)
      } else {
        const key = this.config.storagePrefix + pageId
        localStorage.removeItem(key)
      }

      console.log(`🗑️ 页面状态已清除: ${pageId}`)
    } catch (error) {
      console.error(`❌ 清除页面状态失败 (${pageId}):`, error)
    }
  }

  async clearAllStates(): Promise<void> {
    try {
      // V16.3: 使用直接导入
      const storageBridge = getStorageBridge()
      if (this.isElectron && storageBridge) {
        const pageIds = await this.getSavedPageIds()

        for (const pageId of pageIds) {
          let stateToClean: PageState | null = null

          if (this.stateCache.has(pageId)) {
            stateToClean = this.stateCache.get(pageId)?.data || null
          } else if (window.electronAPI) {
            const storedState = await window.electronAPI.loadPageState(pageId)
            stateToClean = storedState?.data || null
          }

          if (stateToClean) {
            await this._cleanupLocalImages(stateToClean)
          }
        }
      }

      this.stateCache.clear()

      if (this.isElectron && window.electronAPI) {
        await window.electronAPI.clearAllPageStates()
      } else {
        const keysToRemove: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key && key.startsWith(this.config.storagePrefix)) {
            keysToRemove.push(key)
          }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key))
      }

      console.log(`🗑️ 所有页面状态已清除`)
    } catch (error) {
      console.error(`❌ 清除所有页面状态失败:`, error)
    }
  }

  private async _cleanupLocalImages(state: PageState): Promise<void> {
    // V16.3: 使用直接导入
    const storageBridge = getStorageBridge()
    if (!state || !this.isElectron || !storageBridge) return

    const localImages: string[] = []

    if (state.referenceImages && Array.isArray(state.referenceImages)) {
      state.referenceImages.forEach(img => {
        if (img?.base64?.startsWith('electron://')) {
          localImages.push(img.base64)
        }
      })
    }

    if (state.batchReferenceImages && Array.isArray(state.batchReferenceImages)) {
      state.batchReferenceImages.forEach(img => {
        if (img?.base64?.startsWith('electron://')) {
          localImages.push(img.base64)
        }
      })
    }

    for (const imageUrl of localImages) {
      try {
        await storageBridge.deleteImage(imageUrl)
        console.log(`🗑️ 已删除本地图片: ${imageUrl}`)
      } catch (error) {
        console.warn(`删除本地图片失败: ${imageUrl}`, error)
      }
    }
  }

  private async _processStateForStorage(pageId: string, state: PageState): Promise<PageState> {
    const processed = { ...state }

    if (processed.referenceImages && Array.isArray(processed.referenceImages)) {
      processed.referenceImages = await this._processImagesForSave(pageId, processed.referenceImages, 'ref')
    }

    if (processed.batchReferenceImages && Array.isArray(processed.batchReferenceImages)) {
      processed.batchReferenceImages = await this._processImagesForSave(pageId, processed.batchReferenceImages, 'batchRef')
    }

    return processed
  }

  private async _processImagesForSave(pageId: string, images: ReferenceImage[], prefix: string): Promise<ReferenceImage[]> {
    if (!images || !Array.isArray(images)) return []

    const limitedImages = images.slice(0, this.config.maxImagesPerPage)

    const processedImages = await Promise.all(limitedImages.map(async (img, idx) => {
      if (!img) return img

      if (img.base64 && img.base64.startsWith('electron://')) {
        return img
      }

      if (img.base64 && img.base64.startsWith('data:image')) {
        const estimatedSize = img.base64.length
        // V16.3: 使用直接导入
        const storageBridge = getStorageBridge()
        if (estimatedSize > this.config.maxImageSize) {
          if (this.isElectron && storageBridge) {
            try {
              const imageId = `${prefix}_${pageId}_${idx}_${Date.now()}`
              const result = await storageBridge.saveImage(img.base64, imageId)
              if (result.success) {
                console.log(`📁 大图片已保存到本地: ${imageId} (${Math.round(estimatedSize / 1024)}KB)`)
                return {
                  ...img,
                  base64: result.url,
                  _savedToFile: true,
                  _originalSize: estimatedSize
                }
              }
            } catch (error) {
              console.error('保存大图片到本地文件失败:', error)
            }
          }

          console.warn(`⚠️ 大图片已过滤 (${Math.round(estimatedSize / 1024)}KB)`)
          return {
            ...img,
            base64: null,
            _oversized: true,
            _originalSize: estimatedSize
          }
        }
      }

      return img
    }))

    return processedImages
  }

  private async _processStateForLoad(state: PageState): Promise<PageState> {
    if (!state) return state

    const processed = { ...state }

    if (processed.referenceImages && Array.isArray(processed.referenceImages)) {
      processed.referenceImages = await this._processImagesForLoad(processed.referenceImages)
    }

    if (processed.batchReferenceImages && Array.isArray(processed.batchReferenceImages)) {
      processed.batchReferenceImages = await this._processImagesForLoad(processed.batchReferenceImages)
    }

    return processed
  }

  private async _processImagesForLoad(images: ReferenceImage[]): Promise<ReferenceImage[]> {
    if (!images || !Array.isArray(images)) return []
    
    // V16.3: 使用直接导入
    const storageBridge = getStorageBridge()

    const processedImages = await Promise.all(images.map(async (img) => {
      if (!img) return img

      if (img.base64 && img.base64.startsWith('electron://') && storageBridge) {
        try {
          const base64Data = await storageBridge.readImage(img.base64)
          if (base64Data) {
            console.log(`📖 从本地文件恢复图片: ${img.base64}`)
            return {
              ...img,
              base64: base64Data,
              _savedToFile: undefined
            }
          }
        } catch (error) {
          console.error('从本地文件读取图片失败:', error)
        }
        return {
          ...img,
          _loadFailed: true
        }
      }

      return img
    }))

    return processedImages
  }

  async getSavedPageIds(): Promise<string[]> {
    try {
      if (this.isElectron && window.electronAPI) {
        return await window.electronAPI.getSavedPageIds()
      } else {
        const pageIds: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key && key.startsWith(this.config.storagePrefix)) {
            pageIds.push(key.replace(this.config.storagePrefix, ''))
          }
        }
        return pageIds
      }
    } catch (error) {
      console.error('❌ 获取已保存页面列表失败:', error)
      return []
    }
  }
}

// 导出默认实例
export const pageStateManager = new PageStateManager()

// ========================================
// V16.2 B2 - 单例和 window 暴露
// ========================================

let pageStateManagerInstance: PageStateManager | null = null

/**
 * 获取 PageStateManager 单例
 */
export function getPageStateManager(): PageStateManager {
  if (!pageStateManagerInstance) {
    pageStateManagerInstance = new PageStateManager()
  }
  return pageStateManagerInstance
}

/**
 * 创建新的 PageStateManager 实例
 */
export function createPageStateManager(): PageStateManager {
  return new PageStateManager()
}

/**
 * 重置单例（仅用于测试）
 */
export function resetPageStateManager(): void {
  pageStateManagerInstance = null
}

// V16.3 - 添加废弃警告
declare global {
  interface Window {
    pageStateManager: PageStateManager
    pageStateManagerTS: PageStateManager
    PageStateManagerTS: typeof PageStateManager
  }
}

let pageStateManagerDeprecationWarningShown = false

/**
 * 初始化并暴露到 window（过渡期）
 * V16.3: 添加废弃警告
 */
export function initPageStateManagerGlobal(): PageStateManager {
  const manager = getPageStateManager()

  // 过渡期: 暴露到 window (带废弃警告)
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'pageStateManager', {
      get() {
        if (!pageStateManagerDeprecationWarningShown && process.env.NODE_ENV !== 'production') {
          console.warn(
            '[DEPRECATED] window.pageStateManager 已废弃。' +
            '请使用 Services.get("pageState") 或 import { getPageStateManager } from "@/services/PageStateManager"'
          )
          pageStateManagerDeprecationWarningShown = true
        }
        return manager
      },
      configurable: true
    })
    
    window.pageStateManagerTS = manager
    window.PageStateManagerTS = PageStateManager
  }

  console.log('[V16.3] PageStateManager TypeScript 版本已加载 (废弃警告已启用)')

  return manager
}
