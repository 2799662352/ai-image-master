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
   * 上传 Base64 图片到对象存储。
   *
   * In Electron the upload is routed through the main process to Tencent
   * COS bucket `image-master-1345773498` (ap-guangzhou). The Cloudflare
   * Worker / R2 path is kept as a web-only fallback so this service still
   * works in dev/browser preview where `window.electronAPI` is absent.
   *
   * Why we kept the class name `R2StorageService`:
   *   Every history-page caller already depends on this method shape
   *   (`uploadBase64(dataUrl, metadata) → { url, key, success }`). Renaming
   *   would force a sweep across history / image-viewer / donor modules
   *   for cosmetic gain. The class is now a thin storage-router; rename in
   *   a follow-up if/when R2 fallback is removed.
   */
  async uploadBase64(base64Data: string, metadata: UploadMetadata = {}): Promise<UploadResult> {
    // 验证 base64 数据 — same validation regardless of backend.
    if (!base64Data?.startsWith('data:image')) {
      return { success: false, error: '无效的图片数据' }
    }
    const base64Match = base64Data.match(/^data:([^;]+);base64,(.+)$/)
    if (!base64Match) {
      return { success: false, error: '无效的 base64 数据格式' }
    }
    const mimeType = base64Match[1]
    const base64Content = base64Match[2]

    // Lazy-load default config when called before init() — keeps the
    // Tencent COS path usable even if isAvailable()/init() wasn't called.
    if (!this.config) {
      this.config = this.getDefaultConfig()
    }
    const base64Size = (base64Content.length * 3) / 4
    if (base64Size > this.config.features.maxFileSize) {
      return { success: false, error: '图片大小超过限制' }
    }

    // Electron path: route through Tencent COS via main process IPC.
    const cosApi = (window as any)?.electronAPI?.cos
    if (cosApi?.uploadImageHistory) {
      try {
        const result = await cosApi.uploadImageHistory(base64Content, mimeType, {
          ...metadata,
          source: 'ai-image-master',
          uploadedAt: new Date().toISOString(),
        })
        if (result?.success) {
          console.log('图片已上传到 Tencent COS:', result.url)
          return { success: true, url: result.url, key: result.key }
        }
        return { success: false, error: result?.error ?? '上传失败' }
      } catch (error) {
        console.error('Tencent COS 上传失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }

    // Web fallback path — Cloudflare Worker + R2.
    await this.init()
    if (!this.isAvailable()) {
      return { success: false, error: 'R2 服务不可用 (web fallback)' }
    }

    try {
      const { signature, timestamp, nonce } = this.generateSignature({
        type: 'upload',
        mimeType,
        size: base64Content.length
      })

      // 使用正确的 API 端点: /api/upload-base64
      const response = await fetch(`${this.workerUrl}/api/upload-base64`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-Timestamp': String(timestamp),
          'X-Nonce': nonce,
          'Origin': window.location.origin
        },
        body: JSON.stringify({
          base64: base64Content,
          mimeType,
          metadata: {
            ...metadata,
            source: 'ai-image-master',
            uploadedAt: new Date().toISOString()
          }
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        return { success: false, error: `上传失败: ${response.status} - ${errorText}` }
      }

      const result = await response.json()
      
      if (result.success && result.url) {
        console.log('图片已上传到 R2:', result.url)
        return {
          success: true,
          url: result.url,
          key: result.key
        }
      }

      return { success: false, error: result.error || '上传失败' }
    } catch (error) {
      console.error('R2 上传失败:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * 通过 URL 缓存图片到 R2
   */
  async uploadFromUrl(imageUrl: string, metadata: UploadMetadata = {}): Promise<UploadResult> {
    await this.init()

    if (!this.isAvailable()) {
      return { success: false, error: 'R2 服务不可用' }
    }

    // 如果已经是 R2 URL，直接返回
    if (this.isR2Url(imageUrl)) {
      return { success: true, url: imageUrl }
    }

    try {
      const { signature, timestamp, nonce } = this.generateSignature({
        type: 'cache',
        url: imageUrl
      })

      // 使用正确的 API 端点: /api/cache-image
      const response = await fetch(`${this.workerUrl}/api/cache-image`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-Timestamp': String(timestamp),
          'X-Nonce': nonce,
          'Origin': window.location.origin
        },
        body: JSON.stringify({
          url: imageUrl,
          metadata: {
            ...metadata,
            source: 'ai-image-master',
            cachedAt: new Date().toISOString()
          }
        })
      })

      if (!response.ok) {
        return { success: false, error: `缓存失败: ${response.status}` }
      }

      const result = await response.json()
      
      if (result.success && result.cachedUrl) {
        console.log('远程图片已缓存到 R2:', result.cachedUrl)
        return {
          success: true,
          url: result.cachedUrl,
          key: result.key
        }
      }

      return { success: false, error: result.error || '缓存失败' }
    } catch (error) {
      console.error('R2 缓存失败:', error)
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
      const { signature, timestamp, nonce } = this.generateSignature({
        type: 'delete',
        key
      })

      // 使用正确的 API 端点: /api/delete-image
      const response = await fetch(`${this.workerUrl}/api/delete-image`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-Timestamp': String(timestamp),
          'X-Nonce': nonce,
          'Origin': window.location.origin
        },
        body: JSON.stringify({
          key
        })
      })

      const result = await response.json()
      return result.success
    } catch (error) {
      console.error('删除图片失败:', error)
      return false
    }
  }

  /**
   * 批量处理图片上传到 R2（并行上传优化）
   */
  async batchProcess(urls: string[], concurrency: number = 4): Promise<string[]> {
    await this.init()

    if (!this.isAvailable()) {
      console.warn('[R2StorageService] 服务不可用，返回原始 URLs')
      return urls
    }

    console.log(`[R2StorageService] 开始并行上传 ${urls.length} 张图片，并发数: ${concurrency}`)
    const startTime = Date.now()

    // 单张图片上传处理函数
    const processUrl = async (url: string, index: number): Promise<{ index: number; result: string }> => {
      try {
        if (url.startsWith('data:image')) {
          // Base64 图片
          const result = await this.uploadBase64(url)
          if (result.success && result.url) {
            return { index, result: result.url }
          }
        } else if (url.startsWith('http')) {
          // 远程 URL
          const result = await this.uploadFromUrl(url)
          if (result.success && result.url) {
            return { index, result: result.url }
          }
        }
        // 其他类型或上传失败，保留原始 URL
        return { index, result: url }
      } catch (error) {
        console.error(`[R2StorageService] 上传第 ${index + 1} 张图片失败:`, error)
        return { index, result: url }
      }
    }

    // 并行上传（控制并发数）
    const results: string[] = new Array(urls.length)
    
    // 分批并行处理
    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency)
      const batchPromises = batch.map((url, batchIndex) => 
        processUrl(url, i + batchIndex)
      )
      
      const batchResults = await Promise.all(batchPromises)
      batchResults.forEach(({ index, result }) => {
        results[index] = result
      })
      
      console.log(`[R2StorageService] 已完成 ${Math.min(i + concurrency, urls.length)}/${urls.length} 张`)
    }

    const elapsed = Date.now() - startTime
    console.log(`[R2StorageService] 批量上传完成，耗时 ${elapsed}ms`)

    return results
  }

  /**
   * 检查是否为 R2 URL
   */
  isR2Url(url: string): boolean {
    if (!url || !this.workerUrl) return false

    // 检查是否为 R2 域名
    return url.includes('r2.imagen.apiyi.com') ||
           url.includes('r2.apiyi.com') ||
           url.includes('r2-image.apiyi.com') ||
           url.includes(this.workerUrl)
  }

  /**
   * 从 URL 提取 R2 Key
   */
  extractR2Key(url: string): string | null {
    if (!this.isR2Url(url)) return null

    try {
      const urlObj = new URL(url)
      // 提取路径部分作为 key
      // 例如: /flux/202501/xxx.jpg
      return urlObj.pathname.replace(/^\//, '')
    } catch (error) {
      console.error('提取 R2 Key 失败:', error)
      return null
    }
  }

  /**
   * 批量删除
   */
  async batchDelete(r2Keys: string[]): Promise<number> {
    const results = await Promise.allSettled(
      r2Keys.map(key => this.deleteImage(key))
    )

    const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length
    console.log(`批量删除完成: ${successCount}/${r2Keys.length} 成功`)

    return successCount
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
 * V16.6: 自动调用 init() 确保服务可用
 */
export function initR2StorageGlobal(): R2StorageService {
  const service = getR2StorageService()
  
  // V16.6: 确保服务初始化
  service.init().catch(err => {
    console.warn('[R2StorageService] 初始化失败:', err)
  })

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
