/**
 * UpdateNotification - 更新通知组件
 * V17: Dona Dona 赛博朋克风格 (霓虹品红 × 冷青 / 斜切面板 / 终端感)
 */

export interface UpdateNotificationConfig {
  autoCheck: boolean
  checkInterval: number
  showProgress: boolean
  silentDownload: boolean
  containerSelector: string
}

export interface UpdateInfo {
  version: string
  currentVersion: string
  releaseDate?: string
  releaseNotes?: string | null
  autoDownload?: boolean
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
  checkInterval: 60,
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

  init(): void {
    this.container = document.querySelector(this.config.containerSelector)
    if (!this.container) {
      console.warn('[UpdateNotification] 容器未找到:', this.config.containerSelector)
      return
    }

    this.setupIpcListeners()

    if (this.config.autoCheck && this.config.checkInterval > 0) {
      this.startAutoCheck()
    }

    console.log('[UpdateNotification] 初始化完成')
  }

  private setupIpcListeners(): void {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.on) {
      console.warn('[UpdateNotification] electronAPI.on 不可用')
      return
    }

    electronAPI.on('updater:checking-for-update', () => {
      this.status = 'checking'
    })

    electronAPI.on('updater:update-available', (...args: any[]) => {
      const info = this.extractPayload<UpdateInfo & { autoDownload?: boolean }>(args)
      if (!info?.version) return
      this.updateInfo = info
      if (info.autoDownload) {
        this.status = 'downloading'
        this.createProgressNotification()
      } else {
        this.status = 'available'
        this.showUpdateAvailable(info.version, info.releaseNotes || null)
      }
    })

    electronAPI.on('updater:update-not-available', (...args: any[]) => {
      this.status = 'idle'
      const data = this.extractPayload<{ currentVersion?: string; latestVersion?: string }>(args)
      this.showNoUpdate(data?.currentVersion || data?.latestVersion)
    })

    electronAPI.on('updater:download-progress', (...args: any[]) => {
      const progress = this.extractPayload<DownloadProgress>(args)
      if (!progress) return
      this.status = 'downloading'
      this.progress = progress
      if (this.config.showProgress && !this.config.silentDownload) {
        this.showDownloadProgress(progress.percent, progress.eta)
      }
    })

    electronAPI.on('updater:update-downloaded', (...args: any[]) => {
      const info = this.extractPayload<{ version: string }>(args)
      if (!info?.version) return
      this.status = 'ready'
      this.showUpdateReady(info.version)
    })

    electronAPI.on('updater:update-error', (...args: any[]) => {
      const error = this.extractPayload<{ message?: string }>(args)
      const message =
        typeof error?.message === 'string' && error.message.trim()
          ? error.message
          : '未知更新错误'
      this.status = 'error'
      this.showError(message)
    })

    electronAPI.on('updater:download-retry', (...args: any[]) => {
      const info = this.extractPayload<{ attempt: number; maxRetries: number }>(args)
      if (!info) return
      console.log(`[UpdateNotification] 下载重试 ${info.attempt}/${info.maxRetries}`)
    })
  }

  private extractPayload<T>(args: any[]): T | undefined {
    if (args.length === 0) return undefined
    return (args.length === 1 ? args[0] : args[1]) as T
  }

  private startAutoCheck(): void {
    const intervalMs = this.config.checkInterval * 60 * 1000
    this.checkIntervalId = setInterval(() => {
      this.checkForUpdates()
    }, intervalMs)
  }

  stopAutoCheck(): void {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId)
      this.checkIntervalId = null
    }
  }

  async checkForUpdates(): Promise<void> {
    const electronAPI = (window as any).electronAPI
    if (electronAPI?.checkForUpdate) {
      try {
        await electronAPI.checkForUpdate()
      } catch (error) {
        console.error('[UpdateNotification] 检查更新失败:', error)
      }
    }
  }

  showUpdateAvailable(version: string, releaseNotes: string | null): void {
    this.dismiss()
    const notesText = releaseNotes ? this.stripHtml(releaseNotes) : null
    const truncated = notesText ? this.truncateNotes(notesText, 120) : ''

    const notification = document.createElement('div')
    notification.className = 'dn-update dn-available'
    notification.innerHTML = `
      <div class="dn-scanlines"></div>
      <div class="dn-border-outer"></div>
      <div class="dn-content">
        <div class="dn-header">
          <div class="dn-sys-tag">SYS // UPDATE</div>
          <button class="dn-close" data-action="dismiss" aria-label="Dismiss">&times;</button>
        </div>
        <div class="dn-body">
          <div class="dn-title">
            <span class="dn-arrow">▶</span>
            <span class="dn-title-text">NEW PATCH AVAILABLE</span>
            <span class="dn-cursor">_</span>
          </div>
          <div class="dn-version">[v${this.escapeHtml(version)}]</div>
          ${truncated ? `<div class="dn-notes">${this.escapeHtml(truncated)}</div>` : ''}
        </div>
        <div class="dn-actions">
          <button class="dn-btn dn-btn-primary" data-action="download">
            <span class="dn-btn-text">▶ DOWNLOAD</span>
          </button>
          <button class="dn-btn dn-btn-ghost" data-action="later">LATER</button>
        </div>
        <div class="dn-hud">REC ● &nbsp; ID:${Math.random().toString(36).slice(2, 8).toUpperCase()}</div>
      </div>
    `

    this.addStyles()
    this.bindEvents(notification)
    this.container?.appendChild(notification)
    this.notificationElement = notification
    requestAnimationFrame(() => notification.classList.add('show'))
  }

  showDownloadProgress(percent: number, eta?: number): void {
    const hasProgressBar = this.notificationElement?.querySelector('.dn-progress-fill')
    if (!this.notificationElement || !hasProgressBar) {
      this.createProgressNotification()
    }

    const progressBar = this.notificationElement?.querySelector('.dn-progress-fill') as HTMLElement
    const percentText = this.notificationElement?.querySelector('.dn-percent')
    const etaText = this.notificationElement?.querySelector('.dn-eta')
    const speedText = this.notificationElement?.querySelector('.dn-speed')

    if (progressBar) progressBar.style.width = `${percent}%`
    if (percentText) percentText.textContent = `${percent.toFixed(1)}%`
    if (etaText && eta !== undefined) etaText.textContent = this.formatEta(eta)
    if (speedText && this.progress) {
      const speed = this.formatSpeed(this.progress.bytesPerSecond)
      const totalMB = (this.progress.total / 1024 / 1024).toFixed(1)
      speedText.textContent = `${speed} / ${totalMB}MB`
    }
  }

  private createProgressNotification(): void {
    this.dismiss()

    const notification = document.createElement('div')
    notification.className = 'dn-update dn-downloading'
    notification.innerHTML = `
      <div class="dn-scanlines"></div>
      <div class="dn-border-outer"></div>
      <div class="dn-content">
        <div class="dn-header">
          <div class="dn-sys-tag">SYS // DOWNLOADING</div>
          <button class="dn-close" data-action="cancel" aria-label="Cancel">&times;</button>
        </div>
        <div class="dn-body">
          <div class="dn-title">
            <span class="dn-spinner">◠</span>
            <span class="dn-title-text">PATCHING IN PROGRESS</span>
          </div>
          <div class="dn-progress-wrap">
            <div class="dn-progress-bar">
              <div class="dn-progress-fill" style="width: 0%"></div>
            </div>
            <div class="dn-progress-info">
              <span class="dn-percent">0.0%</span>
              <span class="dn-speed"></span>
              <span class="dn-eta"></span>
            </div>
          </div>
        </div>
        <div class="dn-hud">STREAM ● &nbsp; PKG.TRANSFER</div>
      </div>
    `

    this.addStyles()
    this.bindEvents(notification)
    this.container?.appendChild(notification)
    this.notificationElement = notification
    requestAnimationFrame(() => notification.classList.add('show'))
  }

  showUpdateReady(version: string): void {
    const progressBar = this.notificationElement?.querySelector('.dn-progress-fill') as HTMLElement | null
    if (progressBar) {
      progressBar.style.width = '100%'
      const pct = this.notificationElement?.querySelector('.dn-percent')
      if (pct) pct.textContent = '100%'
      const eta = this.notificationElement?.querySelector('.dn-eta')
      if (eta) eta.textContent = 'COMPLETE'
    }
    const delay = progressBar ? 800 : 0
    setTimeout(() => this.createReadyNotification(version), delay)
  }

  private createReadyNotification(version: string): void {
    this.dismiss()

    const notification = document.createElement('div')
    notification.className = 'dn-update dn-ready'
    notification.innerHTML = `
      <div class="dn-scanlines"></div>
      <div class="dn-border-outer"></div>
      <div class="dn-content">
        <div class="dn-header">
          <div class="dn-sys-tag dn-sys-ok">SYS // READY</div>
          <button class="dn-close" data-action="dismiss" aria-label="Dismiss">&times;</button>
        </div>
        <div class="dn-body">
          <div class="dn-title dn-title-ok">
            <span class="dn-arrow">▶</span>
            <span class="dn-title-text">PATCH INSTALLED</span>
          </div>
          <div class="dn-version">[v${this.escapeHtml(version)}] DOWNLOADED</div>
          <div class="dn-hint">// RESTART TO APPLY</div>
        </div>
        <div class="dn-actions">
          <button class="dn-btn dn-btn-success" data-action="install">
            <span class="dn-btn-text">▶ RESTART NOW</span>
          </button>
          <button class="dn-btn dn-btn-ghost" data-action="later">LATER</button>
        </div>
        <div class="dn-hud">SYS // ONLINE &nbsp; STATUS:OK</div>
      </div>
    `

    this.addStyles()
    this.bindEvents(notification)
    this.container?.appendChild(notification)
    this.notificationElement = notification
    requestAnimationFrame(() => notification.classList.add('show'))
  }

  showError(message: string): void {
    this.dismiss()

    const notification = document.createElement('div')
    notification.className = 'dn-update dn-error'
    notification.innerHTML = `
      <div class="dn-scanlines"></div>
      <div class="dn-border-outer"></div>
      <div class="dn-content">
        <div class="dn-header">
          <div class="dn-sys-tag dn-sys-err">SYS // ERROR</div>
          <button class="dn-close" data-action="dismiss" aria-label="Dismiss">&times;</button>
        </div>
        <div class="dn-body">
          <div class="dn-title dn-title-err">
            <span class="dn-arrow">▶</span>
            <span class="dn-title-text">UPDATE FAILED</span>
          </div>
          <div class="dn-error-msg">${this.escapeHtml(message)}</div>
        </div>
        <div class="dn-actions">
          <button class="dn-btn dn-btn-retry" data-action="retry">
            <span class="dn-btn-text">↻ RETRY</span>
          </button>
        </div>
        <div class="dn-hud">ERR // TRACE &nbsp; CODE:0xDEAD</div>
      </div>
    `

    this.addStyles()
    this.bindEvents(notification)
    this.container?.appendChild(notification)
    this.notificationElement = notification
    requestAnimationFrame(() => notification.classList.add('show'))
  }

  private showNoUpdate(version?: string): void {
    this.dismiss()

    const vLabel = version ? `[v${this.escapeHtml(version)}]` : ''
    const notification = document.createElement('div')
    notification.className = 'dn-update dn-no-update'
    notification.innerHTML = `
      <div class="dn-scanlines"></div>
      <div class="dn-border-outer"></div>
      <div class="dn-content">
        <div class="dn-header">
          <div class="dn-sys-tag dn-sys-ok">SYS // CHECK</div>
          <button class="dn-close" data-action="dismiss" aria-label="Dismiss">&times;</button>
        </div>
        <div class="dn-body">
          <div class="dn-title dn-title-ok">
            <span class="dn-arrow">▶</span>
            <span class="dn-title-text">SYSTEM UP TO DATE</span>
          </div>
          <div class="dn-version">${vLabel} LATEST VERSION</div>
        </div>
        <div class="dn-hud">SYS // ONLINE &nbsp; STATUS:OK</div>
      </div>
    `

    this.addStyles()
    this.bindEvents(notification)
    this.container?.appendChild(notification)
    this.notificationElement = notification
    requestAnimationFrame(() => notification.classList.add('show'))

    setTimeout(() => this.dismiss(), 4000)
  }

  private bindEvents(notification: HTMLElement): void {
    notification.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement
      const action = target.closest('[data-action]')?.getAttribute('data-action')
      if (!action) return

      const electronAPI = (window as any).electronAPI

      switch (action) {
        case 'download':
          if (electronAPI?.downloadUpdate) await electronAPI.downloadUpdate()
          break
        case 'install':
          if (electronAPI?.installUpdate) await electronAPI.installUpdate()
          break
        case 'cancel':
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

  dismiss(): void {
    const el = this.notificationElement
    if (el) {
      this.notificationElement = null
      el.classList.remove('show')
      setTimeout(() => el.remove(), 350)
    }
  }

  // ─── Styles ──────────────────────────────────────────────────
  private addStyles(): void {
    if (document.getElementById('dn-update-styles')) return

    const style = document.createElement('style')
    style.id = 'dn-update-styles'
    style.textContent = `
      /* ═══ Dona Dona Cyberpunk Update Panel ═══ */

      @keyframes dnSlideIn {
        from { opacity: 0; transform: translateY(28px) skewX(-1deg); }
        to   { opacity: 1; transform: translateY(0) skewX(0deg); }
      }
      @keyframes dnNeonPulse {
        0%, 100% { box-shadow: 0 0 0 1px #ff2d7a, 0 0 12px #ff2d7a44; }
        50%      { box-shadow: 0 0 0 1px #ff2d7a, 0 0 20px #ff2d7a66, 0 0 40px #ff2d7a22; }
      }
      @keyframes dnCursorBlink {
        0%, 50% { opacity: 1; }
        51%, 100% { opacity: 0; }
      }
      @keyframes dnSpin {
        from { transform: rotate(0deg); }
        to   { transform: rotate(360deg); }
      }
      @keyframes dnScanMove {
        0%   { top: -100%; }
        100% { top: 100%; }
      }
      @keyframes dnGlitch {
        0%, 92%, 100% { transform: none; opacity: 1; }
        93% { transform: translateX(-2px) skewX(-1deg); }
        95% { transform: translateX(2px) skewX(1deg); }
        97% { transform: translateX(-1px); }
      }
      @keyframes dnProgressSweep {
        0%   { left: -40%; }
        100% { left: 140%; }
      }
      @keyframes dnBorderFlicker {
        0%, 100% { opacity: 1; }
        48% { opacity: 1; }
        49% { opacity: 0.4; }
        51% { opacity: 1; }
        85% { opacity: 1; }
        86% { opacity: 0.6; }
        87% { opacity: 1; }
      }

      /* ─── Panel ─── */
      .dn-update {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 10000;
        width: 400px;
        background: #0a0510;
        clip-path: polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px));
        opacity: 0;
        transform: translateY(28px);
        transition: opacity 0.35s ease, transform 0.35s ease;
        font-family: 'JetBrains Mono', 'Fira Code', 'Share Tech Mono', monospace;
        overflow: hidden;
      }
      .dn-update.show {
        opacity: 1;
        transform: translateY(0);
        animation: dnNeonPulse 2.5s ease-in-out infinite, dnGlitch 8s ease-in-out infinite;
      }

      /* ─── Outer border (cyan glow line) ─── */
      .dn-border-outer {
        position: absolute;
        inset: 0;
        clip-path: polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px));
        border: 1px solid #00e5ff33;
        box-shadow: inset 0 0 0 2px #ff2d7a55;
        pointer-events: none;
        z-index: 1;
        animation: dnBorderFlicker 4s ease-in-out infinite;
      }

      /* ─── Scanlines overlay ─── */
      .dn-scanlines {
        position: absolute;
        inset: 0;
        background: repeating-linear-gradient(
          0deg,
          transparent,
          transparent 3px,
          rgba(255, 45, 122, 0.03) 3px,
          rgba(255, 45, 122, 0.03) 4px
        );
        pointer-events: none;
        z-index: 5;
      }
      .dn-scanlines::after {
        content: '';
        position: absolute;
        left: 0;
        right: 0;
        height: 40px;
        top: -100%;
        background: linear-gradient(180deg, transparent, rgba(0, 229, 255, 0.06), transparent);
        animation: dnScanMove 4s linear infinite;
        pointer-events: none;
      }

      /* ─── Content ─── */
      .dn-content {
        position: relative;
        z-index: 3;
        padding: 14px 16px 12px;
      }

      /* ─── Header ─── */
      .dn-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
      }
      .dn-sys-tag {
        font-size: 9px;
        letter-spacing: 0.15em;
        color: #00e5ff;
        text-shadow: 0 0 6px #00e5ff66;
        text-transform: uppercase;
      }
      .dn-sys-ok  { color: #8fff4a; text-shadow: 0 0 6px #8fff4a66; }
      .dn-sys-err { color: #ff2d7a; text-shadow: 0 0 6px #ff2d7a66; }

      .dn-close {
        width: 22px;
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: 1px solid #ff2d7a33;
        color: #ff2d7a88;
        cursor: pointer;
        font-size: 14px;
        font-family: inherit;
        clip-path: polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 4px 100%, 0 calc(100% - 4px));
        transition: all 0.15s;
      }
      .dn-close:hover {
        background: #ff2d7a;
        color: #0a0510;
        border-color: #ff2d7a;
      }

      /* ─── Title ─── */
      .dn-title {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 6px;
      }
      .dn-arrow {
        color: #ff2d7a;
        font-size: 10px;
        text-shadow: 0 0 8px #ff2d7a88;
      }
      .dn-title-text {
        font-size: 14px;
        font-weight: 700;
        color: #ff2d7a;
        letter-spacing: 0.08em;
        text-shadow: 2px 0 #00e5ff44, -1px 0 #ff2d7a22, 0 0 12px #ff2d7a55;
      }
      .dn-title-ok .dn-title-text  { color: #8fff4a; text-shadow: 2px 0 #00e5ff44, 0 0 12px #8fff4a55; }
      .dn-title-ok .dn-arrow       { color: #8fff4a; text-shadow: 0 0 8px #8fff4a88; }
      .dn-title-err .dn-title-text { color: #ff2d7a; text-shadow: 2px 0 #00e5ff44, 0 0 16px #ff2d7a88; }
      .dn-cursor {
        color: #ff2d7a;
        animation: dnCursorBlink 1s step-end infinite;
      }
      .dn-spinner {
        display: inline-block;
        color: #00e5ff;
        animation: dnSpin 1s linear infinite;
        font-size: 12px;
      }

      /* ─── Version / Notes ─── */
      .dn-version {
        font-size: 11px;
        color: #00e5ff;
        letter-spacing: 0.06em;
        font-family: inherit;
        text-shadow: 0 0 4px #00e5ff44;
      }
      .dn-notes {
        font-size: 10px;
        color: #ffffff55;
        margin-top: 8px;
        padding: 6px 8px;
        background: #ff2d7a08;
        border-left: 2px solid #ff2d7a44;
        line-height: 1.5;
        max-height: 52px;
        overflow: hidden;
      }
      .dn-hint {
        font-size: 10px;
        color: #00e5ff88;
        margin-top: 4px;
        letter-spacing: 0.05em;
      }
      .dn-error-msg {
        font-size: 10px;
        color: #ff2d7a;
        margin-top: 6px;
        padding: 6px 8px;
        background: #ff2d7a0a;
        border-left: 2px solid #ff2d7a55;
        max-height: 52px;
        overflow: hidden;
        word-break: break-all;
      }

      /* ─── Progress ─── */
      .dn-progress-wrap { margin-top: 10px; }
      .dn-progress-bar {
        height: 3px;
        background: #ff2d7a18;
        position: relative;
        overflow: hidden;
        clip-path: polygon(0 0, calc(100% - 3px) 0, 100% 100%, 3px 100%);
      }
      .dn-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #ff2d7a, #ff3a8c, #ff6eb4);
        transition: width 0.4s ease;
        box-shadow: 0 0 6px #ff2d7a88, 0 0 12px #ff2d7a44;
        position: relative;
      }
      .dn-progress-fill::after {
        content: '';
        position: absolute;
        top: 0;
        width: 30%;
        height: 100%;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent);
        animation: dnProgressSweep 1.8s ease-in-out infinite;
      }
      .dn-progress-info {
        display: flex;
        justify-content: space-between;
        margin-top: 5px;
        font-size: 10px;
        color: #00e5ff99;
        letter-spacing: 0.04em;
      }

      /* ─── Buttons ─── */
      .dn-actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }
      .dn-btn {
        padding: 6px 14px;
        font-size: 10px;
        font-weight: 700;
        cursor: pointer;
        border: 1px solid transparent;
        font-family: inherit;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        position: relative;
        overflow: hidden;
        clip-path: polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px));
        transition: all 0.12s;
      }
      .dn-btn-primary {
        background: #ff2d7a;
        color: #0a0510;
        border-color: #ff2d7a;
        box-shadow: 0 0 0 1px #ff2d7a, 0 0 12px #ff2d7a44;
      }
      .dn-btn-primary:hover {
        background: #0a0510;
        color: #ff2d7a;
        box-shadow: 0 0 0 1px #ff2d7a, 0 0 20px #ff2d7a66;
      }
      .dn-btn-success {
        background: #8fff4a;
        color: #0a0510;
        border-color: #8fff4a;
        box-shadow: 0 0 0 1px #8fff4a, 0 0 12px #8fff4a44;
      }
      .dn-btn-success:hover {
        background: #0a0510;
        color: #8fff4a;
        box-shadow: 0 0 0 1px #8fff4a, 0 0 20px #8fff4a66;
      }
      .dn-btn-ghost {
        background: transparent;
        color: #ffffff44;
        border-color: #ffffff18;
      }
      .dn-btn-ghost:hover {
        color: #ffffffaa;
        border-color: #ffffff33;
        background: #ffffff08;
      }
      .dn-btn-retry {
        background: transparent;
        color: #ff2d7a;
        border-color: #ff2d7a55;
      }
      .dn-btn-retry:hover {
        background: #ff2d7a;
        color: #0a0510;
      }

      /* ─── HUD decoration ─── */
      .dn-hud {
        margin-top: 10px;
        font-size: 8px;
        color: #00e5ff33;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        border-top: 1px solid #00e5ff11;
        padding-top: 6px;
      }

      /* ─── State-specific top accent line ─── */
      .dn-available .dn-content::before {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 2px;
        background: linear-gradient(90deg, transparent, #ff2d7a, #ff3a8c, #ff2d7a, transparent);
      }
      .dn-downloading .dn-content::before {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 2px;
        background: linear-gradient(90deg, transparent, #00e5ff, #3df, #00e5ff, transparent);
      }
      .dn-ready .dn-content::before {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 2px;
        background: linear-gradient(90deg, transparent, #8fff4a, #aaff77, #8fff4a, transparent);
      }
      .dn-error .dn-content::before {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 2px;
        background: linear-gradient(90deg, transparent, #ff2d7a, #ff6eb4, #ff2d7a, transparent);
      }

      @media (prefers-reduced-motion: reduce) {
        .dn-update, .dn-update.show { animation: none; transition: opacity 0.15s ease; }
        .dn-scanlines::after { animation: none; display: none; }
        .dn-progress-fill::after { animation: none; display: none; }
        .dn-spinner { animation: none; }
        .dn-cursor { animation: none; }
        .dn-border-outer { animation: none; }
      }

      @media (max-width: 480px) {
        .dn-update {
          left: 10px; right: 10px; bottom: 10px;
          width: auto;
        }
      }
    `
    document.head.appendChild(style)
  }

  // ─── Helpers ─────────────────────────────────────────────────
  private escapeHtml(str: string): string {
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }

  private stripHtml(html: string): string {
    const div = document.createElement('div')
    div.innerHTML = html
    return (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim()
  }

  private truncateNotes(notes: string, maxLength: number = 120): string {
    if (notes.length <= maxLength) return notes
    return notes.slice(0, maxLength) + '...'
  }

  private formatEta(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  private formatSpeed(bytesPerSecond: number): string {
    if (bytesPerSecond < 1024) return `${bytesPerSecond} B/s`
    if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
  }

  getStatus(): UpdateStatus { return this.status }
  getUpdateInfo(): UpdateInfo | null { return this.updateInfo }

  destroy(): void {
    this.stopAutoCheck()
    this.dismiss()
    UpdateNotification.instance = null
  }
}

// ─── Singleton exports ─────────────────────────────────────────
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

export function initUpdateNotificationGlobal(): void {
  const notification = getUpdateNotification()
  if (typeof window !== 'undefined') {
    ;(window as any).updateNotificationTS = notification
    ;(window as any).UpdateNotificationTS = UpdateNotification
  }
}
