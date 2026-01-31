// src/renderer/src/features/dialog/DialogManager.ts
// 模态框管理器 - 从 app.js 提取

export interface DialogConfig {
  onOpen?: (dialogId: string) => void
  onClose?: (dialogId: string) => void
  closeOnBackdrop?: boolean
  closeOnEscape?: boolean
}

export interface DialogElements {
  settingsModal?: string
  aboutModal?: string
  activityModal?: string
}

const DEFAULT_ELEMENTS: DialogElements = {
  settingsModal: 'settingsModal',
  aboutModal: 'aboutModal',
  activityModal: 'activityModal'
}

export class DialogManager {
  private activeDialogs: Map<string, HTMLElement> = new Map()
  private config: DialogConfig
  private elements: DialogElements
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private callbacks: Map<string, { onOpen?: () => void; onClose?: () => void }> = new Map()

  constructor(config: DialogConfig = {}, elements: DialogElements = DEFAULT_ELEMENTS) {
    this.config = {
      closeOnBackdrop: true,
      closeOnEscape: true,
      ...config
    }
    this.elements = elements
    this.initEscapeHandler()
  }

  /**
   * 初始化 ESC 键处理
   */
  private initEscapeHandler(): void {
    if (!this.config.closeOnEscape) return

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeTopmost()
      }
    }
    document.addEventListener('keydown', this.escapeHandler)
  }

  /**
   * 打开设置模态框
   */
  openSettings(): void {
    this.open('settingsModal', () => {
      // 渲染站点卡片
      if (typeof (window as any).renderSiteCards === 'function') {
        (window as any).renderSiteCards()
      }
      // 加载并显示已保存的 API Keys
      if ((window as any).app?.loadStoredApiKey) {
        (window as any).app.loadStoredApiKey()
      }
      // 加载当前站点的 API Key
      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement | null
      if (apiKeyInput && (window as any).aiImageAPI) {
        const storedKey = (window as any).aiImageAPI.getStoredApiKey((window as any).aiImageAPI.currentSite)
        const site = (window as any).aiImageAPI.getCurrentSite()
        apiKeyInput.value = storedKey || site?.defaultApiKey || ''
      }
      // 更新模态框内的翻译
      if (typeof (window as any).i18n !== 'undefined' && (window as any).i18n.updateDOM) {
        (window as any).i18n.updateDOM()
      }
    })
  }

  /**
   * 关闭设置模态框
   */
  closeSettings(): void {
    this.close('settingsModal')
  }

  /**
   * 打开项目说明模态框
   */
  openAbout(): void {
    this.open('aboutModal')
  }

  /**
   * 关闭项目说明模态框
   */
  closeAbout(): void {
    this.close('aboutModal')
  }

  /**
   * 打开活动弹窗
   */
  openActivity(): void {
    this.open('activityModal', () => {
      // 关闭移动端菜单（如果打开的话）
      if ((window as any).app?.closeMobileMenu) {
        (window as any).app.closeMobileMenu()
      }
    })
  }

  /**
   * 关闭活动弹窗
   */
  closeActivity(): void {
    this.close('activityModal')
  }

  /**
   * 通用打开模态框方法
   */
  open(dialogId: string, onOpenCallback?: () => void): void {
    const elementId = this.elements[dialogId as keyof DialogElements] || dialogId
    const modal = document.getElementById(elementId)
    
    if (!modal) {
      console.warn(`[DialogManager] Modal not found: ${elementId}`)
      return
    }

    // 保存之前的焦点用于恢复
    this.previousFocus = document.activeElement as HTMLElement
    
    modal.classList.remove('hidden')
    this.activeDialogs.set(dialogId, modal)
    
    // 设置 ARIA 属性以增强可访问性
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    
    // 查找并设置 aria-labelledby
    const titleElement = modal.querySelector('h2, h3, [class*="title"]')
    if (titleElement) {
      const titleId = titleElement.id || `${elementId}-title`
      if (!titleElement.id) {
        titleElement.id = titleId
      }
      modal.setAttribute('aria-labelledby', titleId)
    }

    // 绑定背景点击关闭
    if (this.config.closeOnBackdrop) {
      const backdropHandler = (e: MouseEvent) => {
        if (e.target === modal) {
          this.close(dialogId)
          modal.removeEventListener('click', backdropHandler)
        }
      }
      modal.addEventListener('click', backdropHandler)
    }
    
    // 设置焦点到模态框内的第一个可聚焦元素
    setTimeout(() => {
      const focusable = modal.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusable) {
        focusable.focus()
      } else {
        modal.focus()
      }
    }, 100)

    // 调用回调
    onOpenCallback?.()
    this.config.onOpen?.(dialogId)
    this.callbacks.get(dialogId)?.onOpen?.()
  }
  
  /** 保存之前的焦点 */
  private previousFocus: HTMLElement | null = null

  /**
   * 通用关闭模态框方法
   */
  close(dialogId: string): void {
    const elementId = this.elements[dialogId as keyof DialogElements] || dialogId
    const modal = document.getElementById(elementId)
    
    if (modal) {
      modal.classList.add('hidden')
      this.activeDialogs.delete(dialogId)
      
      // 移除 ARIA 属性
      modal.removeAttribute('aria-modal')
      
      // 恢复之前的焦点
      if (this.previousFocus && document.body.contains(this.previousFocus)) {
        this.previousFocus.focus()
        this.previousFocus = null
      }
      
      this.config.onClose?.(dialogId)
      this.callbacks.get(dialogId)?.onClose?.()
    }
  }

  /**
   * 关闭所有模态框
   */
  closeAll(): void {
    this.activeDialogs.forEach((_, dialogId) => {
      this.close(dialogId)
    })
  }

  /**
   * 关闭最上层的模态框
   */
  closeTopmost(): void {
    const dialogIds = Array.from(this.activeDialogs.keys())
    if (dialogIds.length > 0) {
      const topmost = dialogIds[dialogIds.length - 1]
      this.close(topmost)
    }
  }

  /**
   * 检查指定模态框是否打开
   */
  isOpen(dialogId: string): boolean {
    return this.activeDialogs.has(dialogId)
  }

  /**
   * 检查是否有任何模态框打开
   */
  hasOpenDialogs(): boolean {
    return this.activeDialogs.size > 0
  }

  /**
   * 获取当前打开的模态框列表
   */
  getOpenDialogs(): string[] {
    return Array.from(this.activeDialogs.keys())
  }

  /**
   * 注册模态框回调
   */
  registerCallbacks(dialogId: string, callbacks: { onOpen?: () => void; onClose?: () => void }): void {
    this.callbacks.set(dialogId, callbacks)
  }

  /**
   * 清理资源
   */
  destroy(): void {
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler)
      this.escapeHandler = null
    }
    this.closeAll()
    this.callbacks.clear()
  }
}

// 单例实例
let dialogManagerInstance: DialogManager | null = null

/**
 * 获取 DialogManager 单例
 */
export function getDialogManager(config?: DialogConfig): DialogManager {
  if (!dialogManagerInstance) {
    dialogManagerInstance = new DialogManager(config)
  }
  return dialogManagerInstance
}

/**
 * 创建新的 DialogManager 实例
 */
export function createDialogManager(config?: DialogConfig, elements?: DialogElements): DialogManager {
  return new DialogManager(config, elements)
}
