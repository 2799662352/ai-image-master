/**
 * AccessibilityManager - 可访问性管理模块
 * 
 * 负责应用的可访问性功能，包括：
 * - 焦点管理和焦点陷阱
 * - ARIA 状态更新
 * - 键盘导航增强
 * - 跳过链接
 * - 屏幕阅读器支持
 */

export interface AccessibilityConfig {
  /** 跳过链接目标 ID */
  skipLinkTargets?: string[]
  /** ARIA live 区域 ID */
  liveRegionId?: string
  /** 是否自动创建 live 区域 */
  autoCreateLiveRegion?: boolean
  /** 焦点可见性增强 */
  enhanceFocusVisibility?: boolean
}

export interface FocusTrapOptions {
  /** 初始焦点元素选择器 */
  initialFocus?: string
  /** 返回焦点的元素 */
  returnFocus?: HTMLElement
  /** 允许的焦点元素选择器 */
  focusableSelector?: string
  /** 是否在 ESC 时关闭 */
  closeOnEscape?: boolean
  /** ESC 关闭回调 */
  onEscape?: () => void
}

type AriaLivePriority = 'polite' | 'assertive' | 'off'

const DEFAULT_FOCUSABLE_SELECTOR = 
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

const DEFAULT_CONFIG: Required<AccessibilityConfig> = {
  skipLinkTargets: ['main-content', 'navigation', 'search'],
  liveRegionId: 'aria-live-region',
  autoCreateLiveRegion: true,
  enhanceFocusVisibility: true
}

/**
 * AccessibilityManager 类
 */
export class AccessibilityManager {
  private config: Required<AccessibilityConfig>
  private activeFocusTraps: Map<HTMLElement, FocusTrapOptions & { cleanup: () => void }> = new Map()
  private previousFocus: HTMLElement | null = null
  private liveRegion: HTMLElement | null = null
  
  constructor(config: AccessibilityConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }
  
  /**
   * 初始化可访问性功能
   */
  init(): void {
    console.log('[AccessibilityManager] 初始化可访问性功能...')
    
    // 创建 ARIA live 区域
    if (this.config.autoCreateLiveRegion) {
      this.createLiveRegion()
    }
    
    // 设置跳过链接
    this.setupSkipLinks()
    
    // 增强焦点可见性
    if (this.config.enhanceFocusVisibility) {
      this.enhanceFocusVisibility()
    }
    
    console.log('[AccessibilityManager] 初始化完成')
  }
  
  /**
   * 创建 ARIA live 区域
   */
  private createLiveRegion(): void {
    const existing = document.getElementById(this.config.liveRegionId)
    if (existing) {
      this.liveRegion = existing
      return
    }
    
    const region = document.createElement('div')
    region.id = this.config.liveRegionId
    region.setAttribute('aria-live', 'polite')
    region.setAttribute('aria-atomic', 'true')
    region.className = 'sr-only'
    region.style.cssText = `
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    `
    
    document.body.appendChild(region)
    this.liveRegion = region
  }
  
  /**
   * 更新 ARIA live 区域消息
   */
  updateAriaLive(message: string, priority: AriaLivePriority = 'polite'): void {
    if (!this.liveRegion) {
      this.createLiveRegion()
    }
    
    if (this.liveRegion) {
      this.liveRegion.setAttribute('aria-live', priority)
      // 先清空再设置，确保屏幕阅读器能识别到变化
      this.liveRegion.textContent = ''
      
      requestAnimationFrame(() => {
        if (this.liveRegion) {
          this.liveRegion.textContent = message
        }
      })
    }
  }
  
  /**
   * 设置跳过链接
   */
  setupSkipLinks(): void {
    // 检查是否已存在跳过链接容器
    let container = document.getElementById('skip-links')
    if (container) return
    
    container = document.createElement('div')
    container.id = 'skip-links'
    container.className = 'skip-links-container'
    
    this.config.skipLinkTargets.forEach(targetId => {
      const target = document.getElementById(targetId)
      if (target) {
        const link = document.createElement('a')
        link.href = `#${targetId}`
        link.className = 'skip-link'
        link.textContent = this.getSkipLinkText(targetId)
        
        link.addEventListener('click', (e) => {
          e.preventDefault()
          target.focus()
          target.scrollIntoView({ behavior: 'smooth' })
        })
        
        container!.appendChild(link)
      }
    })
    
    if (container.children.length > 0) {
      // 添加跳过链接样式
      this.addSkipLinkStyles()
      document.body.insertBefore(container, document.body.firstChild)
    }
  }
  
  /**
   * 获取跳过链接文本
   */
  private getSkipLinkText(targetId: string): string {
    const texts: Record<string, string> = {
      'main-content': '跳到主要内容',
      'navigation': '跳到导航',
      'search': '跳到搜索'
    }
    return texts[targetId] || `跳到 ${targetId}`
  }
  
  /**
   * 添加跳过链接样式
   */
  private addSkipLinkStyles(): void {
    const styleId = 'accessibility-skip-link-styles'
    if (document.getElementById(styleId)) return
    
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = `
      .skip-link {
        position: absolute;
        left: -9999px;
        top: auto;
        width: 1px;
        height: 1px;
        overflow: hidden;
        z-index: -999;
      }
      
      .skip-link:focus {
        left: 10px;
        top: 10px;
        width: auto;
        height: auto;
        overflow: visible;
        z-index: 99999;
        padding: 0.75rem 1rem;
        background: #1f2937;
        color: white;
        border-radius: 0.5rem;
        text-decoration: none;
        font-weight: 600;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
      }
      
      .skip-link:focus:hover {
        background: #374151;
      }
    `
    document.head.appendChild(style)
  }
  
  /**
   * 增强焦点可见性
   */
  private enhanceFocusVisibility(): void {
    // 添加焦点可见样式
    const styleId = 'accessibility-focus-styles'
    if (document.getElementById(styleId)) return
    
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = `
      /* 键盘焦点可见性增强 */
      :focus-visible {
        outline: 2px solid #3b82f6;
        outline-offset: 2px;
      }
      
      /* 移除鼠标焦点的 outline */
      :focus:not(:focus-visible) {
        outline: none;
      }
      
      /* 屏幕阅读器专用类 */
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      
      .sr-only-focusable:focus,
      .sr-only-focusable:active {
        position: static;
        width: auto;
        height: auto;
        overflow: visible;
        clip: auto;
        white-space: normal;
      }
    `
    document.head.appendChild(style)
  }
  
  /**
   * 创建焦点陷阱
   */
  trapFocus(container: HTMLElement, options: FocusTrapOptions = {}): () => void {
    const focusableSelector = options.focusableSelector || DEFAULT_FOCUSABLE_SELECTOR
    
    // 保存之前的焦点
    this.previousFocus = document.activeElement as HTMLElement
    
    // 获取可聚焦元素
    const getFocusableElements = () => {
      return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector))
        .filter(el => !el.hasAttribute('disabled') && el.tabIndex !== -1)
    }
    
    // 设置初始焦点
    const focusableElements = getFocusableElements()
    if (options.initialFocus) {
      const initial = container.querySelector<HTMLElement>(options.initialFocus)
      if (initial) {
        initial.focus()
      } else if (focusableElements.length > 0) {
        focusableElements[0].focus()
      }
    } else if (focusableElements.length > 0) {
      focusableElements[0].focus()
    }
    
    // 键盘事件处理
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        const elements = getFocusableElements()
        if (elements.length === 0) return
        
        const firstElement = elements[0]
        const lastElement = elements[elements.length - 1]
        
        if (e.shiftKey) {
          // Shift + Tab
          if (document.activeElement === firstElement) {
            e.preventDefault()
            lastElement.focus()
          }
        } else {
          // Tab
          if (document.activeElement === lastElement) {
            e.preventDefault()
            firstElement.focus()
          }
        }
      } else if (e.key === 'Escape' && options.closeOnEscape) {
        options.onEscape?.()
      }
    }
    
    container.addEventListener('keydown', handleKeyDown)
    
    // 清理函数
    const cleanup = () => {
      container.removeEventListener('keydown', handleKeyDown)
      this.activeFocusTraps.delete(container)
      
      // 恢复焦点
      const returnFocus = options.returnFocus || this.previousFocus
      if (returnFocus && document.body.contains(returnFocus)) {
        returnFocus.focus()
      }
    }
    
    this.activeFocusTraps.set(container, { ...options, cleanup })
    
    return cleanup
  }
  
  /**
   * 释放焦点陷阱
   */
  releaseFocusTrap(container: HTMLElement): void {
    const trap = this.activeFocusTraps.get(container)
    if (trap) {
      trap.cleanup()
    }
  }
  
  /**
   * 恢复焦点到之前的元素
   */
  restoreFocus(): void {
    if (this.previousFocus && document.body.contains(this.previousFocus)) {
      this.previousFocus.focus()
      this.previousFocus = null
    }
  }
  
  /**
   * 启用容器内的箭头键导航
   */
  enableArrowNavigation(container: HTMLElement, options: {
    selector?: string
    loop?: boolean
    vertical?: boolean
    horizontal?: boolean
  } = {}): () => void {
    const {
      selector = '[role="menuitem"], [role="option"], button',
      loop = true,
      vertical = true,
      horizontal = false
    } = options
    
    const handleKeyDown = (e: KeyboardEvent) => {
      const items = Array.from(container.querySelectorAll<HTMLElement>(selector))
        .filter(el => !el.hasAttribute('disabled'))
      
      if (items.length === 0) return
      
      const currentIndex = items.indexOf(document.activeElement as HTMLElement)
      if (currentIndex === -1) return
      
      let nextIndex = currentIndex
      
      if (vertical && e.key === 'ArrowDown' || horizontal && e.key === 'ArrowRight') {
        e.preventDefault()
        nextIndex = currentIndex + 1
        if (nextIndex >= items.length) {
          nextIndex = loop ? 0 : items.length - 1
        }
      } else if (vertical && e.key === 'ArrowUp' || horizontal && e.key === 'ArrowLeft') {
        e.preventDefault()
        nextIndex = currentIndex - 1
        if (nextIndex < 0) {
          nextIndex = loop ? items.length - 1 : 0
        }
      } else if (e.key === 'Home') {
        e.preventDefault()
        nextIndex = 0
      } else if (e.key === 'End') {
        e.preventDefault()
        nextIndex = items.length - 1
      }
      
      if (nextIndex !== currentIndex) {
        items[nextIndex].focus()
      }
    }
    
    container.addEventListener('keydown', handleKeyDown)
    
    return () => {
      container.removeEventListener('keydown', handleKeyDown)
    }
  }
  
  /**
   * 设置元素的 ARIA 属性
   */
  setAriaAttributes(element: HTMLElement, attributes: Record<string, string | boolean>): void {
    for (const [key, value] of Object.entries(attributes)) {
      if (value === false) {
        element.removeAttribute(`aria-${key}`)
      } else if (value === true) {
        element.setAttribute(`aria-${key}`, 'true')
      } else {
        element.setAttribute(`aria-${key}`, value)
      }
    }
  }
  
  /**
   * 更新加载状态
   */
  updateLoadingState(element: HTMLElement, isLoading: boolean, message?: string): void {
    this.setAriaAttributes(element, {
      busy: isLoading,
      disabled: isLoading
    })
    
    if (message) {
      this.updateAriaLive(message, isLoading ? 'polite' : 'assertive')
    }
  }
  
  /**
   * 宣布警告消息
   */
  announceAlert(message: string): void {
    this.updateAriaLive(message, 'assertive')
  }
  
  /**
   * 宣布状态消息
   */
  announceStatus(message: string): void {
    this.updateAriaLive(message, 'polite')
  }
  
  /**
   * 销毁
   */
  destroy(): void {
    // 释放所有焦点陷阱
    for (const trap of this.activeFocusTraps.values()) {
      trap.cleanup()
    }
    this.activeFocusTraps.clear()
    
    // 移除 live 区域
    if (this.liveRegion) {
      this.liveRegion.remove()
      this.liveRegion = null
    }
    
    // 移除跳过链接
    const skipLinks = document.getElementById('skip-links')
    if (skipLinks) {
      skipLinks.remove()
    }
  }
}

// 单例实例
let accessibilityManagerInstance: AccessibilityManager | null = null

/**
 * 获取 AccessibilityManager 单例
 */
export function getAccessibilityManager(config?: AccessibilityConfig): AccessibilityManager {
  if (!accessibilityManagerInstance) {
    accessibilityManagerInstance = new AccessibilityManager(config)
  }
  return accessibilityManagerInstance
}

/**
 * 创建新的 AccessibilityManager 实例 (仅用于测试)
 */
export function createAccessibilityManager(config?: AccessibilityConfig): AccessibilityManager {
  accessibilityManagerInstance = new AccessibilityManager(config)
  return accessibilityManagerInstance
}
