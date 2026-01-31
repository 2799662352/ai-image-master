/**
 * UIComponentsService - UI 组件服务
 * V16.2 A2 - 从 js/components.js 迁移
 * 
 * 功能:
 * - 图片懒加载
 * - 响应式功能
 * - UI 组件工厂方法
 * - 拖拽排序
 * - 无限滚动
 */

/**
 * 图片卡片操作按钮配置
 */
export interface ImageCardAction {
  onclick: string
  title: string
  icon: string
}

/**
 * 图片画廊项
 */
export interface GalleryImage {
  url: string
  title?: string
}

/**
 * UIComponents 配置
 */
export interface UIComponentsConfig {
  /** 是否自动初始化 */
  autoInit?: boolean
  /** 移动端断点 (px) */
  mobileBreakpoint?: number
  /** 是否启用日志 */
  enableLogging?: boolean
}

const DEFAULT_CONFIG: Required<UIComponentsConfig> = {
  autoInit: true,
  mobileBreakpoint: 768,
  enableLogging: false
}

/**
 * UIComponents 类
 * 管理 UI 组件和功能
 */
export class UIComponents {
  private config: Required<UIComponentsConfig>
  private imageObserver: IntersectionObserver | null = null
  private resizeHandler: (() => void) | null = null

  constructor(config: UIComponentsConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }

    if (this.config.autoInit) {
      this.initComponents()
    }
  }

  /**
   * 初始化所有组件
   */
  initComponents(): void {
    this.enhanceTabSwitching()
    this.addImageOptimization()
    this.initResponsiveFeatures()
    this.log('UIComponents 初始化完成')
  }

  /**
   * 日志输出
   */
  private log(message: string): void {
    if (this.config.enableLogging) {
      console.log(`[UIComponents] ${message}`)
    }
  }

  // ========================================
  // 标签切换增强
  // ========================================

  /**
   * 增强标签切换动画
   */
  enhanceTabSwitching(): void {
    const tabBtns = document.querySelectorAll<HTMLElement>('.tab-btn')

    tabBtns.forEach((btn) => {
      btn.addEventListener('mouseenter', () => {
        if (!btn.classList.contains('active')) {
          btn.style.transition = 'all 0.3s ease'
        }
      })

      btn.addEventListener('mouseleave', () => {
        if (!btn.classList.contains('active')) {
          btn.style.transition = 'all 0.3s ease'
        }
      })
    })
  }

  // ========================================
  // 图片优化
  // ========================================

  /**
   * 添加图片优化功能（懒加载）
   */
  addImageOptimization(): void {
    this.imageObserver = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const img = entry.target as HTMLImageElement
            if (img.dataset.src) {
              img.src = img.dataset.src
              img.removeAttribute('data-src')
              observer.unobserve(img)
            }
          }
        })
      }
    )
  }

  /**
   * 观察容器中的图片进行懒加载
   */
  observeImages(container: HTMLElement): void {
    if (!this.imageObserver) return

    const images = container.querySelectorAll<HTMLImageElement>('img[data-src]')
    images.forEach((img) => this.imageObserver!.observe(img))
  }

  // ========================================
  // 响应式功能
  // ========================================

  /**
   * 初始化响应式功能
   */
  initResponsiveFeatures(): void {
    // 初始检查
    if (window.innerWidth < this.config.mobileBreakpoint) {
      this.enableMobileOptimizations()
    }

    // 窗口大小变化监听
    this.resizeHandler = () => {
      if (window.innerWidth < this.config.mobileBreakpoint) {
        this.enableMobileOptimizations()
      } else {
        this.disableMobileOptimizations()
      }
    }

    window.addEventListener('resize', this.resizeHandler)
  }

  /**
   * 启用移动端优化
   */
  enableMobileOptimizations(): void {
    const decorativeElements = document.querySelectorAll<HTMLElement>('.glass-effect')
    decorativeElements.forEach((el) => {
      el.style.backdropFilter = 'none'
      el.style.webkitBackdropFilter = 'none'
    })

    document.body.classList.add('mobile-optimized')
    this.log('移动端优化已启用')
  }

  /**
   * 禁用移动端优化
   */
  disableMobileOptimizations(): void {
    const decorativeElements = document.querySelectorAll<HTMLElement>('.glass-effect')
    decorativeElements.forEach((el) => {
      el.style.backdropFilter = 'blur(10px)'
      el.style.webkitBackdropFilter = 'blur(10px)'
    })

    document.body.classList.remove('mobile-optimized')
    this.log('移动端优化已禁用')
  }

  // ========================================
  // UI 组件工厂方法
  // ========================================

  /**
   * 创建加载动画
   */
  createLoadingSpinner(text: string = '加载中...'): HTMLDivElement {
    const spinner = document.createElement('div')
    spinner.className = 'flex flex-col items-center justify-center py-8'
    spinner.innerHTML = `
      <div class="loading-spinner mb-4"></div>
      <p class="text-white opacity-70">${this.escapeHtml(text)}</p>
    `
    return spinner
  }

  /**
   * 创建错误提示
   */
  createErrorMessage(message: string): HTMLDivElement {
    const error = document.createElement('div')
    error.className = 'flex flex-col items-center justify-center py-8 text-center'
    error.innerHTML = `
      <i class="fas fa-exclamation-triangle text-4xl text-red-400 mb-4"></i>
      <p class="text-white opacity-70 mb-4">${this.escapeHtml(message)}</p>
      <div class="text-sm text-white opacity-60 bg-white bg-opacity-10 rounded-lg p-3 mt-2">
        <i class="fas fa-info-circle mr-1"></i>
        请检查提示词内容，修改后重新点击生成按钮
      </div>
    `
    return error
  }

  /**
   * 创建图片卡片
   */
  createImageCard(url: string, title: string = '', actions: ImageCardAction[] = []): HTMLDivElement {
    const card = document.createElement('div')
    card.className = 'bg-white bg-opacity-5 rounded-lg overflow-hidden'

    const actionsHtml = actions
      .map(
        (action) => `
        <button onclick="${this.escapeHtml(action.onclick)}" 
                class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" 
                title="${this.escapeHtml(action.title)}">
          <i class="fas fa-${this.escapeHtml(action.icon)}"></i>
        </button>
      `
      )
      .join('')

    card.innerHTML = `
      <div class="relative group">
        <img src="${this.escapeHtml(url)}" alt="${this.escapeHtml(title)}" class="w-full h-48 object-cover">
        <div class="absolute inset-0 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-2">
          ${actionsHtml}
        </div>
      </div>
      ${title ? `<div class="p-3"><p class="text-white text-sm truncate">${this.escapeHtml(title)}</p></div>` : ''}
    `

    return card
  }

  /**
   * 创建进度条
   */
  createProgressBar(percentage: number = 0, text: string = ''): HTMLDivElement {
    const progressContainer = document.createElement('div')
    progressContainer.className = 'w-full'

    const safePercentage = Math.max(0, Math.min(100, percentage))

    progressContainer.innerHTML = `
      <div class="bg-white bg-opacity-20 rounded-full h-2 mb-2">
        <div class="bg-gradient-to-r from-purple-500 to-pink-500 h-2 rounded-full transition-all duration-300" 
             style="width: ${safePercentage}%"></div>
      </div>
      ${text ? `<p class="text-white text-sm text-center">${this.escapeHtml(text)}</p>` : ''}
    `

    return progressContainer
  }

  /**
   * 创建确认对话框
   */
  createConfirmDialog(
    message: string,
    onConfirm: () => void,
    onCancel: (() => void) | null = null
  ): HTMLDivElement {
    const dialog = document.createElement('div')
    dialog.className = 'fixed inset-0 bg-black bg-opacity-50 z-[50000] flex items-center justify-center p-4'

    dialog.innerHTML = `
      <div class="bg-white rounded-xl p-6 max-w-sm w-full">
        <h3 class="text-lg font-bold mb-4">确认操作</h3>
        <p class="text-gray-600 mb-6">${this.escapeHtml(message)}</p>
        <div class="flex space-x-3">
          <button class="confirm-btn flex-1 bg-red-500 hover:bg-red-600 text-white py-2 px-4 rounded-md transition-colors">
            确认
          </button>
          <button class="cancel-btn flex-1 bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-md transition-colors">
            取消
          </button>
        </div>
      </div>
    `

    const confirmBtn = dialog.querySelector<HTMLButtonElement>('.confirm-btn')
    const cancelBtn = dialog.querySelector<HTMLButtonElement>('.cancel-btn')

    confirmBtn?.addEventListener('click', () => {
      dialog.remove()
      onConfirm()
    })

    cancelBtn?.addEventListener('click', () => {
      dialog.remove()
      onCancel?.()
    })

    // 点击外部关闭
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) {
        dialog.remove()
        onCancel?.()
      }
    })

    document.body.appendChild(dialog)
    return dialog
  }

  /**
   * 创建输入对话框
   */
  createInputDialog(
    title: string,
    placeholder: string,
    onConfirm: (value: string) => void,
    onCancel: (() => void) | null = null
  ): HTMLDivElement {
    const dialog = document.createElement('div')
    dialog.className = 'fixed inset-0 bg-black bg-opacity-50 z-[50000] flex items-center justify-center p-4'

    dialog.innerHTML = `
      <div class="bg-white rounded-xl p-6 max-w-sm w-full">
        <h3 class="text-lg font-bold mb-4">${this.escapeHtml(title)}</h3>
        <input type="text" 
               class="input-field w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 mb-6" 
               placeholder="${this.escapeHtml(placeholder)}">
        <div class="flex space-x-3">
          <button class="confirm-btn flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-md transition-colors">
            确认
          </button>
          <button class="cancel-btn flex-1 bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-md transition-colors">
            取消
          </button>
        </div>
      </div>
    `

    const inputField = dialog.querySelector<HTMLInputElement>('.input-field')
    const confirmBtn = dialog.querySelector<HTMLButtonElement>('.confirm-btn')
    const cancelBtn = dialog.querySelector<HTMLButtonElement>('.cancel-btn')

    // 自动聚焦
    setTimeout(() => inputField?.focus(), 100)

    confirmBtn?.addEventListener('click', () => {
      const value = inputField?.value.trim()
      if (value) {
        dialog.remove()
        onConfirm(value)
      }
    })

    cancelBtn?.addEventListener('click', () => {
      dialog.remove()
      onCancel?.()
    })

    // 回车确认
    inputField?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        confirmBtn?.click()
      }
    })

    // 点击外部关闭
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) {
        dialog.remove()
        onCancel?.()
      }
    })

    document.body.appendChild(dialog)
    return dialog
  }

  /**
   * 创建图片画廊
   */
  createImageGallery(images: GalleryImage[]): HTMLDivElement {
    const gallery = document.createElement('div')
    gallery.className = 'fixed inset-0 bg-black bg-opacity-90 z-[50000] flex items-center justify-center p-4'

    let currentIndex = 0

    const updateGallery = () => {
      const img = images[currentIndex]
      const escapedUrl = this.escapeHtml(img.url)
      const escapedTitle = this.escapeHtml(img.title || '')

      gallery.innerHTML = `
        <div class="relative max-w-4xl max-h-full">
          <img src="${escapedUrl}" alt="${escapedTitle}" class="max-w-full max-h-full object-contain rounded-lg">
          <button class="close-btn absolute top-4 right-4 text-white text-2xl hover:text-gray-300">
            <i class="fas fa-times"></i>
          </button>
          ${
            images.length > 1
              ? `
            <button class="prev-btn absolute left-4 top-1/2 transform -translate-y-1/2 text-white text-2xl hover:text-gray-300">
              <i class="fas fa-chevron-left"></i>
            </button>
            <button class="next-btn absolute right-12 top-1/2 transform -translate-y-1/2 text-white text-2xl hover:text-gray-300">
              <i class="fas fa-chevron-right"></i>
            </button>
            <div class="absolute bottom-4 left-1/2 transform -translate-x-1/2 text-white">
              ${currentIndex + 1} / ${images.length}
            </div>
          `
              : ''
          }
          <div class="absolute bottom-4 right-4 flex space-x-2">
            <button class="download-btn bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all">
              <i class="fas fa-download"></i>
            </button>
          </div>
        </div>
      `

      // 关闭按钮
      gallery.querySelector('.close-btn')?.addEventListener('click', () => {
        cleanup()
      })

      // 下载按钮 - V16.4: 使用 aiImageAPI 直接下载
      gallery.querySelector('.download-btn')?.addEventListener('click', async () => {
        const api = (window as any).aiImageAPI
        if (api?.downloadImage) {
          await api.downloadImage(img.url, null, api.model)
          const toast = (window as any).toastManagerTS
          toast?.show?.('图片下载成功', 'success')
        }
      })

      if (images.length > 1) {
        gallery.querySelector('.prev-btn')?.addEventListener('click', () => {
          currentIndex = (currentIndex - 1 + images.length) % images.length
          updateGallery()
        })

        gallery.querySelector('.next-btn')?.addEventListener('click', () => {
          currentIndex = (currentIndex + 1) % images.length
          updateGallery()
        })
      }
    }

    // 键盘导航
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cleanup()
      } else if (e.key === 'ArrowLeft' && images.length > 1) {
        currentIndex = (currentIndex - 1 + images.length) % images.length
        updateGallery()
      } else if (e.key === 'ArrowRight' && images.length > 1) {
        currentIndex = (currentIndex + 1) % images.length
        updateGallery()
      }
    }

    const cleanup = () => {
      gallery.remove()
      document.removeEventListener('keydown', handleKeydown)
    }

    document.addEventListener('keydown', handleKeydown)

    // 点击外部关闭
    gallery.addEventListener('click', (e) => {
      if (e.target === gallery) {
        cleanup()
      }
    })

    updateGallery()
    document.body.appendChild(gallery)
    return gallery
  }

  // ========================================
  // 拖拽排序
  // ========================================

  /**
   * 添加拖拽排序功能
   */
  addDragAndDrop(
    container: HTMLElement,
    onReorder: ((newOrder: string[]) => void) | null = null
  ): void {
    let draggedElement: HTMLElement | null = null

    container.addEventListener('dragstart', (e) => {
      const target = e.target as HTMLElement
      draggedElement = target.closest('[draggable]')
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
      }
    })

    container.addEventListener('dragover', (e) => {
      e.preventDefault()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move'
      }

      if (!draggedElement) return

      const afterElement = this.getDragAfterElement(container, e.clientY)
      if (afterElement == null) {
        container.appendChild(draggedElement)
      } else {
        container.insertBefore(draggedElement, afterElement)
      }
    })

    container.addEventListener('dragend', () => {
      if (onReorder) {
        const newOrder = Array.from(container.children)
          .map((child) => (child as HTMLElement).dataset.id)
          .filter((id): id is string => id !== undefined)
        onReorder(newOrder)
      }
      draggedElement = null
    })
  }

  /**
   * 获取拖拽后的位置
   */
  private getDragAfterElement(container: HTMLElement, y: number): HTMLElement | null {
    const draggableElements = [
      ...container.querySelectorAll<HTMLElement>('[draggable]:not(.dragging)')
    ]

    const result = draggableElements.reduce<{ offset: number; element: HTMLElement | null }>(
      (closest, child) => {
        const box = child.getBoundingClientRect()
        const offset = y - box.top - box.height / 2

        if (offset < 0 && offset > closest.offset) {
          return { offset, element: child }
        } else {
          return closest
        }
      },
      { offset: Number.NEGATIVE_INFINITY, element: null }
    )

    return result.element
  }

  // ========================================
  // 无限滚动
  // ========================================

  /**
   * 添加无限滚动
   */
  addInfiniteScroll(container: HTMLElement, loadMore: () => void): () => void {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore()
        }
      },
      { threshold: 1.0 }
    )

    // 创建加载触发器
    const trigger = document.createElement('div')
    trigger.className = 'h-4'
    container.appendChild(trigger)
    observer.observe(trigger)

    // 返回清理函数
    return () => {
      observer.unobserve(trigger)
      trigger.remove()
    }
  }

  // ========================================
  // 工具方法
  // ========================================

  /**
   * HTML 转义
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  /**
   * 销毁组件
   */
  destroy(): void {
    if (this.imageObserver) {
      this.imageObserver.disconnect()
      this.imageObserver = null
    }

    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler)
      this.resizeHandler = null
    }
  }
}

// ========================================
// 单例模式和 window 暴露（过渡期兼容）
// ========================================

let uiComponentsInstance: UIComponents | null = null

/**
 * 获取 UIComponents 单例
 */
export function getUIComponents(config?: UIComponentsConfig): UIComponents {
  if (!uiComponentsInstance) {
    uiComponentsInstance = new UIComponents(config)
  }
  return uiComponentsInstance
}

/**
 * 创建新的 UIComponents 实例
 */
export function createUIComponents(config?: UIComponentsConfig): UIComponents {
  return new UIComponents(config)
}

/**
 * 重置单例（仅用于测试）
 */
export function resetUIComponents(): void {
  if (uiComponentsInstance) {
    uiComponentsInstance.destroy()
    uiComponentsInstance = null
  }
}

// ========================================
// 过渡期: 暴露到 window 供旧代码使用
// V16.3 - 添加废弃警告
// ========================================

declare global {
  interface Window {
    uiComponents: UIComponents
    UIComponentsTS: typeof UIComponents
  }
}

let uiComponentsDeprecationWarningShown = false

/**
 * 初始化并暴露到 window（过渡期）
 * V16.3: 添加废弃警告
 */
export function initUIComponentsGlobal(): UIComponents {
  const components = getUIComponents()

  // 过渡期: 暴露到 window (带废弃警告)
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'uiComponents', {
      get() {
        if (!uiComponentsDeprecationWarningShown && process.env.NODE_ENV !== 'production') {
          console.warn(
            '[DEPRECATED] window.uiComponents 已废弃。' +
            '请使用 Services.get("uiComponents") 或 import { getUIComponents } from "@/features/ui-components"'
          )
          uiComponentsDeprecationWarningShown = true
        }
        return components
      },
      configurable: true
    })
    
    window.UIComponentsTS = UIComponents
  }

  console.log('[V16.3] UIComponents TypeScript 版本已加载 (废弃警告已启用)')

  return components
}
