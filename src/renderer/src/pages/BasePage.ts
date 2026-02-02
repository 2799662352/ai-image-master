// src/renderer/src/pages/BasePage.ts
/**
 * 页面基类
 * 提供所有页面模块的通用功能和接口定义
 */

export interface PageState {
  [key: string]: any
}

export interface UploadConfig {
  maxConcurrency: number
  retryAttempts: number
  timeout: number
}

export interface AppInterface {
  showToast: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void
  switchTab: (tabName: string, updateUrl?: boolean) => void
  addToHistory: (type: string, prompt: string, urls: string[], ratio?: string | null) => void
  currentTab: string
  history: any[]
  pages: Record<string, any>
}

/**
 * 页面基类 - 抽象类
 * 所有页面模块都应继承此类
 */
export abstract class BasePage {
  protected app: AppInterface
  protected stateRestored: boolean = false
  protected isInitialized: boolean = false

  // 默认上传配置
  protected uploadConfig: UploadConfig = {
    maxConcurrency: 5,
    retryAttempts: 3,
    timeout: 30000
  }

  constructor(app: AppInterface) {
    this.app = app
  }

  /**
   * 初始化页面
   */
  abstract init(): void

  /**
   * 绑定事件
   */
  abstract bindEvents(): void

  /**
   * 保存页面状态
   */
  abstract saveState(): void

  /**
   * 恢复页面状态
   */
  abstract restoreState(): Promise<void>

  /**
   * 销毁页面（清理资源）
   */
  destroy(): void {
    this.isInitialized = false
  }

  /**
   * 显示 Toast 消息
   */
  protected showToast(message: string, type: 'success' | 'error' | 'info' | 'warning' = 'info'): void {
    if (this.app?.showToast) {
      this.app.showToast(message, type)
    } else if ((window as any).toastManagerTS) {
      (window as any).toastManagerTS.show(message, type)
    } else {
      console.log(`[${type}] ${message}`)
    }
  }

  /**
   * 获取 DOM 元素
   */
  protected getElement<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null
  }

  /**
   * 安全地添加事件监听器
   * @param elementId - 元素 ID
   * @param event - 事件类型
   * @param handler - 事件处理函数
   * @param silent - 是否静默（不输出警告），用于动态创建的元素
   */
  protected addEventListenerSafe(
    elementId: string,
    event: string,
    handler: EventListener,
    silent: boolean = false
  ): void {
    const element = document.getElementById(elementId)
    if (element) {
      element.addEventListener(event, handler)
    } else if (!silent) {
      console.warn(`[BasePage] Element not found: ${elementId}`)
    }
  }

  /**
   * 获取 i18n 翻译
   */
  protected t(key: string, params?: Record<string, string | number>): string {
    const i18n = (window as any).i18n
    if (i18n?.t) {
      return i18n.t(key, params)
    }
    return key
  }

  /**
   * 获取 API 实例
   */
  protected getApi(): any {
    return (window as any).aiImageAPI
  }

  /**
   * 检查是否在线
   */
  protected isOnline(): boolean {
    return navigator.onLine
  }

  /**
   * 延迟执行（用于动画等）
   */
  protected delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * 请求空闲回调（优化性能）
   */
  protected requestIdleCallback(callback: () => void, options?: { timeout: number }): void {
    if (window.requestIdleCallback) {
      window.requestIdleCallback(callback, options)
    } else {
      setTimeout(callback, options?.timeout || 100)
    }
  }
}

export default BasePage
