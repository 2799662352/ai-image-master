// src/renderer/src/features/index.ts
/**
 * 功能模块导出索引
 */

export { ModelSelector, createModelSelector } from './model-selector'
export type { ModelInfo, ModelSelectorOptions } from './model-selector'

export { ImageViewer, getImageViewer, createImageViewer } from './image-viewer'
export type { ImageViewerOptions } from './image-viewer'

export { ImageOperations, getImageOperations, createImageOperations } from './image-viewer'
export type {
  ImageOperationsConfig,
  HistoryItemLike,
  DownloadResult,
  BatchDownloadProgress
} from './image-viewer'

export { Settings, createSettings } from './settings'
export type { SettingsOptions } from './settings'

export { HistoryManager, getHistoryManager, createHistoryManager } from './history'
export type { HistoryItem, HistoryMetadata, HistoryManagerConfig, HistoryChangeCallback } from './history'

export { HistoryDataService, getHistoryDataService, createHistoryDataService } from './history'
export type { StorageStats, HistoryDataServiceConfig, UploadProgressCallback } from './history'

export { DialogManager, getDialogManager, createDialogManager } from './dialog'
export type { DialogConfig, DialogElements } from './dialog'

export { ErrorHandler, getErrorHandler, createErrorHandler } from './error-handler'
export type { ErrorInfo, NetworkTestResults, ErrorHandlerConfig } from './error-handler'

export { MobileMenuManager, getMobileMenuManager, createMobileMenuManager } from './mobile-menu'
export type { MobileMenuConfig } from './mobile-menu'

export {
  ModelSelectorManager,
  getModelSelectorManager,
  createModelSelectorManager
} from './model-selector'
export type {
  RatioOption,
  ResolutionOption,
  ModelConfig,
  ModelSelectorManagerConfig,
  PageReference as ModelSelectorPageReference
} from './model-selector'

export { SiteManager, getSiteManager, createSiteManager } from './settings'
export type { SiteConfig, SiteManagerConfig } from './settings'

export {
  IntelligentResizeManager,
  getIntelligentResizeManager,
  createIntelligentResizeManager
} from './intelligent-resize'
export type {
  ImageData,
  OutputSize,
  PageReference as IntelligentResizePageReference,
  IntelligentResizeConfig
} from './intelligent-resize'

export { UIStateManager, getUIStateManager, createUIStateManager } from './ui-state'
export type { SelectorConfig, UIStateManagerConfig } from './ui-state'

export { TabManager, getTabManager, createTabManager } from './tab-manager'
export type { PageModule, TabManagerConfig, TabChangeCallback } from './tab-manager'

export { KeyboardShortcuts, getKeyboardShortcuts, createKeyboardShortcuts } from './keyboard'
export type {
  PageActions,
  KeyboardShortcutsConfig,
  ShortcutHandler,
  PasteHandler
} from './keyboard'

export { LanguageManager, getLanguageManager, createLanguageManager } from './language'
export type {
  I18nService,
  LanguageManagerConfig,
  LanguageChangeEvent
} from './language'

export {
  AccessibilityManager,
  getAccessibilityManager,
  createAccessibilityManager
} from './accessibility'
export type {
  AccessibilityConfig,
  FocusTrapOptions
} from './accessibility'

export {
  RatioResolutionManager,
  getRatioResolutionManager,
  createRatioResolutionManager
} from './model-selector'
export type { RatioResolutionConfig } from './model-selector'

export {
  NetworkDiagnosticsModal,
  getNetworkDiagnosticsModal,
  createNetworkDiagnosticsModal
} from './error-handler'
export type {
  NetworkRestrictedInfo,
  NetworkDiagnosticsConfig
} from './error-handler'

// V16.1.2 - Intro Video Controller
export {
  IntroVideoController,
  getIntroVideoController,
  initIntroVideo,
  resetIntroVideoController
} from './intro-video'
export type {
  IntroVideoConfig,
  IntroVideoState
} from './intro-video'

// V16.2 A1 - Performance Monitor
export {
  PerformanceMonitor,
  getPerformanceMonitor,
  createPerformanceMonitor,
  resetPerformanceMonitor,
  initPerformanceMonitorGlobal
} from './performance'
export type {
  PerformanceMetrics,
  PerformanceReport,
  PerformanceMonitorConfig
} from './performance'

// V18 - Performance Dashboard
export {
  PerformanceDashboard,
  getPerformanceDashboard,
  initPerformanceDashboard,
  resetPerformanceDashboard
} from './performance'
export type {
  PerformanceMetric,
  PerformanceDashboardConfig
} from './performance'

// V16.2 A2 - UI Components
export {
  UIComponents,
  getUIComponents,
  createUIComponents,
  resetUIComponents,
  initUIComponentsGlobal
} from './ui-components'
export type {
  ImageCardAction,
  GalleryImage,
  UIComponentsConfig
} from './ui-components'

// V17 - Update Notification
export {
  UpdateNotification,
  getUpdateNotification,
  createUpdateNotification,
  resetUpdateNotification,
  initUpdateNotificationGlobal
} from './updater'
export type {
  UpdateNotificationConfig,
  UpdateInfo,
  DownloadProgress
} from './updater'
