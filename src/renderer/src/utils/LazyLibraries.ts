/**
 * LazyLibraries - 延迟加载第三方库
 * V18: 减少初始加载时间，按需加载大型第三方库
 * 
 * 基于 Context7 Vite 最佳实践:
 * - 使用动态 import() 进行代码分割
 * - Vite 自动优化异步 chunk 加载
 */

/**
 * jszip 3.x 的类型声明是 `export = JSZip`,所以 `typeof import('jszip')` 就是
 * 构造器本身、**没有** `default` 成员 —— 原来写的 `['default']` 从来不存在。
 */
type JSZipCtor = typeof import('jszip')

/**
 * 同一份 CJS 模块经打包后可能以两种形状抵达:构造器本身,或 esModuleInterop
 * 包出来的 `{ default: 构造器 }` 命名空间(取决于谁来处理这次 `import()`)。
 * 这里按运行时形状取,而不是赌其中一种。
 */
function unwrapJSZip(module: JSZipCtor | { default: JSZipCtor }): JSZipCtor {
  return typeof module === 'function' ? module : module.default
}

// 缓存已加载的库实例
let jsZipCtor: JSZipCtor | null = null
let imageCompressionInstance: typeof import('browser-image-compression') | null = null

// 加载状态
let jsZipLoading: Promise<JSZipCtor> | null = null
let imageCompressionLoading: Promise<typeof import('browser-image-compression')> | null = null

/**
 * 延迟加载 JSZip
 * 用于: 批量下载、ZIP 打包功能
 * 库大小: ~97 kB
 */
export async function getJSZip(): Promise<JSZipCtor> {
  if (jsZipCtor) {
    return jsZipCtor
  }

  // 用局部变量持有本次的 promise 再返回:模块级 `let` 被闭包捕获后 TS 不再认
  // 「刚在 if 里赋过值所以非 null」,直接 await 那个变量会被判 possibly null。
  let loading = jsZipLoading
  if (!loading) {
    console.log('[LazyLibraries] 🔄 开始加载 JSZip...')
    const startTime = performance.now()

    loading = import('jszip').then(module => {
      const ctor = unwrapJSZip(module)
      jsZipCtor = ctor
      const loadTime = performance.now() - startTime
      console.log(`[LazyLibraries] ✅ JSZip 加载完成 (${loadTime.toFixed(1)}ms)`)
      return ctor
    })
    jsZipLoading = loading
  }

  return loading
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
  return jsZipCtor !== null
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
    jszip: jsZipCtor ? 'loaded' : (jsZipLoading ? 'loading' : 'not-loaded'),
    imageCompression: imageCompressionInstance ? 'loaded' : (imageCompressionLoading ? 'loading' : 'not-loaded')
  }
}
