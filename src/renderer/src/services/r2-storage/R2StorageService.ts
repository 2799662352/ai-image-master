// src/renderer/src/services/r2-storage/R2StorageService.ts
/**
 * Cloudflare R2 存储服务
 * 处理云端图片存储和检索
 */

export interface R2Config {
  features: {
    autoCache: boolean
    maxFileSize: number
    allowedFormats: string[]
    ttl: number
  }
}

export interface UploadMetadata {
  model?: string
  prompt?: string
  source?: string
  [key: string]: any
}

export interface UploadResult {
  success: boolean
  url?: string
  key?: string
  error?: string
}

export interface R2ImageInfo {
  url: string
  key: string
  size?: number
  contentType?: string
  metadata?: Record<string, string>
}

const DEFAULT_CONFIG: R2Config = {
  features: {
    autoCache: true,
    maxFileSize: 52428800, // 50MB
    allowedFormats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    ttl: 2592000 // 30天
  }
}

const DEFAULT_WORKER_URL = 'https://ai-image-proxy.uchihasasiky.workers.dev'

export class R2StorageService {
  private workerUrl: string | null = null
  private config: R2Config | null = null
  private initialized = false
  private initPromise: Promise<void> | null = null

  constructor() {
    // 构造函数保持简单，实际初始化在 init() 中进行
  }

  /**
   * 初始化服务
   */
  async init(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._initialize()
    await this.initPromise
    this.initialized = true
  }

  private async _initialize(): Promise<void> {
    this.workerUrl = this.getLocalWorkerUrl()
    this.config = this.getDefaultConfig()

    if (this.workerUrl) {
      console.log('R2存储服务已初始化，Worker URL:', this.workerUrl)
    } else {
      this.workerUrl = DEFAULT_WORKER_URL
      console.log('使用默认 Worker URL:', this.workerUrl)
    }
  }

  /**
   * 获取本地配置的 Worker URL
   */
  private getLocalWorkerUrl(): string | null {
    return localStorage.getItem('worker_url') ||
           window.CLOUDFLARE_WORKER_URL ||
           null
  }

  /**
   * 获取默认配置
   */
  getDefaultConfig(): R2Config {
    return { ...DEFAULT_CONFIG }
  }

  /**
   * 检查服务是否可用
   */
  isAvailable(): boolean {
    const hasWorkerUrl = !!this.workerUrl || !!this.getLocalWorkerUrl()

    if (hasWorkerUrl && !this.workerUrl) {
      this.workerUrl = this.getLocalWorkerUrl()
      this.config = this.getDefaultConfig()
      console.log('使用本地配置的 Worker URL:', this.workerUrl)
    }

    return !!this.workerUrl
  }

  /**
   * 生成签名
   */
  private generateSignature(data: any): { signature: string; timestamp: number; nonce: string } {
    const timestamp = Date.now()
    const nonce = Math.random().toString(36).substring(2)
    const signString = `${timestamp}:${nonce}:${JSON.stringify(data)}`
    const signature = btoa(signString)

    return { signature, timestamp, nonce }
  }

  /**
   * 上传 Base64 图片到 R2
   */
  async uploadBase64(base64Data: string, metadata: UploadMetadata = {}): Promise<UploadResult> {
    await this.init()

    if (!this.isAvailable()) {
      return { success: false, error: 'R2 服务不可用' }
    }

    try {
      // 验证 base64 数据
      if (!base64Data?.startsWith('data:image')) {
        return { success: false, error: '无效的图片数据' }
      }

      // 检查文件大小
      const base64Size = (base64Data.length * 3) / 4
      if (this.config && base64Size > this.config.features.maxFileSize) {
        return { success: false, error: '图片大小超过限制' }
      }

      const { signature, timestamp, nonce } = this.generateSignature({ action: 'upload' })

      const response = await fetch(`${this.workerUrl}/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-Timestamp': String(timestamp),
          'X-Nonce': nonce
        },
        body: JSON.stringify({
          image: base64Data,
          metadata
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        return { success: false, error: `上传失败: ${response.status} - ${errorText}` }
      }

      const result = await response.json()
      return {
        success: true,
        url: result.url,
        key: result.key
      }
    } catch (error) {
      console.error('R2 上传失败:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * 通过 URL 上传图片到 R2
   */
  async uploadFromUrl(imageUrl: string, metadata: UploadMetadata = {}): Promise<UploadResult> {
    await this.init()

    if (!this.isAvailable()) {
      return { success: false, error: 'R2 服务不可用' }
    }

    try {
      const { signature, timestamp, nonce } = this.generateSignature({ action: 'proxy-upload' })

      const response = await fetch(`${this.workerUrl}/proxy-upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-Timestamp': String(timestamp),
          'X-Nonce': nonce
        },
        body: JSON.stringify({
          url: imageUrl,
          metadata
        })
      })

      if (!response.ok) {
        return { success: false, error: `代理上传失败: ${response.status}` }
      }

      const result = await response.json()
      return {
        success: true,
        url: result.url,
        key: result.key
      }
    } catch (error) {
      console.error('R2 代理上传失败:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * 获取图片信息
   */
  async getImageInfo(key: string): Promise<R2ImageInfo | null> {
    await this.init()

    if (!this.isAvailable()) {
      return null
    }

    try {
      const response = await fetch(`${this.workerUrl}/info/${key}`)
      if (!response.ok) {
        return null
      }
      return await response.json()
    } catch (error) {
      console.error('获取图片信息失败:', error)
      return null
    }
  }

  /**
   * 删除图片
   */
  async deleteImage(key: string): Promise<boolean> {
    await this.init()

    if (!this.isAvailable()) {
      return false
    }

    try {
      const { signature, timestamp, nonce } = this.generateSignature({ action: 'delete', key })

      const response = await fetch(`${this.workerUrl}/delete/${key}`, {
        method: 'DELETE',
        headers: {
          'X-Signature': signature,
          'X-Timestamp': String(timestamp),
          'X-Nonce': nonce
        }
      })

      return response.ok
    } catch (error) {
      console.error('删除图片失败:', error)
      return false
    }
  }

  /**
   * 获取 Worker URL
   */
  getWorkerUrl(): string | null {
    return this.workerUrl
  }

  /**
   * 设置 Worker URL
   */
  setWorkerUrl(url: string): void {
    this.workerUrl = url
    localStorage.setItem('worker_url', url)
  }

  /**
   * 获取配置
   */
  getConfig(): R2Config | null {
    return this.config
  }
}

// 创建单例
let instance: R2StorageService | null = null

export function getR2StorageService(): R2StorageService {
  if (!instance) {
    instance = new R2StorageService()
  }
  return instance
}

export function createR2StorageService(): R2StorageService {
  return new R2StorageService()
}

/**
 * 重置单例（仅用于测试）
 */
export function resetR2StorageService(): void {
  instance = null
}

// ========================================
// V16.2 B3 - 过渡期 window 暴露
// V16.3 - 添加废弃警告
// ========================================

declare global {
  interface Window {
    r2Storage: R2StorageService
    r2StorageTS: R2StorageService
    R2StorageServiceTS: typeof R2StorageService
  }
}

let r2StorageDeprecationWarningShown = false

/**
 * 初始化并暴露到 window（过渡期）
 * V16.3: 添加废弃警告
 */
export function initR2StorageGlobal(): R2StorageService {
  const service = getR2StorageService()

  // 过渡期: 暴露到 window (带废弃警告)
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'r2Storage', {
      get() {
        if (!r2StorageDeprecationWarningShown && process.env.NODE_ENV !== 'production') {
          console.warn(
            '[DEPRECATED] window.r2Storage 已废弃。' +
            '请使用 Services.get("r2Storage") 或 import { getR2StorageService } from "@/services/r2-storage"'
          )
          r2StorageDeprecationWarningShown = true
        }
        return service
      },
      configurable: true
    })
    
    window.r2StorageTS = service
    window.R2StorageServiceTS = R2StorageService
  }

  console.log('[V16.3] R2StorageService TypeScript 版本已加载 (废弃警告已启用)')

  return service
}
