// src/renderer/src/services/version-checker/VersionChecker.ts
/**
 * 版本检测服务模块
 * V16.2 A3 - 合并 js/services/version-checker.js 功能
 * 检测应用版本更新
 */

export interface VersionInfo {
  version: string
  releaseDate?: string
  buildTime?: string
  description?: string
  changelog?: string[]
  releaseNotes?: string[]
  downloadUrl?: string
  forceUpdate?: boolean
}

export interface UpdateCheckResult {
  hasUpdate: boolean
  currentVersion?: string
  newVersion?: string
  changelog?: string[]
  downloadUrl?: string
  forceUpdate?: boolean
}

export interface VersionCheckerConfig {
  versionFile: string
  localStorageKey: string
  checkIntervalMs: number
}

const DEFAULT_CONFIG: VersionCheckerConfig = {
  versionFile: 'version.json',
  localStorageKey: 'app_version',
  checkIntervalMs: 3600000 // 1小时
}

export class VersionChecker {
  private config: VersionCheckerConfig
  private checkInterval: ReturnType<typeof setInterval> | null = null
  private onUpdateCallbacks: Set<(result: UpdateCheckResult) => void>

  constructor(config?: Partial<VersionCheckerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.onUpdateCallbacks = new Set()
  }

  /**
   * 获取服务器端的最新版本信息
   */
  async fetchServerVersion(): Promise<VersionInfo | null> {
    try {
      const timestamp = Date.now()
      const response = await fetch(`${this.config.versionFile}?t=${timestamp}`, {
        cache: 'no-cache',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      })

      if (!response.ok) {
        throw new Error(`获取版本信息失败: ${response.status}`)
      }

      return await response.json()
    } catch (error) {
      console.error('获取服务器版本失败:', error)
      return null
    }
  }

  /**
   * 获取本地存储的版本号
   */
  getLocalVersion(): VersionInfo | null {
    try {
      const localVersion = localStorage.getItem(this.config.localStorageKey)
      return localVersion ? JSON.parse(localVersion) : null
    } catch (error) {
      console.error('读取本地版本失败:', error)
      return null
    }
  }

  /**
   * 保存版本号到本地存储
   */
  saveLocalVersion(versionInfo: VersionInfo): boolean {
    try {
      localStorage.setItem(this.config.localStorageKey, JSON.stringify(versionInfo))
      return true
    } catch (error) {
      console.error('保存本地版本失败:', error)
      return false
    }
  }

  /**
   * 比较版本号
   * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
   */
  compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number)
    const parts2 = v2.split('.').map(Number)

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const part1 = parts1[i] || 0
      const part2 = parts2[i] || 0

      if (part1 > part2) return 1
      if (part1 < part2) return -1
    }

    return 0
  }

  /**
   * 检查是否有新版本
   */
  async checkForUpdate(): Promise<UpdateCheckResult> {
    try {
      const serverVersion = await this.fetchServerVersion()
      
      if (!serverVersion?.version) {
        console.log('无法获取服务器版本信息')
        return { hasUpdate: false }
      }

      const localVersion = this.getLocalVersion()

      // 如果本地没有版本信息，保存当前版本并返回
      if (!localVersion) {
        this.saveLocalVersion(serverVersion)
        console.log('首次访问，保存版本信息:', serverVersion.version)
        return { hasUpdate: false }
      }

      // 比较版本号
      const comparison = this.compareVersions(serverVersion.version, localVersion.version)

      if (comparison > 0) {
        const result: UpdateCheckResult = {
          hasUpdate: true,
          currentVersion: localVersion.version,
          newVersion: serverVersion.version,
          changelog: serverVersion.changelog,
          downloadUrl: serverVersion.downloadUrl,
          forceUpdate: serverVersion.forceUpdate
        }

        // 触发更新回调
        this.onUpdateCallbacks.forEach(cb => cb(result))

        return result
      }

      return {
        hasUpdate: false,
        currentVersion: localVersion.version
      }
    } catch (error) {
      console.error('检查更新失败:', error)
      return { hasUpdate: false }
    }
  }

  /**
   * 开始自动检查更新
   */
  startAutoCheck(): void {
    if (this.checkInterval) {
      return
    }

    // 立即检查一次
    this.checkForUpdate()

    // 设置定时检查
    this.checkInterval = setInterval(() => {
      this.checkForUpdate()
    }, this.config.checkIntervalMs)

    console.log(`版本自动检查已启动，间隔: ${this.config.checkIntervalMs}ms`)
  }

  /**
   * 停止自动检查更新
   */
  stopAutoCheck(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
      console.log('版本自动检查已停止')
    }
  }

  /**
   * 监听更新事件
   */
  onUpdate(callback: (result: UpdateCheckResult) => void): () => void {
    this.onUpdateCallbacks.add(callback)
    return () => this.onUpdateCallbacks.delete(callback)
  }

  /**
   * 标记版本已更新
   */
  markAsUpdated(): void {
    this.fetchServerVersion().then(version => {
      if (version) {
        this.saveLocalVersion(version)
      }
    })
  }

  /**
   * 获取当前版本
   */
  getCurrentVersion(): string | null {
    return this.getLocalVersion()?.version || null
  }

  // ========================================
  // V16.2 A3 - 从 JS 版本合并的功能
  // ========================================

  /**
   * 强制刷新页面（清除缓存）
   */
  forceRefresh(): void {
    try {
      // 清除 Service Worker 缓存
      if ('caches' in window) {
        caches.keys().then((names) => {
          names.forEach((name) => {
            caches.delete(name)
          })
        })
      }

      // 添加时间戳参数强制刷新
      const currentUrl = new URL(window.location.href)
      currentUrl.searchParams.set('_refresh', String(Date.now()))
      window.location.href = currentUrl.href
    } catch (error) {
      console.error('刷新页面失败:', error)
      // 降级方案：普通刷新
      window.location.reload()
    }
  }

  /**
   * 显示更新提示对话框
   */
  showUpdateDialog(updateInfo: UpdateCheckResult): void {
    const modal = document.getElementById('updateModal')
    if (!modal) {
      console.error('更新提示对话框不存在')
      return
    }

    // 更新版本文本
    const versionText = document.getElementById('updateVersionText')
    if (versionText && updateInfo.newVersion) {
      versionText.textContent = updateInfo.newVersion
    }

    // 渲染更新说明
    this.renderUpdateNotes(updateInfo.changelog || [])

    // 显示对话框
    modal.classList.remove('hidden')
    modal.classList.add('flex')
  }

  /**
   * 隐藏更新提示对话框
   */
  hideUpdateDialog(): void {
    const modal = document.getElementById('updateModal')
    if (modal) {
      modal.classList.add('hidden')
      modal.classList.remove('flex')
    }
  }

  /**
   * 渲染更新说明列表
   */
  renderUpdateNotes(releaseNotes: string[]): void {
    const container = document.getElementById('updateNotesContainer')
    const notesList = document.getElementById('updateNotesList')

    if (!container || !notesList) {
      console.warn('更新内容容器不存在')
      return
    }

    // 清空现有内容
    notesList.innerHTML = ''

    if (releaseNotes && releaseNotes.length > 0) {
      releaseNotes.forEach((note) => {
        const li = document.createElement('li')
        li.className = 'flex items-start'
        li.innerHTML = `
          <i class="fas fa-check-circle text-purple-500 mr-2 mt-0.5 flex-shrink-0"></i>
          <span>${this.escapeHtml(note)}</span>
        `
        notesList.appendChild(li)
      })
      container.classList.remove('hidden')
    } else {
      container.classList.add('hidden')
    }
  }

  /**
   * HTML 转义
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  /**
   * 初始化版本检测（包含 UI 绑定）
   */
  async init(): Promise<void> {
    console.log('[VersionChecker] 初始化版本检测系统...')

    // 页面加载时检测一次
    const updateInfo = await this.checkForUpdate()

    if (updateInfo.hasUpdate) {
      this.showUpdateDialog(updateInfo)
    }

    // 绑定按钮事件
    this.bindEvents()
  }

  /**
   * 绑定事件监听器
   */
  bindEvents(): void {
    // 确定按钮 - 刷新页面
    const confirmBtn = document.getElementById('confirmUpdate')
    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => {
        this.fetchServerVersion().then((serverVersion) => {
          if (serverVersion) {
            this.saveLocalVersion(serverVersion)
          }
          this.forceRefresh()
        })
      })
    }

    // 取消按钮 - 关闭对话框并保存版本号
    const cancelBtn = document.getElementById('cancelUpdate')
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        this.fetchServerVersion().then((serverVersion) => {
          if (serverVersion) {
            this.saveLocalVersion(serverVersion)
          }
        })
        this.hideUpdateDialog()
      })
    }

    // 关闭按钮
    const closeBtn = document.getElementById('closeUpdate')
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.fetchServerVersion().then((serverVersion) => {
          if (serverVersion) {
            this.saveLocalVersion(serverVersion)
          }
        })
        this.hideUpdateDialog()
      })
    }

    // 点击模态框外部关闭
    const modal = document.getElementById('updateModal')
    if (modal) {
      modal.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).id === 'updateModal') {
          this.fetchServerVersion().then((serverVersion) => {
            if (serverVersion) {
              this.saveLocalVersion(serverVersion)
            }
          })
          this.hideUpdateDialog()
        }
      })
    }
  }
}

// 创建单例
let instance: VersionChecker | null = null

export function getVersionChecker(config?: Partial<VersionCheckerConfig>): VersionChecker {
  if (!instance) {
    instance = new VersionChecker(config)
  }
  return instance
}

export function createVersionChecker(config?: Partial<VersionCheckerConfig>): VersionChecker {
  return new VersionChecker(config)
}

/**
 * 重置单例（仅用于测试）
 */
export function resetVersionChecker(): void {
  instance = null
}

// ========================================
// V16.2 A3 - 过渡期 window 暴露
// V16.3 - 添加废弃警告
// ========================================

declare global {
  interface Window {
    versionChecker: VersionChecker
    VersionCheckerTS: typeof VersionChecker
  }
}

let versionCheckerDeprecationWarningShown = false

/**
 * 初始化并暴露到 window（过渡期）
 * V16.3: 添加废弃警告
 */
export function initVersionCheckerGlobal(config?: Partial<VersionCheckerConfig>): VersionChecker {
  const checker = getVersionChecker(config)

  // 过渡期: 暴露到 window (带废弃警告)
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'versionChecker', {
      get() {
        if (!versionCheckerDeprecationWarningShown && process.env.NODE_ENV !== 'production') {
          console.warn(
            '[DEPRECATED] window.versionChecker 已废弃。' +
            '请使用 Services.get("versionChecker") 或 import { getVersionChecker } from "@/services/version-checker"'
          )
          versionCheckerDeprecationWarningShown = true
        }
        return checker
      },
      configurable: true
    })
    
    window.VersionCheckerTS = VersionChecker
  }

  console.log('[V16.3] VersionChecker TypeScript 版本已加载 (废弃警告已启用)')

  return checker
}
