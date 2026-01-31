/**
 * UpdateNotification - 更新通知组件
 * V17: 提供用户友好的更新通知界面
 * 
 * 功能:
 * - 显示可用更新信息
 * - 显示下载进度
 * - 显示更新就绪状态
 * - 支持用户交互 (下载/安装/稍后)
 */

export interface UpdateNotificationConfig {
  /** 自动检查更新 */
  autoCheck: boolean
  /** 检查间隔 (分钟) */
  checkInterval: number
  /** 显示下载进度 */
  showProgress: boolean
  /** 静默下载 (后台下载不显示进度) */
  silentDownload: boolean
  /** 容器元素选择器 */
  containerSelector: string
}

export interface UpdateInfo {
  version: string
  currentVersion: string
  releaseDate?: string
  releaseNotes?: string | null
}

export interface DownloadProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
  eta?: number
}

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

const DEFAULT_CONFIG: UpdateNotificationConfig = {
  autoCheck: true,
  checkInterval: 60, // 60 minutes
  showProgress: true,
  silentDownload: false,
  containerSelector: 'body'
}

export class UpdateNotification {
  private static instance: UpdateNotification | null = null
  private config: UpdateNotificationConfig
  private container: HTMLElement | null = null
  private notificationElement: HTMLElement | null = null
  private status: UpdateStatus = 'idle'
  private updateInfo: UpdateInfo | null = null
  private progress: DownloadProgress | null = null
  private checkIntervalId: ReturnType<typeof setInterval> | null = null

  constructor(config: Partial<UpdateNotificationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  static getInstance(config?: Partial<UpdateNotificationConfig>): UpdateNotification {
    if (!UpdateNotification.instance) {
      UpdateNotification.instance = new UpdateNotification(config)
    }
    return UpdateNotification.instance
  }

  /**
   * 初始化更新通知组件
   */
  init(): void {
    this.container = document.querySelector(this.config.containerSelector)
    if (!this.container) {
      console.warn('[UpdateNotification] 容器未找到:', this.config.containerSelector)
      return
    }

    // 监听来自主进程的更新事件
    this.setupIpcListeners()

    // 如果启用自动检查，设置定时器
    if (this.config.autoCheck && this.config.checkInterval > 0) {
      this.startAutoCheck()
    }

    console.log('[UpdateNotification] 初始化完成')
  }

  /**
   * 设置 IPC 监听器
   */
  private setupIpcListeners(): void {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.on) {
      console.warn('[UpdateNotification] electronAPI.on 不可用')
      return
    }

    // 正在检查更新
    electronAPI.on('updater:checking-for-update', () => {
      this.status = 'checking'
      // 检查更新时不显示通知，避免打扰用户
    })

    // 有可用更新
    electronAPI.on('updater:update-available', (_event: any, info: UpdateInfo) => {
      this.status = 'available'
      this.updateInfo = info
      this.showUpdateAvailable(info.version, info.releaseNotes || null)
    })

    // 没有可用更新
    electronAPI.on('updater:update-not-available', () => {
      this.status = 'idle'
      this.dismiss()
    })

    // 下载进度
    electronAPI.on('updater:download-progress', (_event: any, progress: DownloadProgress) => {
      this.status = 'downloading'
      this.progress = progress
      if (this.config.showProgress && !this.config.silentDownload) {
        this.showDownloadProgress(progress.percent, progress.eta)
      }
    })

    // 下载完成
    electronAPI.on('updater:update-downloaded', (_event: any, info: { version: string }) => {
      this.status = 'ready'
      this.showUpdateReady(info.version)
    })

    // 更新错误
    electronAPI.on('updater:update-error', (_event: any, error: { message: string }) => {
      this.status = 'error'
      this.showError(error.message)
    })

    // 下载重试
    electronAPI.on('updater:download-retry', (_event: any, info: { attempt: number; maxRetries: number }) => {
      console.log(`[UpdateNotification] 下载重试 ${info.attempt}/${info.maxRetries}`)
    })
  }

  /**
   * 启动自动检查
   */
  private startAutoCheck(): void {
    const intervalMs = this.config.checkInterval * 60 * 1000
    this.checkIntervalId = setInterval(() => {
      this.checkForUpdates()
    }, intervalMs)
  }

  /**
   * 停止自动检查
   */
  stopAutoCheck(): void {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId)
      this.checkIntervalId = null
    }
  }

  /**
   * 检查更新
   */
  async checkForUpdates(): Promise<void> {
    const electronAPI = (window as any).electronAPI
    if (electronAPI?.invoke) {
      try {
        await electronAPI.invoke('updater:check')
      } catch (error) {
        console.error('[UpdateNotification] 检查更新失败:', error)
      }
    }
  }

  /**
   * 显示可用更新通知
   */
  showUpdateAvailable(version: string, releaseNotes: string | null): void {
    this.dismiss()

    const notification = document.createElement('div')
    notification.className = 'update-notification update-available'
    notification.innerHTML = `
      <div class="update-notification-content">
        <div class="update-icon">
          <i class="fas fa-download"></i>
        </div>
        <div class="update-info">
          <div class="update-title">新版本可用</div>
          <div class="update-version">v${version}</div>
          ${releaseNotes ? `<div class="update-notes">${this.truncateNotes(releaseNotes)}</div>` : ''}
        </div>
        <div class="update-actions">
          <button class="update-btn update-btn-primary" data-action="download">
            <i class="fas fa-download"></i> 下载更新
          </button>
          <button class="update-btn update-btn-secondary" data-action="later">
            稍后提醒
          </button>
        </div>
        <button class="update-close" data-action="dismiss">
          <i class="fas fa-times"></i>
        </button>
      </div>
    `

    this.addStyles()
    this.bindEvents(notification)
    this.container?.appendChild(notification)
    this.notificationElement = notification

    // 动画显示
    requestAnimationFrame(() => {
      notification.classList.add('show')
    })
  }

  /**
   * 显示下载进度
   */
  showDownloadProgress(percent: number, eta?: number): void {
    if (!this.notificationElement) {
      this.createProgressNotification()
    }

    const progressBar = this.notificationElement?.querySelector('.progress-bar-fill') as HTMLElement
    const percentText = this.notificationElement?.querySelector('.progress-percent')
    const etaText = this.notificationElement?.querySelector('.progress-eta')

    if (progressBar) {
      progressBar.style.width = `${percent}%`
    }
    if (percentText) {
      percentText.textContent = `${percent.toFixed(1)}%`
    }
    if (etaText && eta !== undefined) {
      etaText.textContent = this.formatEta(eta)
    }
  }

  /**
   * 创建下载进度通知
   */
  private createProgressNotification(): void {
    this.dismiss()

    const notification = document.createElement('div')
    notification.className = 'update-notification update-downloading'
    notification.innerHTML = `
      <div class="update-notification-content">
        <div class="update-icon">
          <i class="fas fa-sync-alt fa-spin"></i>
        </div>
        <div class="update-info">
          <div class="update-title">正在下载更新</div>
          <div class="progress-container">
            <div class="progress-bar">
              <div class="progress-bar-fill" style="width: 0%"></div>
            </div>
            <div class="progress-text">
              <span class="progress-percent">0%</span>
              <span class="progress-eta"></span>
            </div>
          </div>
        </div>
        <button class="update-close" data-action="cancel">
          <i class="fas fa-times"></i>
        </button>
      </div>
    `

    this.addStyles()
    this.bindEvents(notification)
    this.container?.appendChild(notification)
    this.notificationElement = notification

    requestAnimationFrame(() => {
      notification.classList.add('show')
    })
  }

  /**
   * 显示更新就绪通知
   */
  showUpdateReady(version: string): void {
    this.dismiss()

    const notification = document.createElement('div')
    notification.className = 'update-notification update-ready'
    notification.innerHTML = `
      <div class="update-notification-content">
        <div class="update-icon update-icon-success">
          <i class="fas fa-check-circle"></i>
        </div>
        <div class="update-info">
          <div class="update-title">更新已就绪</div>
          <div class="update-version">v${version} 已下载完成</div>
          <div class="update-hint">重启应用以完成更新</div>
        </div>
        <div class="update-actions">
          <button class="update-btn update-btn-primary" data-action="install">
            <i class="fas fa-redo"></i> 立即重启
          </button>
          <button class="update-btn update-btn-secondary" data-action="later">
            稍后重启
          </button>
        </div>
        <button class="update-close" data-action="dismiss">
          <i class="fas fa-times"></i>
        </button>
      </div>
    `

    this.addStyles()
    this.bindEvents(notification)
    this.container?.appendChild(notification)
    this.notificationElement = notification

    requestAnimationFrame(() => {
      notification.classList.add('show')
    })
  }

  /**
   * 显示错误通知
   */
  showError(message: string): void {
    this.dismiss()

    const notification = document.createElement('div')
    notification.className = 'update-notification update-error'
    notification.innerHTML = `
      <div class="update-notification-content">
        <div class="update-icon update-icon-error">
          <i class="fas fa-exclamation-triangle"></i>
        </div>
        <div class="update-info">
          <div class="update-title">更新失败</div>
          <div class="update-error-message">${message}</div>
        </div>
        <div class="update-actions">
          <button class="update-btn update-btn-secondary" data-action="retry">
            <i class="fas fa-redo"></i> 重试
          </button>
        </div>
        <button class="update-close" data-action="dismiss">
          <i class="fas fa-times"></i>
        </button>
      </div>
    `

    this.addStyles()
    this.bindEvents(notification)
    this.container?.appendChild(notification)
    this.notificationElement = notification

    requestAnimationFrame(() => {
      notification.classList.add('show')
    })
  }

  /**
   * 绑定事件
   */
  private bindEvents(notification: HTMLElement): void {
    notification.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement
      const action = target.closest('[data-action]')?.getAttribute('data-action')
      
      if (!action) return

      const electronAPI = (window as any).electronAPI

      switch (action) {
        case 'download':
          if (electronAPI?.invoke) {
            await electronAPI.invoke('updater:download')
          }
          break
        case 'install':
          if (electronAPI?.invoke) {
            await electronAPI.invoke('updater:install')
          }
          break
        case 'cancel':
          if (electronAPI?.invoke) {
            await electronAPI.invoke('updater:cancelDownload')
          }
          this.dismiss()
          break
        case 'retry':
          this.checkForUpdates()
          break
        case 'later':
        case 'dismiss':
          this.dismiss()
          break
      }
    })
  }

  /**
   * 关闭通知
   */
  dismiss(): void {
    if (this.notificationElement) {
      this.notificationElement.classList.remove('show')
      setTimeout(() => {
        this.notificationElement?.remove()
        this.notificationElement = null
      }, 300)
    }
  }

  /**
   * 添加样式
   */
  private addStyles(): void {
    if (document.getElementById('update-notification-styles')) return

    const style = document.createElement('style')
    style.id = 'update-notification-styles'
    style.textContent = `
      .update-notification {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 10000;
        max-width: 400px;
        background: rgba(30, 30, 40, 0.95);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        opacity: 0;
        transform: translateY(20px);
        transition: all 0.3s ease;
      }

      .update-notification.show {
        opacity: 1;
        transform: translateY(0);
      }

      .update-notification-content {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 16px;
        position: relative;
      }

      .update-icon {
        flex-shrink: 0;
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        border-radius: 10px;
        color: white;
        font-size: 18px;
      }

      .update-icon-success {
        background: linear-gradient(135deg, #10b981, #059669);
      }

      .update-icon-error {
        background: linear-gradient(135deg, #ef4444, #dc2626);
      }

      .update-info {
        flex: 1;
        min-width: 0;
      }

      .update-title {
        font-weight: 600;
        color: #fff;
        font-size: 14px;
        margin-bottom: 4px;
      }

      .update-version {
        color: #a0aec0;
        font-size: 13px;
      }

      .update-hint {
        color: #718096;
        font-size: 12px;
        margin-top: 4px;
      }

      .update-notes {
        color: #718096;
        font-size: 12px;
        margin-top: 8px;
        max-height: 60px;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .update-error-message {
        color: #f87171;
        font-size: 12px;
        margin-top: 4px;
      }

      .update-actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }

      .update-btn {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        border: none;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .update-btn-primary {
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        color: white;
      }

      .update-btn-primary:hover {
        background: linear-gradient(135deg, #4f46e5, #7c3aed);
        transform: translateY(-1px);
      }

      .update-btn-secondary {
        background: rgba(255, 255, 255, 0.1);
        color: #a0aec0;
      }

      .update-btn-secondary:hover {
        background: rgba(255, 255, 255, 0.15);
      }

      .update-close {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        color: #718096;
        cursor: pointer;
        border-radius: 4px;
        transition: all 0.2s ease;
      }

      .update-close:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }

      .progress-container {
        margin-top: 8px;
      }

      .progress-bar {
        height: 6px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
        overflow: hidden;
      }

      .progress-bar-fill {
        height: 100%;
        background: linear-gradient(90deg, #6366f1, #8b5cf6);
        border-radius: 3px;
        transition: width 0.3s ease;
      }

      .progress-text {
        display: flex;
        justify-content: space-between;
        margin-top: 6px;
        font-size: 12px;
        color: #a0aec0;
      }

      @media (max-width: 480px) {
        .update-notification {
          left: 10px;
          right: 10px;
          bottom: 10px;
          max-width: none;
        }
      }
    `
    document.head.appendChild(style)
  }

  /**
   * 截断发布说明
   */
  private truncateNotes(notes: string, maxLength: number = 100): string {
    if (notes.length <= maxLength) return notes
    return notes.slice(0, maxLength) + '...'
  }

  /**
   * 格式化预估时间
   */
  private formatEta(seconds: number): string {
    if (seconds < 60) {
      return `剩余 ${Math.round(seconds)} 秒`
    }
    const minutes = Math.floor(seconds / 60)
    const secs = Math.round(seconds % 60)
    return `剩余 ${minutes}:${secs.toString().padStart(2, '0')}`
  }

  /**
   * 获取当前状态
   */
  getStatus(): UpdateStatus {
    return this.status
  }

  /**
   * 获取更新信息
   */
  getUpdateInfo(): UpdateInfo | null {
    return this.updateInfo
  }

  /**
   * 销毁组件
   */
  destroy(): void {
    this.stopAutoCheck()
    this.dismiss()
    UpdateNotification.instance = null
  }
}

// 单例获取函数
let updateNotificationInstance: UpdateNotification | null = null

export function getUpdateNotification(config?: Partial<UpdateNotificationConfig>): UpdateNotification {
  if (!updateNotificationInstance) {
    updateNotificationInstance = new UpdateNotification(config)
  }
  return updateNotificationInstance
}

export function createUpdateNotification(config?: Partial<UpdateNotificationConfig>): UpdateNotification {
  return new UpdateNotification(config)
}

export function resetUpdateNotification(): void {
  if (updateNotificationInstance) {
    updateNotificationInstance.destroy()
    updateNotificationInstance = null
  }
}

/**
 * 初始化更新通知到 window 对象 (用于过渡期兼容)
 */
export function initUpdateNotificationGlobal(): void {
  const notification = getUpdateNotification()
  
  if (typeof window !== 'undefined') {
    ;(window as any).updateNotificationTS = notification
    ;(window as any).UpdateNotificationTS = UpdateNotification
  }
}
