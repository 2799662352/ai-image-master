// src/renderer/src/utils/index.ts
/**
 * 工具函数导出索引
 */

// Toast 通知
export {
  showToast,
  ensureToastElement,
  toastSuccess,
  toastError,
  toastInfo,
  toastWarning
} from './toast'
export type { ToastType } from './toast'

// 格式化工具
export {
  formatFileSize,
  formatDate,
  formatRelativeTime,
  formatNumber,
  truncateText,
  formatDuration,
  formatPercent
} from './format'

// DOM 工具
export {
  getElement,
  getElementOrThrow,
  $,
  $$,
  on,
  off,
  toggleClass,
  show,
  hide,
  toggle,
  createElement,
  empty,
  ready,
  delay,
  debounce,
  throttle
} from './dom'

// 网络诊断工具
export {
  NetworkDiagnostics,
  getNetworkDiagnostics,
  createNetworkDiagnostics,
  quickNetworkCheck
} from './network-diagnostics'
export type {
  NetworkTestResult,
  DiagnosisReport,
  NetworkDiagnosticsConfig
} from './network-diagnostics'

// 剪贴板工具
export {
  ClipboardManager,
  getClipboardManager,
  createClipboardManager,
  copyToClipboard,
  pasteFromClipboard
} from './clipboard'
export type {
  ClipboardManagerConfig,
  PasteResult
} from './clipboard'

// V18: 延迟加载库
export {
  getJSZip,
  getImageCompression,
  preloadLibraries,
  isJSZipLoaded,
  isImageCompressionLoaded,
  getLibraryLoadStatus
} from './LazyLibraries'

// URL 验证工具
export {
  isValidImageUrl,
  isBase64DataUrl,
  isExternalUrl,
  isPendingUrl,
  isRemovedPlaceholder,
  filterValidImageUrls,
  getFirstValidThumbnail
} from './url-validator'
