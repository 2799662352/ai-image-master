/**
 * 统一的加载状态管理器
 * 提供一致的加载反馈体验
 */
export class LoadingManager {
  private static instance: LoadingManager
  
  static getInstance(): LoadingManager {
    if (!LoadingManager.instance) {
      LoadingManager.instance = new LoadingManager()
    }
    return LoadingManager.instance
  }

  /**
   * 显示按钮加载状态
   */
  showButtonLoading(btn: HTMLButtonElement, text?: string): void {
    btn.disabled = true
    btn.dataset.originalContent = btn.innerHTML
    btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>${text || '处理中...'}`
    btn.setAttribute('aria-busy', 'true')
  }

  /**
   * 恢复按钮状态
   */
  hideButtonLoading(btn: HTMLButtonElement): void {
    btn.disabled = false
    if (btn.dataset.originalContent) {
      btn.innerHTML = btn.dataset.originalContent
      delete btn.dataset.originalContent
    }
    btn.setAttribute('aria-busy', 'false')
  }

  /**
   * 显示区域骨架屏
   */
  showSkeleton(container: HTMLElement, rows: number = 3): void {
    container.dataset.originalContent = container.innerHTML
    container.innerHTML = Array(rows).fill(0).map(() => `
      <div class="skeleton-row animate-pulse p-4">
        <div class="skeleton h-4 w-3/4 mb-2 bg-gray-700 rounded"></div>
        <div class="skeleton h-4 w-1/2 bg-gray-700 rounded"></div>
      </div>
    `).join('')
    container.setAttribute('aria-busy', 'true')
    container.setAttribute('aria-label', '加载中')
  }

  /**
   * 隐藏骨架屏
   */
  hideSkeleton(container: HTMLElement): void {
    if (container.dataset.originalContent) {
      container.innerHTML = container.dataset.originalContent
      delete container.dataset.originalContent
    }
    container.setAttribute('aria-busy', 'false')
    container.removeAttribute('aria-label')
  }

  /**
   * 显示进度条
   */
  showProgress(container: HTMLElement, percent: number, text?: string): void {
    let progressBar = container.querySelector('.loading-progress-bar') as HTMLElement
    
    if (!progressBar) {
      progressBar = document.createElement('div')
      progressBar.className = 'loading-progress-bar'
      progressBar.innerHTML = `
        <div class="progress-text text-sm text-gray-400 mb-1"></div>
        <div class="progress-track h-2 bg-gray-700 rounded overflow-hidden">
          <div class="progress-fill h-full bg-[#FCE300] transition-all duration-300" style="width: 0%"></div>
        </div>
      `
      container.appendChild(progressBar)
    }

    const fill = progressBar.querySelector('.progress-fill') as HTMLElement
    const textEl = progressBar.querySelector('.progress-text') as HTMLElement
    
    if (fill) fill.style.width = `${percent}%`
    if (textEl && text) textEl.textContent = text
    
    progressBar.setAttribute('role', 'progressbar')
    progressBar.setAttribute('aria-valuenow', String(percent))
    progressBar.setAttribute('aria-valuemin', '0')
    progressBar.setAttribute('aria-valuemax', '100')
  }

  /**
   * 隐藏进度条
   */
  hideProgress(container: HTMLElement): void {
    const progressBar = container.querySelector('.loading-progress-bar')
    progressBar?.remove()
  }

  /**
   * 显示全屏加载遮罩
   */
  showOverlay(message?: string): void {
    let overlay = document.getElementById('loading-overlay')
    
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.id = 'loading-overlay'
      overlay.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999]'
      overlay.setAttribute('role', 'alert')
      overlay.setAttribute('aria-busy', 'true')
      overlay.innerHTML = `
        <div class="bg-[#27272A] p-6 rounded-none flex flex-col items-center space-y-4">
          <i class="fas fa-spinner fa-spin text-4xl text-[#FCE300]"></i>
          <span class="loading-message text-white">${message || '加载中...'}</span>
        </div>
      `
      document.body.appendChild(overlay)
    } else {
      const msgEl = overlay.querySelector('.loading-message')
      if (msgEl && message) msgEl.textContent = message
      overlay.classList.remove('hidden')
    }
  }

  /**
   * 隐藏全屏加载遮罩
   */
  hideOverlay(): void {
    const overlay = document.getElementById('loading-overlay')
    if (overlay) {
      overlay.classList.add('hidden')
    }
  }
}

export const loadingManager = LoadingManager.getInstance()
