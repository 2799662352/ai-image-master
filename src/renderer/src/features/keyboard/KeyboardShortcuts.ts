// src/renderer/src/features/keyboard/KeyboardShortcuts.ts
/**
 * 键盘快捷键管理器
 * 处理全局快捷键、粘贴事件和上传上下文检测
 */

export interface PageActions {
  generateImage?: () => void
  editImage?: () => void
  batchGenerate?: () => void
  handlePasteEvent?: (e: ClipboardEvent) => void
  handleBatchPasteEvent?: (e: ClipboardEvent) => void
}

export interface KeyboardShortcutsConfig {
  getCurrentTab: () => string
  getPages: () => Record<string, PageActions>
  closeSettings?: () => void
  closeAbout?: () => void
  closeActivity?: () => void
  uploadElementIds?: string[]
  uploadContextTimeout?: number
}

export type ShortcutHandler = (e: KeyboardEvent) => void
export type PasteHandler = (e: ClipboardEvent) => void

export class KeyboardShortcuts {
  private config: KeyboardShortcutsConfig
  private lastUploadInteraction: number | null = null
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null
  private pasteHandler: ((e: ClipboardEvent) => void) | null = null
  private customShortcuts: Map<string, ShortcutHandler> = new Map()

  private readonly DEFAULT_UPLOAD_ELEMENT_IDS = [
    'referenceImageArea',
    'batchReferenceImageArea'
  ]

  private readonly UPLOAD_CONTEXT_TIMEOUT = 3000 // 3 seconds

  constructor(config: KeyboardShortcutsConfig) {
    this.config = config
  }

  /**
   * 初始化键盘快捷键
   */
  init(): void {
    this.keydownHandler = (e: KeyboardEvent) => this.handleKeyboard(e)
    this.pasteHandler = (e: ClipboardEvent) => this.handlePaste(e)

    document.addEventListener('keydown', this.keydownHandler)
    document.addEventListener('paste', this.pasteHandler)

    // 绑定上传区域交互跟踪
    this.bindUploadInteractionTracking()

    console.log('⌨️ 键盘快捷键已初始化')
  }

  /**
   * 处理键盘事件
   */
  handleKeyboard(e: KeyboardEvent): void {
    // 检查自定义快捷键
    const shortcutKey = this.getShortcutKey(e)
    const customHandler = this.customShortcuts.get(shortcutKey)
    if (customHandler) {
      customHandler(e)
      return
    }

    // Ctrl/Cmd + Enter 执行当前页面的主要操作
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      this.handleExecuteAction()
      return
    }

    // Escape 关闭模态框
    if (e.key === 'Escape') {
      this.handleEscape()
      return
    }
  }

  /**
   * 处理执行操作 (Ctrl/Cmd + Enter)
   */
  private handleExecuteAction(): void {
    const currentTab = this.config.getCurrentTab()
    const pages = this.config.getPages()

    switch (currentTab) {
      case 'generate':
        if (pages.generate?.generateImage) {
          pages.generate.generateImage()
        }
        break
      case 'edit':
        if (pages.edit?.editImage) {
          pages.edit.editImage()
        }
        break
      case 'batch':
        if (pages.batch?.batchGenerate) {
          pages.batch.batchGenerate()
        }
        break
    }
  }

  /**
   * 处理 Escape 键
   */
  private handleEscape(): void {
    // 先检查自定义站点模态框
    const customSiteModal = document.getElementById('customSiteModal')
    if (customSiteModal && !customSiteModal.classList.contains('hidden')) {
      // 尝试调用全局的 closeCustomSiteModal 函数
      if (typeof (window as any).closeCustomSiteModal === 'function') {
        (window as any).closeCustomSiteModal()
      }
      return
    }

    // 检查设置模态框
    const settingsModal = document.getElementById('settingsModal')
    if (settingsModal && !settingsModal.classList.contains('hidden')) {
      this.config.closeSettings?.()
    }

    // 关闭关于和活动模态框
    this.config.closeAbout?.()
    this.config.closeActivity?.()
  }

  /**
   * 处理粘贴事件
   */
  handlePaste(e: ClipboardEvent): void {
    // 检查是否在输入框中粘贴文本，如果是则不处理图片
    const activeElement = document.activeElement
    if (activeElement && (activeElement.tagName === 'TEXTAREA' || activeElement.tagName === 'INPUT')) {
      return
    }

    // 检查是否有与上传相关的元素获得焦点或者最近被交互过
    const isInUploadContext = this.isInImageUploadContext()
    if (!isInUploadContext) {
      return // 不在上传上下文中，不处理粘贴
    }

    // 根据当前激活的面板，分发粘贴事件
    const currentTab = this.config.getCurrentTab()
    const pages = this.config.getPages()

    if (currentTab === 'generate') {
      if (pages.generate?.handlePasteEvent) {
        pages.generate.handlePasteEvent(e)
      }
    } else if (currentTab === 'batch') {
      if (pages.batch?.handleBatchPasteEvent) {
        pages.batch.handleBatchPasteEvent(e)
      }
    }
  }

  /**
   * 绑定上传区域交互跟踪
   */
  private bindUploadInteractionTracking(): void {
    const uploadElementIds = this.config.uploadElementIds || this.DEFAULT_UPLOAD_ELEMENT_IDS

    uploadElementIds.forEach(id => {
      const element = document.getElementById(id)
      if (element) {
        // 监听多种交互事件
        const events = ['mouseenter', 'click', 'focus', 'touchstart']
        events.forEach(eventType => {
          element.addEventListener(eventType, () => {
            this.lastUploadInteraction = Date.now()
          })
        })

        // 为子元素也添加交互跟踪（使用捕获阶段）
        element.addEventListener('click', () => {
          this.lastUploadInteraction = Date.now()
        }, true)
      }
    })
  }

  /**
   * 检查是否在图片上传的上下文中
   */
  isInImageUploadContext(): boolean {
    const activeElement = document.activeElement
    const uploadElementIds = this.config.uploadElementIds || this.DEFAULT_UPLOAD_ELEMENT_IDS

    // 检查当前焦点是否在上传相关的元素上
    if (activeElement) {
      for (const id of uploadElementIds) {
        const uploadElement = document.getElementById(id)
        if (uploadElement && (activeElement === uploadElement || uploadElement.contains(activeElement))) {
          return true
        }
      }
    }

    // 检查最近是否有与上传区域的交互
    const timeout = this.config.uploadContextTimeout || this.UPLOAD_CONTEXT_TIMEOUT
    const currentTime = Date.now()
    if (this.lastUploadInteraction && (currentTime - this.lastUploadInteraction) < timeout) {
      return true
    }

    return false
  }

  /**
   * 获取快捷键标识
   */
  private getShortcutKey(e: KeyboardEvent): string {
    const parts: string[] = []
    if (e.ctrlKey) parts.push('ctrl')
    if (e.metaKey) parts.push('meta')
    if (e.altKey) parts.push('alt')
    if (e.shiftKey) parts.push('shift')
    parts.push(e.key.toLowerCase())
    return parts.join('+')
  }

  /**
   * 注册自定义快捷键
   */
  registerShortcut(key: string, handler: ShortcutHandler): () => void {
    this.customShortcuts.set(key.toLowerCase(), handler)

    // 返回取消注册函数
    return () => {
      this.customShortcuts.delete(key.toLowerCase())
    }
  }

  /**
   * 取消注册快捷键
   */
  unregisterShortcut(key: string): void {
    this.customShortcuts.delete(key.toLowerCase())
  }

  /**
   * 手动触发上传交互记录
   */
  recordUploadInteraction(): void {
    this.lastUploadInteraction = Date.now()
  }

  /**
   * 销毁实例
   */
  destroy(): void {
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler)
      this.keydownHandler = null
    }
    if (this.pasteHandler) {
      document.removeEventListener('paste', this.pasteHandler)
      this.pasteHandler = null
    }
    this.customShortcuts.clear()
    this.lastUploadInteraction = null
  }
}

// 单例实例
let keyboardShortcutsInstance: KeyboardShortcuts | null = null

/**
 * 获取 KeyboardShortcuts 单例
 */
export function getKeyboardShortcuts(config?: KeyboardShortcutsConfig): KeyboardShortcuts {
  if (!keyboardShortcutsInstance && config) {
    keyboardShortcutsInstance = new KeyboardShortcuts(config)
  }
  if (!keyboardShortcutsInstance) {
    throw new Error('KeyboardShortcuts not initialized. Please provide config.')
  }
  return keyboardShortcutsInstance
}

/**
 * 创建新的 KeyboardShortcuts 实例
 */
export function createKeyboardShortcuts(config: KeyboardShortcutsConfig): KeyboardShortcuts {
  return new KeyboardShortcuts(config)
}
