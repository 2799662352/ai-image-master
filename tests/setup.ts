// tests/setup.ts - Vitest 测试设置

import { vi } from 'vitest'

// Mock Electron API
const mockElectronAPI = {
  isElectron: true,
  saveImage: vi.fn().mockResolvedValue({ success: true, path: '/mock/path' }),
  readImage: vi.fn().mockResolvedValue('data:image/png;base64,mock'),
  deleteImage: vi.fn().mockResolvedValue({ success: true }),
  saveHistory: vi.fn().mockResolvedValue({ success: true }),
  loadHistory: vi.fn().mockResolvedValue([]),
  getStorageInfo: vi.fn().mockResolvedValue({ imageCount: 0, totalSize: 0, storagePath: '/mock' }),
  selectSavePath: vi.fn().mockResolvedValue('/mock/save/path'),
  exportImage: vi.fn().mockResolvedValue({ success: true }),
  openPath: vi.fn().mockResolvedValue(undefined),
  savePageState: vi.fn().mockResolvedValue({ success: true }),
  loadPageState: vi.fn().mockResolvedValue(null),
  clearPageState: vi.fn().mockResolvedValue({ success: true }),
  clearAllPageStates: vi.fn().mockResolvedValue({ success: true }),
  getSavedPageIds: vi.fn().mockResolvedValue([]),
  clearWebCache: vi.fn().mockResolvedValue({ success: true }),
  getCacheSize: vi.fn().mockResolvedValue({ cacheSize: 0 }),
  saveTemplate: vi.fn().mockResolvedValue({ success: true }),
  saveTemplateOverride: vi.fn().mockResolvedValue({ success: true }),
  loadCustomTemplates: vi.fn().mockResolvedValue({}),
  loadTemplateOverrides: vi.fn().mockResolvedValue({}),
  deleteTemplate: vi.fn().mockResolvedValue({ success: true }),
  resetTemplateOverride: vi.fn().mockResolvedValue({ success: true }),
  exportTemplates: vi.fn().mockResolvedValue({ success: true }),
  importTemplates: vi.fn().mockResolvedValue({ success: true }),
  saveCustomGallery: vi.fn().mockResolvedValue({ success: true }),
  loadCustomGallery: vi.fn().mockResolvedValue([]),
  deleteCustomGalleryImage: vi.fn().mockResolvedValue({ success: true }),
  addCustomGalleryImage: vi.fn().mockResolvedValue({ success: true }),
  getCustomGalleryPath: vi.fn().mockResolvedValue('/mock/gallery')
}

// 设置全局 mock
Object.defineProperty(globalThis, 'window', {
  value: {
    electronAPI: mockElectronAPI,
    localStorage: {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      length: 0,
      key: vi.fn()
    },
    location: {
      hash: '',
      pathname: '/',
      href: 'http://localhost/',
      origin: 'http://localhost'
    },
    history: {
      pushState: vi.fn(),
      replaceState: vi.fn()
    },
    requestIdleCallback: vi.fn((cb) => setTimeout(cb, 0)),
    requestAnimationFrame: vi.fn((cb) => setTimeout(cb, 16)),
    cancelAnimationFrame: vi.fn(),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn().mockReturnValue(true),
    open: vi.fn().mockReturnValue(null)
  },
  writable: true
})

// Mock R2 Storage
const mockR2Storage = {
  init: vi.fn().mockResolvedValue(undefined),
  isAvailable: vi.fn().mockReturnValue(false),
  uploadBase64: vi.fn().mockResolvedValue({ success: true, url: 'https://mock.r2.url/image.png' }),
  uploadFromUrl: vi.fn().mockResolvedValue({ success: true, url: 'https://mock.r2.url/image.png' }),
  getImageInfo: vi.fn().mockResolvedValue(null),
  deleteImage: vi.fn().mockResolvedValue(true),
  batchDelete: vi.fn().mockResolvedValue(true),
  isR2Url: vi.fn().mockReturnValue(false),
  extractR2Key: vi.fn().mockReturnValue(null)
}

// Mock Version Checker
const mockVersionChecker = {
  init: vi.fn().mockResolvedValue(undefined),
  checkForUpdate: vi.fn().mockResolvedValue({ hasUpdate: false }),
  getLocalVersion: vi.fn().mockReturnValue({ version: '1.0.0' }),
  saveLocalVersion: vi.fn().mockReturnValue(true)
}

// 添加 window 上的全局对象
Object.assign((globalThis as any).window, {
  r2Storage: mockR2Storage,
  versionChecker: mockVersionChecker,
  storageBridge: {
    isElectron: true,
    saveHistory: vi.fn().mockResolvedValue({ success: true }),
    loadHistory: vi.fn().mockResolvedValue([]),
    getStorageInfo: vi.fn().mockResolvedValue({ imageCount: 0, totalSize: 0 })
  },
  aiImageAPI: {
    getCurrentModel: vi.fn().mockReturnValue({ name: 'Test Model' }),
    hasApiKey: vi.fn().mockReturnValue(false)
  }
})

// Mock fetch
global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({}),
  text: () => Promise.resolve('')
})

// Mock console methods to reduce noise in tests
vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})

// 导出 mock 供测试使用
export { mockElectronAPI, mockR2Storage, mockVersionChecker }
