/**
 * AppBootstrap 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AppBootstrap, createAppBootstrap, getAppBootstrap } from '../../src/renderer/src/core/AppBootstrap'

describe('AppBootstrap', () => {
  const originalDispatchEvent = window.dispatchEvent
  
  beforeEach(() => {
    // 重置单例
    AppBootstrap.resetInstance()
    
    // 清理 DOM
    document.body.innerHTML = ''
    
    // 重置全局状态
    ;(window as any).appInitialized = undefined
    
    // Mock window.dispatchEvent
    window.dispatchEvent = vi.fn().mockReturnValue(true)
  })
  
  afterEach(() => {
    vi.restoreAllMocks()
    window.dispatchEvent = originalDispatchEvent
  })
  
  describe('单例模式', () => {
    it('getInstance 返回相同实例', () => {
      const instance1 = AppBootstrap.getInstance()
      const instance2 = AppBootstrap.getInstance()
      expect(instance1).toBe(instance2)
    })
    
    it('resetInstance 后返回新实例', () => {
      const instance1 = AppBootstrap.getInstance()
      AppBootstrap.resetInstance()
      const instance2 = AppBootstrap.getInstance()
      expect(instance1).not.toBe(instance2)
    })
    
    it('getAppBootstrap 返回单例', () => {
      const instance1 = getAppBootstrap()
      const instance2 = getAppBootstrap()
      expect(instance1).toBe(instance2)
    })
    
    it('createAppBootstrap 重置并返回新实例', () => {
      const instance1 = getAppBootstrap()
      const instance2 = createAppBootstrap()
      expect(instance1).not.toBe(instance2)
    })
  })
  
  describe('初始化状态', () => {
    it('初始状态正确', () => {
      const bootstrap = createAppBootstrap()
      const state = bootstrap.getState()
      
      expect(state.initialized).toBe(false)
      expect(state.criticalReady).toBe(false)
      expect(state.nonCriticalReady).toBe(false)
      expect(state.retryCount).toBe(0)
      expect(state.error).toBeNull()
    })
  })
  
  describe('回调注册', () => {
    it('onCriticalInit 注册回调', async () => {
      const bootstrap = createAppBootstrap({ requiredElements: [] })
      const callback = vi.fn()
      
      bootstrap.onCriticalInit(callback)
      await bootstrap.init()
      
      expect(callback).toHaveBeenCalledTimes(1)
    })
    
    it('onNonCriticalInit 注册回调', async () => {
      const bootstrap = createAppBootstrap({ requiredElements: [] })
      const callback = vi.fn()
      
      bootstrap.onNonCriticalInit(callback)
      await bootstrap.init()
      
      // 非关键回调是异步执行的
      await new Promise(resolve => setTimeout(resolve, 200))
      
      expect(callback).toHaveBeenCalledTimes(1)
    })
    
    it('onReady 在已就绪时立即执行', async () => {
      const bootstrap = createAppBootstrap({ requiredElements: [] })
      await bootstrap.init()
      
      const callback = vi.fn()
      bootstrap.onReady(callback)
      
      expect(callback).toHaveBeenCalledTimes(1)
    })
    
    it('onReady 在未就绪时延迟执行', async () => {
      const bootstrap = createAppBootstrap({ requiredElements: [] })
      
      const callback = vi.fn()
      bootstrap.onReady(callback)
      
      expect(callback).not.toHaveBeenCalled()
      
      await bootstrap.init()
      
      expect(callback).toHaveBeenCalledTimes(1)
    })
  })
  
  describe('初始化流程', () => {
    it('不重复初始化', async () => {
      const bootstrap = createAppBootstrap({ requiredElements: [] })
      const callback = vi.fn()
      
      bootstrap.onCriticalInit(callback)
      
      await bootstrap.init()
      await bootstrap.init() // 第二次调用
      
      expect(callback).toHaveBeenCalledTimes(1)
    })
    
    it('初始化成功后状态正确', async () => {
      const bootstrap = createAppBootstrap({ requiredElements: [] })
      
      await bootstrap.init()
      
      const state = bootstrap.getState()
      expect(state.initialized).toBe(true)
      expect(state.criticalReady).toBe(true)
      expect(state.error).toBeNull()
    })
    
    it('触发 appReady 事件', async () => {
      const bootstrap = createAppBootstrap({ requiredElements: [] })
      
      await bootstrap.init()
      
      // 验证 dispatchEvent 被调用
      expect(window.dispatchEvent).toHaveBeenCalled()
      expect((window as any).appInitialized).toBe(true)
    })
  })
  
  describe('DOM 元素检查', () => {
    it('元素存在时立即初始化', async () => {
      // 创建必需元素
      const div = document.createElement('div')
      div.id = 'testElement'
      document.body.appendChild(div)
      
      const bootstrap = createAppBootstrap({ 
        requiredElements: ['testElement'],
        maxRetries: 3
      })
      
      await bootstrap.init()
      
      const state = bootstrap.getState()
      expect(state.retryCount).toBe(0)
      expect(state.initialized).toBe(true)
    })
    
    it('元素不存在时重试', async () => {
      const bootstrap = createAppBootstrap({ 
        requiredElements: ['nonExistentElement'],
        maxRetries: 2,
        retryDelay: 10
      })
      
      await bootstrap.init()
      
      const state = bootstrap.getState()
      expect(state.retryCount).toBe(2)
      // 仍然初始化，但有警告
      expect(state.initialized).toBe(true)
    })
  })
  
  describe('错误处理', () => {
    it('关键回调失败时抛出错误', async () => {
      const bootstrap = createAppBootstrap({ requiredElements: [] })
      const error = new Error('Test error')
      
      bootstrap.onCriticalInit(() => {
        throw error
      })
      
      await expect(bootstrap.init()).rejects.toThrow('Test error')
      
      const state = bootstrap.getState()
      expect(state.error).toBe(error)
    })
    
    it('非关键回调失败不中断应用', async () => {
      const bootstrap = createAppBootstrap({ requiredElements: [] })
      
      bootstrap.onNonCriticalInit(() => {
        throw new Error('Non-critical error')
      })
      
      await bootstrap.init()
      
      // 等待非关键初始化
      await new Promise(resolve => setTimeout(resolve, 200))
      
      const state = bootstrap.getState()
      expect(state.criticalReady).toBe(true)
      // 非关键失败不影响整体状态
    })
  })
  
  describe('链式调用', () => {
    it('支持链式注册回调', () => {
      const bootstrap = createAppBootstrap({ requiredElements: [] })
      
      const result = bootstrap
        .onCriticalInit(() => {})
        .onNonCriticalInit(() => {})
        .onReady(() => {})
      
      expect(result).toBe(bootstrap)
    })
  })
})
