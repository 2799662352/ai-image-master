/**
 * PerformanceMonitorService - 性能监控服务
 * V16.2 A1 - 从 js/performance-monitor.js 迁移
 * 
 * 功能:
 * - 监控和记录应用加载性能指标
 * - 使用 PerformanceObserver 捕获绘制时间
 * - 生成性能报告
 */

/**
 * 性能指标接口
 */
export interface PerformanceMetrics {
  /** DOMContentLoaded 时间 (ms) */
  domContentLoaded: number | null
  /** 应用初始化完成时间 (ms) */
  appInitialized: number | null
  /** 首次绘制时间 (ms) */
  firstPaint: number | null
  /** 首次内容绘制时间 (ms) */
  firstContentfulPaint: number | null
  /** 可交互时间 (ms) */
  timeToInteractive: number | null
}

/**
 * 性能报告接口
 */
export interface PerformanceReport extends PerformanceMetrics {
  summary: {
    domToApp: number | null
    total: number | null
  }
}

/**
 * PerformanceMonitor 配置接口
 */
export interface PerformanceMonitorConfig {
  /** 是否启用日志 */
  enableLogging?: boolean
  /** 是否自动初始化 */
  autoInit?: boolean
}

const DEFAULT_CONFIG: Required<PerformanceMonitorConfig> = {
  enableLogging: true,
  autoInit: true
}

/**
 * PerformanceMonitor 类
 * 监控应用性能指标
 */
export class PerformanceMonitor {
  private metrics: PerformanceMetrics
  private startTime: number
  private config: Required<PerformanceMonitorConfig>
  private observer: PerformanceObserver | null = null

  constructor(config: PerformanceMonitorConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.metrics = {
      domContentLoaded: null,
      appInitialized: null,
      firstPaint: null,
      firstContentfulPaint: null,
      timeToInteractive: null
    }
    this.startTime = performance.now()

    if (this.config.autoInit) {
      this.init()
    }
  }

  /**
   * 初始化性能监控
   */
  init(): void {
    // 记录 DOMContentLoaded 时间
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        this.metrics.domContentLoaded = performance.now()
        this.logMetric('DOMContentLoaded', this.metrics.domContentLoaded)
      })
    } else {
      this.metrics.domContentLoaded = performance.now()
      this.logMetric('DOMContentLoaded', this.metrics.domContentLoaded)
    }

    // 记录应用初始化时间
    window.addEventListener('appReady', () => {
      this.metrics.appInitialized = performance.now()
      this.logMetric('AppInitialized', this.metrics.appInitialized)
      this.calculateTimeToInteractive()
      this.printSummary()
    })

    // 记录首次绘制时间（使用 PerformanceObserver）
    this.observePaintTiming()
  }

  /**
   * 使用 PerformanceObserver 观察绘制时间
   */
  private observePaintTiming(): void {
    if ('PerformanceObserver' in window) {
      try {
        this.observer = new PerformanceObserver((list: PerformanceObserverEntryList) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-paint') {
              this.metrics.firstPaint = entry.startTime
              this.logMetric('FirstPaint', this.metrics.firstPaint)
            }
            if (entry.name === 'first-contentful-paint') {
              this.metrics.firstContentfulPaint = entry.startTime
              this.logMetric('FirstContentfulPaint', this.metrics.firstContentfulPaint)
            }
          }
        })
        this.observer.observe({ type: 'paint', buffered: true })
      } catch (e) {
        // PerformanceObserver 可能在某些环境下不可用
        console.warn('[PerformanceMonitor] Paint timing not available')
      }
    }
  }

  /**
   * 记录指标日志
   */
  private logMetric(name: string, value: number | null): void {
    if (!this.config.enableLogging) return
    
    if (value !== null && value !== undefined) {
      console.log(`⏱️ [Performance] ${name}: ${value.toFixed(2)}ms`)
    }
  }

  /**
   * 计算可交互时间
   */
  private calculateTimeToInteractive(): void {
    if (this.metrics.domContentLoaded !== null && this.metrics.appInitialized !== null) {
      this.metrics.timeToInteractive = 
        this.metrics.appInitialized - this.metrics.domContentLoaded
    }
  }

  /**
   * 打印性能摘要
   */
  printSummary(): void {
    if (!this.config.enableLogging) return

    console.log('\n📊 [Performance Summary]')
    console.log('─'.repeat(40))
    
    if (this.metrics.firstPaint !== null) {
      console.log(`  First Paint:           ${this.metrics.firstPaint.toFixed(2)}ms`)
    }
    if (this.metrics.firstContentfulPaint !== null) {
      console.log(`  First Contentful Paint: ${this.metrics.firstContentfulPaint.toFixed(2)}ms`)
    }
    if (this.metrics.domContentLoaded !== null) {
      console.log(`  DOM Content Loaded:    ${this.metrics.domContentLoaded.toFixed(2)}ms`)
    }
    if (this.metrics.appInitialized !== null) {
      console.log(`  App Initialized:       ${this.metrics.appInitialized.toFixed(2)}ms`)
    }
    if (this.metrics.timeToInteractive !== null) {
      console.log(`  Time to Interactive:   ${this.metrics.timeToInteractive.toFixed(2)}ms`)
    }
    
    console.log('─'.repeat(40))
  }

  /**
   * 获取性能报告
   */
  getReport(): PerformanceReport {
    return {
      ...this.metrics,
      summary: {
        domToApp: this.metrics.timeToInteractive,
        total: this.metrics.appInitialized
      }
    }
  }

  /**
   * 获取当前指标
   */
  getMetrics(): Readonly<PerformanceMetrics> {
    return { ...this.metrics }
  }

  /**
   * 获取启动时间
   */
  getStartTime(): number {
    return this.startTime
  }

  /**
   * 手动记录自定义指标
   */
  recordCustomMetric(name: string, value?: number): void {
    const metricValue = value ?? performance.now()
    this.logMetric(name, metricValue)
  }

  /**
   * 销毁监控器
   */
  destroy(): void {
    if (this.observer) {
      this.observer.disconnect()
      this.observer = null
    }
  }
}

// ========================================
// 单例模式和 window 暴露（过渡期兼容）
// ========================================

let performanceMonitorInstance: PerformanceMonitor | null = null

/**
 * 获取 PerformanceMonitor 单例
 */
export function getPerformanceMonitor(config?: PerformanceMonitorConfig): PerformanceMonitor {
  if (!performanceMonitorInstance) {
    performanceMonitorInstance = new PerformanceMonitor(config)
  }
  return performanceMonitorInstance
}

/**
 * 创建新的 PerformanceMonitor 实例
 */
export function createPerformanceMonitor(config?: PerformanceMonitorConfig): PerformanceMonitor {
  return new PerformanceMonitor(config)
}

/**
 * 重置单例（仅用于测试）
 */
export function resetPerformanceMonitor(): void {
  if (performanceMonitorInstance) {
    performanceMonitorInstance.destroy()
    performanceMonitorInstance = null
  }
}

// ========================================
// 过渡期: 暴露到 window 供旧代码使用
// V16.3 - 添加废弃警告
// ========================================

declare global {
  interface Window {
    performanceMonitor: PerformanceMonitor
    PerformanceMonitorTS: typeof PerformanceMonitor
  }
}

let performanceMonitorDeprecationWarningShown = false

/**
 * 初始化并暴露到 window（过渡期）
 * V16.3: 添加废弃警告
 */
export function initPerformanceMonitorGlobal(): PerformanceMonitor {
  const monitor = getPerformanceMonitor()
  
  // 过渡期: 暴露到 window (带废弃警告)
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'performanceMonitor', {
      get() {
        if (!performanceMonitorDeprecationWarningShown && process.env.NODE_ENV !== 'production') {
          console.warn(
            '[DEPRECATED] window.performanceMonitor 已废弃。' +
            '请使用 Services.get("performanceMonitor") 或 import { getPerformanceMonitor } from "@/features/performance"'
          )
          performanceMonitorDeprecationWarningShown = true
        }
        return monitor
      },
      configurable: true
    })
    
    window.PerformanceMonitorTS = PerformanceMonitor
  }
  
  console.log('[V16.3] PerformanceMonitor TypeScript 版本已加载 (废弃警告已启用)')
  
  return monitor
}
