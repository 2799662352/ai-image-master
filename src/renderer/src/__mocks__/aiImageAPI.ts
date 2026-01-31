/**
 * Mock AI Image API for testing
 * 
 * This mock provides a minimal implementation of the AI Image API
 * that can be used in Vitest tests without requiring an actual API connection.
 * 
 * Usage in tests:
 * ```typescript
 * vi.mock('@renderer/__mocks__/aiImageAPI')
 * ```
 */

import { vi } from 'vitest'

// 模拟模型配置
export const mockModels = {
  'flux-1.1-pro': {
    name: 'Flux 1.1 Pro',
    key: 'flux-1.1-pro',
    ratios: [
      { key: '1:1', label: '1:1', width: 1024, height: 1024 },
      { key: '16:9', label: '16:9', width: 1024, height: 576 },
      { key: '9:16', label: '9:16', width: 576, height: 1024 }
    ],
    capabilities: {
      multipleImages: true,
      customSize: true,
      intelligentResize: false,
      referenceImage: true,
      maxReferenceImages: 3
    }
  },
  'seedream-3.0': {
    name: 'Seedream 3.0',
    key: 'seedream-3.0',
    ratios: [
      { key: '1:1', label: '1:1', width: 1024, height: 1024 }
    ],
    capabilities: {
      multipleImages: false,
      customSize: false,
      intelligentResize: true,
      referenceImage: false
    }
  }
}

export const mockAiImageAPI = {
  // 模型管理
  model: 'flux-1.1-pro',
  getModels: vi.fn().mockReturnValue(mockModels),
  getCurrentModel: vi.fn().mockReturnValue(mockModels['flux-1.1-pro']),
  saveModel: vi.fn().mockReturnValue(true),
  setModel: vi.fn(),
  
  // API Key 管理
  hasApiKey: vi.fn().mockReturnValue(true),
  setApiKey: vi.fn(),
  getApiKey: vi.fn().mockReturnValue('mock-api-key'),
  validateApiKey: vi.fn().mockResolvedValue(true),
  
  // 图片生成
  generateImage: vi.fn().mockResolvedValue({
    success: true,
    images: ['https://mock.url/image1.png'],
    prompt: 'test prompt'
  }),
  batchGenerate: vi.fn().mockResolvedValue({
    success: true,
    images: ['https://mock.url/image1.png', 'https://mock.url/image2.png'],
    prompt: 'test prompt'
  }),
  
  // 图片操作
  downloadImage: vi.fn().mockResolvedValue({ success: true }),
  downloadImagesAsZip: vi.fn().mockResolvedValue({ success: true, message: '下载完成' }),
  
  // 任务状态
  getTaskStatus: vi.fn().mockResolvedValue({ status: 'completed' }),
  cancelTask: vi.fn().mockResolvedValue({ success: true }),
  
  // 网络
  markUrlAsUserAccessible: vi.fn()
}

/**
 * Setup function to install the mock on window.aiImageAPI
 */
export function setupAiImageAPIMock(): void {
  Object.defineProperty(window, 'aiImageAPI', {
    value: mockAiImageAPI,
    writable: true,
    configurable: true
  })
}

/**
 * Cleanup function to reset all mocks
 */
export function resetAiImageAPIMock(): void {
  Object.values(mockAiImageAPI).forEach(mock => {
    if (typeof mock === 'function' && 'mockReset' in mock) {
      (mock as ReturnType<typeof vi.fn>).mockReset()
    }
  })
  
  // 恢复默认返回值
  mockAiImageAPI.getModels.mockReturnValue(mockModels)
  mockAiImageAPI.getCurrentModel.mockReturnValue(mockModels['flux-1.1-pro'])
  mockAiImageAPI.saveModel.mockReturnValue(true)
  mockAiImageAPI.hasApiKey.mockReturnValue(true)
}

export default mockAiImageAPI
