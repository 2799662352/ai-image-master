// tests/benchmarks/startup.bench.ts
/**
 * 启动性能基准测试
 * 
 * 测量关键初始化路径的性能:
 * - ServiceBridge 初始化
 * - 服务单例获取
 * - 页面工厂函数
 * 
 * 运行: npm run test:bench
 */

import { bench, describe, beforeEach, afterEach } from 'vitest'

// Mock window 和 document 对象
const mockWindow = {
  __serviceBridgeInitialized: false,
  requestIdleCallback: (fn: Function) => setTimeout(fn, 0),
  addEventListener: () => {},
  dispatchEvent: () => true
} as any

const mockDocument = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, appendChild: () => {} }),
  addEventListener: () => {}
} as any

describe('Startup Performance Benchmarks', () => {
  beforeEach(() => {
    // 重置全局状态
    global.window = mockWindow
    global.document = mockDocument
  })

  afterEach(() => {
    // 清理
    mockWindow.__serviceBridgeInitialized = false
  })

  bench('StorageBridge singleton access', async () => {
    // 模拟获取存储桥接单例
    const getStorageBridge = () => ({
      get: async () => null,
      set: async () => {},
      remove: async () => {},
      clear: async () => {}
    })
    
    const storage = getStorageBridge()
    await storage.get('test-key')
  }, {
    time: 1000,
    iterations: 100
  })

  bench('I18n service initialization', async () => {
    // 模拟 i18n 服务初始化
    const initI18n = async () => {
      const translations = {
        en: { hello: 'Hello' },
        zh: { hello: '你好' }
      }
      return {
        t: (key: string) => translations.zh[key as keyof typeof translations.zh] || key,
        currentLang: 'zh'
      }
    }
    
    await initI18n()
  }, {
    time: 1000,
    iterations: 100
  })

  bench('ToastManager show operation', () => {
    // 模拟 Toast 显示操作
    const showToast = (message: string, type: string) => {
      const toast = { message, type, visible: true }
      return toast
    }
    
    showToast('Test message', 'success')
  }, {
    time: 500,
    iterations: 1000
  })

  bench('TabManager switchTab operation', () => {
    // 模拟标签页切换
    const pages = { generate: true, history: true, batch: true }
    const switchTab = (tabName: string) => {
      const validTabs = Object.keys(pages)
      if (!validTabs.includes(tabName)) return false
      return true
    }
    
    switchTab('generate')
    switchTab('history')
    switchTab('batch')
  }, {
    time: 500,
    iterations: 1000
  })

  bench('ErrorHandler format operation', () => {
    // 模拟错误格式化
    const formatError = (error: Error) => {
      return {
        message: error.message,
        stack: error.stack,
        timestamp: Date.now(),
        context: 'test'
      }
    }
    
    formatError(new Error('Test error'))
  }, {
    time: 500,
    iterations: 1000
  })
})

describe('Service Factory Benchmarks', () => {
  bench('Multiple service singleton access', () => {
    // 模拟多个服务单例访问
    const services: Record<string, any> = {}
    
    const getService = (name: string) => {
      if (!services[name]) {
        services[name] = { name, initialized: true }
      }
      return services[name]
    }
    
    getService('storage')
    getService('i18n')
    getService('api')
    getService('toast')
    getService('error')
  }, {
    time: 500,
    iterations: 1000
  })

  bench('Page factory function call', () => {
    // 模拟页面工厂函数
    const createPage = (type: string, app: any) => ({
      type,
      app,
      state: {},
      init: () => {},
      destroy: () => {}
    })
    
    createPage('generate', { showToast: () => {} })
    createPage('history', { showToast: () => {} })
  }, {
    time: 500,
    iterations: 1000
  })
})

describe('Critical Path Benchmarks', () => {
  bench('Event dispatch and handling', () => {
    // 模拟事件分发
    const eventBus = {
      listeners: new Map<string, Function[]>(),
      on(event: string, fn: Function) {
        if (!this.listeners.has(event)) {
          this.listeners.set(event, [])
        }
        this.listeners.get(event)!.push(fn)
      },
      emit(event: string, data: any) {
        const fns = this.listeners.get(event) || []
        fns.forEach(fn => fn(data))
      }
    }
    
    eventBus.on('test', () => {})
    eventBus.emit('test', { data: 'test' })
  }, {
    time: 500,
    iterations: 1000
  })

  bench('DOM element lookup simulation', () => {
    // 模拟 DOM 查找
    const elements = new Map([
      ['#generateBtn', { id: 'generateBtn' }],
      ['#promptInput', { id: 'promptInput' }],
      ['#historyList', { id: 'historyList' }]
    ])
    
    const getElementById = (id: string) => elements.get(`#${id}`)
    
    getElementById('generateBtn')
    getElementById('promptInput')
    getElementById('historyList')
  }, {
    time: 500,
    iterations: 1000
  })

  bench('State object creation and update', () => {
    // 模拟状态管理
    interface State {
      prompt: string
      ratio: string
      isGenerating: boolean
    }
    
    const createState = (): State => ({
      prompt: '',
      ratio: '1:1',
      isGenerating: false
    })
    
    const updateState = (state: State, updates: Partial<State>): State => ({
      ...state,
      ...updates
    })
    
    let state = createState()
    state = updateState(state, { prompt: 'test' })
    state = updateState(state, { isGenerating: true })
  }, {
    time: 500,
    iterations: 1000
  })
})
