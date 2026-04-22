// src/main/updater.ts - 自动更新模块
import { autoUpdater, UpdateInfo, ProgressInfo, AppUpdater } from 'electron-updater'
import { BrowserWindow, ipcMain, app } from 'electron'

export type UpdateProvider = 'github' | 'generic' | 's3'

/** V17: 发布渠道类型 */
export type ReleaseChannel = 'latest' | 'stable' | 'beta' | 'alpha'

export interface UpdaterConfig {
  /** 更新源类型 */
  provider?: UpdateProvider
  /** GitHub 仓库所有者 (provider=github 时必填) */
  owner?: string
  /** GitHub 仓库名称 (provider=github 时必填) */
  repo?: string
  /** 私有仓库 token */
  token?: string
  /** 通用更新服务器 URL (provider=generic 时必填) */
  url?: string
  /** S3 存储桶名称 (provider=s3 时必填) */
  bucket?: string
  /** S3 区域 (provider=s3 时必填) */
  region?: string
  /** 自动下载 */
  autoDownload?: boolean
  /** 是否允许预发布版本 */
  allowPrerelease?: boolean
  /** 是否允许降级 */
  allowDowngrade?: boolean
  /** 下载重试次数 */
  maxRetries?: number
  /** 重试延迟 (毫秒) */
  retryDelay?: number
  /** V17: 发布渠道 (latest/stable/beta/alpha) */
  channel?: ReleaseChannel
  /** 备用更新源（主源失败时自动切换） */
  fallback?: Partial<UpdaterConfig>
}

export interface UpdateProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
  delta: number
  /** 预估剩余时间 (秒) */
  eta?: number
}

export interface UpdateResult {
  success: boolean
  error?: string
  version?: string
}

export class AutoUpdater {
  private mainWindow: BrowserWindow | null = null
  private isCheckingUpdate = false
  private isDownloading = false
  private config: UpdaterConfig
  private downloadRetryCount = 0
  private downloadStartTime: number | null = null
  private usingFallback = false

  constructor(config: UpdaterConfig = {}) {
    this.config = {
      provider: 'github',
      autoDownload: true,
      allowPrerelease: false,
      allowDowngrade: false,
      maxRetries: 3,
      retryDelay: 2000,
      channel: 'latest',
      ...config
    }

    this.configureAutoUpdater()
    this.setupEventListeners()
    this.setupIPC()
  }

  /**
   * 配置 autoUpdater
   */
  private configureAutoUpdater(): void {
    // 基本配置
    autoUpdater.autoDownload = this.config.autoDownload ?? false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.autoRunAppAfterInstall = true
    
    // V17: 渠道配置 - beta/alpha 渠道自动允许预发布版本
    const channel = this.config.channel ?? 'latest'
    if (channel === 'beta' || channel === 'alpha') {
      autoUpdater.allowPrerelease = true
      autoUpdater.allowDowngrade = this.config.allowDowngrade ?? true // beta 渠道允许降级到 stable
    } else {
      autoUpdater.allowPrerelease = this.config.allowPrerelease ?? false
      autoUpdater.allowDowngrade = this.config.allowDowngrade ?? false
    }
    
    // V17: 设置渠道 (影响 latest-{channel}.yml 文件选择)
    autoUpdater.channel = channel

    // 配置 provider
    this.setFeedURL()

    // GitHub provider 需要手动指定旧版 blockmap 的下载地址才能启用差分更新
    // electron-updater 默认从 latest release 取 blockmap，但 GitHub 的旧 release 地址不同
    if (this.config.provider === 'github' && this.config.owner && this.config.repo) {
      const currentVersion = app.getVersion()
      autoUpdater.previousBlockmapBaseUrlOverride =
        `https://github.com/${this.config.owner}/${this.config.repo}/releases/download/v${currentVersion}/`
      console.log(`[AutoUpdater] 差分更新已配置, previousBlockmap → v${currentVersion}`)
    }

    // 配置认证 token (用于私有仓库)
    if (this.config.token) {
      this.setAuthToken(this.config.token)
    }

    console.log(`[AutoUpdater] 配置完成, provider=${this.config.provider}, channel=${channel}`)
  }

  /**
   * 设置更新源 URL
   */
  private setFeedURL(): void {
    const { provider, owner, repo, url, bucket, region, token } = this.config

    try {
      switch (provider) {
        case 'github':
          if (owner && repo) {
            autoUpdater.setFeedURL({
              provider: 'github',
              owner,
              repo,
              private: !!token,
              token
            })
          }
          break

        case 'generic':
          if (url) {
            autoUpdater.setFeedURL({
              provider: 'generic',
              url
            })
          }
          break

        case 's3':
          if (bucket && region) {
            autoUpdater.setFeedURL({
              provider: 's3',
              bucket,
              region
            })
          }
          break
      }
    } catch (error) {
      console.error('[AutoUpdater] 设置更新源失败:', error)
    }
  }

  /**
   * 设置认证 token
   */
  private setAuthToken(token: string): void {
    // 设置 GitHub token 用于访问私有仓库
    if (this.config.provider === 'github') {
      process.env.GH_TOKEN = token
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<UpdaterConfig>): void {
    this.config = { ...this.config, ...config }
    this.configureAutoUpdater()
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  private setupEventListeners(): void {
    // 检查更新出错
    autoUpdater.on('error', (error: Error) => {
      console.error('[AutoUpdater] 检查更新出错:', error)

      // 处理下载错误重试
      if (this.isDownloading && this.downloadRetryCount < (this.config.maxRetries ?? 3)) {
        this.downloadRetryCount++
        console.log(`[AutoUpdater] 下载失败，尝试重试 (${this.downloadRetryCount}/${this.config.maxRetries})`)
        this.sendToRenderer('download-retry', {
          attempt: this.downloadRetryCount,
          maxRetries: this.config.maxRetries,
          error: error.message
        })

        // 延迟重试
        setTimeout(() => {
          this.downloadUpdateInternal()
        }, this.config.retryDelay ?? 2000)
        return
      }

      if (!this.isDownloading && !this.usingFallback && this.config.fallback) {
        console.log(`[AutoUpdater] 主源 ${this.config.provider} 检查失败，切换到备用源...`)
        this.usingFallback = true
        this.switchProvider(this.config.fallback)
        this.isCheckingUpdate = false
        setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 1000)
        return
      }

      this.sendToRenderer('update-error', {
        message: error.message,
        code: this.getErrorCode(error),
        isRetryable: this.isRetryableError(error)
      })
      this.isCheckingUpdate = false
      this.isDownloading = false
      this.downloadRetryCount = 0
    })

    // 检查更新中
    autoUpdater.on('checking-for-update', () => {
      console.log('[AutoUpdater] 正在检查更新...')
      this.sendToRenderer('checking-for-update', {
        provider: this.config.provider,
        timestamp: Date.now()
      })
      this.isCheckingUpdate = true
    })

    // 有可用更新
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      console.log('[AutoUpdater] 发现新版本:', info.version)
      this.sendToRenderer('update-available', {
        version: info.version,
        currentVersion: app.getVersion(),
        releaseDate: info.releaseDate,
        releaseNotes: this.formatReleaseNotes(info.releaseNotes),
        files: info.files,
        sha512: info.sha512,
        autoDownload: this.config.autoDownload ?? false
      })
      this.isCheckingUpdate = false
    })

    // 没有可用更新
    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      console.log('[AutoUpdater] 当前已是最新版本:', info.version)
      this.sendToRenderer('update-not-available', {
        currentVersion: app.getVersion(),
        latestVersion: info.version
      })
      this.isCheckingUpdate = false
    })

    // 下载进度
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      const percent = progress.percent
      const totalMB = (progress.total / 1024 / 1024).toFixed(1)
      const speedKB = (progress.bytesPerSecond / 1024).toFixed(0)
      console.log(`[AutoUpdater] 下载进度: ${percent.toFixed(1)}% | ${totalMB}MB total | ${speedKB}KB/s`)

      // 计算预估剩余时间
      let eta: number | undefined
      if (this.downloadStartTime && progress.bytesPerSecond > 0) {
        const remaining = progress.total - progress.transferred
        eta = Math.round(remaining / progress.bytesPerSecond)
      }

      const progressData: UpdateProgress = {
        percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
        delta: progress.delta,
        eta
      }

      this.sendToRenderer('download-progress', progressData)
    })

    // 下载完成
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      console.log('[AutoUpdater] 更新下载完成:', info.version)
      const downloadTime = this.downloadStartTime ? Date.now() - this.downloadStartTime : undefined
      this.isDownloading = false
      this.downloadRetryCount = 0
      this.downloadStartTime = null

      this.sendToRenderer('update-downloaded', {
        version: info.version,
        releaseNotes: this.formatReleaseNotes(info.releaseNotes),
        downloadTime
      })
    })
  }

  /**
   * 格式化发布说明
   */
  private formatReleaseNotes(notes: unknown): string | null {
    if (!notes) return null
    if (typeof notes === 'string') return notes
    if (Array.isArray(notes)) {
      return notes
        .map((n: { note?: string | null }) => n.note || '')
        .filter(Boolean)
        .join('\n')
    }
    return null
  }

  /**
   * 获取错误代码
   */
  private getErrorCode(error: Error): string {
    const message = error.message.toLowerCase()
    if (message.includes('network') || message.includes('timeout')) return 'NETWORK_ERROR'
    if (message.includes('404') || message.includes('not found')) return 'NOT_FOUND'
    if (message.includes('401') || message.includes('403')) return 'AUTH_ERROR'
    if (message.includes('signature')) return 'SIGNATURE_ERROR'
    return 'UNKNOWN_ERROR'
  }

  /**
   * 判断是否可重试的错误
   */
  private isRetryableError(error: Error): boolean {
    const code = this.getErrorCode(error)
    return ['NETWORK_ERROR', 'UNKNOWN_ERROR'].includes(code)
  }

  /**
   * 内部下载方法
   */
  private async downloadUpdateInternal(): Promise<void> {
    try {
      this.downloadStartTime = Date.now()
      await autoUpdater.downloadUpdate()
    } catch (error) {
      console.error('[AutoUpdater] 下载异常:', error)
      throw error
    }
  }

  private async handleDownload(): Promise<UpdateResult> {
    try {
      if (this.isDownloading) {
        return { success: false, error: '正在下载更新中...' }
      }
      this.isDownloading = true
      this.downloadRetryCount = 0
      await this.downloadUpdateInternal()
      return { success: true }
    } catch (error: any) {
      console.error('[AutoUpdater] 下载更新失败:', error)
      this.isDownloading = false
      return { success: false, error: error.message }
    }
  }

  private handleInstall(): UpdateResult {
    try {
      autoUpdater.quitAndInstall(false, true)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  private setupIPC(): void {
    ipcMain.handle('updater:check', () => this.checkForUpdates())
    ipcMain.handle('updater:download', () => this.handleDownload())
    ipcMain.handle('updater:install', () => this.handleInstall())
    ipcMain.handle('updater:getVersion', () => app.getVersion())

    // preload 仍用这些旧通道名
    ipcMain.handle('check-for-update', () => this.checkForUpdates())
    ipcMain.handle('download-update', () => this.handleDownload())
    ipcMain.handle('install-update', () => this.handleInstall())
    ipcMain.handle('get-app-version', () => app.getVersion())

    // 获取更新器状态
    ipcMain.handle('updater:getStatus', () => {
      return {
        isCheckingUpdate: this.isCheckingUpdate,
        isDownloading: this.isDownloading,
        downloadRetryCount: this.downloadRetryCount,
        config: {
          provider: this.config.provider,
          autoDownload: this.config.autoDownload,
          allowPrerelease: this.config.allowPrerelease,
          channel: this.config.channel
        }
      }
    })

    // V17: 获取当前发布渠道
    ipcMain.handle('updater:getChannel', (): ReleaseChannel => {
      return this.config.channel ?? 'latest'
    })

    // V17: 设置发布渠道
    const VALID_CHANNELS: ReleaseChannel[] = ['latest', 'stable', 'beta', 'alpha']
    ipcMain.handle('updater:setChannel', (_event, channel: ReleaseChannel) => {
      if (!VALID_CHANNELS.includes(channel)) {
        return { success: false, error: `Invalid channel: ${channel}` }
      }
      this.updateConfig({ channel })
      return { success: true, channel }
    })

    // 更新配置
    ipcMain.handle('updater:updateConfig', (_event, config: Partial<UpdaterConfig>) => {
      this.updateConfig(config)
      return { success: true }
    })

    // 取消下载
    ipcMain.handle('updater:cancelDownload', () => {
      try {
        // electron-updater 没有直接的取消方法，我们只能重置状态
        this.isDownloading = false
        this.downloadRetryCount = 0
        this.downloadStartTime = null
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    })
  }

  private sendToRenderer(channel: string, data?: any): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(`updater:${channel}`, data)
    }
  }

  /**
   * 启动时检查更新（延迟执行，不阻塞启动）
   */
  checkForUpdatesOnStartup(delayMs: number = 5000): void {
    setTimeout(async () => {
      try {
        console.log('[AutoUpdater] 启动时检查更新...')
        await autoUpdater.checkForUpdates()
      } catch (error) {
        console.error('[AutoUpdater] 启动时检查更新失败:', error)
      }
    }, delayMs)
  }

  /**
   * 手动检查更新
   */
  async checkForUpdates(): Promise<UpdateResult> {
    try {
      if (this.isCheckingUpdate) {
        return { success: false, error: '正在检查更新中...' }
      }
      const result = await autoUpdater.checkForUpdates()
      return { success: true, version: result?.updateInfo?.version }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  /**
   * 获取更新器实例 (用于高级配置)
   */
  getAutoUpdater(): AppUpdater {
    return autoUpdater
  }

  /**
   * 获取当前配置
   */
  getConfig(): UpdaterConfig {
    return { ...this.config }
  }

  /**
   * 是否正在检查更新
   */
  isChecking(): boolean {
    return this.isCheckingUpdate
  }

  /**
   * 是否正在下载
   */
  isDownloadingUpdate(): boolean {
    return this.isDownloading
  }

  /**
   * 运行时切换更新源（用于 COS → GitHub fallback）
   */
  switchProvider(newConfig: Partial<UpdaterConfig>): void {
    Object.assign(this.config, newConfig)
    this.setFeedURL()
    console.log(`[AutoUpdater] 已切换 provider → ${this.config.provider}`)
  }
}

// 导出单例创建函数
let autoUpdaterInstance: AutoUpdater | null = null

export function getAutoUpdaterInstance(config?: UpdaterConfig): AutoUpdater {
  if (!autoUpdaterInstance) {
    autoUpdaterInstance = new AutoUpdater(config)
  }
  return autoUpdaterInstance
}

export function createAutoUpdater(config?: UpdaterConfig): AutoUpdater {
  return new AutoUpdater(config)
}

// 兼容旧的导出方式
export { autoUpdaterInstance }
