/**
 * Mock ServiceBridge for testing
 * 
 * This mock provides a minimal implementation of ServiceBridge
 * that can be used in Vitest tests without full initialization.
 * 
 * Usage in tests:
 * ```typescript
 * vi.mock('@renderer/services/ServiceBridge')
 * ```
 */

import { vi } from 'vitest'

// Mock service instances
export const mockStorageBridge = {
  loadHistory: vi.fn().mockResolvedValue([]),
  saveHistory: vi.fn().mockResolvedValue(true),
  get: vi.fn().mockReturnValue(null),
  set: vi.fn(),
  delete: vi.fn()
}

export const mockI18nService = {
  init: vi.fn().mockResolvedValue(undefined),
  t: vi.fn((key: string) => key),
  setLocale: vi.fn(),
  getLocale: vi.fn().mockReturnValue('zh-CN'),
  on: vi.fn()
}

export const mockApiService = {
  request: vi.fn().mockResolvedValue({ success: true }),
  get: vi.fn().mockResolvedValue({}),
  post: vi.fn().mockResolvedValue({})
}

export const mockHistoryDataService = {
  init: vi.fn().mockResolvedValue(undefined),
  getAll: vi.fn().mockReturnValue([]),
  addToHistory: vi.fn().mockResolvedValue({ id: 'mock-id' }),
  clearOldHistory: vi.fn().mockResolvedValue(0),
  getStorageStats: vi.fn().mockReturnValue({
    historySize: 0,
    historyCount: 0,
    totalSize: 0,
    estimatedLimit: 5120,
    r2Enabled: false,
    storageMode: 'local'
  })
}

export const mockToastManager = {
  show: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}

export const mockErrorHandler = {
  handle: vi.fn(),
  getRejectionTypeName: vi.fn((type: string) => type),
  showNetworkTestResults: vi.fn(),
  showNanoBananaFAQ: vi.fn(),
  formatErrorForCopy: vi.fn().mockReturnValue('')
}

// Mock ServiceBridge configuration
export const mockServiceBridgeConfig = {
  useTypescriptServices: true,
  exposeUtilFunctions: true,
  onReady: vi.fn()
}

// Mock initialization function
export const initServiceBridge = vi.fn().mockResolvedValue(undefined)

// Mock ready check
export const isServiceBridgeReady = vi.fn().mockReturnValue(true)

// Mock auto getters
export const getStorageBridgeAuto = vi.fn().mockReturnValue(mockStorageBridge)
export const getI18nServiceAuto = vi.fn().mockReturnValue(mockI18nService)
export const getHistoryDataServiceAuto = vi.fn().mockReturnValue(mockHistoryDataService)

// Mock translation shortcut
export const t = vi.fn((key: string) => key)

/**
 * Setup function to configure ServiceBridge mocks
 */
export function setupServiceBridgeMock(): void {
  // Set up window globals that ServiceBridge would normally create
  Object.defineProperty(window, '__serviceBridgeInitialized', {
    value: true,
    writable: true,
    configurable: true
  })
  
  Object.defineProperty(window, 'storageBridgeTS', {
    value: mockStorageBridge,
    writable: true,
    configurable: true
  })
  
  Object.defineProperty(window, 'i18nServiceTS', {
    value: mockI18nService,
    writable: true,
    configurable: true
  })
  
  Object.defineProperty(window, 'historyDataServiceTS', {
    value: mockHistoryDataService,
    writable: true,
    configurable: true
  })
  
  Object.defineProperty(window, 'toastManagerTS', {
    value: mockToastManager,
    writable: true,
    configurable: true
  })
  
  Object.defineProperty(window, 'errorHandlerTS', {
    value: mockErrorHandler,
    writable: true,
    configurable: true
  })
}

/**
 * Reset all ServiceBridge mocks
 */
export function resetServiceBridgeMock(): void {
  initServiceBridge.mockReset()
  isServiceBridgeReady.mockReset().mockReturnValue(true)
  
  // Reset all mock objects
  const allMocks = [
    mockStorageBridge,
    mockI18nService,
    mockApiService,
    mockHistoryDataService,
    mockToastManager,
    mockErrorHandler
  ]
  
  allMocks.forEach(mockObj => {
    Object.values(mockObj).forEach(mock => {
      if (typeof mock === 'function' && 'mockReset' in mock) {
        (mock as ReturnType<typeof vi.fn>).mockReset()
      }
    })
  })
}

export default {
  initServiceBridge,
  isServiceBridgeReady,
  getStorageBridgeAuto,
  getI18nServiceAuto,
  getHistoryDataServiceAuto,
  t,
  setupServiceBridgeMock,
  resetServiceBridgeMock
}
