/**
 * EventManager - 集中式事件管理器
 * 
 * V16.4: 使用事件委托模式替代内联 onclick 事件
 * 通过 data-action 属性实现声明式事件绑定
 */

import { ServiceRegistry, SERVICE_KEYS } from '../services/ServiceBridge'
import { useAgentChatStore } from '../features/agent-chat/store'
import type { AppBootstrap } from './AppBootstrap'

// 事件处理器类型
export type EventHandler = (event: Event, target: HTMLElement, data: DOMStringMap) => void | Promise<void>

// 事件动作映射
export interface ActionHandlers {
  [action: string]: EventHandler
}

export interface EventManagerConfig {
  /** 事件委托根元素 */
  delegateRoot?: HTMLElement | Document
  /** 是否启用调试日志 */
  debug?: boolean
  /** AppBootstrap 实例引用 */
  bootstrap?: AppBootstrap
}

const DEFAULT_CONFIG: Required<EventManagerConfig> = {
  delegateRoot: document,
  debug: false,
  bootstrap: null as any
}

/**
 * EventManager 单例类
 * 管理应用的全局事件
 */
export class EventManager {
  private static instance: EventManager | null = null
  
  private config: Required<EventManagerConfig>
  private actionHandlers: Map<string, Map<string, EventHandler>> = new Map()
  private initialized = false
  private boundHandlers: Map<string, EventListener> = new Map()

  private constructor(config: EventManagerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    
    // 初始化事件类型映射
    this.actionHandlers.set('click', new Map())
    this.actionHandlers.set('change', new Map())
    this.actionHandlers.set('input', new Map())
    this.actionHandlers.set('submit', new Map())
  }

  /**
   * 获取单例实例
   */
  static getInstance(config?: EventManagerConfig): EventManager {
    if (!EventManager.instance) {
      EventManager.instance = new EventManager(config)
    }
    return EventManager.instance
  }

  /**
   * 重置单例 (仅用于测试)
   */
  static resetInstance(): void {
    if (EventManager.instance) {
      EventManager.instance.destroy()
    }
    EventManager.instance = null
  }

  /**
   * 设置 AppBootstrap 引用
   */
  setBootstrap(bootstrap: AppBootstrap): void {
    this.config.bootstrap = bootstrap
  }

  /**
   * 注册事件处理器
   * @param eventType 事件类型 (click, change, input, submit)
   * @param action data-action 属性值
   * @param handler 事件处理函数
   */
  registerAction(eventType: string, action: string, handler: EventHandler): this {
    if (!this.actionHandlers.has(eventType)) {
      this.actionHandlers.set(eventType, new Map())
    }
    this.actionHandlers.get(eventType)!.set(action, handler)
    
    if (this.config.debug) {
      console.log(`[EventManager] 注册动作: ${eventType}:${action}`)
    }
    
    return this
  }

  /**
   * 注册点击事件处理器 (便捷方法)
   */
  onClick(action: string, handler: EventHandler): this {
    return this.registerAction('click', action, handler)
  }

  /**
   * 批量注册点击事件处理器
   */
  registerClickHandlers(handlers: ActionHandlers): this {
    Object.entries(handlers).forEach(([action, handler]) => {
      this.onClick(action, handler)
    })
    return this
  }

  /**
   * 初始化事件委托
   * 在 DOM 根元素上设置统一的事件监听器
   */
  init(): void {
    if (this.initialized) {
      console.log('[EventManager] 已初始化，跳过')
      return
    }

    console.log('[EventManager] 初始化事件委托...')

    // 注册默认的应用事件处理器
    this.registerDefaultHandlers()

    // 为每种事件类型设置委托
    this.actionHandlers.forEach((handlers, eventType) => {
      if (handlers.size > 0) {
        this.setupEventDelegation(eventType)
      }
    })

    // 设置全局事件 (模态框关闭、键盘快捷键等)
    this.setupGlobalEvents()

    this.initialized = true
    console.log('[EventManager] ✅ 事件委托初始化完成')
  }

  /**
   * 注册默认的应用事件处理器
   */
  private registerDefaultHandlers(): void {
    // 标签页切换
    this.onClick('switch-tab', (e, target, data) => {
      const tab = data.tab
      if (tab) {
        const tabManager = ServiceRegistry.get<any>(SERVICE_KEYS.TAB_MANAGER)
        if (tabManager) {
          tabManager.setPages(this.config.bootstrap?.getPages?.() || {})
          tabManager.switchTab(tab, true)
        }
      }
    })

    // 切换 AGENT (Codex) 浮层 —— 与 Ctrl+Shift+A 完全一致
    this.onClick('toggle-agent', () => {
      useAgentChatStore.getState().toggle()
    })

    // 顶栏「导演台 3D」入口 —— 独立浮层;动态 import 保证 three.js 按需加载
    this.onClick('open-director', () => {
      void import('../features/director-launcher').then((m) => m.openDirectorOverlay())
    })

    // 打开设置
    this.onClick('open-settings', () => {
      const siteManager = ServiceRegistry.get<any>(SERVICE_KEYS.SITE_MANAGER)
      siteManager?.openSettingsModal()
    })

    // 关闭设置
    this.onClick('close-settings', () => {
      const siteManager = ServiceRegistry.get<any>(SERVICE_KEYS.SITE_MANAGER)
      siteManager?.closeSettingsModal()
    })

    // 打开关于
    this.onClick('open-about', () => {
      document.getElementById('aboutModal')?.classList.remove('hidden')
    })

    // 关闭关于
    this.onClick('close-about', () => {
      document.getElementById('aboutModal')?.classList.add('hidden')
    })

    // 打开活动
    this.onClick('open-activity', () => {
      const modal = document.getElementById('activityModal')
      if (modal) {
        modal.classList.remove('hidden')
        // 触发活动内容加载
        const activityList = document.getElementById('activityList')
        if (activityList && activityList.innerHTML.trim() === '') {
          activityList.innerHTML = '<p class="text-gray-500">暂无活动</p>'
        }
      }
    })

    // 关闭活动
    this.onClick('close-activity', () => {
      document.getElementById('activityModal')?.classList.add('hidden')
    })

    // 下载图片
    this.onClick('download-image', async (e, target, data) => {
      const url = data.url
      if (url) {
        const api = (window as any).aiImageAPI
        if (api?.downloadImage) {
          await api.downloadImage(url, null, api.model)
          const toast = ServiceRegistry.get<any>(SERVICE_KEYS.TOAST)
          toast?.show('图片下载成功', 'success')
        }
      }
    })

    // 查看图片
    this.onClick('view-image', (e, target, data) => {
      const urls = data.urls ? JSON.parse(data.urls) : []
      const index = parseInt(data.index || '0', 10)
      const imageViewer = ServiceRegistry.get<any>(SERVICE_KEYS.IMAGE_VIEWER)
      imageViewer?.open(urls, index)
    })

    // 切换语言下拉菜单
    this.onClick('toggle-language', () => {
      const languageManager = ServiceRegistry.get<any>(SERVICE_KEYS.LANGUAGE)
      languageManager?.toggleDropdown()
    })

    // 切换语言
    this.onClick('switch-language', (e, target, data) => {
      const lang = data.lang
      if (lang) {
        const i18n = ServiceRegistry.get<any>(SERVICE_KEYS.I18N) || (window as any).i18n
        i18n?.setLanguage?.(lang)
        
        // 关闭移动端菜单
        const mobileMenu = ServiceRegistry.get<any>(SERVICE_KEYS.MOBILE_MENU)
        mobileMenu?.close()
      }
    })

    // 切换移动端菜单
    this.onClick('toggle-mobile-menu', () => {
      const mobileMenu = ServiceRegistry.get<any>(SERVICE_KEYS.MOBILE_MENU)
      mobileMenu?.toggle()
    })

    // 关闭移动端菜单
    this.onClick('close-mobile-menu', () => {
      const mobileMenu = ServiceRegistry.get<any>(SERVICE_KEYS.MOBILE_MENU)
      mobileMenu?.close()
    })

    // 保存 API Key
    this.onClick('save-api-key', async () => {
      const siteManager = ServiceRegistry.get<any>(SERVICE_KEYS.SITE_MANAGER)
      await siteManager?.saveApiKeyPublic()
    })

    // 刷新页面
    this.onClick('reload-page', () => {
      location.reload()
    })

    // 批量下载图片
    this.onClick('batch-download', async (e, target, data) => {
      const urlsStr = data.urls
      const prompt = data.prompt || ''
      if (urlsStr) {
        try {
          const urls = JSON.parse(urlsStr)
          // 调用批量下载功能
          const batchPage = (window as any).batchPage
          if (batchPage?.downloadBatchImages) {
            await batchPage.downloadBatchImages(urls, prompt)
          }
        } catch (err) {
          console.error('[EventManager] 批量下载解析失败:', err)
        }
      }
    })

    // 关闭/移除父元素
    this.onClick('dismiss-parent', (e, target) => {
      // 向上查找 3 层父元素并移除 (用于模态框/通知)
      const toRemove = target.closest('.batch-notification') || 
                       target.parentElement?.parentElement?.parentElement
      toRemove?.remove()
    })
  }

  /**
   * 设置特定事件类型的委托
   */
  private setupEventDelegation(eventType: string): void {
    const handlers = this.actionHandlers.get(eventType)
    if (!handlers || handlers.size === 0) return

    const listener = async (e: Event) => {
      const target = e.target as HTMLElement
      
      // 查找带有 data-action 属性的元素
      const actionElement = target.closest('[data-action]') as HTMLElement
      if (!actionElement) return

      const action = actionElement.dataset.action
      if (!action) return

      const handler = handlers.get(action)
      if (!handler) {
        if (this.config.debug) {
          console.log(`[EventManager] 未找到处理器: ${eventType}:${action}`)
        }
        return
      }

      if (this.config.debug) {
        console.log(`[EventManager] 触发动作: ${eventType}:${action}`)
      }

      try {
        await handler(e, actionElement, actionElement.dataset)
      } catch (error) {
        console.error(`[EventManager] 动作处理失败 (${action}):`, error)
        const errorHandler = ServiceRegistry.get<any>(SERVICE_KEYS.ERROR_HANDLER)
        errorHandler?.showDetailedError(error, `事件处理: ${action}`)
      }
    }

    this.config.delegateRoot.addEventListener(eventType, listener)
    this.boundHandlers.set(eventType, listener)
  }

  /**
   * 设置全局事件
   */
  private setupGlobalEvents(): void {
    // 模态框外部点击关闭
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      
      // 关于模态框
      if (target.id === 'aboutModal') {
        document.getElementById('aboutModal')?.classList.add('hidden')
      }
      
      // 活动模态框
      if (target.id === 'activityModal') {
        document.getElementById('activityModal')?.classList.add('hidden')
      }

      // 语言下拉菜单
      const langDropdown = document.getElementById('languageDropdown')
      if (langDropdown && !langDropdown.classList.contains('hidden')) {
        if (!target.closest('#languageSwitcher') && !target.closest('#languageDropdown')) {
          const languageManager = ServiceRegistry.get<any>(SERVICE_KEYS.LANGUAGE)
          languageManager?.closeDropdown()
        }
      }
    })

    // 键盘快捷键 - 委托给 KeyboardShortcuts
    // (已在其他地方初始化)
  }

  /**
   * 移除事件处理器
   */
  removeAction(eventType: string, action: string): boolean {
    const handlers = this.actionHandlers.get(eventType)
    if (handlers) {
      return handlers.delete(action)
    }
    return false
  }

  /**
   * 检查是否有特定动作的处理器
   */
  hasAction(eventType: string, action: string): boolean {
    return this.actionHandlers.get(eventType)?.has(action) ?? false
  }

  /**
   * 获取所有已注册的动作
   */
  getRegisteredActions(): Record<string, string[]> {
    const result: Record<string, string[]> = {}
    this.actionHandlers.forEach((handlers, eventType) => {
      result[eventType] = Array.from(handlers.keys())
    })
    return result
  }

  /**
   * 销毁事件管理器
   */
  destroy(): void {
    // 移除所有事件监听器
    this.boundHandlers.forEach((listener, eventType) => {
      this.config.delegateRoot.removeEventListener(eventType, listener)
    })
    this.boundHandlers.clear()
    
    // 清除所有处理器
    this.actionHandlers.forEach(handlers => handlers.clear())
    
    this.initialized = false
    console.log('[EventManager] 已销毁')
  }
}

// 单例实例
let eventManagerInstance: EventManager | null = null

/**
 * 获取 EventManager 单例
 */
export function getEventManager(config?: EventManagerConfig): EventManager {
  if (!eventManagerInstance) {
    eventManagerInstance = EventManager.getInstance(config)
  }
  return eventManagerInstance
}

/**
 * 创建新的 EventManager 实例
 */
export function createEventManager(config?: EventManagerConfig): EventManager {
  return new (EventManager as any)(config)
}

/**
 * 重置单例（仅用于测试）
 */
export function resetEventManager(): void {
  EventManager.resetInstance()
  eventManagerInstance = null
}

// ========================================
// V16.4 - window 暴露 (过渡期)
// ========================================

declare global {
  interface Window {
    eventManager: EventManager
    eventManagerTS: EventManager
    EventManagerTS: typeof EventManager
  }
}

/**
 * 初始化并暴露到 window（过渡期）
 */
export function initEventManagerGlobal(config?: EventManagerConfig): EventManager {
  const manager = getEventManager(config)

  // 过渡期: 暴露到 window
  if (typeof window !== 'undefined') {
    window.eventManager = manager
    window.eventManagerTS = manager
    window.EventManagerTS = EventManager
  }

  console.log('[V16.4] EventManager 已加载')

  return manager
}
