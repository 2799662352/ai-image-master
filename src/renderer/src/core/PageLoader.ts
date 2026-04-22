// src/renderer/src/core/PageLoader.ts
/**
 * 页面懒加载器
 * 实现非首屏页面的动态导入和加载
 */

export interface PageLoaderConfig {
  /** 首屏页面列表（不需要懒加载） */
  criticalPages: string[]
  /** 页面模块映射 */
  pageModules: Record<string, () => Promise<any>>
  /** 加载完成回调 */
  onPageLoaded?: (pageName: string, module: any) => void
  /** 加载失败回调 */
  onLoadError?: (pageName: string, error: Error) => void
  /** 显示加载指示器 */
  showLoadingIndicator?: boolean
}

export interface LoadingState {
  pageName: string
  status: 'idle' | 'loading' | 'loaded' | 'error'
  module?: any
  error?: Error
}

const DEFAULT_CONFIG: PageLoaderConfig = {
  criticalPages: ['generate'],
  pageModules: {},
  showLoadingIndicator: true
}

export class PageLoader {
  private config: PageLoaderConfig
  private loadedPages: Map<string, any> = new Map()
  private loadingPromises: Map<string, Promise<any>> = new Map()
  private loadingStates: Map<string, LoadingState> = new Map()

  constructor(config: Partial<PageLoaderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 注册页面模块
   */
  registerPage(pageName: string, loader: () => Promise<any>): void {
    this.config.pageModules[pageName] = loader
  }

  /**
   * 批量注册页面模块
   */
  registerPages(pages: Record<string, () => Promise<any>>): void {
    Object.assign(this.config.pageModules, pages)
  }

  /**
   * 加载页面模块
   */
  async loadPage(pageName: string): Promise<any> {
    // 如果已经加载，直接返回
    if (this.loadedPages.has(pageName)) {
      return this.loadedPages.get(pageName)
    }

    // 如果正在加载，返回加载中的 Promise
    if (this.loadingPromises.has(pageName)) {
      return this.loadingPromises.get(pageName)
    }

    // 检查是否有对应的加载器
    const loader = this.config.pageModules[pageName]
    if (!loader) {
      console.warn(`[PageLoader] 未找到页面 ${pageName} 的加载器`)
      return null
    }

    // 更新加载状态
    this.updateLoadingState(pageName, 'loading')

    // 显示加载指示器
    if (this.config.showLoadingIndicator) {
      this.showLoading(pageName)
    }

    // 创建加载 Promise
    const loadPromise = (async () => {
      try {
        console.log(`[PageLoader] 开始加载页面: ${pageName}`)
        const module = await loader()
        
        // 存储加载的模块
        this.loadedPages.set(pageName, module)
        this.updateLoadingState(pageName, 'loaded', module)
        
        // 调用回调
        this.config.onPageLoaded?.(pageName, module)
        
        console.log(`[PageLoader] 页面 ${pageName} 加载完成`)
        return module
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        console.error(`[PageLoader] 加载页面 ${pageName} 失败:`, err)
        
        this.updateLoadingState(pageName, 'error', undefined, err)
        this.config.onLoadError?.(pageName, err)
        
        throw err
      } finally {
        this.loadingPromises.delete(pageName)
        if (this.config.showLoadingIndicator) {
          this.hideLoading(pageName)
        }
      }
    })()

    this.loadingPromises.set(pageName, loadPromise)
    return loadPromise
  }

  /**
   * 预加载页面
   */
  async preloadPage(pageName: string): Promise<void> {
    if (!this.loadedPages.has(pageName) && !this.loadingPromises.has(pageName)) {
      try {
        await this.loadPage(pageName)
      } catch {
        // 预加载失败时静默处理
      }
    }
  }

  /**
   * 预加载多个页面
   */
  async preloadPages(pageNames: string[]): Promise<void> {
    const promises = pageNames.map(name => this.preloadPage(name))
    await Promise.allSettled(promises)
  }

  /**
   * 在空闲时预加载非关键页面
   */
  preloadNonCriticalPages(): void {
    const nonCriticalPages = Object.keys(this.config.pageModules).filter(
      name => !this.config.criticalPages.includes(name)
    )

    if ('requestIdleCallback' in window) {
      (window as any).requestIdleCallback(() => {
        this.preloadPages(nonCriticalPages)
      }, { timeout: 3000 })
    } else {
      // Fallback for browsers without requestIdleCallback
      setTimeout(() => {
        this.preloadPages(nonCriticalPages)
      }, 2000)
    }
  }

  /**
   * 检查页面是否已加载
   */
  isPageLoaded(pageName: string): boolean {
    return this.loadedPages.has(pageName)
  }

  /**
   * 检查页面是否正在加载
   */
  isPageLoading(pageName: string): boolean {
    return this.loadingPromises.has(pageName)
  }

  /**
   * 检查页面是否为首屏关键页面
   */
  isCriticalPage(pageName: string): boolean {
    return this.config.criticalPages.includes(pageName)
  }

  /**
   * 获取页面模块
   */
  getPage(pageName: string): any | undefined {
    return this.loadedPages.get(pageName)
  }

  /**
   * 获取所有已加载的页面
   */
  getLoadedPages(): string[] {
    return Array.from(this.loadedPages.keys())
  }

  /**
   * 获取加载状态
   */
  getLoadingState(pageName: string): LoadingState | undefined {
    return this.loadingStates.get(pageName)
  }

  /**
   * 更新加载状态
   */
  private updateLoadingState(
    pageName: string, 
    status: LoadingState['status'], 
    module?: any, 
    error?: Error
  ): void {
    this.loadingStates.set(pageName, {
      pageName,
      status,
      module,
      error
    })
  }

  /**
   * 显示加载指示器
   */
  private showLoading(pageName: string): void {
    const panel = document.getElementById(`${pageName}Panel`)
    if (!panel) return

    // 检查是否已有加载指示器
    if (panel.querySelector('.page-loading-indicator')) return

    const indicator = document.createElement('div')
    indicator.className = 'page-loading-indicator fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]'
    indicator.innerHTML = `
      <div class="bg-white rounded-lg p-6 shadow-xl flex items-center space-x-4">
        <div class="animate-spin rounded-full h-8 w-8 border-4 border-blue-500 border-t-transparent"></div>
        <span class="text-gray-700 font-medium">正在加载页面...</span>
      </div>
    `
    panel.appendChild(indicator)
  }

  /**
   * 隐藏加载指示器
   */
  private hideLoading(pageName: string): void {
    const panel = document.getElementById(`${pageName}Panel`)
    if (!panel) return

    const indicator = panel.querySelector('.page-loading-indicator')
    if (indicator) {
      indicator.remove()
    }
  }

  /**
   * 卸载页面
   */
  unloadPage(pageName: string): void {
    const module = this.loadedPages.get(pageName)
    if (module?.destroy) {
      module.destroy()
    }
    this.loadedPages.delete(pageName)
    this.loadingStates.delete(pageName)
  }

  /**
   * 清除所有已加载的页面
   */
  clear(): void {
    this.loadedPages.forEach((module, pageName) => {
      if (module?.destroy) {
        module.destroy()
      }
    })
    this.loadedPages.clear()
    this.loadingPromises.clear()
    this.loadingStates.clear()
  }
}

// 单例实例
let pageLoaderInstance: PageLoader | null = null

/**
 * 获取 PageLoader 单例
 */
export function getPageLoader(config?: Partial<PageLoaderConfig>): PageLoader {
  if (!pageLoaderInstance) {
    pageLoaderInstance = new PageLoader(config)
  }
  return pageLoaderInstance
}

/**
 * 创建新的 PageLoader 实例
 */
export function createPageLoader(config?: Partial<PageLoaderConfig>): PageLoader {
  return new PageLoader(config)
}

/**
 * 默认页面模块配置
 * 用于懒加载非首屏页面
 */
export const defaultPageModules: Record<string, () => Promise<any>> = {
  // 首屏关键页面 - 不需要懒加载
  // generate: () => import('@/pages/generate'),
  
  // 非首屏页面 - 懒加载
  history: () => import('../features/history'),
  // batch: () => import('../pages/batch'),
  // compare: () => import('../pages/compare'),
  // director: () => import('../pages/director'),
  // understand: () => import('../pages/understand'),
}

/**
 * 重置单例（仅用于测试）
 */
export function resetPageLoader(): void {
  pageLoaderInstance = null
}

// ========================================
// V16.2 D - 过渡期 window 暴露
// ========================================

declare global {
  interface Window {
    pageLoader: PageLoader
    pageLoaderTS: PageLoader
    PageLoaderTS: typeof PageLoader
  }
}

/**
 * 初始化并暴露到 window（过渡期）
 */
export function initPageLoaderGlobal(config?: Partial<PageLoaderConfig>): PageLoader {
  const loader = getPageLoader(config)

  // 过渡期: 暴露到 window
  if (typeof window !== 'undefined') {
    window.pageLoader = loader
    window.pageLoaderTS = loader
    window.PageLoaderTS = PageLoader
  }

  console.log('[V16.2] PageLoader TypeScript 版本已加载')

  return loader
}
