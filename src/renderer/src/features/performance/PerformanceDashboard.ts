/**
 * PerformanceDashboard - 实时性能监控面板
 * V18: 提供可视化的性能监控界面
 * 
 * 基于 Context7 Electron 最佳实践:
 * - 使用 process.getProcessMemoryInfo() 获取内存信息
 * - 使用 performance API 获取加载时间
 * - 定期刷新数据
 */

import { getLibraryLoadStatus } from '../../utils/LazyLibraries'

export interface PerformanceMetric {
  label: string
  value: string
  unit?: string
  status: 'good' | 'warning' | 'critical'
}

export interface PerformanceDashboardConfig {
  /** 刷新间隔 (毫秒) */
  refreshInterval: number
  /** 容器选择器 */
  containerSelector: string
  /** 是否显示详细信息 */
  showDetails: boolean
  /** 开发模式下才显示 */
  devModeOnly: boolean
}

const DEFAULT_CONFIG: PerformanceDashboardConfig = {
  refreshInterval: 2000,
  containerSelector: 'body',
  showDetails: true,
  devModeOnly: true
}

export class PerformanceDashboard {
  private static instance: PerformanceDashboard | null = null
  private config: PerformanceDashboardConfig
  private container: HTMLElement | null = null
  private dashboardElement: HTMLElement | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private isVisible = false
  private startTime: number

  constructor(config: Partial<PerformanceDashboardConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.startTime = performance.now()
  }

  static getInstance(config?: Partial<PerformanceDashboardConfig>): PerformanceDashboard {
    if (!PerformanceDashboard.instance) {
      PerformanceDashboard.instance = new PerformanceDashboard(config)
    }
    return PerformanceDashboard.instance
  }

  /**
   * 初始化性能面板
   */
  init(): void {
    // 开发模式检查
    if (this.config.devModeOnly && !this.isDevMode()) {
      console.log('[PerformanceDashboard] 仅在开发模式下启用')
      return
    }

    this.container = document.querySelector(this.config.containerSelector)
    if (!this.container) {
      console.warn('[PerformanceDashboard] 容器未找到')
      return
    }

    this.createToggleButton()
    console.log('[PerformanceDashboard] 初始化完成 (按 Alt+P 切换)')

    // 监听键盘快捷键
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        this.toggle()
      }
    })
  }

  /**
   * 判断是否为开发模式
   */
  private isDevMode(): boolean {
    return (
      (window as any).electronAPI?.isDevMode?.() === true ||
      process.env.NODE_ENV === 'development' ||
      location.hostname === 'localhost'
    )
  }

  /**
   * 创建切换按钮
   */
  private createToggleButton(): void {
    const button = document.createElement('button')
    button.id = 'perf-dashboard-toggle'
    button.innerHTML = '📊'
    button.title = '性能监控 (Alt+P)'
    button.style.cssText = `
      position: fixed;
      bottom: 10px;
      left: 10px;
      z-index: 9999;
      width: 36px;
      height: 36px;
      border: none;
      border-radius: 50%;
      background: rgba(30, 30, 40, 0.8);
      color: #fff;
      font-size: 16px;
      cursor: pointer;
      opacity: 0.6;
      transition: opacity 0.2s;
    `
    button.addEventListener('mouseenter', () => button.style.opacity = '1')
    button.addEventListener('mouseleave', () => button.style.opacity = '0.6')
    button.addEventListener('click', () => this.toggle())

    this.container?.appendChild(button)
  }

  /**
   * 切换面板显示
   */
  toggle(): void {
    if (this.isVisible) {
      this.hide()
    } else {
      this.show()
    }
  }

  /**
   * 显示面板
   */
  show(): void {
    if (this.isVisible) return

    this.createDashboard()
    this.startRefresh()
    this.isVisible = true
  }

  /**
   * 隐藏面板
   */
  hide(): void {
    if (!this.isVisible) return

    this.stopRefresh()
    this.dashboardElement?.remove()
    this.dashboardElement = null
    this.isVisible = false
  }

  /**
   * 创建仪表板
   */
  private createDashboard(): void {
    this.addStyles()

    const dashboard = document.createElement('div')
    dashboard.id = 'perf-dashboard'
    dashboard.className = 'perf-dashboard'
    dashboard.innerHTML = `
      <div class="perf-header">
        <span class="perf-title">📊 性能监控</span>
        <button class="perf-close" title="关闭">×</button>
      </div>
      <div class="perf-content">
        <div class="perf-section">
          <div class="perf-section-title">内存</div>
          <div class="perf-metrics" id="perf-memory"></div>
        </div>
        <div class="perf-section">
          <div class="perf-section-title">性能</div>
          <div class="perf-metrics" id="perf-timing"></div>
        </div>
        <div class="perf-section">
          <div class="perf-section-title">延迟加载库</div>
          <div class="perf-metrics" id="perf-libraries"></div>
        </div>
      </div>
    `

    dashboard.querySelector('.perf-close')?.addEventListener('click', () => this.hide())

    this.container?.appendChild(dashboard)
    this.dashboardElement = dashboard

    // 立即更新一次
    this.refresh()
  }

  /**
   * 开始定时刷新
   */
  private startRefresh(): void {
    this.refreshTimer = setInterval(() => {
      this.refresh()
    }, this.config.refreshInterval)
  }

  /**
   * 停止定时刷新
   */
  private stopRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  /**
   * 刷新数据
   */
  private async refresh(): Promise<void> {
    if (!this.dashboardElement) return

    // 更新内存指标
    const memoryContainer = this.dashboardElement.querySelector('#perf-memory')
    if (memoryContainer) {
      memoryContainer.innerHTML = this.renderMemoryMetrics()
    }

    // 更新性能指标
    const timingContainer = this.dashboardElement.querySelector('#perf-timing')
    if (timingContainer) {
      timingContainer.innerHTML = this.renderTimingMetrics()
    }

    // 更新库加载状态
    const librariesContainer = this.dashboardElement.querySelector('#perf-libraries')
    if (librariesContainer) {
      librariesContainer.innerHTML = this.renderLibraryStatus()
    }
  }

  /**
   * 渲染内存指标
   */
  private renderMemoryMetrics(): string {
    const metrics: PerformanceMetric[] = []

    // JS 堆内存
    if ((performance as any).memory) {
      const mem = (performance as any).memory
      const usedMB = mem.usedJSHeapSize / (1024 * 1024)
      const totalMB = mem.totalJSHeapSize / (1024 * 1024)
      const limitMB = mem.jsHeapSizeLimit / (1024 * 1024)
      const usagePercent = (usedMB / limitMB) * 100

      metrics.push({
        label: 'JS 堆已用',
        value: usedMB.toFixed(1),
        unit: 'MB',
        status: usagePercent < 50 ? 'good' : usagePercent < 80 ? 'warning' : 'critical'
      })

      metrics.push({
        label: 'JS 堆总量',
        value: totalMB.toFixed(1),
        unit: 'MB',
        status: 'good'
      })

      metrics.push({
        label: '堆限制',
        value: limitMB.toFixed(0),
        unit: 'MB',
        status: 'good'
      })
    }

    // DOM 节点数
    const nodeCount = document.getElementsByTagName('*').length
    metrics.push({
      label: 'DOM 节点',
      value: nodeCount.toString(),
      status: nodeCount < 1500 ? 'good' : nodeCount < 3000 ? 'warning' : 'critical'
    })

    return metrics.map(m => this.renderMetric(m)).join('')
  }

  /**
   * 渲染性能指标
   */
  private renderTimingMetrics(): string {
    const metrics: PerformanceMetric[] = []
    const now = performance.now()

    // 页面运行时间
    const runTime = (now - this.startTime) / 1000
    metrics.push({
      label: '运行时间',
      value: runTime.toFixed(0),
      unit: 's',
      status: 'good'
    })

    // 页面加载时间
    const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
    if (navEntry) {
      const loadTime = navEntry.loadEventEnd - navEntry.startTime
      metrics.push({
        label: '页面加载',
        value: loadTime.toFixed(0),
        unit: 'ms',
        status: loadTime < 2000 ? 'good' : loadTime < 5000 ? 'warning' : 'critical'
      })

      const domReady = navEntry.domContentLoadedEventEnd - navEntry.startTime
      metrics.push({
        label: 'DOM 就绪',
        value: domReady.toFixed(0),
        unit: 'ms',
        status: domReady < 1000 ? 'good' : domReady < 2000 ? 'warning' : 'critical'
      })
    }

    // FPS 估算 (简单估算)
    const fps = this.estimateFPS()
    metrics.push({
      label: 'FPS (估算)',
      value: fps.toString(),
      status: fps >= 50 ? 'good' : fps >= 30 ? 'warning' : 'critical'
    })

    return metrics.map(m => this.renderMetric(m)).join('')
  }

  /**
   * 渲染库加载状态
   */
  private renderLibraryStatus(): string {
    const status = getLibraryLoadStatus()
    
    const statusMap: Record<string, { label: string; icon: string }> = {
      'loaded': { label: '已加载', icon: '✅' },
      'loading': { label: '加载中', icon: '⏳' },
      'not-loaded': { label: '未加载', icon: '⬜' }
    }

    return `
      <div class="perf-metric">
        <span class="perf-label">JSZip</span>
        <span class="perf-value">${statusMap[status.jszip].icon} ${statusMap[status.jszip].label}</span>
      </div>
      <div class="perf-metric">
        <span class="perf-label">imageCompression</span>
        <span class="perf-value">${statusMap[status.imageCompression].icon} ${statusMap[status.imageCompression].label}</span>
      </div>
    `
  }

  /**
   * 渲染单个指标
   */
  private renderMetric(metric: PerformanceMetric): string {
    const statusClass = `status-${metric.status}`
    return `
      <div class="perf-metric ${statusClass}">
        <span class="perf-label">${metric.label}</span>
        <span class="perf-value">${metric.value}${metric.unit ? ' ' + metric.unit : ''}</span>
      </div>
    `
  }

  /**
   * 估算 FPS
   */
  private estimateFPS(): number {
    // 使用 PerformanceObserver 的简单 FPS 估算
    const entries = performance.getEntriesByType('paint')
    if (entries.length >= 2) {
      const fps = Math.round(1000 / ((entries[entries.length - 1] as any).startTime - (entries[entries.length - 2] as any).startTime))
      return Math.min(fps, 60)
    }
    return 60 // 默认假设 60 FPS
  }

  /**
   * 添加样式
   */
  private addStyles(): void {
    if (document.getElementById('perf-dashboard-styles')) return

    const style = document.createElement('style')
    style.id = 'perf-dashboard-styles'
    style.textContent = `
      .perf-dashboard {
        position: fixed;
        bottom: 50px;
        left: 10px;
        z-index: 10000;
        width: 280px;
        background: rgba(20, 20, 30, 0.95);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        font-family: 'SF Mono', Monaco, 'Courier New', monospace;
        font-size: 12px;
        color: #e0e0e0;
      }

      .perf-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }

      .perf-title {
        font-weight: 600;
        font-size: 13px;
      }

      .perf-close {
        width: 24px;
        height: 24px;
        border: none;
        background: transparent;
        color: #888;
        font-size: 18px;
        cursor: pointer;
        border-radius: 4px;
        transition: all 0.2s;
      }

      .perf-close:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }

      .perf-content {
        padding: 8px;
      }

      .perf-section {
        margin-bottom: 12px;
      }

      .perf-section:last-child {
        margin-bottom: 4px;
      }

      .perf-section-title {
        color: #888;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 6px;
        padding: 0 4px;
      }

      .perf-metrics {
        background: rgba(0, 0, 0, 0.3);
        border-radius: 6px;
        padding: 4px;
      }

      .perf-metric {
        display: flex;
        justify-content: space-between;
        padding: 4px 8px;
        border-radius: 4px;
      }

      .perf-metric:nth-child(odd) {
        background: rgba(255, 255, 255, 0.02);
      }

      .perf-label {
        color: #aaa;
      }

      .perf-value {
        font-weight: 500;
      }

      .perf-metric.status-good .perf-value {
        color: #10b981;
      }

      .perf-metric.status-warning .perf-value {
        color: #f59e0b;
      }

      .perf-metric.status-critical .perf-value {
        color: #ef4444;
      }
    `
    document.head.appendChild(style)
  }

  /**
   * 销毁组件
   */
  destroy(): void {
    this.hide()
    document.getElementById('perf-dashboard-toggle')?.remove()
    document.getElementById('perf-dashboard-styles')?.remove()
    PerformanceDashboard.instance = null
  }
}

// 单例获取函数
let dashboardInstance: PerformanceDashboard | null = null

export function getPerformanceDashboard(config?: Partial<PerformanceDashboardConfig>): PerformanceDashboard {
  if (!dashboardInstance) {
    dashboardInstance = new PerformanceDashboard(config)
  }
  return dashboardInstance
}

export function initPerformanceDashboard(): void {
  const dashboard = getPerformanceDashboard()
  dashboard.init()
}

export function resetPerformanceDashboard(): void {
  if (dashboardInstance) {
    dashboardInstance.destroy()
    dashboardInstance = null
  }
}
