/**
 * AppBootstrap - 应用启动引导模块
 * 
 * 负责应用的初始化流程，使用单例模式确保只初始化一次。
 * 分离关键路径和非关键路径初始化，优化启动性能。
 * 
 * V16.4: 增强为完整的应用引导器，替代 app.js
 */

import { ServiceRegistry, SERVICE_KEYS } from '../services/ServiceBridge'

// 页面注册表类型
export interface PageRegistry {
  generate?: any
  batch?: any
  history?: any
  compare?: any
  understand?: any
  director?: any
  promptTemplates?: any
}

export interface BootstrapConfig {
  /** 必需的 DOM 元素 ID 列表 */
  requiredElements?: string[]
  /** DOM 检查最大重试次数 */
  maxRetries?: number
  /** 重试间隔 (ms) */
  retryDelay?: number
  /** 非关键功能延迟超时 (ms) */
  idleTimeout?: number
}

export interface BootstrapState {
  initialized: boolean
  criticalReady: boolean
  nonCriticalReady: boolean
  retryCount: number
  error: Error | null
}

type InitCallback = () => void | Promise<void>

const DEFAULT_CONFIG: Required<BootstrapConfig> = {
  requiredElements: [
    'modelSelector',
    'modelSelectorMobile',
    'referenceImageArea',
    'batchReferenceImageArea'
  ],
  maxRetries: 5,
  retryDelay: 200,
  idleTimeout: 2000
}

/**
 * AppBootstrap 单例类
 * 管理应用的启动初始化流程
 */
export class AppBootstrap {
  private static instance: AppBootstrap | null = null
  
  private config: Required<BootstrapConfig>
  private state: BootstrapState
  private criticalCallbacks: InitCallback[] = []
  private nonCriticalCallbacks: InitCallback[] = []
  private readyCallbacks: Array<() => void> = []
  
  private constructor(config: BootstrapConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.state = {
      initialized: false,
      criticalReady: false,
      nonCriticalReady: false,
      retryCount: 0,
      error: null
    }
  }
  
  /**
   * 获取单例实例
   */
  static getInstance(config?: BootstrapConfig): AppBootstrap {
    if (!AppBootstrap.instance) {
      AppBootstrap.instance = new AppBootstrap(config)
    }
    return AppBootstrap.instance
  }
  
  /**
   * 重置单例 (仅用于测试)
   */
  static resetInstance(): void {
    AppBootstrap.instance = null
  }
  
  /**
   * 获取当前状态
   */
  getState(): Readonly<BootstrapState> {
    return { ...this.state }
  }
  
  /**
   * 注册关键路径初始化回调
   */
  onCriticalInit(callback: InitCallback): this {
    this.criticalCallbacks.push(callback)
    return this
  }
  
  /**
   * 注册非关键路径初始化回调
   */
  onNonCriticalInit(callback: InitCallback): this {
    this.nonCriticalCallbacks.push(callback)
    return this
  }
  
  /**
   * 注册应用就绪回调
   */
  onReady(callback: () => void): this {
    if (this.state.criticalReady) {
      // 已就绪，立即执行
      callback()
    } else {
      this.readyCallbacks.push(callback)
    }
    return this
  }
  
  /**
   * 启动应用初始化
   */
  async init(): Promise<void> {
    if (this.state.initialized) {
      console.log('[AppBootstrap] 已初始化，跳过重复初始化')
      return
    }
    
    console.log('[AppBootstrap] 开始应用初始化...')
    
    try {
      // 检查 DOM 元素
      const domReady = await this.waitForDOM()
      if (!domReady) {
        throw new Error('关键 DOM 元素加载超时')
      }
      
      // 执行关键路径初始化
      await this.runCriticalInit()
      
      // 标记关键路径完成
      this.state.criticalReady = true
      this.state.initialized = true
      
      // 触发就绪事件
      this.dispatchReady()
      
      // 调度非关键路径初始化
      this.scheduleNonCriticalInit()
      
      console.log('[AppBootstrap] 初始化完成')
      
    } catch (error) {
      this.state.error = error as Error
      console.error('[AppBootstrap] 初始化失败:', error)
      this.showErrorUI(error as Error)
      throw error
    }
  }
  
  /**
   * 等待 DOM 元素就绪
   */
  private async waitForDOM(): Promise<boolean> {
    const { requiredElements, maxRetries, retryDelay } = this.config
    
    const checkElements = (): string[] => {
      return requiredElements.filter(id => !document.getElementById(id))
    }
    
    let missing = checkElements()
    
    while (missing.length > 0 && this.state.retryCount < maxRetries) {
      console.log(`[AppBootstrap] 等待 DOM 元素: ${missing.join(', ')} (重试 ${this.state.retryCount + 1}/${maxRetries})`)
      
      await new Promise(resolve => setTimeout(resolve, retryDelay))
      this.state.retryCount++
      missing = checkElements()
    }
    
    if (missing.length > 0) {
      console.warn(`[AppBootstrap] 以下 DOM 元素未找到: ${missing.join(', ')}`)
      // 仍然继续初始化，但发出警告
    }
    
    return true
  }
  
  /**
   * 执行关键路径初始化
   */
  private async runCriticalInit(): Promise<void> {
    console.log('[AppBootstrap] 执行关键路径初始化...')
    
    for (const callback of this.criticalCallbacks) {
      try {
        await callback()
      } catch (error) {
        console.error('[AppBootstrap] 关键初始化回调失败:', error)
        throw error
      }
    }
    
    console.log('[AppBootstrap] 关键路径初始化完成')
  }
  
  /**
   * 调度非关键路径初始化
   */
  private scheduleNonCriticalInit(): void {
    const runNonCritical = async () => {
      console.log('[AppBootstrap] 开始非关键功能初始化...')
      
      for (const callback of this.nonCriticalCallbacks) {
        try {
          await callback()
        } catch (error) {
          // 非关键功能失败不中断应用
          console.warn('[AppBootstrap] 非关键初始化回调失败:', error)
        }
      }
      
      this.state.nonCriticalReady = true
      console.log('[AppBootstrap] 非关键功能初始化完成')
    }
    
    // 使用 requestIdleCallback 或降级到 setTimeout
    try {
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window && typeof (window as any).requestIdleCallback === 'function') {
        (window as any).requestIdleCallback(runNonCritical, { timeout: this.config.idleTimeout })
      } else {
        setTimeout(runNonCritical, 100)
      }
    } catch {
      // 降级到 setTimeout
      setTimeout(runNonCritical, 100)
    }
  }
  
  /**
   * 触发应用就绪事件
   */
  private dispatchReady(): void {
    // 设置全局标志
    if (typeof window !== 'undefined') {
      (window as Window & { appInitialized?: boolean }).appInitialized = true
      try {
        if (typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new Event('appReady'))
        }
      } catch {
        // 忽略测试环境中的错误
      }
    }
    
    // 执行注册的回调
    for (const callback of this.readyCallbacks) {
      try {
        callback()
      } catch (error) {
        console.warn('[AppBootstrap] 就绪回调执行失败:', error)
      }
    }
    
    console.log('[AppBootstrap] appReady 事件已触发')
  }
  
  /**
   * 显示错误 UI
   */
  private showErrorUI(error: Error): void {
    if (typeof document === 'undefined') return
    
    const errorDiv = document.createElement('div')
    errorDiv.className = 'app-bootstrap-error'
    errorDiv.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(220, 38, 38, 0.95);
      color: white;
      padding: 2rem;
      border-radius: 1rem;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
      z-index: 9999;
      max-width: 500px;
      text-align: center;
    `
    
    errorDiv.innerHTML = `
      <h2 style="margin-bottom: 1rem; font-size: 1.25rem; font-weight: bold;">应用初始化失败</h2>
      <p style="margin-bottom: 1rem; opacity: 0.9;">${this.escapeHtml(error.message)}</p>
      <button 
        onclick="location.reload()" 
        style="
          background: white;
          color: #dc2626;
          border: none;
          padding: 0.5rem 1rem;
          border-radius: 0.5rem;
          cursor: pointer;
          font-weight: 600;
        "
      >刷新页面</button>
    `
    
    document.body.appendChild(errorDiv)
  }
  
  /**
   * HTML 转义
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  // ========================================
  // V16.4 - 完整应用引导方法 (替代 app.js)
  // ========================================

  /** 页面注册表 */
  private pages: PageRegistry = {}
  
  /** 当前活动标签页 */
  private currentTab = 'generate'
  
  /** 历史记录 */
  private history: any[] = []

  /**
   * 完整的应用引导流程 (替代 app.init())
   * V16.4: 这是新的主入口点
   */
  async bootstrap(): Promise<void> {
    if (this.state.initialized) {
      console.log('[AppBootstrap] 已初始化，跳过')
      return
    }

    console.log('[AppBootstrap] 🚀 开始完整应用引导...')
    const startTime = performance.now()

    try {
      // ========== 关键路径：立即执行 ==========
      
      // 1. 初始化国际化系统（最优先）
      await this.initI18nWithTimeout()

      // 2. 初始化页面模块
      this.initPages()

      // 3. 初始化模型选择器
      await this.initModelSelectorWithRetry()

      // 4. 加载已存储的 API Key
      this.loadStoredApiKey()

      // 标记关键路径完成
      this.state.criticalReady = true
      this.state.initialized = true

      // 触发应用就绪事件
      this.dispatchReady()

      const criticalTime = performance.now() - startTime
      console.log(`[AppBootstrap] ✅ 关键初始化完成: ${criticalTime.toFixed(1)}ms`)

      // ========== 非关键路径：延迟执行 ==========
      this.scheduleNonCriticalBootstrap()

    } catch (error) {
      this.state.error = error as Error
      console.error('[AppBootstrap] ❌ 引导失败:', error)
      this.showErrorUI(error as Error)
      throw error
    }
  }

  /**
   * 初始化国际化系统（带超时保护）
   */
  private async initI18nWithTimeout(): Promise<void> {
    console.log('[AppBootstrap] 初始化国际化系统...')
    
    try {
      const i18n = ServiceRegistry.get<any>(SERVICE_KEYS.I18N)
      if (!i18n) {
        // 回退到 window.i18n
        const windowI18n = (window as any).i18n || (window as any).i18nServiceTS
        if (windowI18n) {
          const initPromise = windowI18n.init()
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('I18N init timeout')), 1000)
          )
          
          const currentLang = await Promise.race([initPromise, timeoutPromise])
          console.log(`[AppBootstrap] ✅ i18n 初始化完成: ${currentLang}`)
          
          // 注册语言切换回调
          this.setupI18nCallbacks(windowI18n)
        }
      } else {
        await i18n.init()
        this.setupI18nCallbacks(i18n)
      }
    } catch (error) {
      console.warn('[AppBootstrap] ⚠️ i18n 初始化失败或超时，使用默认语言:', (error as Error).message)
      // 不抛出错误，继续初始化
    }
  }

  /**
   * 设置 i18n 语言切换回调
   */
  private setupI18nCallbacks(i18n: any): void {
    if (!i18n?.onLanguageChange) return

    i18n.onLanguageChange((lang: string) => {
      console.log(`[AppBootstrap] 语言已切换: ${lang}`)

      // 重新渲染动态生成的 UI 元素
      const api = (window as any).aiImageAPI
      const currentModel = api?.getCurrentModel()
      if (currentModel) {
        const ratioManager = ServiceRegistry.get<any>(SERVICE_KEYS.RATIO_RESOLUTION)
        ratioManager?.renderRatioOptions(currentModel, this.pages.generate)
        ratioManager?.renderResolutionOptions(currentModel, this.pages.generate)
      }

      // 更新模型选择器显示名称
      const modelSelector = ServiceRegistry.get<any>(SERVICE_KEYS.MODEL_SELECTOR)
      modelSelector?.updateDisplayNames()

      // 通知所有页面模块语言已切换
      Object.values(this.pages).forEach((page: any) => {
        if (page && typeof page.onLanguageChange === 'function') {
          page.onLanguageChange(lang)
        }
      })

      // 更新 API 状态显示
      const siteManager = ServiceRegistry.get<any>(SERVICE_KEYS.SITE_MANAGER)
      siteManager?.updateApiStatusDisplay()

      // 更新 SEO 标签
      const languageManager = ServiceRegistry.get<any>(SERVICE_KEYS.LANGUAGE)
      languageManager?.updateSEOForLanguage(lang)
    })

    // 更新语言选择器显示
    const languageManager = ServiceRegistry.get<any>(SERVICE_KEYS.LANGUAGE)
    languageManager?.updateSwitcherDisplay(i18n.getCurrentLanguage?.() || 'zh-CN')
  }

  /**
   * 初始化所有页面模块 (替代 app.initPages())
   */
  private initPages(): void {
    console.log('[AppBootstrap] 初始化页面模块...')

    // 使用 TypeScript 页面工厂函数创建页面实例
    const w = window as any
    
    this.pages = {
      generate: w.createGeneratePageTS?.(this.createAppProxy()),
      batch: w.createBatchPageTS?.(this.createAppProxy()),
      history: w.createHistoryPageTS?.(this.createAppProxy()),
      compare: w.createComparePageTS?.(this.createAppProxy()),
      understand: w.createUnderstandPageTS?.(this.createAppProxy()),
      director: w.createDirectorPageTS?.(this.createAppProxy())
    }

    // 初始化提示词模板模块
    this.pages.promptTemplates = w.createPromptTemplatesTS?.(this.createAppProxy())

    // 设置全局引用便于其他模块访问 (过渡期)
    w.generatePage = this.pages.generate
    w.batchPage = this.pages.batch
    w.comparePage = this.pages.compare
    w.understandPage = this.pages.understand
    w.directorPage = this.pages.director
    w.promptTemplates = this.pages.promptTemplates

    console.log('[AppBootstrap] ✅ 页面模块初始化完成')
  }

  /**
   * 创建 app 代理对象（兼容旧页面模块）
   * V16.4: 这提供了与原 app 对象相同的接口
   */
  private createAppProxy(): any {
    const self = this
    return {
      // 页面和标签管理
      get pages() { return self.pages },
      get currentTab() { return self.currentTab },
      switchTab: (tab: string, updateUrl = true) => {
        const tabManager = ServiceRegistry.get<any>(SERVICE_KEYS.TAB_MANAGER)
        tabManager?.setPages(this.pages)
        tabManager?.switchTab(tab, updateUrl)
        self.currentTab = tab
      },

      // Toast 和错误处理
      showToast: (msg: string, type = 'info') => {
        const toast = ServiceRegistry.get<any>(SERVICE_KEYS.TOAST)
        toast?.show(msg, type)
      },
      showDetailedError: (error: any, context = '') => {
        const errorHandler = ServiceRegistry.get<any>(SERVICE_KEYS.ERROR_HANDLER)
        errorHandler?.showDetailedError(error, context)
      },

      // 历史记录
      get history() { return self.history },
      addToHistory: (type: string, prompt: string, urls: string[], ratio?: string) => {
        const historyService = ServiceRegistry.get<any>(SERVICE_KEYS.HISTORY_DATA)
        if (historyService) {
          const item = { type, prompt, images: urls, ratio, timestamp: Date.now() }
          historyService.add(item)
          self.history = historyService.getAll()
        }
      },

      // 图片操作
      downloadImage: async (url: string) => {
        const imageViewer = ServiceRegistry.get<any>(SERVICE_KEYS.IMAGE_VIEWER)
        const api = (window as any).aiImageAPI
        if (api?.downloadImage) {
          await api.downloadImage(url, null, api.model)
          const toast = ServiceRegistry.get<any>(SERVICE_KEYS.TOAST)
          toast?.show('图片下载成功', 'success')
        }
      },
      viewImage: (urls: string[], idx = 0) => {
        const imageViewer = ServiceRegistry.get<any>(SERVICE_KEYS.IMAGE_VIEWER)
        imageViewer?.open(urls, idx)
      },

      // UI 状态
      renderRatioOptions: (mc: any) => {
        const ratioManager = ServiceRegistry.get<any>(SERVICE_KEYS.RATIO_RESOLUTION)
        ratioManager?.renderRatioOptions(mc, self.pages.generate)
      },
      renderResolutionOptions: (mc: any) => {
        const ratioManager = ServiceRegistry.get<any>(SERVICE_KEYS.RATIO_RESOLUTION)
        ratioManager?.renderResolutionOptions(mc, self.pages.generate)
      },
      renderBatchRatioOptions: (mc: any) => {
        const ratioManager = ServiceRegistry.get<any>(SERVICE_KEYS.RATIO_RESOLUTION)
        ratioManager?.renderBatchRatioOptions(mc, self.pages.batch)
      },

      // 设置和关于
      openSettings: () => {
        const siteManager = ServiceRegistry.get<any>(SERVICE_KEYS.SITE_MANAGER)
        siteManager?.openSettingsModal()
      },
      closeSettings: () => {
        const siteManager = ServiceRegistry.get<any>(SERVICE_KEYS.SITE_MANAGER)
        siteManager?.closeSettingsModal()
      },
      openAbout: () => {
        document.getElementById('aboutModal')?.classList.remove('hidden')
      },
      closeAbout: () => {
        document.getElementById('aboutModal')?.classList.add('hidden')
      },

      // 智能调整
      setupIntelligentResizeMode: () => {
        const resizeManager = ServiceRegistry.get<any>(SERVICE_KEYS.INTELLIGENT_RESIZE)
        resizeManager?.setPages(self.pages)
        resizeManager?.setupIntelligentResizeMode()
      },
      updateIntelligentResizeUI: () => {
        const resizeManager = ServiceRegistry.get<any>(SERVICE_KEYS.INTELLIGENT_RESIZE)
        resizeManager?.setPages(self.pages)
        resizeManager?.updateIntelligentResizeUI()
      },

      // i18n
      get i18n() { 
        return ServiceRegistry.get<any>(SERVICE_KEYS.I18N) || (window as any).i18n 
      }
    }
  }

  /**
   * 初始化模型选择器（带重试）
   */
  private async initModelSelectorWithRetry(retryCount = 0): Promise<void> {
    console.log('[AppBootstrap] 初始化模型选择器...')
    
    const desktopSelector = document.getElementById('modelSelector')
    const mobileSelector = document.getElementById('modelSelectorMobile')

    if (!desktopSelector || !mobileSelector) {
      if (retryCount < 5) {
        console.log(`[AppBootstrap] 等待模型选择器 DOM (重试 ${retryCount + 1}/5)`)
        await new Promise(r => setTimeout(r, 200))
        return this.initModelSelectorWithRetry(retryCount + 1)
      }
      console.warn('[AppBootstrap] 模型选择器 DOM 未找到')
      return
    }

    // 使用 ModelSelectorManager
    const modelSelector = ServiceRegistry.get<any>(SERVICE_KEYS.MODEL_SELECTOR)
    if (modelSelector) {
      modelSelector.init()
      console.log('[AppBootstrap] ✅ 模型选择器初始化完成')
    } else {
      // 回退到 window
      const w = window as any
      w.modelSelectorManagerTS?.init()
    }
  }

  /**
   * 加载已存储的 API Key
   */
  private loadStoredApiKey(): void {
    const api = (window as any).aiImageAPI
    if (!api) return

    const apiKey = api.getStoredApiKey?.()
    if (apiKey) {
      api.setApiKey?.(apiKey)
      console.log('[AppBootstrap] ✅ API Key 已加载')
    }

    // 更新 API 状态显示
    const siteManager = ServiceRegistry.get<any>(SERVICE_KEYS.SITE_MANAGER)
    siteManager?.updateApiStatusDisplay(!!apiKey)
  }

  /**
   * 调度非关键初始化
   */
  private scheduleNonCriticalBootstrap(): void {
    const runNonCritical = async () => {
      console.log('[AppBootstrap] 开始非关键功能初始化...')

      try {
        // 初始化历史记录服务
        const historyService = ServiceRegistry.get<any>(SERVICE_KEYS.HISTORY_DATA)
        if (historyService) {
          await historyService.init()
          this.history = historyService.getAll() || []
          console.log(`[AppBootstrap] 历史记录已加载: ${this.history.length} 条`)
        }

        // 初始化版本检查器
        const versionChecker = ServiceRegistry.get<any>(SERVICE_KEYS.VERSION_CHECKER)
        if (versionChecker) {
          await versionChecker.init()
          console.log('[AppBootstrap] 版本检查器已初始化')
        }

        this.state.nonCriticalReady = true
        console.log('[AppBootstrap] ✅ 非关键功能初始化完成')

      } catch (error) {
        console.warn('[AppBootstrap] 非关键功能初始化失败:', error)
      }
    }

    // 使用 requestIdleCallback 或降级到 setTimeout
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      (window as any).requestIdleCallback(runNonCritical, { timeout: this.config.idleTimeout })
    } else {
      setTimeout(runNonCritical, 100)
    }
  }

  /**
   * 获取页面注册表
   */
  getPages(): Readonly<PageRegistry> {
    return { ...this.pages }
  }

  /**
   * 获取当前标签页
   */
  getCurrentTab(): string {
    return this.currentTab
  }

  /**
   * 设置当前标签页
   */
  setCurrentTab(tab: string): void {
    this.currentTab = tab
  }
}

// 单例获取函数
let bootstrapInstance: AppBootstrap | null = null

/**
 * 获取 AppBootstrap 单例
 */
export function getAppBootstrap(config?: BootstrapConfig): AppBootstrap {
  if (!bootstrapInstance) {
    bootstrapInstance = AppBootstrap.getInstance(config)
  }
  return bootstrapInstance
}

/**
 * 创建新的 AppBootstrap 实例 (仅用于测试)
 */
export function createAppBootstrap(config?: BootstrapConfig): AppBootstrap {
  AppBootstrap.resetInstance()
  bootstrapInstance = AppBootstrap.getInstance(config)
  return bootstrapInstance
}

/**
 * 重置单例（仅用于测试）
 */
export function resetAppBootstrap(): void {
  AppBootstrap.resetInstance()
  bootstrapInstance = null
}

// ========================================
// V16.2 D - 过渡期 window 暴露
// ========================================

declare global {
  interface Window {
    appBootstrap: AppBootstrap
    appBootstrapTS: AppBootstrap
    AppBootstrapTS: typeof AppBootstrap
    appInitialized: boolean
  }
}

/**
 * 初始化并暴露到 window（过渡期）
 */
export function initAppBootstrapGlobal(config?: BootstrapConfig): AppBootstrap {
  const bootstrap = getAppBootstrap(config)

  // 过渡期: 暴露到 window
  if (typeof window !== 'undefined') {
    window.appBootstrap = bootstrap
    window.appBootstrapTS = bootstrap
    window.AppBootstrapTS = AppBootstrap
  }

  console.log('[V16.2] AppBootstrap TypeScript 版本已加载')

  return bootstrap
}
