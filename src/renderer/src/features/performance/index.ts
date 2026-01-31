/**
 * Performance Feature
 * V16.2 A1 - 性能监控模块
 * V18 - 性能仪表盘
 */

export {
  PerformanceMonitor,
  getPerformanceMonitor,
  createPerformanceMonitor,
  resetPerformanceMonitor,
  initPerformanceMonitorGlobal,
  type PerformanceMetrics,
  type PerformanceReport,
  type PerformanceMonitorConfig
} from './PerformanceMonitorService'

// V18: 性能仪表盘
export {
  PerformanceDashboard,
  getPerformanceDashboard,
  initPerformanceDashboard,
  resetPerformanceDashboard,
  type PerformanceMetric,
  type PerformanceDashboardConfig
} from './PerformanceDashboard'
