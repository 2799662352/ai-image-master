// src/renderer/src/services/ServiceBridge.ts
/**
 * 服务桥接层
 * 用于将 TypeScript 服务暴露到 window 对象
 * 支持从 JS 代码渐进迁移到 TypeScript
 * 
 * V16.3 - ServiceRegistry: 集中式服务注册表，替代 window 全局变量
 */

import { getStorageBridge, StorageBridge } from './storage'
import { LangChainDirectorService } from './LangChainDirectorService'
import { LangChainStoryboardService } from './LangChainStoryboardService'
import { getI18nService, I18nService } from './i18n'
import { getApiService, ApiService } from './api'
import { getR2StorageService, R2StorageService, initR2StorageGlobal } from './r2-storage'
import { initPageStateManagerGlobal, getPageStateManager, PageStateManager } from './PageStateManager'
import { getVersionChecker, VersionChecker } from './version-checker'
import { getHistoryDataService, HistoryDataService } from '../features/history'
import { getIntelligentResizeManager, IntelligentResizeManager } from '../features/intelligent-resize'
import { getLanguageManager, LanguageManager } from '../features/language'
import { getErrorHandler, ErrorHandler } from '../features/error-handler'
import { getUIStateManager, UIStateManager } from '../features/ui-state'
import { getModelSelectorManager, ModelSelectorManager, getRatioResolutionManager, RatioResolutionManager } from '../features/model-selector'
import { getImageViewer, ImageViewer } from '../features/image-viewer'
import { getSiteManager, SiteManager } from '../features/settings/SiteManager'
import { getTabManager, TabManager } from '../features/tab-manager'
import { getMobileMenuManager, MobileMenuManager } from '../features/mobile-menu'
import { getModalFactory, ModalFactory } from '../features/dialog'
import { KeyboardShortcuts, createKeyboardShortcuts } from '../features/keyboard'
import { getToastManager, ToastManager } from '../features/toast'
import { getEventManager, EventManager } from '../core/EventManager'
import { getUpdateNotification, UpdateNotification } from '../features/updater'
import { getPerformanceDashboard, PerformanceDashboard } from '../features/performance'
import { formatFileSize, formatDate, formatRelativeTime, formatNumber, formatDuration } from '../utils'
import type { AppInterface } from '../pages/BasePage'
import { type GeneratePage, createGeneratePage, getGeneratePage } from '../pages/GeneratePage'
import { type HistoryPage, createHistoryPage, getHistoryPage } from '../pages/HistoryPage'
import { type BatchPage, createBatchPage, getBatchPage } from '../pages/BatchPage'
import { type ComparePage, createComparePage, getComparePage } from '../pages/ComparePage'
import { type PromptTemplates, createPromptTemplates, getPromptTemplates } from '../pages/PromptTemplates'
import { type UnderstandPage, createUnderstandPage, getUnderstandPage } from '../pages/UnderstandPage'
import { type DirectorPage, createDirectorPage, getDirectorPage } from '../pages/DirectorPage'

// ========================================
// V16.3 - ServiceRegistry: 集中式服务注册表
// 替代 window 全局变量，提供类型安全的服务访问
// ========================================

/**
 * 服务注册表 - 集中管理所有服务实例
 * 用于替代 window 全局变量暴露
 * 
 * @example
 * // 注册服务
 * ServiceRegistry.register('storage', getStorageBridge())
 * 
 * // 获取服务 (可能为 null)
 * const storage = ServiceRegistry.get<StorageBridge>('storage')
 * 
 * // 获取必需服务 (抛出异常如果不存在)
 * const storage = ServiceRegistry.getRequired<StorageBridge>('storage')
 */
export class ServiceRegistry {
  private static services = new Map<string, unknown>()
  private static initialized = false

  /**
   * 注册服务到注册表
   */
  static register<T>(key: string, service: T): void {
    this.services.set(key, service)
  }

  /**
   * 获取服务 (可能返回 null)
   */
  static get<T>(key: string): T | null {
    return (this.services.get(key) as T) || null
  }

  /**
   * 获取必需的服务 (不存在时抛出异常)
   */
  static getRequired<T>(key: string): T {
    const service = this.services.get(key)
    if (!service) {
      throw new Error(`[ServiceRegistry] Service not found: ${key}`)
    }
    return service as T
  }

  /**
   * 检查服务是否已注册
   */
  static has(key: string): boolean {
    return this.services.has(key)
  }

  /**
   * 获取所有已注册的服务键
   */
  static keys(): string[] {
    return Array.from(this.services.keys())
  }

  /**
   * 清空所有服务 (仅用于测试)
   */
  static clear(): void {
    this.services.clear()
    this.initialized = false
  }

  /**
   * 标记为已初始化
   */
  static markInitialized(): void {
    this.initialized = true
  }

  /**
   * 检查是否已初始化
   */
  static isInitialized(): boolean {
    return this.initialized
  }
}

/**
 * Services 命名空间别名 - 更简洁的访问方式
 * 
 * @example
 * import { Services } from '@/services/ServiceBridge'
 * const storage = Services.getRequired<StorageBridge>('storage')
 */
export const Services = ServiceRegistry

// ========================================
// 服务键常量 - 类型安全的服务标识符
// ========================================

export const SERVICE_KEYS = {
  // 核心服务
  STORAGE: 'storage',
  I18N: 'i18n',
  API: 'api',
  R2_STORAGE: 'r2Storage',
  VERSION_CHECKER: 'versionChecker',
  HISTORY_DATA: 'historyData',
  PAGE_STATE: 'pageState',
  
  // 功能模块
  INTELLIGENT_RESIZE: 'intelligentResize',
  LANGUAGE: 'language',
  ERROR_HANDLER: 'errorHandler',
  UI_STATE: 'uiState',
  MODEL_SELECTOR: 'modelSelector',
  RATIO_RESOLUTION: 'ratioResolution',
  IMAGE_VIEWER: 'imageViewer',
  SITE_MANAGER: 'siteManager',
  TAB_MANAGER: 'tabManager',
  MOBILE_MENU: 'mobileMenu',
  MODAL_FACTORY: 'modalFactory',
  TOAST: 'toast',
  KEYBOARD_SHORTCUTS: 'keyboardShortcuts',
  
  // V16.2 新增
  PERFORMANCE_MONITOR: 'performanceMonitor',
  UI_COMPONENTS: 'uiComponents',
  
  // V16.4 新增
  EVENT_MANAGER: 'eventManager',
  
  // V17 新增
  UPDATE_NOTIFICATION: 'updateNotification',
  
  // V18 新增
  PERFORMANCE_DASHBOARD: 'performanceDashboard',

  // V19 新增 - LangChain AI 服务
  LANGCHAIN_DIRECTOR: 'langchainDirector'
} as const

export type ServiceKey = typeof SERVICE_KEYS[keyof typeof SERVICE_KEYS]

// ========================================
// 原有配置接口
// ========================================

export interface ServiceBridgeConfig {
  /** 是否使用 TS 服务替代 JS 服务 */
  useTypescriptServices?: boolean
  /** 是否暴露工具函数到 window */
  exposeUtilFunctions?: boolean
  /** 初始化完成回调 */
  onReady?: () => void
  /** 是否启用废弃警告 (默认开发环境启用) */
  enableDeprecationWarnings?: boolean
}

/**
 * 初始化服务桥接
 * 将 TypeScript 服务暴露到 window 对象供 JS 代码使用
 * 
 * 性能优化策略:
 * - 关键服务: 立即初始化 (Storage, I18n, Api, Toast, Error)
 * - 非关键服务: 使用 requestIdleCallback 延迟初始化
 */
export async function initServiceBridge(config: ServiceBridgeConfig = {}): Promise<void> {
  const {
    useTypescriptServices = true,
    exposeUtilFunctions = true,
    onReady
  } = config

  // 避免重复初始化
  if (window.__serviceBridgeInitialized) {
    console.log('[ServiceBridge] 服务桥接已初始化，跳过')
    return
  }

  const startTime = performance.now()
  console.log('[ServiceBridge] 开始初始化服务桥接...')

  try {
    // 暴露 TypeScript 服务
    if (useTypescriptServices) {
      // ========== 关键路径: 立即初始化 ==========
      // 这些服务是 app 渲染和基本交互必需的
      
      // StorageBridge - 加载设置必需
      const storageBridge = getStorageBridge()
      window.storageBridgeTS = storageBridge
      ServiceRegistry.register(SERVICE_KEYS.STORAGE, storageBridge)
      console.log('[ServiceBridge] ✓ StorageBridge (TS) 已就绪')

      // I18nService - UI 文本显示必需
      const i18n = getI18nService()
      await i18n.init()
      window.i18nServiceTS = i18n
      // 兼容性：BasePage.t() 使用 window.i18n
      ;(window as any).i18n = i18n
      ServiceRegistry.register(SERVICE_KEYS.I18N, i18n)
      console.log('[ServiceBridge] ✓ I18nService (TS) 已就绪')

      // ApiService - API 调用必需
      const apiService = getApiService()
      window.apiServiceTS = apiService
      ServiceRegistry.register(SERVICE_KEYS.API, apiService)
      console.log('[ServiceBridge] ✓ ApiService (TS) 已就绪')

      // ToastManager - 用户反馈必需
      const toastManager = getToastManager()
      window.toastManagerTS = toastManager
      ServiceRegistry.register(SERVICE_KEYS.TOAST, toastManager)
      console.log('[ServiceBridge] ✓ ToastManager (TS) 已就绪')

      // ErrorHandler - 错误处理必需
      const errorHandler = getErrorHandler()
      window.errorHandlerTS = errorHandler
      ServiceRegistry.register(SERVICE_KEYS.ERROR_HANDLER, errorHandler)
      console.log('[ServiceBridge] ✓ ErrorHandler (TS) 已就绪')

      // TabManager - 页签切换必需
      const tabManager = getTabManager({
        showToast: (msg: string, type: 'success' | 'error' | 'info') => {
          ;(window as any).app?.showToast?.(msg, type)
        }
      })
      
      // 绑定标签按钮点击事件和初始化 hash 路由
      tabManager.bindTabButtons()
      tabManager.initHashRouter()
      
      window.tabManagerTS = tabManager
      ServiceRegistry.register(SERVICE_KEYS.TAB_MANAGER, tabManager)
      console.log('[ServiceBridge] ✓ TabManager (TS) 已就绪')

      // ModelSelectorManager - 生成页面必需
      const modelSelectorManager = getModelSelectorManager()
      window.modelSelectorManagerTS = modelSelectorManager
      ServiceRegistry.register(SERVICE_KEYS.MODEL_SELECTOR, modelSelectorManager)
      console.log('[ServiceBridge] ✓ ModelSelectorManager (TS) 已就绪')

      // RatioResolutionManager - 生成页面必需
      const ratioResolutionManager = getRatioResolutionManager()
      window.ratioResolutionManagerTS = ratioResolutionManager
      ServiceRegistry.register(SERVICE_KEYS.RATIO_RESOLUTION, ratioResolutionManager)
      console.log('[ServiceBridge] ✓ RatioResolutionManager (TS) 已就绪')

      // HistoryDataService - 历史功能必需
      const historyDataService = getHistoryDataService()
      window.historyDataServiceTS = historyDataService
      ServiceRegistry.register(SERVICE_KEYS.HISTORY_DATA, historyDataService)
      console.log('[ServiceBridge] ✓ HistoryDataService (TS) 已就绪')

      console.log(`[ServiceBridge] 关键服务初始化完成: ${(performance.now() - startTime).toFixed(1)}ms`)

      // ========== 非关键路径: 延迟初始化 ==========
      // 使用 requestIdleCallback 在浏览器空闲时初始化
      const initNonCriticalServices = () => {
        const nonCriticalStart = performance.now()
        
        // R2StorageService - 后台存储
        const r2Storage = initR2StorageGlobal()  // V16.5: Also sets window.r2Storage for backward compatibility
        ServiceRegistry.register(SERVICE_KEYS.R2_STORAGE, r2Storage)

        // PageStateManager - 页面状态管理
        const pageStateManager = initPageStateManagerGlobal()
        ServiceRegistry.register(SERVICE_KEYS.PAGE_STATE, pageStateManager)
        console.log('[ServiceBridge] ✓ PageStateManager (TS) 已就绪')

        // VersionChecker - 版本检查可延迟
        const versionChecker = getVersionChecker()
        window.versionCheckerTS = versionChecker
        ServiceRegistry.register(SERVICE_KEYS.VERSION_CHECKER, versionChecker)

        // IntelligentResizeManager - 仅特定功能需要
        const intelligentResize = getIntelligentResizeManager()
        window.intelligentResizeManagerTS = intelligentResize
        ServiceRegistry.register(SERVICE_KEYS.INTELLIGENT_RESIZE, intelligentResize)

        // LanguageManager - i18n 已初始化
        const languageManager = getLanguageManager()
        window.languageManagerTS = languageManager
        ServiceRegistry.register(SERVICE_KEYS.LANGUAGE, languageManager)

        // UIStateManager - UI 状态管理
        const uiStateManager = getUIStateManager()
        window.uiStateManagerTS = uiStateManager
        ServiceRegistry.register(SERVICE_KEYS.UI_STATE, uiStateManager)

        // ImageViewer - 仅查看图片时需要
        const imageViewer = getImageViewer({
          onDownload: async (url: string) => {
            const api = (window as any).aiImageAPI
            if (api?.downloadImage) {
              await api.downloadImage(url, null, api.model)
              ;(window as any).app?.showToast?.('图片下载成功', 'success')
            }
          },
          onBatchDownload: async (urls: string[]) => {
            const api = (window as any).aiImageAPI
            if (api?.downloadImagesAsZip) {
              const zipFilename = `ai_images_${Date.now()}.zip`
              const result = await api.downloadImagesAsZip(urls, zipFilename, () => {}, api.model)
              ;(window as any).app?.showToast?.(result.message || '批量下载完成', 'success')
            }
          },
          showToast: (msg: string, type: 'success' | 'error' | 'info') => {
            ;(window as any).app?.showToast?.(msg, type)
          }
        })
        window.imageViewerTS = imageViewer
        ServiceRegistry.register(SERVICE_KEYS.IMAGE_VIEWER, imageViewer)

        // SiteManager - 设置页面
        const siteManager = getSiteManager({
          showToast: (msg: string, type: 'success' | 'error' | 'info') => {
            ;(window as any).app?.showToast?.(msg, type)
          },
          updateApiStatus: (hasKey: boolean) => {
            ;(window as any).app?.updateApiStatus?.(hasKey)
          }
        })
        // 初始化设置模态框事件监听（按钮点击等）
        siteManager.initSettingsModalEvents()
        window.siteManagerTS = siteManager
        ServiceRegistry.register(SERVICE_KEYS.SITE_MANAGER, siteManager)

        // MobileMenuManager - 仅移动端需要
        const mobileMenuManager = getMobileMenuManager()
        window.mobileMenuManagerTS = mobileMenuManager
        ServiceRegistry.register(SERVICE_KEYS.MOBILE_MENU, mobileMenuManager)

        // ModalFactory - 按需创建模态框
        const modalFactory = getModalFactory()
        window.modalFactoryTS = modalFactory
        ServiceRegistry.register(SERVICE_KEYS.MODAL_FACTORY, modalFactory)

        // V16.4: EventManager - 事件委托管理器
        const eventManager = getEventManager()
        window.eventManagerTS = eventManager
        window.EventManagerTS = EventManager
        ServiceRegistry.register(SERVICE_KEYS.EVENT_MANAGER, eventManager)
        // 初始化事件委托
        eventManager.init()

        // V17: UpdateNotification - 更新通知组件
        const updateNotification = getUpdateNotification()
        window.updateNotificationTS = updateNotification
        window.UpdateNotificationTS = UpdateNotification
        ServiceRegistry.register(SERVICE_KEYS.UPDATE_NOTIFICATION, updateNotification)
        // 初始化更新通知
        updateNotification.init()

        // V18: PerformanceDashboard - 性能监控面板
        const performanceDashboard = getPerformanceDashboard()
        window.performanceDashboardTS = performanceDashboard
        window.PerformanceDashboardTS = PerformanceDashboard
        ServiceRegistry.register(SERVICE_KEYS.PERFORMANCE_DASHBOARD, performanceDashboard)
        // 初始化性能面板 (开发模式自动启用)
        performanceDashboard.init()

        // KeyboardShortcuts - 键盘快捷键
        const keyboardShortcuts = createKeyboardShortcuts({
          executeAction: () => {
            // Ctrl/Cmd + Enter 执行当前页面的主要操作
            const tabManager = ServiceRegistry.get<any>(SERVICE_KEYS.TAB_MANAGER)
            const currentTab = tabManager?.getCurrentTab()
            if (currentTab === 'generate') {
              ;(window as any).generatePageTS?.generateImage?.()
            } else if (currentTab === 'batch') {
              ;(window as any).batchPageTS?.startBatch?.()
            }
          },
          copyToClipboard: async (text: string) => {
            await navigator.clipboard.writeText(text)
          },
          showToast: (msg: string, type: 'success' | 'error' | 'info') => {
            const toast = ServiceRegistry.get<any>(SERVICE_KEYS.TOAST)
            toast?.show(msg, type)
          }
        })
        window.keyboardShortcutsTS = keyboardShortcuts
        ServiceRegistry.register(SERVICE_KEYS.KEYBOARD_SHORTCUTS, keyboardShortcuts)
        // 初始化键盘快捷键
        keyboardShortcuts.init()

        console.log(`[ServiceBridge] 非关键服务初始化完成: ${(performance.now() - nonCriticalStart).toFixed(1)}ms`)
        
        // 标记 ServiceRegistry 完全初始化
        ServiceRegistry.markInitialized()
        console.log(`[ServiceBridge] ServiceRegistry 已完全初始化，注册服务: ${ServiceRegistry.keys().join(', ')}`)
        
        // 更新 appServices 命名空间中的非关键服务
        if (window.appServices) {
          window.appServices.services.r2Storage = r2Storage
          window.appServices.services.versionChecker = versionChecker
          window.appServices.features.intelligentResize = intelligentResize
          window.appServices.features.language = languageManager
          window.appServices.features.uiState = uiStateManager
          window.appServices.features.imageViewer = imageViewer
          window.appServices.features.siteManager = siteManager
          window.appServices.features.mobileMenu = mobileMenuManager
          window.appServices.features.modalFactory = modalFactory
        }
      }

      // 使用 requestIdleCallback 或 setTimeout 回退
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(initNonCriticalServices, { timeout: 2000 })
      } else {
        setTimeout(initNonCriticalServices, 100)
      }

      // Page factory functions are exposed but not instantiated here
      // They will be created by app.js when needed
      window.createGeneratePageTS = createGeneratePage
      window.createHistoryPageTS = createHistoryPage
      window.createBatchPageTS = createBatchPage
      window.createComparePageTS = createComparePage
      window.createPromptTemplatesTS = createPromptTemplates
      window.createUnderstandPageTS = createUnderstandPage
      window.createDirectorPageTS = createDirectorPage
      window.getGeneratePageTS = getGeneratePage
      window.getHistoryPageTS = getHistoryPage
      window.getBatchPageTS = getBatchPage
      window.getComparePageTS = getComparePage
      window.getPromptTemplatesTS = getPromptTemplates
      window.getUnderstandPageTS = getUnderstandPage
      window.getDirectorPageTS = getDirectorPage
      console.log('[ServiceBridge] ✓ Page factories (TS) 已就绪 (GeneratePage, HistoryPage, BatchPage, ComparePage, PromptTemplates, UnderstandPage, DirectorPage)')
    }

    // 暴露工具函数
    if (exposeUtilFunctions) {
      window.formatFileSize = formatFileSize
      window.formatDate = formatDate
      window.formatRelativeTime = formatRelativeTime
      window.formatNumber = formatNumber
      window.formatDuration = formatDuration
      console.log('[ServiceBridge] ✓ 工具函数已暴露到 window')
    }

    // 创建统一的服务命名空间 (新架构)
    // 非关键服务将在 requestIdleCallback 中填充
    // V16.3: 使用 ServiceRegistry 替代直接 window.* 访问
    window.appServices = {
      // 服务层 (关键服务立即可用)
      services: {
        storage: ServiceRegistry.getRequired(SERVICE_KEYS.STORAGE),
        i18n: ServiceRegistry.getRequired(SERVICE_KEYS.I18N),
        api: ServiceRegistry.getRequired(SERVICE_KEYS.API),
        r2Storage: null as any, // 延迟初始化
        versionChecker: null as any, // 延迟初始化
        historyData: ServiceRegistry.getRequired(SERVICE_KEYS.HISTORY_DATA)
      },
      // 功能模块 (部分延迟初始化)
      // V16.3: 使用 ServiceRegistry 替代直接 window.* 访问
      features: {
        intelligentResize: null as any, // 延迟初始化
        language: null as any, // 延迟初始化
        errorHandler: ServiceRegistry.getRequired(SERVICE_KEYS.ERROR_HANDLER),
        uiState: null as any, // 延迟初始化
        modelSelector: ServiceRegistry.getRequired(SERVICE_KEYS.MODEL_SELECTOR),
        ratioResolution: ServiceRegistry.getRequired(SERVICE_KEYS.RATIO_RESOLUTION),
        imageViewer: null as any, // 延迟初始化
        siteManager: null as any, // 延迟初始化
        tabManager: ServiceRegistry.getRequired(SERVICE_KEYS.TAB_MANAGER),
        mobileMenu: null as any, // 延迟初始化
        modalFactory: null as any, // 延迟初始化
        toast: ServiceRegistry.getRequired(SERVICE_KEYS.TOAST)
      },
      // 页面工厂
      pages: {
        createGenerate: window.createGeneratePageTS!,
        createHistory: window.createHistoryPageTS!,
        createBatch: window.createBatchPageTS!,
        createCompare: window.createComparePageTS!,
        createPromptTemplates: window.createPromptTemplatesTS!,
        createUnderstand: window.createUnderstandPageTS!,
        createDirector: window.createDirectorPageTS!,
        getGenerate: window.getGeneratePageTS!,
        getHistory: window.getHistoryPageTS!,
        getBatch: window.getBatchPageTS!,
        getCompare: window.getComparePageTS!,
        getPromptTemplates: window.getPromptTemplatesTS!,
        getUnderstand: window.getUnderstandPageTS!,
        getDirector: window.getDirectorPageTS!
      },
      // 工具函数
      utils: {
        formatFileSize,
        formatDate,
        formatRelativeTime,
        formatNumber,
        formatDuration
      }
    }
    console.log('[ServiceBridge] ✓ 统一服务命名空间 window.appServices 已创建')

    // 暴露 aiImageAPI 兼容接口 (供 SiteManager 等模块使用)
    const apiService = getApiService()
    ;(window as any).aiImageAPI = {
      // 站点管理
      getAllSites: () => apiService.getAllSites(),
      getCurrentSite: () => apiService.getCurrentSite(),
      get currentSite() { return apiService.currentSiteKey },
      saveSite: (key: string) => apiService.saveSite(key),

      // 自定义站点 CRUD
      addCustomSite: (key: string, config: any) => apiService.addCustomSite(key, config),
      updateCustomSite: (key: string, config: any) => apiService.updateCustomSite(key, config),
      removeCustomSite: (key: string) => apiService.removeCustomSite(key),

      // API Key 管理
      getStoredApiKey: (site?: string) => apiService.getStoredApiKey(site),
      getStoredVisionApiKey: (site?: string) => apiService.getStoredVisionApiKey(site),
      saveApiKey: (key: string) => apiService.saveApiKey(key),
      saveVisionApiKey: (key: string) => apiService.saveVisionApiKey(key),
      hasApiKey: () => apiService.hasApiKey(),
      get apiKey() { return apiService.hasApiKey() ? 'configured' : null },

      // 模型管理
      getCurrentModel: () => apiService.getCurrentModel(),
      getAllModels: () => apiService.getAllModels(),
      setModel: (key: string) => apiService.setModel(key),
      get model() { return apiService.getCurrentModel()?.name },

      // 图片生成
      generateImage: (params: any) => apiService.generateImage(params),
      generateImageWithReference: (prompt: string, referenceImages: any[], ratio?: string, count?: number, resolution?: string) => 
        apiService.generateImageWithReference(prompt, referenceImages, ratio || '1:1', count || 1, resolution),
      getModelCapabilities: (modelKey?: string) => apiService.getModelCapabilities(modelKey),

      // 批量生成
      batchGenerate: (prompts: string[], ratio?: string, concurrency?: number, n?: number, resolution?: string | null) => 
        apiService.batchGenerate(prompts, ratio, concurrency, n, resolution),
      batchGenerateWithReference: (prompts: string[], referenceImages: string[], ratio?: string, concurrency?: number, n?: number, resolution?: string | null) => 
        apiService.batchGenerateWithReference(prompts, referenceImages, ratio, concurrency, n, resolution),

      // 图像理解
      understandImage: (params: any) => apiService.understandImage(params),
      
      // Vision API Key
      get visionApiKey() { return apiService.getStoredVisionApiKey() },
      
      // 流式图像分析
      analyzeImagesStream: (
        images: Array<{ base64: string; mimeType?: string }>,
        prompt: string,
        model: string,
        maxTokens: number | null,
        onChunk: (chunk: string) => void,
        onComplete: () => void,
        onError: (error: Error) => void
      ) => apiService.analyzeImagesStream(images, prompt, model, maxTokens, onChunk, onComplete, onError),

      // 图片下载
      downloadImage: async (url: string, filename?: string | null, _model?: string) => {
        const suggestedName = filename || `image_${Date.now()}.png`
        let blobUrl: string | null = null
        
        try {
          // Electron 环境：使用主进程保存
          if (window.electronAPI?.isElectron) {
            let base64Data: string
            
            if (url.startsWith('data:')) {
              base64Data = url
            } else {
              // 获取图片数据
              const response = await fetch(url)
              const blob = await response.blob()
              base64Data = await new Promise<string>((resolve) => {
                const reader = new FileReader()
                reader.onloadend = () => resolve(reader.result as string)
                reader.readAsDataURL(blob)
              })
            }
            
            // 使用 StorageBridge 导出到用户选择的目录
            const storageBridge = getStorageBridge()
            const result = await storageBridge.exportImageToPath(base64Data, suggestedName)
            
            if (result.success) {
              return { success: true, message: '图片下载成功' }
            } else {
              return { success: false, error: result.error || '保存失败' }
            }
          }
          
          // 浏览器环境：使用 <a> 下载
          if (url.startsWith('data:')) {
            blobUrl = url
          } else {
            const response = await fetch(url)
            const blob = await response.blob()
            blobUrl = URL.createObjectURL(blob)
          }

          const link = document.createElement('a')
          link.href = blobUrl
          link.download = suggestedName
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          
          return { success: true, message: '图片下载成功' }
        } catch (error) {
          console.error('下载图片失败:', error)
          return { success: false, error: (error as Error).message }
        } finally {
          // 确保释放 blob URL 避免内存泄漏
          if (blobUrl && !url.startsWith('data:')) {
            URL.revokeObjectURL(blobUrl)
          }
        }
      },

      // 批量下载为 ZIP
      downloadImagesAsZip: async (
        urls: string[],
        zipFilename: string,
        onProgress?: (completed: number, total: number) => void,
        _model?: string
      ) => {
        try {
          // 动态导入 JSZip
          const JSZip = (await import('jszip')).default
          const zip = new JSZip()

          for (let i = 0; i < urls.length; i++) {
            const url = urls[i]
            onProgress?.(i, urls.length)

            try {
              let blob: Blob
              if (url.startsWith('data:')) {
                // base64 转 blob
                const response = await fetch(url)
                blob = await response.blob()
              } else {
                const response = await fetch(url)
                blob = await response.blob()
              }

              const ext = blob.type.split('/')[1] || 'png'
              zip.file(`image_${i + 1}.${ext}`, blob)
            } catch (err) {
              console.error(`下载第 ${i + 1} 张图片失败:`, err)
            }
          }

          onProgress?.(urls.length, urls.length)

          const content = await zip.generateAsync({ type: 'blob' })
          const blobUrl = URL.createObjectURL(content)

          const link = document.createElement('a')
          link.href = blobUrl
          link.download = zipFilename
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)

          URL.revokeObjectURL(blobUrl)
          return { success: true, message: `已下载 ${urls.length} 张图片` }
        } catch (error) {
          console.error('批量下载失败:', error)
          throw new Error('批量下载失败，请右键图片选择"另存为"手动下载')
        }
      },

      // 图片预加载
      preloadImages: (urls: string[]) => {
        urls.forEach(url => {
          const img = new Image()
          img.src = url
        })
      }
    }
    console.log('[ServiceBridge] ✓ window.aiImageAPI 兼容接口已创建')

    window.__serviceBridgeInitialized = true
    console.log(`[ServiceBridge] 服务桥接初始化完成: ${(performance.now() - startTime).toFixed(1)}ms`)

    // 触发回调
    onReady?.()

  } catch (error) {
    console.error('[ServiceBridge] 初始化失败:', error)
    throw error
  }
}

/**
 * 获取存储桥接 (优先使用 ServiceRegistry)
 * V16.3: 使用 ServiceRegistry 替代直接 window.* 访问
 */
export function getStorageBridgeAuto(): StorageBridge {
  const fromRegistry = ServiceRegistry.get<StorageBridge>(SERVICE_KEYS.STORAGE)
  if (fromRegistry) {
    return fromRegistry
  }
  return getStorageBridge()
}

/**
 * 获取国际化服务 (优先使用 ServiceRegistry)
 * V16.3: 使用 ServiceRegistry 替代直接 window.* 访问
 */
export function getI18nServiceAuto(): I18nService {
  const fromRegistry = ServiceRegistry.get<I18nService>(SERVICE_KEYS.I18N)
  if (fromRegistry) {
    return fromRegistry
  }
  return getI18nService()
}

/**
 * 翻译文本的快捷函数
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const i18n = getI18nServiceAuto()
  return i18n.t(key, params)
}

/**
 * 检查服务桥接是否已初始化
 */
export function isServiceBridgeReady(): boolean {
  return window.__serviceBridgeInitialized === true
}

/**
 * 获取历史数据服务 (优先使用 TS 版本)
 */
export function getHistoryDataServiceAuto(): HistoryDataService {
  if (window.historyDataServiceTS) {
    return window.historyDataServiceTS
  }
  return getHistoryDataService()
}

/**
 * 获取智能尺寸管理器 (优先使用 TS 版本)
 */
export function getIntelligentResizeManagerAuto(): IntelligentResizeManager {
  if (window.intelligentResizeManagerTS) {
    return window.intelligentResizeManagerTS
  }
  return getIntelligentResizeManager()
}

/**
 * 获取语言管理器 (优先使用 TS 版本)
 */
export function getLanguageManagerAuto(): LanguageManager {
  if (window.languageManagerTS) {
    return window.languageManagerTS
  }
  return getLanguageManager()
}

/**
 * 获取错误处理器 (优先使用 TS 版本)
 */
export function getErrorHandlerAuto(): ErrorHandler {
  if (window.errorHandlerTS) {
    return window.errorHandlerTS
  }
  return getErrorHandler()
}

/**
 * 获取 UI 状态管理器 (优先使用 TS 版本)
 */
export function getUIStateManagerAuto(): UIStateManager {
  if (window.uiStateManagerTS) {
    return window.uiStateManagerTS
  }
  return getUIStateManager()
}

/**
 * 获取模型选择器管理器 (优先使用 TS 版本)
 */
export function getModelSelectorManagerAuto(): ModelSelectorManager {
  if (window.modelSelectorManagerTS) {
    return window.modelSelectorManagerTS
  }
  return getModelSelectorManager()
}

/**
 * 获取比例/分辨率管理器 (优先使用 TS 版本)
 */
export function getRatioResolutionManagerAuto(): RatioResolutionManager {
  if (window.ratioResolutionManagerTS) {
    return window.ratioResolutionManagerTS
  }
  return getRatioResolutionManager()
}

/**
 * 获取生成页面实例 (优先使用已创建的 TS 版本)
 */
export function getGeneratePageAuto(): GeneratePage | null {
  if (window.generatePageTS) {
    return window.generatePageTS
  }
  return getGeneratePage()
}

/**
 * 获取历史页面实例 (优先使用已创建的 TS 版本)
 */
export function getHistoryPageAuto(): HistoryPage | null {
  if (window.historyPageTS) {
    return window.historyPageTS
  }
  return getHistoryPage()
}

/**
 * 创建生成页面实例并暴露到 window
 */
export function initGeneratePage(app: AppInterface): GeneratePage {
  const page = createGeneratePage(app)
  window.generatePageTS = page
  console.log('[ServiceBridge] ✓ GeneratePage (TS) 实例已创建')
  return page
}

/**
 * 创建历史页面实例并暴露到 window
 */
export function initHistoryPage(app: AppInterface): HistoryPage {
  const page = createHistoryPage(app)
  window.historyPageTS = page
  console.log('[ServiceBridge] ✓ HistoryPage (TS) 实例已创建')
  return page
}

/**
 * 获取批量页面实例 (优先使用已创建的 TS 版本)
 */
export function getBatchPageAuto(): BatchPage | null {
  if (window.batchPageTS) {
    return window.batchPageTS
  }
  return getBatchPage()
}

/**
 * 获取对比页面实例 (优先使用已创建的 TS 版本)
 */
export function getComparePageAuto(): ComparePage | null {
  if (window.comparePageTS) {
    return window.comparePageTS
  }
  return getComparePage()
}

/**
 * 创建批量页面实例并暴露到 window
 */
export function initBatchPage(app: AppInterface): BatchPage {
  const page = createBatchPage(app)
  window.batchPageTS = page
  console.log('[ServiceBridge] ✓ BatchPage (TS) 实例已创建')
  return page
}

/**
 * 创建对比页面实例并暴露到 window
 */
export function initComparePage(app: AppInterface): ComparePage {
  const page = createComparePage(app)
  window.comparePageTS = page
  console.log('[ServiceBridge] ✓ ComparePage (TS) 实例已创建')
  return page
}

/**
 * 获取提示词模板实例 (优先使用已创建的 TS 版本)
 */
export function getPromptTemplatesAuto(): PromptTemplates | null {
  if (window.promptTemplatesTS) {
    return window.promptTemplatesTS
  }
  return getPromptTemplates()
}

/**
 * 获取图像理解页面实例 (优先使用已创建的 TS 版本)
 */
export function getUnderstandPageAuto(): UnderstandPage | null {
  if (window.understandPageTS) {
    return window.understandPageTS
  }
  return getUnderstandPage()
}

/**
 * 获取导演模式页面实例 (优先使用已创建的 TS 版本)
 */
export function getDirectorPageAuto(): DirectorPage | null {
  if (window.directorPageTS) {
    return window.directorPageTS
  }
  return getDirectorPage()
}

/**
 * 创建提示词模板实例并暴露到 window
 */
export function initPromptTemplates(app: AppInterface): PromptTemplates {
  const page = createPromptTemplates(app)
  window.promptTemplatesTS = page
  console.log('[ServiceBridge] ✓ PromptTemplates (TS) 实例已创建')
  return page
}

/**
 * 创建图像理解页面实例并暴露到 window
 */
export function initUnderstandPage(app: AppInterface): UnderstandPage {
  const page = createUnderstandPage(app)
  window.understandPageTS = page
  console.log('[ServiceBridge] ✓ UnderstandPage (TS) 实例已创建')
  return page
}

/**
 * 创建导演模式页面实例并暴露到 window
 */
export function initDirectorPage(app: AppInterface): DirectorPage {
  const page = createDirectorPage(app)
  window.directorPageTS = page
  console.log('[ServiceBridge] ✓ DirectorPage (TS) 实例已创建')
  return page
}

/**
 * 获取或创建 LangChain Director Service 实例（懒加载）
 * 需要 visionApiKey 才能创建，否则返回 null
 * 当 API key 变更时自动重建实例
 */
let _langchainDirectorInstance: LangChainDirectorService | null = null
let _langchainCacheKey: string | null = null

export function getLangChainDirectorService(model?: string): LangChainDirectorService | null {
  const api = (window as any).aiImageAPI
  const apiKey = api?.visionApiKey as string | undefined
  if (!apiKey) {
    console.debug('[ServiceBridge] LangChainDirector unavailable: no visionApiKey configured')
    return null
  }

  const site = api?.getCurrentSite?.()
  const baseURL = site?.baseURL as string | undefined
  if (!baseURL) {
    console.debug('[ServiceBridge] LangChainDirector unavailable: no site baseURL')
    return null
  }

  const cacheKey = `${apiKey}|${baseURL}|${model || ''}`
  if (!_langchainDirectorInstance || _langchainCacheKey !== cacheKey) {
    _langchainDirectorInstance = new LangChainDirectorService({ apiKey, baseURL, model })
    _langchainCacheKey = cacheKey
    ServiceRegistry.register(SERVICE_KEYS.LANGCHAIN_DIRECTOR, _langchainDirectorInstance)
    console.log('[ServiceBridge] ✓ LangChainDirectorService 实例已创建, baseURL:', baseURL, 'model:', model || 'default')
  }
  return _langchainDirectorInstance
}

/**
 * 获取或创建 LangChain Storyboard Service 实例（懒加载）
 */
let _langchainStoryboardInstance: LangChainStoryboardService | null = null
let _storyboardCacheKey: string | null = null

export function getLangChainStoryboardService(model?: string): LangChainStoryboardService | null {
  const api = (window as any).aiImageAPI
  const apiKey = api?.visionApiKey as string | undefined
  if (!apiKey) return null

  const site = api?.getCurrentSite?.()
  const baseURL = site?.baseURL as string | undefined
  if (!baseURL) return null

  const cacheKey = `storyboard|${apiKey}|${baseURL}|${model || ''}`
  if (!_langchainStoryboardInstance || _storyboardCacheKey !== cacheKey) {
    _langchainStoryboardInstance = new LangChainStoryboardService({ apiKey, baseURL, model })
    _storyboardCacheKey = cacheKey
    console.log('[ServiceBridge] ✓ LangChainStoryboardService 实例已创建, model:', model || 'default')
  }
  return _langchainStoryboardInstance
}

/**
 * 统一服务命名空间类型定义
 */
export interface AppServicesNamespace {
  services: {
    storage: StorageBridge
    i18n: I18nService
    api: ApiService
    r2Storage: R2StorageService
    versionChecker: VersionChecker
    historyData: HistoryDataService
  }
  features: {
    intelligentResize: IntelligentResizeManager
    language: LanguageManager
    errorHandler: ErrorHandler
    uiState: UIStateManager
    modelSelector: ModelSelectorManager
    ratioResolution: RatioResolutionManager
    imageViewer: ImageViewer
    siteManager: SiteManager
    tabManager: TabManager
    mobileMenu: MobileMenuManager
    modalFactory: ModalFactory
    toast: ToastManager
  }
  pages: {
    createGenerate: (app: AppInterface) => GeneratePage
    createHistory: (app: AppInterface) => HistoryPage
    createBatch: (app: AppInterface) => BatchPage
    createCompare: (app: AppInterface) => ComparePage
    createPromptTemplates: (app: AppInterface) => PromptTemplates
    createUnderstand: (app: AppInterface) => UnderstandPage
    createDirector: (app: AppInterface) => DirectorPage
    getGenerate: () => GeneratePage | null
    getHistory: () => HistoryPage | null
    getBatch: () => BatchPage | null
    getCompare: () => ComparePage | null
    getPromptTemplates: () => PromptTemplates | null
    getUnderstand: () => UnderstandPage | null
    getDirector: () => DirectorPage | null
  }
  utils: {
    formatFileSize: typeof formatFileSize
    formatDate: typeof formatDate
    formatRelativeTime: typeof formatRelativeTime
    formatNumber: typeof formatNumber
    formatDuration: typeof formatDuration
  }
}

// 扩展 Window 类型 - 使用 any 避免与其他声明冲突
declare global {
  interface Window {
    __serviceBridgeInitialized?: boolean
    // 统一服务命名空间 (新架构)
    appServices?: AppServicesNamespace
    // 以下为向后兼容的单独暴露 (旧架构)
    historyDataServiceTS?: HistoryDataService
    intelligentResizeManagerTS?: IntelligentResizeManager
    languageManagerTS?: LanguageManager
    errorHandlerTS?: ErrorHandler
    uiStateManagerTS?: UIStateManager
    modelSelectorManagerTS?: ModelSelectorManager
    ratioResolutionManagerTS?: RatioResolutionManager
    imageViewerTS?: ImageViewer
    siteManagerTS?: SiteManager
    tabManagerTS?: TabManager
    mobileMenuManagerTS?: MobileMenuManager
    modalFactoryTS?: ModalFactory
    keyboardShortcutsTS?: KeyboardShortcuts
    toastManagerTS?: ToastManager
    // Page factories
    createGeneratePageTS?: (app: AppInterface) => GeneratePage
    createHistoryPageTS?: (app: AppInterface) => HistoryPage
    createBatchPageTS?: (app: AppInterface) => BatchPage
    createComparePageTS?: (app: AppInterface) => ComparePage
    createPromptTemplatesTS?: (app: AppInterface) => PromptTemplates
    createUnderstandPageTS?: (app: AppInterface) => UnderstandPage
    createDirectorPageTS?: (app: AppInterface) => DirectorPage
    getGeneratePageTS?: () => GeneratePage | null
    getHistoryPageTS?: () => HistoryPage | null
    getBatchPageTS?: () => BatchPage | null
    getComparePageTS?: () => ComparePage | null
    getPromptTemplatesTS?: () => PromptTemplates | null
    getUnderstandPageTS?: () => UnderstandPage | null
    getDirectorPageTS?: () => DirectorPage | null
    // Page instances (set by app.js)
    generatePageTS?: GeneratePage
    historyPageTS?: HistoryPage
    batchPageTS?: BatchPage
    comparePageTS?: ComparePage
    promptTemplatesTS?: PromptTemplates
    understandPageTS?: UnderstandPage
    directorPageTS?: DirectorPage
  }
}
