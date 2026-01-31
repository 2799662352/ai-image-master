// tests/fixtures/data.ts
/**
 * 共享测试数据
 * 
 * 提供一致的测试数据供单元测试和 E2E 测试使用
 */

// ============ 历史记录测试数据 ============

export interface TestHistoryItem {
  id: string
  type: 'text2img' | 'img2img' | 'batch'
  prompt: string
  urls: string[]
  timestamp: number
  model: string
  params?: {
    ratio?: string
    resolution?: string
    seed?: number
    negativePrompt?: string
  }
}

export const testHistoryItems: TestHistoryItem[] = [
  {
    id: 'hist-001',
    type: 'text2img',
    prompt: 'A beautiful sunset over the ocean with golden clouds',
    urls: ['https://example.com/images/sunset-001.png'],
    timestamp: Date.now() - 3600000, // 1 hour ago
    model: 'flux-schnell',
    params: {
      ratio: '16:9',
      resolution: '1K'
    }
  },
  {
    id: 'hist-002',
    type: 'text2img',
    prompt: 'Cyberpunk city at night with neon lights',
    urls: [
      'https://example.com/images/cyberpunk-001.png',
      'https://example.com/images/cyberpunk-002.png'
    ],
    timestamp: Date.now() - 7200000, // 2 hours ago
    model: 'flux-pro',
    params: {
      ratio: '1:1',
      resolution: '2K'
    }
  },
  {
    id: 'hist-003',
    type: 'img2img',
    prompt: 'Transform into anime style',
    urls: ['https://example.com/images/anime-001.png'],
    timestamp: Date.now() - 86400000, // 1 day ago
    model: 'seedream',
    params: {
      ratio: '1:1',
      resolution: '1K'
    }
  },
  {
    id: 'hist-004',
    type: 'batch',
    prompt: 'Mountain landscape in autumn',
    urls: [
      'https://example.com/images/mountain-001.png',
      'https://example.com/images/mountain-002.png',
      'https://example.com/images/mountain-003.png'
    ],
    timestamp: Date.now() - 172800000, // 2 days ago
    model: 'flux-schnell',
    params: {
      ratio: '3:2',
      resolution: '1K'
    }
  },
  {
    id: 'hist-005',
    type: 'text2img',
    prompt: 'Abstract art with vibrant colors',
    urls: ['https://example.com/images/abstract-001.png'],
    timestamp: Date.now() - 259200000, // 3 days ago
    model: 'gemini-imagen',
    params: {
      ratio: '1:1',
      resolution: '2K'
    }
  }
]

// ============ 模型测试数据 ============

export interface TestModel {
  key: string
  name: string
  provider: string
  capabilities: {
    multipleImages: boolean
    img2img: boolean
    inpainting: boolean
    intelligentResize?: boolean
  }
  ratios: string[]
  resolutions: string[]
  maxBatchCount?: number
}

export const testModels: TestModel[] = [
  {
    key: 'flux-schnell',
    name: 'Flux Schnell',
    provider: 'black-forest-labs',
    capabilities: {
      multipleImages: true,
      img2img: true,
      inpainting: false
    },
    ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2'],
    resolutions: ['1K', '2K'],
    maxBatchCount: 4
  },
  {
    key: 'flux-pro',
    name: 'Flux Pro',
    provider: 'black-forest-labs',
    capabilities: {
      multipleImages: true,
      img2img: true,
      inpainting: true
    },
    ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2'],
    resolutions: ['1K', '2K', '4K'],
    maxBatchCount: 4
  },
  {
    key: 'seedream',
    name: 'Seedream 3.0',
    provider: 'bytedance',
    capabilities: {
      multipleImages: false,
      img2img: false,
      inpainting: false
    },
    ratios: ['1:1', '16:9', '9:16'],
    resolutions: ['1K', '2K'],
    maxBatchCount: 15
  },
  {
    key: 'gemini-imagen',
    name: 'Gemini Imagen 3',
    provider: 'google',
    capabilities: {
      multipleImages: true,
      img2img: false,
      inpainting: false,
      intelligentResize: true
    },
    ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    resolutions: ['1K', '2K'],
    maxBatchCount: 4
  }
]

// ============ 站点配置测试数据 ============

export interface TestSite {
  key: string
  name: string
  apiEndpoint: string
  apiKeyPattern?: RegExp
}

export const testSites: TestSite[] = [
  {
    key: 'siliconflow',
    name: 'SiliconFlow',
    apiEndpoint: 'https://api.siliconflow.cn',
    apiKeyPattern: /^sk-[a-zA-Z0-9]{48}$/
  },
  {
    key: 'replicate',
    name: 'Replicate',
    apiEndpoint: 'https://api.replicate.com',
    apiKeyPattern: /^r8_[a-zA-Z0-9]{37}$/
  }
]

// ============ 用户设置测试数据 ============

export interface TestUserSettings {
  apiKey?: string
  site: string
  language: string
  theme: 'light' | 'dark' | 'auto'
  defaultModel: string
  defaultRatio: string
  defaultResolution: string
}

export const testUserSettings: TestUserSettings = {
  apiKey: 'sk-test-key-for-testing-purposes-only-12345678',
  site: 'siliconflow',
  language: 'zh-CN',
  theme: 'dark',
  defaultModel: 'flux-schnell',
  defaultRatio: '1:1',
  defaultResolution: '1K'
}

// ============ API 响应测试数据 ============

export interface TestApiResponse {
  success: boolean
  data?: {
    images: string[]
    seed?: number
    timing?: number
  }
  error?: {
    code: string
    message: string
  }
}

export const testApiResponses = {
  success: {
    success: true,
    data: {
      images: ['https://example.com/generated/image-001.png'],
      seed: 12345,
      timing: 2500
    }
  } as TestApiResponse,
  
  rateLimited: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: '请求过于频繁，请稍后再试'
    }
  } as TestApiResponse,
  
  invalidApiKey: {
    success: false,
    error: {
      code: 'INVALID_API_KEY',
      message: 'API Key 无效或已过期'
    }
  } as TestApiResponse,
  
  insufficientBalance: {
    success: false,
    error: {
      code: 'INSUFFICIENT_BALANCE',
      message: '账户余额不足'
    }
  } as TestApiResponse,
  
  networkError: {
    success: false,
    error: {
      code: 'NETWORK_ERROR',
      message: '网络连接失败，请检查网络设置'
    }
  } as TestApiResponse,
  
  timeout: {
    success: false,
    error: {
      code: 'TIMEOUT',
      message: '请求超时，请重试'
    }
  } as TestApiResponse
}

// ============ 提示词模板测试数据 ============

export interface TestPromptTemplate {
  id: string
  name: string
  category: string
  prompt: string
  tags: string[]
}

export const testPromptTemplates: TestPromptTemplate[] = [
  {
    id: 'template-001',
    name: '赛博朋克城市',
    category: '科幻',
    prompt: 'Cyberpunk cityscape at night, neon lights, rain, highly detailed, 8k',
    tags: ['cyberpunk', 'city', 'night', 'neon']
  },
  {
    id: 'template-002',
    name: '日落风景',
    category: '自然',
    prompt: 'Beautiful sunset over the ocean, golden hour, dramatic clouds, peaceful',
    tags: ['sunset', 'ocean', 'nature', 'peaceful']
  },
  {
    id: 'template-003',
    name: '人物肖像',
    category: '人物',
    prompt: 'Professional portrait, soft lighting, bokeh background, high quality',
    tags: ['portrait', 'professional', 'lighting']
  }
]

// ============ 错误消息测试数据 ============

export const testErrorMessages = {
  validation: {
    emptyPrompt: '请输入提示词',
    promptTooLong: '提示词过长，请精简内容',
    invalidApiKey: '请输入有效的 API Key',
    invalidRatio: '无效的比例选项'
  },
  api: {
    networkError: '网络连接失败，请检查网络设置',
    timeout: '请求超时，请重试',
    rateLimited: '请求过于频繁，请稍后再试',
    serverError: '服务器错误，请稍后再试'
  },
  storage: {
    saveError: '保存失败，请重试',
    loadError: '加载数据失败',
    quotaExceeded: '存储空间不足'
  }
}
