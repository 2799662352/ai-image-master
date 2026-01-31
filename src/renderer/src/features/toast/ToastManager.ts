// src/renderer/src/features/toast/ToastManager.ts
/**
 * Toast 通知管理器
 * 处理全局 toast 通知的显示和队列管理
 */

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface ToastConfig {
  duration?: number
  containerId?: string
  iconId?: string
  messageId?: string
}

export interface ToastAction {
  label: string
  onClick: () => void
}

const TOAST_ICONS: Record<ToastType, string> = {
  success: '<i class="fas fa-check-circle text-green-500 text-xl"></i>',
  error: '<i class="fas fa-exclamation-circle text-red-500 text-xl"></i>',
  info: '<i class="fas fa-info-circle text-blue-500 text-xl"></i>',
  warning: '<i class="fas fa-exclamation-triangle text-yellow-500 text-xl"></i>'
}

const DEFAULT_CONFIG: ToastConfig = {
  duration: 3000,
  containerId: 'toast',
  iconId: 'toastIcon',
  messageId: 'toastMessage'
}

export class ToastManager {
  private config: ToastConfig
  private currentTimeout: ReturnType<typeof setTimeout> | null = null
  private queue: Array<{ message: string; type: ToastType }> = []
  private isShowing = false

  constructor(config: ToastConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 显示 toast 通知
   */
  show(message: string, type: ToastType = 'info'): void {
    const toast = document.getElementById(this.config.containerId!)
    const toastIcon = document.getElementById(this.config.iconId!)
    const toastMessage = document.getElementById(this.config.messageId!)

    if (!toast || !toastIcon || !toastMessage) {
      // 降级到 console
      console.log(`[Toast ${type}] ${message}`)
      return
    }

    // 清除之前的定时器
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout)
    }

    // 更新内容
    toastIcon.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info
    toastMessage.textContent = message

    // 显示
    toast.classList.remove('hidden')
    this.isShowing = true

    // 自动隐藏
    this.currentTimeout = setTimeout(() => {
      this.dismiss()
      this.processQueue()
    }, this.config.duration!)
  }

  /**
   * 显示带操作按钮的 toast
   */
  showWithAction(message: string, action: ToastAction, type: ToastType = 'info'): void {
    const toast = document.getElementById(this.config.containerId!)
    const toastIcon = document.getElementById(this.config.iconId!)
    const toastMessage = document.getElementById(this.config.messageId!)

    if (!toast || !toastIcon || !toastMessage) {
      console.log(`[Toast ${type}] ${message} [Action: ${action.label}]`)
      return
    }

    // 清除之前的定时器
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout)
    }

    // 更新内容，添加操作按钮
    toastIcon.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info
    toastMessage.innerHTML = `
      <span>${message}</span>
      <button class="toast-action-btn ml-2 px-2 py-1 bg-blue-500 text-white rounded text-sm hover:bg-blue-600">
        ${action.label}
      </button>
    `

    // 绑定操作按钮事件
    const actionBtn = toastMessage.querySelector('.toast-action-btn')
    if (actionBtn) {
      actionBtn.addEventListener('click', () => {
        action.onClick()
        this.dismiss()
      })
    }

    // 显示
    toast.classList.remove('hidden')
    this.isShowing = true

    // 自动隐藏（带操作的 toast 显示时间更长）
    this.currentTimeout = setTimeout(() => {
      this.dismiss()
      this.processQueue()
    }, this.config.duration! * 2)
  }

  /**
   * 添加到队列
   */
  enqueue(message: string, type: ToastType = 'info'): void {
    if (this.isShowing) {
      this.queue.push({ message, type })
    } else {
      this.show(message, type)
    }
  }

  /**
   * 处理队列中的下一个 toast
   */
  private processQueue(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      setTimeout(() => {
        this.show(next.message, next.type)
      }, 300) // 短暂延迟以实现过渡效果
    }
  }

  /**
   * 隐藏 toast
   */
  dismiss(): void {
    const toast = document.getElementById(this.config.containerId!)
    if (toast) {
      toast.classList.add('hidden')
    }
    this.isShowing = false

    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout)
      this.currentTimeout = null
    }
  }

  /**
   * 清空队列
   */
  clearQueue(): void {
    this.queue = []
  }

  /**
   * 销毁实例
   */
  destroy(): void {
    this.dismiss()
    this.clearQueue()
  }
}

// 单例实例
let toastManagerInstance: ToastManager | null = null

/**
 * 获取 ToastManager 单例
 */
export function getToastManager(config?: ToastConfig): ToastManager {
  if (!toastManagerInstance) {
    toastManagerInstance = new ToastManager(config)
  }
  return toastManagerInstance
}

/**
 * 创建新的 ToastManager 实例
 */
export function createToastManager(config?: ToastConfig): ToastManager {
  return new ToastManager(config)
}
