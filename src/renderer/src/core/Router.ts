// src/renderer/src/core/Router.ts
/**
 * 页面路由器
 * 管理页面切换、URL hash 同步和页面生命周期
 */

export interface PageModule {
  onActivate?: () => void
  onDeactivate?: () => void
  loadPanel?: () => void
  init?: () => Promise<void> | void
  destroy?: () => void
}

export interface RouterConfig {
  defaultTab: string
  validTabs: string[]
  panelSuffix: string
  tabBtnClass: string
  tabPanelClass: string
  updateUrl: boolean
}

export type RouteChangeCallback = (newTab: string, previousTab: string | null) => void

const DEFAULT_CONFIG: RouterConfig = {
  defaultTab: 'generate',
  validTabs: ['generate', 'batch', 'compare', 'history', 'understand', 'director', 'settings'],
  panelSuffix: 'Panel',
  tabBtnClass: 'tab-btn',
  tabPanelClass: 'tab-panel',
  updateUrl: true
}

export class Router {
  private currentTab: string
  private previousTab: string | null = null
  private pages: Map<string, PageModule>
  private config: RouterConfig
  private onChangeCallbacks: Set<RouteChangeCallback>
  private initialized = false

  constructor(config?: Partial<RouterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.currentTab = this.config.defaultTab
    this.pages = new Map()
    this.onChangeCallbacks = new Set()
  }

  /**
   * 初始化路由器
   */
  init(): void {
    if (this.initialized) return

    // 监听 hashchange 事件
    window.addEventListener('hashchange', () => this.handleHashChange())
    
    // 监听 popstate 事件（浏览器前进/后退）
    window.addEventListener('popstate', () => this.handleHashChange())

    // 解析初始 URL
    this.handleHashChange()

    this.initialized = true
    console.log('[Router] 初始化完成')
  }

  /**
   * 注册页面模块
   */
  register(name: string, module: PageModule): void {
    this.pages.set(name, module)
  }

  /**
   * 批量注册页面模块
   */
  registerAll(modules: Record<string, PageModule>): void {
    for (const [name, module] of Object.entries(modules)) {
      this.register(name, module)
    }
  }

  /**
   * 取消注册页面模块
   */
  unregister(name: string): void {
    this.pages.delete(name)
  }

  /**
   * 导航到指定页面
   */
  navigate(tabName: string, updateUrl = true): boolean {
    // 验证目标标签
    if (!this.config.validTabs.includes(tabName)) {
      console.warn(`[Router] 无效的标签: ${tabName}`)
      return false
    }

    // 检查目标面板是否存在
    const targetPanel = document.getElementById(`${tabName}${this.config.panelSuffix}`)
    if (!targetPanel) {
      console.warn(`[Router] 面板 ${tabName}${this.config.panelSuffix} 不存在`)
      return false
    }

    // 如果已经在当前页面，不执行切换
    if (tabName === this.currentTab) {
      return true
    }

    // 保存之前的标签
    this.previousTab = this.currentTab

    // 更新标签按钮状态
    this.updateTabButtons(tabName)

    // 显示对应面板
    this.updatePanels(tabName)

    // 更新当前标签
    this.currentTab = tabName

    // 更新 URL hash
    if (updateUrl && this.config.updateUrl) {
      window.history.pushState(null, '', `#${tabName}`)
    }

    // 触发页面生命周期
    this.triggerLifecycle(this.previousTab, tabName)

    // 触发回调
    this.notifyChange(tabName, this.previousTab)

    return true
  }

  /**
   * 更新标签按钮状态
   */
  private updateTabButtons(activeTab: string): void {
    document.querySelectorAll(`.${this.config.tabBtnClass}`).forEach(btn => {
      const tabBtn = btn as HTMLElement
      tabBtn.classList.remove('active')
      if (tabBtn.dataset.tab === activeTab) {
        tabBtn.classList.add('active')
      }
    })
  }

  /**
   * 更新面板显示状态
   */
  private updatePanels(visibleTab: string): void {
    document.querySelectorAll(`.${this.config.tabPanelClass}`).forEach(panel => {
      panel.classList.add('hidden')
    })

    const targetPanel = document.getElementById(`${visibleTab}${this.config.panelSuffix}`)
    if (targetPanel) {
      targetPanel.classList.remove('hidden')
    }
  }

  /**
   * 触发页面生命周期
   */
  private triggerLifecycle(previousTab: string | null, newTab: string): void {
    // 使用 requestAnimationFrame 延迟状态操作，避免阻塞 UI
    requestAnimationFrame(() => {
      // 调用之前页面的失活回调
      if (previousTab) {
        const prevPage = this.pages.get(previousTab)
        if (prevPage?.onDeactivate) {
          console.log(`[Router] 失活页面: ${previousTab}`)
          prevPage.onDeactivate()
        }
      }

      // 再次使用 requestAnimationFrame 延迟激活
      requestAnimationFrame(() => {
        const newPage = this.pages.get(newTab)
        if (newPage?.onActivate) {
          console.log(`[Router] 激活页面: ${newTab}`)
          newPage.onActivate()
        }
      })
    })
  }

  /**
   * 处理 URL hash 变化
   */
  private handleHashChange(): void {
    const hash = window.location.hash.slice(1) // 去掉 #

    if (hash && this.config.validTabs.includes(hash)) {
      this.navigate(hash, false)
    } else if (!hash) {
      this.navigate(this.config.defaultTab, false)
    }
  }

  /**
   * 通知路由变化
   */
  private notifyChange(newTab: string, previousTab: string | null): void {
    this.onChangeCallbacks.forEach(cb => cb(newTab, previousTab))
  }

  /**
   * 监听路由变化
   */
  onChange(callback: RouteChangeCallback): () => void {
    this.onChangeCallbacks.add(callback)
    return () => this.onChangeCallbacks.delete(callback)
  }

  /**
   * 获取当前标签
   */
  getCurrentTab(): string {
    return this.currentTab
  }

  /**
   * 获取之前的标签
   */
  getPreviousTab(): string | null {
    return this.previousTab
  }

  /**
   * 获取页面模块
   */
  getPage(name: string): PageModule | undefined {
    return this.pages.get(name)
  }

  /**
   * 获取所有注册的页面
   */
  getAllPages(): Map<string, PageModule> {
    return new Map(this.pages)
  }

  /**
   * 检查是否为有效标签
   */
  isValidTab(tabName: string): boolean {
    return this.config.validTabs.includes(tabName)
  }

  /**
   * 添加有效标签
   */
  addValidTab(tabName: string): void {
    if (!this.config.validTabs.includes(tabName)) {
      this.config.validTabs.push(tabName)
    }
  }

  /**
   * 获取配置
   */
  getConfig(): RouterConfig {
    return { ...this.config }
  }

  /**
   * 销毁路由器
   */
  destroy(): void {
    window.removeEventListener('hashchange', () => this.handleHashChange())
    window.removeEventListener('popstate', () => this.handleHashChange())
    this.pages.clear()
    this.onChangeCallbacks.clear()
    this.initialized = false
  }
}

// 创建单例
let instance: Router | null = null

export function getRouter(config?: Partial<RouterConfig>): Router {
  if (!instance) {
    instance = new Router(config)
  }
  return instance
}

export function createRouter(config?: Partial<RouterConfig>): Router {
  return new Router(config)
}
