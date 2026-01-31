// src/renderer/src/features/image-viewer/ImageViewer.ts
/**
 * 图片查看器模块
 * 支持多图切换、下载、批量下载等功能
 */

export interface ImageViewerOptions {
  onDownload?: (url: string) => Promise<void>
  onBatchDownload?: (urls: string[]) => Promise<void>
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void
}

export class ImageViewer {
  private modal: HTMLDivElement | null = null
  private currentIndex = 0
  private urls: string[] = []
  private options: ImageViewerOptions
  private keyboardHandler: ((e: KeyboardEvent) => void) | null = null

  constructor(options: ImageViewerOptions = {}) {
    this.options = options
  }

  /**
   * 打开图片查看器
   */
  open(urls: string | string[], startIndex = 0): void {
    // 转换为数组
    this.urls = typeof urls === 'string' ? [urls] : [...urls]
    this.currentIndex = startIndex

    // 创建模态框
    this.createModal()

    // 绑定键盘事件
    this.bindKeyboardEvents()

    // 预加载图片
    if (this.urls.length > 1) {
      this.preloadImages()
    }
  }

  /**
   * 关闭图片查看器
   */
  close(): void {
    if (this.modal) {
      this.modal.remove()
      this.modal = null
    }
    this.unbindKeyboardEvents()
  }

  /**
   * 创建模态框
   */
  private createModal(): void {
    this.modal = document.createElement('div')
    this.modal.className = 'fixed inset-0 bg-black bg-opacity-90 z-[50000] flex items-center justify-center p-4'
    this.modal.innerHTML = this.getModalHTML()

    // 绑定事件
    this.bindEvents()

    document.body.appendChild(this.modal)
  }

  /**
   * 获取模态框 HTML
   */
  private getModalHTML(): string {
    const hasMultiple = this.urls.length > 1
    const currentUrl = this.urls[this.currentIndex]

    return `
      <div class="relative max-w-6xl max-h-full w-full h-full flex items-center justify-center">
        <!-- 图片容器 -->
        <div class="image-container flex items-center justify-center max-w-full max-h-full">
          <img src="${currentUrl}" alt="查看图片" class="max-w-full object-contain rounded-lg" style="max-height: 500px;">
        </div>
        
        <!-- 控制按钮 -->
        <div class="absolute top-4 right-4 flex space-x-2">
          <div class="image-counter bg-black bg-opacity-50 text-white px-3 py-1 rounded-full text-sm">
            ${hasMultiple ? `${this.currentIndex + 1} / ${this.urls.length}` : ''}
          </div>
          <button class="download-btn bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-full transition-all" title="下载图片">
            <i class="fas fa-download"></i>
          </button>
          ${hasMultiple ? `
            <button class="batch-download-btn bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-full transition-all" title="批量下载">
              <i class="fas fa-file-archive"></i>
            </button>
          ` : ''}
          <button class="close-btn bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-full transition-all">
            <i class="fas fa-times"></i>
          </button>
        </div>
        
        <!-- 帮助提示 -->
        <div class="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-black bg-opacity-70 text-white text-sm px-4 py-2 rounded-full opacity-75">
          <i class="fas fa-info-circle mr-1"></i>
          提示：右键图片可选择"图片另存为"下载
        </div>
        
        <!-- 左右切换按钮 -->
        ${hasMultiple ? `
          <button class="prev-btn absolute left-4 top-1/2 transform -translate-y-1/2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-3 rounded-full transition-all">
            <i class="fas fa-chevron-left"></i>
          </button>
          <button class="next-btn absolute right-4 top-1/2 transform -translate-y-1/2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-3 rounded-full transition-all">
            <i class="fas fa-chevron-right"></i>
          </button>
        ` : ''}
      </div>
    `
  }

  /**
   * 更新图片显示
   */
  private updateImage(): void {
    if (!this.modal) return

    const imageContainer = this.modal.querySelector('.image-container')
    const counter = this.modal.querySelector('.image-counter')

    if (imageContainer) {
      imageContainer.innerHTML = `
        <img src="${this.urls[this.currentIndex]}" alt="查看图片" class="max-w-full object-contain rounded-lg" style="max-height: 500px;">
      `
    }

    if (counter && this.urls.length > 1) {
      counter.textContent = `${this.currentIndex + 1} / ${this.urls.length}`
    }
  }

  /**
   * 上一张图片
   */
  private prevImage(): void {
    if (this.urls.length <= 1) return
    this.currentIndex = (this.currentIndex - 1 + this.urls.length) % this.urls.length
    this.updateImage()
  }

  /**
   * 下一张图片
   */
  private nextImage(): void {
    if (this.urls.length <= 1) return
    this.currentIndex = (this.currentIndex + 1) % this.urls.length
    this.updateImage()
  }

  /**
   * 绑定事件
   */
  private bindEvents(): void {
    if (!this.modal) return

    // 关闭按钮
    const closeBtn = this.modal.querySelector('.close-btn')
    closeBtn?.addEventListener('click', () => this.close())

    // 下载按钮
    const downloadBtn = this.modal.querySelector('.download-btn')
    downloadBtn?.addEventListener('click', async () => {
      if (this.options.onDownload) {
        await this.options.onDownload(this.urls[this.currentIndex])
      }
    })

    // 批量下载按钮
    const batchDownloadBtn = this.modal.querySelector('.batch-download-btn')
    batchDownloadBtn?.addEventListener('click', async () => {
      if (this.options.onBatchDownload) {
        await this.options.onBatchDownload(this.urls)
      }
    })

    // 上一张按钮
    const prevBtn = this.modal.querySelector('.prev-btn')
    prevBtn?.addEventListener('click', () => this.prevImage())

    // 下一张按钮
    const nextBtn = this.modal.querySelector('.next-btn')
    nextBtn?.addEventListener('click', () => this.nextImage())

    // 点击背景关闭
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) {
        this.close()
      }
    })
  }

  /**
   * 绑定键盘事件
   */
  private bindKeyboardEvents(): void {
    this.keyboardHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.close()
      } else if (e.key === 'ArrowLeft') {
        this.prevImage()
      } else if (e.key === 'ArrowRight') {
        this.nextImage()
      }
    }
    document.addEventListener('keydown', this.keyboardHandler)
  }

  /**
   * 解绑键盘事件
   */
  private unbindKeyboardEvents(): void {
    if (this.keyboardHandler) {
      document.removeEventListener('keydown', this.keyboardHandler)
      this.keyboardHandler = null
    }
  }

  /**
   * 预加载图片
   */
  private preloadImages(): void {
    this.urls.forEach(url => {
      const img = new Image()
      img.src = url
    })
  }

  /**
   * 获取当前图片 URL
   */
  getCurrentUrl(): string {
    return this.urls[this.currentIndex]
  }

  /**
   * 获取当前索引
   */
  getCurrentIndex(): number {
    return this.currentIndex
  }

  /**
   * 跳转到指定图片
   */
  goToIndex(index: number): void {
    if (index >= 0 && index < this.urls.length) {
      this.currentIndex = index
      this.updateImage()
    }
  }
}

// 创建全局单例
let instance: ImageViewer | null = null

export function getImageViewer(options?: ImageViewerOptions): ImageViewer {
  if (!instance) {
    instance = new ImageViewer(options)
  }
  return instance
}

export function createImageViewer(options?: ImageViewerOptions): ImageViewer {
  return new ImageViewer(options)
}
