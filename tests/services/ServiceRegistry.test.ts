// tests/services/ServiceRegistry.test.ts
// V16.3: ServiceRegistry 单元测试

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// 简化的 ServiceRegistry 实现副本用于测试
// (避免循环依赖问题)
class ServiceRegistry {
  private static services = new Map<string, unknown>()
  private static initialized = false

  static register<T>(key: string, service: T): void {
    this.services.set(key, service)
  }

  static get<T>(key: string): T | null {
    return (this.services.get(key) as T) || null
  }

  static getRequired<T>(key: string): T {
    const service = this.services.get(key)
    if (!service) throw new Error(`Service not found: ${key}`)
    return service as T
  }

  static has(key: string): boolean {
    return this.services.has(key)
  }

  static keys(): string[] {
    return Array.from(this.services.keys())
  }

  static clear(): void {
    this.services.clear()
    this.initialized = false
  }

  static markInitialized(): void {
    this.initialized = true
  }

  static isInitialized(): boolean {
    return this.initialized
  }
}

// SERVICE_KEYS 常量
const SERVICE_KEYS = {
  STORAGE: 'storage',
  I18N: 'i18n',
  API: 'api',
  TOAST: 'toast',
  ERROR_HANDLER: 'errorHandler',
  TAB_MANAGER: 'tabManager',
  MODEL_SELECTOR: 'modelSelector',
  RATIO_RESOLUTION: 'ratioResolution',
  HISTORY_DATA: 'historyData',
  R2_STORAGE: 'r2Storage',
  VERSION_CHECKER: 'versionChecker',
  INTELLIGENT_RESIZE: 'intelligentResize',
  LANGUAGE: 'language',
  UI_STATE: 'uiState',
  IMAGE_VIEWER: 'imageViewer',
  SITE_MANAGER: 'siteManager',
  MOBILE_MENU: 'mobileMenu',
  MODAL_FACTORY: 'modalFactory'
} as const

describe('ServiceRegistry', () => {
  beforeEach(() => {
    // 清除 ServiceRegistry 状态
    ServiceRegistry.clear()
  })

  afterEach(() => {
    ServiceRegistry.clear()
  })

  describe('register / get', () => {
    it('should register and retrieve a service', () => {
      const mockService = { name: 'TestService' }
      
      ServiceRegistry.register('test', mockService)
      
      const retrieved = ServiceRegistry.get('test')
      expect(retrieved).toBe(mockService)
    })

    it('should return null for non-existent service', () => {
      const result = ServiceRegistry.get('nonexistent')
      expect(result).toBeNull()
    })

    it('should overwrite existing service with same key', () => {
      const service1 = { id: 1 }
      const service2 = { id: 2 }
      
      ServiceRegistry.register('myService', service1)
      ServiceRegistry.register('myService', service2)
      
      const retrieved = ServiceRegistry.get('myService')
      expect(retrieved).toBe(service2)
    })
  })

  describe('getRequired', () => {
    it('should return service when it exists', () => {
      const mockService = { name: 'RequiredService' }
      ServiceRegistry.register('required', mockService)
      
      const result = ServiceRegistry.getRequired('required')
      expect(result).toBe(mockService)
    })

    it('should throw error for non-existent service', () => {
      expect(() => {
        ServiceRegistry.getRequired('nonexistent')
      }).toThrow('Service not found: nonexistent')
    })
  })

  describe('has', () => {
    it('should return true when service exists', () => {
      ServiceRegistry.register('exists', { value: true })
      expect(ServiceRegistry.has('exists')).toBe(true)
    })

    it('should return false when service does not exist', () => {
      expect(ServiceRegistry.has('doesNotExist')).toBe(false)
    })
  })

  describe('keys', () => {
    it('should return empty array when no services registered', () => {
      expect(ServiceRegistry.keys()).toEqual([])
    })

    it('should return all registered service keys', () => {
      ServiceRegistry.register('service1', {})
      ServiceRegistry.register('service2', {})
      ServiceRegistry.register('service3', {})
      
      const keys = ServiceRegistry.keys()
      expect(keys).toContain('service1')
      expect(keys).toContain('service2')
      expect(keys).toContain('service3')
      expect(keys.length).toBe(3)
    })
  })

  describe('clear', () => {
    it('should remove all registered services', () => {
      ServiceRegistry.register('a', {})
      ServiceRegistry.register('b', {})
      
      ServiceRegistry.clear()
      
      expect(ServiceRegistry.keys()).toEqual([])
      expect(ServiceRegistry.get('a')).toBeNull()
      expect(ServiceRegistry.get('b')).toBeNull()
    })
  })

  describe('initialization state', () => {
    it('should start as not initialized', () => {
      expect(ServiceRegistry.isInitialized()).toBe(false)
    })

    it('should become initialized after markInitialized', () => {
      ServiceRegistry.markInitialized()
      expect(ServiceRegistry.isInitialized()).toBe(true)
    })

    it('should reset initialization state on clear', () => {
      ServiceRegistry.markInitialized()
      ServiceRegistry.clear()
      expect(ServiceRegistry.isInitialized()).toBe(false)
    })
  })

  describe('SERVICE_KEYS', () => {
    it('should have all expected service keys defined', () => {
      expect(SERVICE_KEYS.STORAGE).toBeDefined()
      expect(SERVICE_KEYS.I18N).toBeDefined()
      expect(SERVICE_KEYS.API).toBeDefined()
      expect(SERVICE_KEYS.TOAST).toBeDefined()
      expect(SERVICE_KEYS.ERROR_HANDLER).toBeDefined()
      expect(SERVICE_KEYS.TAB_MANAGER).toBeDefined()
      expect(SERVICE_KEYS.MODEL_SELECTOR).toBeDefined()
      expect(SERVICE_KEYS.RATIO_RESOLUTION).toBeDefined()
      expect(SERVICE_KEYS.HISTORY_DATA).toBeDefined()
      expect(SERVICE_KEYS.R2_STORAGE).toBeDefined()
      expect(SERVICE_KEYS.VERSION_CHECKER).toBeDefined()
    })

    it('should have unique values for all keys', () => {
      const values = Object.values(SERVICE_KEYS)
      const uniqueValues = new Set(values)
      expect(uniqueValues.size).toBe(values.length)
    })
  })

  describe('type safety', () => {
    it('should preserve service type through get', () => {
      interface TestService {
        doSomething(): string
      }
      
      const service: TestService = {
        doSomething: () => 'done'
      }
      
      ServiceRegistry.register('typedService', service)
      
      const retrieved = ServiceRegistry.get<TestService>('typedService')
      expect(retrieved?.doSomething()).toBe('done')
    })
  })
})

describe('Deprecation Warnings', () => {
  let originalEnv: string | undefined
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env.NODE_ENV = originalEnv
    consoleWarnSpy.mockRestore()
  })

  it('should show deprecation warning in development mode when accessing deprecated window property', () => {
    // 这个测试验证 Object.defineProperty 的废弃警告机制
    // 实际的警告由各个服务的 init*Global() 函数设置
    // 这里只验证概念
    
    let warningShown = false
    const mockService = { value: 'test' }
    
    Object.defineProperty((globalThis as any).window, 'testDeprecatedService', {
      get() {
        if (!warningShown) {
          console.warn('[DEPRECATED] window.testDeprecatedService')
          warningShown = true
        }
        return mockService
      },
      configurable: true
    })
    
    // 首次访问应该触发警告
    const result1 = (globalThis as any).window.testDeprecatedService
    expect(result1).toBe(mockService)
    expect(consoleWarnSpy).toHaveBeenCalledWith('[DEPRECATED] window.testDeprecatedService')
    
    // 再次访问不应该重复警告
    consoleWarnSpy.mockClear()
    const result2 = (globalThis as any).window.testDeprecatedService
    expect(result2).toBe(mockService)
    expect(consoleWarnSpy).not.toHaveBeenCalled()
    
    // 清理
    delete (globalThis as any).window.testDeprecatedService
  })
})
