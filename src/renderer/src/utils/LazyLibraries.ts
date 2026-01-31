/**
 * LazyLibraries - 延迟加载第三方库
 * V18: 减少初始加载时间，按需加载大型第三方库
 * 
 * 基于 Context7 Vite 最佳实践:
 * - 使用动态 import() 进行代码分割
 * - Vite 自动优化异步 chunk 加载
 */

// 缓存已加载的库实例
let jsZipInstance: typeof import('jszip') | null = null
let imageCompressionInstance: typeof import('browser-image-compression') | null = null

// 加载状态
let jsZipLoading: Promise<typeof import('jszip')> | null = null
let imageCompressionLoading: Promise<typeof import('browser-image-compression')> | null = null

/**
 * 延迟加载 JSZip
 * 用于: 批量下载、ZIP 打包功能
 * 库大小: ~97 kB
 */
export async function getJSZip(): Promise<typeof import('jszip')['default']> {
  if (jsZipInstance) {
    return jsZipInstance.default
  }

  if (!jsZipLoading) {
    console.log('[LazyLibraries] 🔄 开始加载 JSZip...')
    const startTime = performance.now()
    
    jsZipLoading = import('jszip').then(module => {
      jsZipInstance = module
      const loadTime = performance.now() - startTime
      console.log(`[LazyLibraries] ✅ JSZip 加载完成 (${loadTime.toFixed(1)}ms)`)
      return module
    })
  }

  const module = await jsZipLoading
  return module.default
}

/**
 * 延迟加载 browser-image-compression
 * 用于: 图片压缩、上传前处理
 * 库大小: 包含在 vendor chunk
 */
export async function getImageCompression(): Promise<typeof import('browser-image-compression')['default']> {
  if (imageCompressionInstance) {
    return imageCompressionInstance.default
  }

  if (!imageCompressionLoading) {
    console.log('[LazyLibraries] 🔄 开始加载 browser-image-compression...')
    const startTime = performance.now()
    
    imageCompressionLoading = import('browser-image-compression').then(module => {
      imageCompressionInstance = module
      const loadTime = performance.now() - startTime
      console.log(`[LazyLibraries] ✅ browser-image-compression 加载完成 (${loadTime.toFixed(1)}ms)`)
      return module
    })
  }

  const module = await imageCompressionLoading
  return module.default
}

/**
 * 预加载库 (用于用户空闲时预取)
 * 可在 requestIdleCallback 中调用
 */
export function preloadLibraries(): void {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => {
      // 预加载但不阻塞
      getJSZip().catch(() => {})
      getImageCompression().catch(() => {})
    }, { timeout: 5000 })
  }
}

/**
 * 检查库是否已加载
 */
export function isJSZipLoaded(): boolean {
  return jsZipInstance !== null
}

export function isImageCompressionLoaded(): boolean {
  return imageCompressionInstance !== null
}

/**
 * 获取加载状态
 */
export function getLibraryLoadStatus(): {
  jszip: 'loaded' | 'loading' | 'not-loaded'
  imageCompression: 'loaded' | 'loading' | 'not-loaded'
} {
  return {
    jszip: jsZipInstance ? 'loaded' : (jsZipLoading ? 'loading' : 'not-loaded'),
    imageCompression: imageCompressionInstance ? 'loaded' : (imageCompressionLoading ? 'loading' : 'not-loaded')
  }
}
