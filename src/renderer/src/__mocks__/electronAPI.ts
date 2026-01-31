/**
 * Mock Electron API for testing
 * 
 * This mock provides a minimal implementation of the Electron API
 * that can be used in Vitest tests without requiring an actual Electron environment.
 * 
 * Usage in tests:
 * ```typescript
 * vi.mock('@renderer/__mocks__/electronAPI')
 * ```
 */

import { vi } from 'vitest'

export const mockElectronAPI = {
  // 图片操作
  saveImage: vi.fn().mockResolvedValue({ success: true, path: '/mock/path/image.png' }),
  readImage: vi.fn().mockResolvedValue('data:image/png;base64,mockBase64Data'),
  deleteImage: vi.fn().mockResolvedValue({ success: true }),
  exportImage: vi.fn().mockResolvedValue({ success: true, path: '/mock/export/path' }),
  
  // 历史记录
  saveHistory: vi.fn().mockResolvedValue({ success: true }),
  loadHistory: vi.fn().mockResolvedValue([]),
  
  // 存储信息
  getStorageInfo: vi.fn().mockResolvedValue({
    imageCount: 0,
    totalSize: 0,
    storagePath: '/mock/user/data'
  }),
  
  // 文件对话框
  selectSavePath: vi.fn().mockResolvedValue('/mock/selected/path'),
  openPath: vi.fn().mockResolvedValue(undefined),
  
  // 页面状态
  savePageState: vi.fn().mockResolvedValue({ success: true }),
  loadPageState: vi.fn().mockResolvedValue(null),
  clearPageState: vi.fn().mockResolvedValue({ success: true }),
  clearAllPageStates: vi.fn().mockResolvedValue({ success: true }),
  getSavedPageIds: vi.fn().mockResolvedValue([]),
  
  // 缓存
  clearWebCache: vi.fn().mockResolvedValue({ success: true }),
  getCacheSize: vi.fn().mockResolvedValue({ cacheSize: 0 }),
  
  // 模板
  saveTemplate: vi.fn().mockResolvedValue({ success: true }),
  saveTemplateOverride: vi.fn().mockResolvedValue({ success: true }),
  loadCustomTemplates: vi.fn().mockResolvedValue({}),
  loadTemplateOverrides: vi.fn().mockResolvedValue({}),
  deleteTemplate: vi.fn().mockResolvedValue({ success: true }),
  resetTemplateOverride: vi.fn().mockResolvedValue({ success: true }),
  exportTemplates: vi.fn().mockResolvedValue({ success: true, path: '/mock/templates.json' }),
  importTemplates: vi.fn().mockResolvedValue({ success: true, imported: { templates: 0, overrides: 0 } }),
  
  // 自定义图库
  getCustomGalleryPath: vi.fn().mockResolvedValue('/mock/gallery'),
  addCustomGalleryImage: vi.fn().mockResolvedValue({ success: true, filename: 'mock.png' }),
  saveCustomGallery: vi.fn().mockResolvedValue({ success: true }),
  loadCustomGallery: vi.fn().mockResolvedValue([]),
  deleteCustomGalleryImage: vi.fn().mockResolvedValue({ success: true }),
  
  // 自动更新
  checkForUpdates: vi.fn().mockResolvedValue(undefined),
  downloadUpdate: vi.fn().mockResolvedValue(undefined),
  quitAndInstall: vi.fn().mockResolvedValue(undefined),
  onUpdateAvailable: vi.fn(),
  onDownloadProgress: vi.fn(),
  onUpdateDownloaded: vi.fn()
}

/**
 * Setup function to install the mock on window.electronAPI
 */
export function setupElectronAPIMock(): void {
  Object.defineProperty(window, 'electronAPI', {
    value: mockElectronAPI,
    writable: true,
    configurable: true
  })
}

/**
 * Cleanup function to reset all mocks
 */
export function resetElectronAPIMock(): void {
  Object.values(mockElectronAPI).forEach(mock => {
    if (typeof mock === 'function' && 'mockReset' in mock) {
      (mock as ReturnType<typeof vi.fn>).mockReset()
    }
  })
}

export default mockElectronAPI
