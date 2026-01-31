/**
 * Central mocks index
 * 
 * Import all mocks from this file for consistent test setup.
 * 
 * Usage in tests/setup.ts:
 * ```typescript
 * import { setupAllMocks, resetAllMocks } from '@renderer/__mocks__'
 * 
 * beforeEach(() => {
 *   setupAllMocks()
 * })
 * 
 * afterEach(() => {
 *   resetAllMocks()
 * })
 * ```
 */

export {
  mockElectronAPI,
  setupElectronAPIMock,
  resetElectronAPIMock
} from './electronAPI'

export {
  mockAiImageAPI,
  mockModels,
  setupAiImageAPIMock,
  resetAiImageAPIMock
} from './aiImageAPI'

// Re-export ServiceBridge mocks for convenience
export {
  mockStorageBridge,
  mockI18nService,
  mockApiService,
  mockHistoryDataService,
  mockToastManager,
  mockErrorHandler,
  setupServiceBridgeMock,
  resetServiceBridgeMock
} from '../services/__mocks__/ServiceBridge'

/**
 * Setup all mocks at once
 */
export function setupAllMocks(): void {
  const { setupElectronAPIMock } = require('./electronAPI')
  const { setupAiImageAPIMock } = require('./aiImageAPI')
  const { setupServiceBridgeMock } = require('../services/__mocks__/ServiceBridge')
  
  setupElectronAPIMock()
  setupAiImageAPIMock()
  setupServiceBridgeMock()
}

/**
 * Reset all mocks at once
 */
export function resetAllMocks(): void {
  const { resetElectronAPIMock } = require('./electronAPI')
  const { resetAiImageAPIMock } = require('./aiImageAPI')
  const { resetServiceBridgeMock } = require('../services/__mocks__/ServiceBridge')
  
  resetElectronAPIMock()
  resetAiImageAPIMock()
  resetServiceBridgeMock()
}
