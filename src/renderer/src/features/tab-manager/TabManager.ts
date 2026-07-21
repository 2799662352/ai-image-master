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

  // v4.3.9 修复快速点击闪屏:
  // - switchGeneration:每次 switchTab 自增,RAF 回调里比对,丢弃 stale 闭包
  // - pendingRafIds:取消正在排队的 RAF,避免回调与新目标错乱
  // - reentrancyGuard:防止 onTabChange → useTabStore.subscribe → switchTab 反向同步形成回环
  private switchGeneration = 0
  private pendingRaf1: number | null = null
  private pendingRaf2: number | null = null
  private reentrancyGuard = false

  private readonly DEFAULT_VALID_TABS = [
    'generate',
    'batch',
    // 'compare' 已被 'audio'(音频生成,seed-audio-1.0)替换;ComparePage 代码暂留未注册
    'audio',
    'history',
    'understand',
    'director',
    'storyboardSplit',
    'smartErase',
    'agentWorkspace',
    'marketplace',
    'portraitLibrary'
  ]

  constructor(config: TabManagerConfig = {}) {
    this.config = config
    this.currentTab = config.defaultTab || 'generate'
    this.validTabs = config.validTabs || this.DEFAULT_VALID_TABS
  }

  /**
   * 取消上一次 switchTab 排队中的 RAF,防止 stale 回调跑到新目标之后
   */
  private cancelPendingTransition(): void {
    if (this.pendingRaf1 !== null) {
      cancelAnimationFrame(this.pendingRaf1)
      this.pendingRaf1 = null
    }
    if (this.pendingRaf2 !== null) {
      cancelAnimationFrame(this.pendingRaf2)
      this.pendingRaf2 = null
    }
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
   *
   * v4.3.9 修复:用户快速连续点击不同 tab 时,旧实现里 onTabChange 回调在两层 RAF
   * 后才触发,闭包里 newTab 是 stale 的;再加上 ServiceBridge 双向同步
   * (tabManager.onTabChange ↔ useTabStore.subscribe),stale 回调会把 useTabStore
   * 反推回旧 tab,导致 ~16ms 的旧页面内容闪现。
   *
   * 修复策略:
   *  1. onTabChange 回调改为同步触发(与 updateTabUI 原子),让 React mount/unmount
   *     的可见性切换跟 panel.hidden 切换在同一帧完成,既消除闪屏也消除空帧。
   *  2. 仅保留 deactivatePage/activatePage 在 RAF 里(它们可能跑重活)。
   *  3. 用 generation counter + cancelAnimationFrame 取消上一轮排队中的 RAF,
   *     避免 stale 闭包跑过头。
   *  4. reentrancyGuard 兜底:任何 onTabChange 回调里如果有人又调 switchTab,
   *     直接吞掉,杜绝反向同步循环。
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

    // 重入保护:onTabChange 回调里如果反向调回 switchTab,直接吞掉,
    // 让最外层的那次 switchTab 决定最终状态,而不是在回调里再 fork 一次。
    if (this.reentrancyGuard) {
      return
    }

    // 保存之前的标签名
    const previousTab = this.currentTab

    // 如果切换到相同的标签，不执行任何操作
    if (previousTab === tabName) {
      return
    }

    // 取消上一次 switchTab 还在排队的 RAF(它们的闭包已经 stale)
    this.cancelPendingTransition()

    // 1. 立即更新 UI(用户感知响应)
    this.updateTabUI(tabName)

    // 更新当前标签
    this.currentTab = tabName

    // 更新 URL hash(仅当需要时)
    if (updateUrl) {
      window.history.pushState(null, '', `#${tabName}`)
    }

    // 2. 同步触发 onTabChange 回调
    //    React 的 mount/unmount 走这条路,必须跟 updateTabUI 在同一帧完成,
    //    否则 panel.hidden 已经切了但 react-root.display 还没切,会出现
    //    空白闪屏或旧内容闪现。
    this.reentrancyGuard = true
    try {
      this.tabChangeCallbacks.forEach(callback => {
        try {
          callback(tabName, previousTab)
        } catch (error) {
          console.error('Tab change callback error:', error)
        }
      })
    } finally {
      this.reentrancyGuard = false
    }

    // 3. 仅 deactivatePage / activatePage 走 RAF,这俩可能跑重活(数据加载等)
    const generation = ++this.switchGeneration
    this.pendingRaf1 = requestAnimationFrame(() => {
      this.pendingRaf1 = null
      // stale guard:用户在这一帧之前又点了别的 tab,放弃本次执行
      if (generation !== this.switchGeneration) return

      this.deactivatePage(previousTab)

      this.pendingRaf2 = requestAnimationFrame(() => {
        this.pendingRaf2 = null
        if (generation !== this.switchGeneration) return

        this.activatePage(tabName)
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
  private static readonly REACT_MANAGED_TABS = new Set(['agentWorkspace', 'director'])

  private activatePage(tabName: string): void {
    const page = this.pages[tabName]
    if (page && typeof page.onActivate === 'function') {
      console.log(`🔄 激活页面: ${tabName}`)
      try {
        page.onActivate()
      } catch (error) {
        console.error(`页面 ${tabName} 激活失败:`, error)
      }
    } else if (!TabManager.REACT_MANAGED_TABS.has(tabName)) {
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
    this.cancelPendingTransition()
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
