// src/renderer/src/features/image-viewer/ImageOperations.ts
/**
 * 图片操作服务
 * 处理图片下载、复制URL、R2存储集成等功能
 * V16.3 - 使用直接导入替代 window 全局变量
 */

import { ImageViewer, ImageViewerOptions, createImageViewer } from './ImageViewer'
import { getR2StorageService } from '../../services/r2-storage'

export interface ImageOperationsConfig {
  onDownloadStart?: (url: string) => void
  onDownloadSuccess?: (url: string) => void
  onDownloadError?: (url: string, error: Error) => void
  onCopySuccess?: (url: string) => void
  onCopyError?: (url: string, error: Error) => void
  showToast?: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void
  getHistory?: () => HistoryItemLike[]
}

export interface HistoryItemLike {
  id?: number
  urls?: string[]
  r2Storage?: boolean
}

export interface DownloadResult {
  success: boolean
  message?: string
  error?: string
}

export interface BatchDownloadProgress {
  completed: number
  total: number
}

export class ImageOperations {
  private config: ImageOperationsConfig
  private viewer: ImageViewer | null = null

  constructor(config: ImageOperationsConfig = {}) {
    this.config = config
  }

  /**
   * 下载单张图片
   * 支持从历史记录中查找对应的 R2 URL
   */
  async downloadImage(url: string, filename?: string): Promise<DownloadResult> {
    try {
      this.config.onDownloadStart?.(url)

      // 尝试从历史记录中查找 R2 URL
      const resolvedUrl = this.resolveR2Url(url)

      // 使用 aiImageAPI 下载
      if (window.aiImageAPI?.downloadImage) {
        await window.aiImageAPI.downloadImage(
          resolvedUrl,
          filename,
          window.aiImageAPI.model
        )
        
        this.config.onDownloadSuccess?.(resolvedUrl)
        this.config.showToast?.('图片下载成功', 'success')
        
        return { success: true, message: '图片下载成功' }
      }

      // 降级到浏览器下载
      return await this.browserDownload(resolvedUrl, filename)
    } catch (error) {
      const err = error as Error
      this.config.onDownloadError?.(url, err)
      this.config.showToast?.(err.message || '下载失败', 'error')
      
      return { success: false, error: err.message }
    }
  }

  /**
   * 批量下载图片为 ZIP
   */
  async downloadImagesAsZip(
    urls: string[],
    zipFilename?: string,
    onProgress?: (progress: BatchDownloadProgress) => void
  ): Promise<DownloadResult> {
    try {
      const filename = zipFilename || `ai_images_${Date.now()}.zip`
      
      // 解析所有 URL
      const resolvedUrls = urls.map(url => this.resolveR2Url(url))

      if (window.aiImageAPI?.downloadImagesAsZip) {
        const result = await window.aiImageAPI.downloadImagesAsZip(
          resolvedUrls,
          filename,
          (completed: number, total: number) => {
            onProgress?.({ completed, total })
            this.config.showToast?.(`正在下载 ${completed}/${total}`, 'info')
          },
          window.aiImageAPI.model
        )

        this.config.showToast?.(result.message || '批量下载完成', 'success')
        return { success: true, message: result.message || '批量下载完成' }
      }

      return { success: false, error: '批量下载不可用' }
    } catch (error) {
      const err = error as Error
      this.config.showToast?.(err.message || '批量下载失败', 'error')
      return { success: false, error: err.message }
    }
  }

  /**
   * 复制 URL 到剪贴板
   */
  async copyToClipboard(url: string): Promise<boolean> {
    try {
      // 解析 R2 URL
      const resolvedUrl = this.resolveR2Url(url)

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(resolvedUrl)
        this.config.onCopySuccess?.(resolvedUrl)
        this.config.showToast?.('URL 已复制到剪贴板', 'success')
        return true
      }

      // 降级到 execCommand
      return this.execCommandCopy(resolvedUrl)
    } catch (error) {
      const err = error as Error
      this.config.onCopyError?.(url, err)
      this.config.showToast?.('复制失败', 'error')
      return false
    }
  }

  /**
   * 打开图片查看器
   */
  viewImage(urls: string | string[], startIndex = 0): void {
    // 转换为数组
    const urlArray = typeof urls === 'string' ? [urls] : urls

    // 创建查看器配置
    const viewerOptions: ImageViewerOptions = {
      onDownload: async (url) => {
        await this.downloadImage(url)
      },
      onBatchDownload: async (allUrls) => {
        await this.downloadImagesAsZip(allUrls)
      },
      showToast: this.config.showToast
    }

    // 创建新的查看器实例
    this.viewer = createImageViewer(viewerOptions)
    this.viewer.open(urlArray, startIndex)

    // 预加载图片
    if (urlArray.length > 1 && window.aiImageAPI?.preloadImages) {
      window.aiImageAPI.preloadImages(urlArray)
    }
  }

  /**
   * 关闭图片查看器
   */
  closeViewer(): void {
    this.viewer?.close()
    this.viewer = null
  }

  /**
   * 从历史记录中解析 R2 URL
   */
  private resolveR2Url(url: string): string {
    if (!this.config.getHistory) {
      return url
    }

    const history = this.config.getHistory()
    
    // 查找包含此 URL 的历史记录
    const historyItem = history.find(item =>
      item.urls && item.urls.includes(url)
    )

    // 如果找到历史记录且已上传到 R2
    if (historyItem && historyItem.r2Storage && historyItem.urls) {
      const urlIndex = historyItem.urls.indexOf(url)
      const r2Url = historyItem.urls[urlIndex]
      
      if (r2Url && r2Url.includes('r2/images/')) {
        console.log('[ImageOperations] 使用 R2 URL')
        return r2Url
      }
    }

    return url
  }

  /**
   * 浏览器下载降级方案
   */
  private async browserDownload(url: string, filename?: string): Promise<DownloadResult> {
    try {
      // 如果是 base64
      if (url.startsWith('data:')) {
        const link = document.createElement('a')
        link.href = url
        link.download = filename || `image_${Date.now()}.png`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        
        this.config.showToast?.('图片下载成功', 'success')
        return { success: true, message: '图片下载成功' }
      }

      // 外部 URL
      const response = await fetch(url)
      const blob = await response.blob()
      const blobUrl = URL.createObjectURL(blob)

      const link = document.createElement('a')
      link.href = blobUrl
      link.download = filename || `image_${Date.now()}.png`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)

      URL.revokeObjectURL(blobUrl)
      
      this.config.showToast?.('图片下载成功', 'success')
      return { success: true, message: '图片下载成功' }
    } catch (error) {
      const err = error as Error
      this.config.showToast?.(err.message || '下载失败', 'error')
      return { success: false, error: err.message }
    }
  }

  /**
   * execCommand 复制降级方案
   */
  private execCommandCopy(text: string): boolean {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()

    try {
      const success = document.execCommand('copy')
      document.body.removeChild(textarea)
      
      if (success) {
        this.config.showToast?.('URL 已复制到剪贴板', 'success')
      }
      return success
    } catch {
      document.body.removeChild(textarea)
      return false
    }
  }

  /**
   * 预加载图片
   */
  preloadImages(urls: string[]): void {
    if (window.aiImageAPI?.preloadImages) {
      window.aiImageAPI.preloadImages(urls)
    } else {
      // 降级方案
      urls.forEach(url => {
        const img = new Image()
        img.src = url
      })
    }
  }

  /**
   * 获取图片信息
   */
  async getImageInfo(url: string): Promise<{
    width: number
    height: number
    size?: number
    type?: string
  } | null> {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        resolve({
          width: img.naturalWidth,
          height: img.naturalHeight
        })
      }
      img.onerror = () => {
        resolve(null)
      }
      img.src = url
    })
  }

  /**
   * 检查 URL 是否为 R2 存储
   * V16.3: 使用直接导入替代 window 全局变量
   */
  isR2Url(url: string): boolean {
    const r2Storage = getR2StorageService()
    return url.includes('r2/images/') || 
           (r2Storage?.isR2Url?.(url) ?? false)
  }
}

// 单例
let instance: ImageOperations | null = null

export function getImageOperations(config?: ImageOperationsConfig): ImageOperations {
  if (!instance) {
    instance = new ImageOperations(config)
  }
  return instance
}

export function createImageOperations(config?: ImageOperationsConfig): ImageOperations {
  return new ImageOperations(config)
}

// Window 类型扩展已在 src/types/index.ts 中定义
// 此处仅引用全局 Window 类型
