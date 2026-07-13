// src/main/updater.ts - 自动更新模块
import { autoUpdater, UpdateInfo, ProgressInfo, AppUpdater } from 'electron-updater'
import { BrowserWindow, ipcMain, app } from 'electron'

export type UpdateProvider = 'github' | 'generic' | 's3'

/** V17: 发布渠道类型 */
export type ReleaseChannel = 'latest' | 'stable' | 'beta' | 'alpha'
type ElectronUpdaterChannel = Exclude<ReleaseChannel, 'stable'>

export function releaseChannelForVersion(version: string): ElectronUpdaterChannel {
  const prereleaseChannel = version.match(
    /^\d+\.\d+\.\d+-(beta|alpha)(?:[.-]|$)/i,
  )?.[1]?.toLowerCase()

  if (prereleaseChannel === 'beta') return 'beta'
  if (prereleaseChannel === 'alpha') return 'alpha'
  return 'latest'
}

export function normalizeReleaseChannel(
  channel: ReleaseChannel,
): ElectronUpdaterChannel {
  switch (channel) {
    case 'latest':
    case 'stable':
      return 'latest'
    case 'beta':
      return 'beta'
    case 'alpha':
      return 'alpha'
    default: {
      const exhaustiveChannel: never = channel
      throw new Error(`Unsupported release channel: ${exhaustiveChannel}`)
    }
  }
}

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
  /**
   * 安装前清理钩子。在 quitAndInstall 之前同步等它跑完, 把所有 main
   * process 持有的文件句柄 / 子进程释放掉。
   *
   * 为什么是必须的(round-5 真凶):
   * Windows 上 NSIS 安装器需要替换 `resources/app.asar`,
   * `resources/*.node`, 主 exe 等文件。如果还有任何子进程(codex,
   * docker mcp gateway, smartErase worker)握着这些文件的句柄,
   * NSIS 会陷入 partial install —— 旧 exe 已被改名成 .bak, 但新 exe
   * 没装上, 用户感知就是"更新把自己卸载了"。
   *
   * 之前的 round-1 修复只把 `isInstallingUpdate` flag 加到 before-quit
   * 让出 quit 周期, 但子进程并没有被杀。本轮补上。
   *
   * 推荐内容: 杀 codex/docker 子进程, dispose fs watchers, shutdown DB,
   * 即 main/index.ts 里的 cleanupAgentRuntime()。
   *
   * 必须能在 PRE_INSTALL_TIMEOUT_MS 内完成, 超时会被无情跳过 ——
   * 因为 quitAndInstall 阶段卡死比 partial install 更糟。
   */
  preInstallCleanup?: () => Promise<void>
}

/**
 * preInstallCleanup 的硬超时。codex SIGTERM 给 2s 才升 SIGKILL, agentManager
 * 串行 stop 多个 backend, 加上 db shutdown / dockerGateway.stop 留点余量。
 * 超过 8s 就放弃, 让 NSIS 自己去抢锁(它有内置重试)。
 */
const PRE_INSTALL_TIMEOUT_MS = 8_000

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

  /**
   * 安装更新期间置 true。给 src/main/index.ts 的 `before-quit` 监听检查,
   * 让它跳过自定义 cleanup + preventDefault 流程, 把 quit 周期完整交给
   * electron-updater 自己接管 —— 否则 NSIS 安装器会在父进程被打断的瞬间
   * 把旧 exe 改名/删除但新 exe 还没就位, 用户感知就是"自我删除/启动失败"。
   *
   * 用 static 是因为 before-quit 监听写在模块顶层, 无法持有 AutoUpdater
   * 实例引用; 一个进程也只可能有一个 updater 实例。
   */
  static isInstallingUpdate = false

  constructor(config: UpdaterConfig = {}) {
    const defaultChannel = config.channel ?? releaseChannelForVersion(app.getVersion())
    this.config = {
      provider: 'github',
      autoDownload: true,
      allowPrerelease: false,
      maxRetries: 3,
      retryDelay: 2000,
      ...config,
      channel: defaultChannel,
      allowDowngrade: false,
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
    // 关键: autoInstallOnAppQuit 和 handleInstall 里的 quitAndInstall 是
    // 二选一的两种姿势, 同时开会让 update 在两个不同的 quit 周期里都尝试
    // 安装一次 NSIS 包 —— 第二次进入时 installer 已经把旧 exe 改名了,
    // 直接命中 "self-deletion" 的 Windows 经典坑。我们这里走"显式由用户
    // 点'立即重启安装'触发 quitAndInstall"那条路, 所以把 autoInstall 关掉。
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.autoRunAppAfterInstall = true
    
    // beta/alpha 自动接收预发布版本；stable 是 latest 的 UI 别名。
    const channel = normalizeReleaseChannel(this.config.channel ?? 'latest')
    autoUpdater.allowPrerelease =
      channel === 'beta' || channel === 'alpha'
        ? true
        : (this.config.allowPrerelease ?? false)

    // electron-updater 的 channel setter 在启用多频道更新文件时可能重新打开
    // allowDowngrade，因此必须最后显式关闭，避免回退频道变成客户端自动降级。
    autoUpdater.channel = channel
    autoUpdater.allowDowngrade = false

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
    this.config = { ...this.config, ...config, allowDowngrade: false }
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

  private async handleInstall(): Promise<UpdateResult> {
    try {
      // 标记安装中 —— 让 main/index.ts 的 before-quit 监听放行,
      // 不要 preventDefault 也不要再独立调一次 cleanupAgentRuntime,
      // 而是把 cleanup 集中到本函数里 await 完, 再交给 electron-updater。
      AutoUpdater.isInstallingUpdate = true

      // 关键(round-5 真凶): 在 quitAndInstall 之前**同步**等待子进程
      // 都死透。NSIS 在 Windows 上必须能独占 `resources/` 和主 exe;
      // 残留的 codex/docker 子进程会握着 *.node / app.asar 的句柄,
      // 让 NSIS partial-install, 引发"老 exe 已删 / 新 exe 未就位"
      // 的自删现象。
      //
      // 硬超时 8s: 即便清理卡住也得继续, 让 NSIS 自己去抢锁
      // (它有 retry-on-locked-file 的内置策略, 比这里傻等更靠谱)。
      const cleanup = this.config.preInstallCleanup
      if (cleanup) {
        let timer: NodeJS.Timeout | undefined
        await Promise.race([
          cleanup().catch((err) => {
            console.warn('[AutoUpdater] preInstallCleanup error (ignored):', err)
          }),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              console.warn(
                `[AutoUpdater] preInstallCleanup 超时 ${PRE_INSTALL_TIMEOUT_MS}ms, 强行往下走 quitAndInstall`,
              )
              resolve()
            }, PRE_INSTALL_TIMEOUT_MS)
            timer.unref?.()
          }),
        ])
        if (timer) clearTimeout(timer)
      }

      // isSilent=false: NSIS UI 可见, 让用户看到进度;
      // isForceRunAfter=true: 安装完自动重启新版本(用户期望)。
      autoUpdater.quitAndInstall(false, true)
      return { success: true }
    } catch (error: any) {
      // 安装失败回滚 flag, 否则下一次正常退出会被错误跳过 cleanup。
      AutoUpdater.isInstallingUpdate = false
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
