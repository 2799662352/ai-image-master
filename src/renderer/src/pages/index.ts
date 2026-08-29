// src/renderer/src/pages/index.ts
/**
 * 页面模块导出
 * 
 * 性能优化策略:
 * - 首屏页面 (GeneratePage): 静态导入，立即可用
 * - 非首屏页面: 提供动态导入函数，按需加载
 * 
 * 使用方式:
 * - 静态导入: import { GeneratePage } from '@pages'
 * - 动态导入: const { HistoryPage } = await loadHistoryPage()
 * 
 * ⚠️ 注意: src/services/ 和 src/features/ 下的文件不应从此 barrel 导入，
 * 应直接导入具体页面文件 (如 from '../pages/UnderstandPage')，
 * 以避免循环 chunk 依赖 (V18: ServiceBridge 已改为直接导入)
 */

// Base - 所有页面都需要
export { BasePage } from './BasePage'
export type { PageState, UploadConfig, AppInterface } from './BasePage'

// ========== 首屏页面: 静态导入 ==========

// GeneratePage - 首屏，必须立即可用
export { GeneratePage, createGeneratePage, getGeneratePage } from './GeneratePage'
export type { ReferenceImage, GeneratePageState, ProgressToast, GenerateResult, ImageDimensions } from './GeneratePage'

// ========== 非首屏页面: 静态导出 (向后兼容) ==========
// 注意: 这些静态导出会导致页面在首次访问 index.ts 时全部加载
// 建议使用下方的动态导入函数以获得更好的性能

// HistoryPage
export { HistoryPage, createHistoryPage, getHistoryPage } from './HistoryPage'
export type { HistoryItem, StorageInfo } from './HistoryPage'

// BatchPage
export { BatchPage, createBatchPage, getBatchPage } from './BatchPage'
export type { BatchMode, BatchReferenceImage, BatchResult, BatchPageState } from './BatchPage'

// ComparePage(UI 已被 AudioPage 替换,代码暂留未注册)
export { ComparePage, createComparePage, getComparePage } from './ComparePage'
export type { CompareReferenceImage, CompareModel, CompareResult, ComparisonData, ComparePageState } from './ComparePage'

// AudioPage(音频生成,seed-audio-1.0,占用原 compare tab 位)
export { AudioPage, createAudioPage, getAudioPage } from './AudioPage'

// PromptTemplates
export { PromptTemplates, createPromptTemplates, getPromptTemplates } from './PromptTemplates'
export type { PromptTemplate, TemplateCategories, PromptTemplatesState } from './PromptTemplates'

// UnderstandPage
export { UnderstandPage, createUnderstandPage, getUnderstandPage } from './UnderstandPage'
export type { UploadedImage, VisionModel, ModelConfig, AnalysisRole, RoleConfig, UnderstandPageState } from './UnderstandPage'

// DirectorPage 不在此导出: vanilla 的 pages/DirectorPage.ts 已随 Director V2
// 一起删除(commit 21d6574e),现由 pages-react/DirectorPage.tsx 接管。React 版是
// 默认导出的组件,形状与本 barrel 的 create*/get* 工厂约定不同,不能在此转发。

// ========== 动态导入函数: 按需加载 (推荐) ==========

/**
 * 动态加载 HistoryPage
 * @example
 * const historyModule = await loadHistoryPage()
 * const page = historyModule.createHistoryPage(app)
 */
export const loadHistoryPage = () => import('./HistoryPage')

/**
 * 动态加载 BatchPage
 */
export const loadBatchPage = () => import('./BatchPage')

/**
 * 动态加载 ComparePage
 */
export const loadComparePage = () => import('./ComparePage')

/**
 * 动态加载 PromptTemplates
 */
export const loadPromptTemplates = () => import('./PromptTemplates')

/**
 * 动态加载 UnderstandPage
 */
export const loadUnderstandPage = () => import('./UnderstandPage')

// ========== 页面加载状态管理 ==========

/** 页面加载状态缓存 */
const pageLoadCache = new Map<string, Promise<any>>()

/**
 * 带缓存的页面加载器
 * 避免重复加载同一页面
 */
export async function loadPageWithCache<T>(
  pageName: string,
  loader: () => Promise<T>
): Promise<T> {
  if (!pageLoadCache.has(pageName)) {
    pageLoadCache.set(pageName, loader())
  }
  return pageLoadCache.get(pageName) as Promise<T>
}

/**
 * 预加载指定页面 (用于空闲时预热)
 */
export function preloadPage(pageName: 'history' | 'batch' | 'compare' | 'promptTemplates' | 'understand'): void {
  const loaders: Record<string, () => Promise<any>> = {
    history: loadHistoryPage,
    batch: loadBatchPage,
    compare: loadComparePage,
    promptTemplates: loadPromptTemplates,
    understand: loadUnderstandPage
  }
  
  const loader = loaders[pageName]
  if (loader && !pageLoadCache.has(pageName)) {
    // 使用 requestIdleCallback 在空闲时预加载
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => {
        loadPageWithCache(pageName, loader)
      }, { timeout: 5000 })
    } else {
      setTimeout(() => loadPageWithCache(pageName, loader), 1000)
    }
  }
}

/**
 * 预加载所有非首屏页面 (用于首屏渲染完成后)
 */
export function preloadAllPages(): void {
  const pages: Array<'history' | 'batch' | 'compare' | 'promptTemplates' | 'understand'> = [
    'history', 'batch', 'compare', 'promptTemplates', 'understand'
  ]
  pages.forEach(preloadPage)
}
