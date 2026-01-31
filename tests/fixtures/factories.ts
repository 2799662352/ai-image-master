// tests/fixtures/factories.ts
/**
 * Mock 数据工厂
 * 
 * 提供创建测试数据的工厂函数，支持自定义覆盖
 */

import type { TestHistoryItem, TestModel, TestApiResponse, TestPromptTemplate } from './data'

// ============ 计数器和 ID 生成 ============

let idCounter = 0

function generateId(prefix: string = 'test'): string {
  return `${prefix}-${++idCounter}-${Date.now()}`
}

function resetIdCounter(): void {
  idCounter = 0
}

// ============ 历史记录工厂 ============

interface CreateHistoryItemOptions extends Partial<TestHistoryItem> {}

function createHistoryItem(overrides: CreateHistoryItemOptions = {}): TestHistoryItem {
  return {
    id: generateId('hist'),
    type: 'text2img',
    prompt: 'Test prompt for unit testing',
    urls: ['https://example.com/test-image.png'],
    timestamp: Date.now(),
    model: 'flux-schnell',
    params: {
      ratio: '1:1',
      resolution: '1K'
    },
    ...overrides
  }
}

function createHistoryItems(count: number, overrides: CreateHistoryItemOptions = {}): TestHistoryItem[] {
  return Array.from({ length: count }, (_, index) => 
    createHistoryItem({
      id: generateId('hist'),
      prompt: `Test prompt ${index + 1}`,
      timestamp: Date.now() - index * 3600000, // 每条相隔 1 小时
      ...overrides
    })
  )
}

// ============ 模型工厂 ============

interface CreateModelOptions extends Partial<TestModel> {}

function createModel(overrides: CreateModelOptions = {}): TestModel {
  return {
    key: generateId('model'),
    name: 'Test Model',
    provider: 'test-provider',
    capabilities: {
      multipleImages: true,
      img2img: false,
      inpainting: false
    },
    ratios: ['1:1', '16:9', '9:16'],
    resolutions: ['1K', '2K'],
    maxBatchCount: 4,
    ...overrides
  }
}

// ============ API 响应工厂 ============

interface CreateApiResponseOptions {
  success?: boolean
  images?: string[]
  seed?: number
  timing?: number
  errorCode?: string
  errorMessage?: string
}

function createApiResponse(options: CreateApiResponseOptions = {}): TestApiResponse {
  const { 
    success = true, 
    images = ['https://example.com/generated.png'],
    seed = Math.floor(Math.random() * 1000000),
    timing = 2000,
    errorCode,
    errorMessage
  } = options

  if (success) {
    return {
      success: true,
      data: { images, seed, timing }
    }
  } else {
    return {
      success: false,
      error: {
        code: errorCode || 'ERROR',
        message: errorMessage || 'An error occurred'
      }
    }
  }
}

function createSuccessResponse(images: string[] = ['https://example.com/image.png']): TestApiResponse {
  return createApiResponse({ success: true, images })
}

function createErrorResponse(code: string, message: string): TestApiResponse {
  return createApiResponse({ success: false, errorCode: code, errorMessage: message })
}

// ============ 提示词模板工厂 ============

interface CreatePromptTemplateOptions extends Partial<TestPromptTemplate> {}

function createPromptTemplate(overrides: CreatePromptTemplateOptions = {}): TestPromptTemplate {
  return {
    id: generateId('template'),
    name: 'Test Template',
    category: 'test',
    prompt: 'A test prompt template for unit testing',
    tags: ['test', 'template'],
    ...overrides
  }
}

// ============ 图片数据工厂 ============

interface ImageData {
  id: string
  url: string
  width: number
  height: number
  size: number
  format: string
  createdAt: number
}

interface CreateImageDataOptions extends Partial<ImageData> {}

function createImageData(overrides: CreateImageDataOptions = {}): ImageData {
  return {
    id: generateId('img'),
    url: 'https://example.com/image.png',
    width: 1024,
    height: 1024,
    size: 1048576, // 1MB
    format: 'png',
    createdAt: Date.now(),
    ...overrides
  }
}

// ============ 用户会话工厂 ============

interface UserSession {
  id: string
  userId: string
  apiKey: string
  site: string
  createdAt: number
  lastActiveAt: number
}

interface CreateUserSessionOptions extends Partial<UserSession> {}

function createUserSession(overrides: CreateUserSessionOptions = {}): UserSession {
  const now = Date.now()
  return {
    id: generateId('session'),
    userId: generateId('user'),
    apiKey: 'sk-test-' + Math.random().toString(36).substring(2, 15),
    site: 'siliconflow',
    createdAt: now,
    lastActiveAt: now,
    ...overrides
  }
}

// ============ 任务队列项工厂 ============

interface QueueItem {
  id: string
  type: 'generate' | 'batch' | 'img2img'
  status: 'pending' | 'processing' | 'completed' | 'failed'
  prompt: string
  model: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  result?: {
    images: string[]
    seed: number
  }
  error?: string
}

interface CreateQueueItemOptions extends Partial<QueueItem> {}

function createQueueItem(overrides: CreateQueueItemOptions = {}): QueueItem {
  return {
    id: generateId('queue'),
    type: 'generate',
    status: 'pending',
    prompt: 'Test generation prompt',
    model: 'flux-schnell',
    createdAt: Date.now(),
    ...overrides
  }
}

// ============ DOM 元素 Mock 工厂 ============

interface MockElement {
  id: string
  tagName: string
  className: string
  textContent: string
  innerHTML: string
  style: Record<string, string>
  dataset: Record<string, string>
  classList: {
    add: (cls: string) => void
    remove: (cls: string) => void
    contains: (cls: string) => boolean
    toggle: (cls: string) => boolean
  }
  getAttribute: (name: string) => string | null
  setAttribute: (name: string, value: string) => void
  addEventListener: (event: string, handler: Function) => void
  removeEventListener: (event: string, handler: Function) => void
  click: () => void
  focus: () => void
  blur: () => void
}

function createMockElement(options: Partial<MockElement> = {}): MockElement {
  const classes = new Set<string>()
  const attributes = new Map<string, string>()
  const listeners = new Map<string, Set<Function>>()

  return {
    id: options.id || '',
    tagName: options.tagName || 'DIV',
    className: options.className || '',
    textContent: options.textContent || '',
    innerHTML: options.innerHTML || '',
    style: options.style || {},
    dataset: options.dataset || {},
    classList: {
      add: (cls: string) => classes.add(cls),
      remove: (cls: string) => classes.delete(cls),
      contains: (cls: string) => classes.has(cls),
      toggle: (cls: string) => {
        if (classes.has(cls)) {
          classes.delete(cls)
          return false
        }
        classes.add(cls)
        return true
      }
    },
    getAttribute: (name: string) => attributes.get(name) || null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    addEventListener: (event: string, handler: Function) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set())
      }
      listeners.get(event)!.add(handler)
    },
    removeEventListener: (event: string, handler: Function) => {
      listeners.get(event)?.delete(handler)
    },
    click: () => {
      listeners.get('click')?.forEach(fn => fn())
    },
    focus: () => {
      listeners.get('focus')?.forEach(fn => fn())
    },
    blur: () => {
      listeners.get('blur')?.forEach(fn => fn())
    },
    ...options
  }
}

// ============ 导出 ============

export {
  // ID 生成
  generateId,
  resetIdCounter,
  
  // 历史记录
  createHistoryItem,
  createHistoryItems,
  
  // 模型
  createModel,
  
  // API 响应
  createApiResponse,
  createSuccessResponse,
  createErrorResponse,
  
  // 提示词模板
  createPromptTemplate,
  
  // 图片数据
  createImageData,
  
  // 用户会话
  createUserSession,
  
  // 任务队列
  createQueueItem,
  
  // DOM Mock
  createMockElement
}

// 类型导出
export type {
  CreateHistoryItemOptions,
  CreateModelOptions,
  CreateApiResponseOptions,
  CreatePromptTemplateOptions,
  CreateImageDataOptions,
  CreateUserSessionOptions,
  CreateQueueItemOptions,
  ImageData,
  UserSession,
  QueueItem,
  MockElement
}
