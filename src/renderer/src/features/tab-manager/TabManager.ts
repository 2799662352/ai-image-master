// src/renderer/src/features/tab-manager/TabManager.ts
/**
 * 标签页管理器
 * 处理标签页切换、URL hash 路由和页面生命周期
 */

export interface PageModule {
  onActivate?: () => void
  onDeactivate?: () => void
  loadPanel?: () => void
  [key: string]: any
}

export interface TabManagerConfig {
  defaultTab?: string
  validTabs?: string[]
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void
}

export type TabChangeCallback = (tabName: string, previousTab: string) => void

export class TabManager {
  private currentTab: string
  private pages: Record<string, PageModule> = {}
  private validTabs: string[]
  private config: TabManagerConfig
  private tabChangeCallbacks: TabChangeCallback[] = []

  private readonly DEFAULT_VALID_TABS = [
    'generate',
    'batch',
    'compare',
    'history',
    'understand',
    'director'
  ]

  constructor(config: TabManagerConfig = {}) {
    this.config = config
    this.currentTab = config.defaultTab || 'generate'
    this.validTabs = config.validTabs || this.DEFAULT_VALID_TABS
  }

  /**
   * 设置页面模块引用
   */
  setPages(pages: Record<string, PageModule>): void {
    this.pages = pages
  }

  /**
   * 初始化 hash 路由
   */
  initHashRouter(): void {
    // 监听 hash 变化
    window.addEventListener('hashchange', () => this.handleHashChange())

    // 处理初始 hash
    this.handleHashChange()
  }

  /**
   * 处理 URL hash 变化
   */
  private handleHashChange(): void {
    const hash = window.location.hash.slice(1) // 移除 # 号

    if (hash && this.validTabs.includes(hash)) {
      // 切换到指定的标签，但不更新 URL（避免循环）
      this.switchTab(hash, false)
    } else if (!hash) {
      // 如果没有 hash，默认显示第一个标签
      this.switchTab(this.config.defaultTab || 'generate', false)
    }
  }

  /**
   * 切换标签页
   */
  switchTab(tabName: string, updateUrl = true): void {
    // 验证标签名
    if (!this.validTabs.includes(tabName)) {
      console.warn(`无效的标签名: ${tabName}`)
      return
    }

    // 检查目标面板是否存在
    const targetPanel = document.getElementById(`${tabName}Panel`)
    if (!targetPanel) {
      console.warn(`面板 ${tabName}Panel 不存在，无法切换`)
      this.config.showToast?.(`功能 ${tabName} 暂不可用`, 'error')
      return
    }

    // 保存之前的标签名
    const previousTab = this.currentTab

    // 如果切换到相同的标签，不执行任何操作
    if (previousTab === tabName) {
      return
    }

    // 1. 立即更新 UI（用户感知响应）
    this.updateTabUI(tabName)

    // 更新当前标签
    this.currentTab = tabName

    // 更新 URL hash（仅当需要时）
    if (updateUrl) {
      window.history.pushState(null, '', `#${tabName}`)
    }

    // 2. 使用 requestAnimationFrame 延迟状态操作，避免阻塞 UI
    requestAnimationFrame(() => {
      // 调用之前页面的失活回调
      this.deactivatePage(previousTab)

      // 再次使用 requestAnimationFrame 延迟激活，确保失活完成
      requestAnimationFrame(() => {
        // 调用新页面的激活回调
        this.activatePage(tabName)

        // 触发回调
        this.tabChangeCallbacks.forEach(callback => {
          try {
            callback(tabName, previousTab)
          } catch (error) {
            console.error('Tab change callback error:', error)
          }
        })
      })
    })
  }

  /**
   * 更新标签 UI
   */
  private updateTabUI(tabName: string): void {
    // 更新标签按钮状态
    document.querySelectorAll('.tab-btn').forEach(btn => {
      const element = btn as HTMLElement
      element.classList.remove('active')
      if (element.dataset.tab === tabName) {
        element.classList.add('active')
      }
    })

    // 隐藏所有面板
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.add('hidden')
    })

    // 显示目标面板
    const targetPanel = document.getElementById(`${tabName}Panel`)
    if (targetPanel) {
      targetPanel.classList.remove('hidden')
    }
  }

  /**
   * 失活页面
   */
  private deactivatePage(tabName: string): void {
    const page = this.pages[tabName]
    if (page && typeof page.onDeactivate === 'function') {
      console.log(`🔄 失活页面: ${tabName}`)
      try {
        page.onDeactivate()
      } catch (error) {
        console.error(`页面 ${tabName} 失活失败:`, error)
      }
    }
  }

  /**
   * 激活页面
   */
  private activatePage(tabName: string): void {
    const page = this.pages[tabName]
    if (page && typeof page.onActivate === 'function') {
      console.log(`🔄 激活页面: ${tabName}`)
      try {
        page.onActivate()
      } catch (error) {
        console.error(`页面 ${tabName} 激活失败:`, error)
      }
    } else {
      console.warn(`⚠️ 页面 ${tabName} 未找到或未完全初始化`)
    }
  }

  /**
   * 获取当前标签名
   */
  getCurrentTab(): string {
    return this.currentTab
  }

  /**
   * 检查是否是当前标签
   */
  isCurrentTab(tabName: string): boolean {
    return this.currentTab === tabName
  }

  /**
   * 获取有效标签列表
   */
  getValidTabs(): string[] {
    return [...this.validTabs]
  }

  /**
   * 添加标签切换回调
   */
  onTabChange(callback: TabChangeCallback): () => void {
    this.tabChangeCallbacks.push(callback)

    // 返回取消订阅函数
    return () => {
      const index = this.tabChangeCallbacks.indexOf(callback)
      if (index > -1) {
        this.tabChangeCallbacks.splice(index, 1)
      }
    }
  }

  /**
   * 绑定标签按钮点击事件
   */
  bindTabButtons(): void {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement
        const tabName = target.dataset.tab

        if (tabName) {
          this.switchTab(tabName, true)
        } else {
          console.warn('按钮缺少 data-tab 属性:', target)
        }
      })
    })
  }

  /**
   * 销毁实例
   */
  destroy(): void {
    this.tabChangeCallbacks = []
    this.pages = {}
  }
}

// 单例实例
let tabManagerInstance: TabManager | null = null

/**
 * 获取 TabManager 单例
 */
export function getTabManager(config?: TabManagerConfig): TabManager {
  if (!tabManagerInstance) {
    tabManagerInstance = new TabManager(config)
  }
  return tabManagerInstance
}

/**
 * 创建新的 TabManager 实例
 */
export function createTabManager(config?: TabManagerConfig): TabManager {
  return new TabManager(config)
}
