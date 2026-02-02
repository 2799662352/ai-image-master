/** @vitest-environment jsdom */
// tests/core/EventManager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  EventManager,
  getEventManager,
  createEventManager,
  resetEventManager,
  initEventManagerGlobal,
  type EventHandler,
  type EventManagerConfig
} from '../../src/renderer/src/core/EventManager'

// Mock ServiceRegistry
vi.mock('../../src/renderer/src/services/ServiceBridge', () => ({
  ServiceRegistry: {
    get: vi.fn(() => null)
  },
  SERVICE_KEYS: {
    TAB_MANAGER: 'tabManager',
    SITE_MANAGER: 'siteManager',
    IMAGE_VIEWER: 'imageViewer',
    LANGUAGE: 'language',
    MOBILE_MENU: 'mobileMenu',
    I18N: 'i18n',
    TOAST: 'toast',
    ERROR_HANDLER: 'errorHandler'
  }
}))

describe('EventManager', () => {
  beforeEach(() => {
    // Reset singleton before each test
    resetEventManager()
    // Clear document body
    document.body.innerHTML = ''
  })

  afterEach(() => {
    resetEventManager()
    vi.clearAllMocks()
  })

  describe('Singleton Pattern', () => {
    it('getInstance 应该返回单例实例', () => {
      const instance1 = EventManager.getInstance()
      const instance2 = EventManager.getInstance()
      
      expect(instance1).toBe(instance2)
    })

    it('getInstance 应该使用传入的配置创建实例', () => {
      const config: EventManagerConfig = { debug: true }
      const instance = EventManager.getInstance(config)
      
      expect(instance).toBeDefined()
    })

    it('resetInstance 应该清除单例实例', () => {
      const instance1 = EventManager.getInstance()
      EventManager.resetInstance()
      const instance2 = EventManager.getInstance()
      
      expect(instance1).not.toBe(instance2)
    })

    it('getEventManager 应该返回单例实例', () => {
      const instance1 = getEventManager()
      const instance2 = getEventManager()
      
      expect(instance1).toBe(instance2)
    })

    it('createEventManager 应该创建新实例', () => {
      const instance1 = createEventManager()
      const instance2 = createEventManager()
      
      // createEventManager creates new instances each time
      expect(instance1).toBeDefined()
      expect(instance2).toBeDefined()
    })

    it('resetEventManager 应该重置单例', () => {
      const instance1 = getEventManager()
      resetEventManager()
      const instance2 = getEventManager()
      
      expect(instance1).not.toBe(instance2)
    })
  })

  describe('registerAction', () => {
    it('应该注册事件处理器', () => {
      const manager = getEventManager()
      const handler: EventHandler = vi.fn()
      
      manager.registerAction('click', 'test-action', handler)
      
      expect(manager.hasAction('click', 'test-action')).toBe(true)
    })

    it('应该支持链式调用', () => {
      const manager = getEventManager()
      const handler: EventHandler = vi.fn()
      
      const result = manager.registerAction('click', 'action1', handler)
      
      expect(result).toBe(manager)
    })

    it('应该为新事件类型创建处理器映射', () => {
      const manager = getEventManager()
      const handler: EventHandler = vi.fn()
      
      manager.registerAction('custom-event', 'custom-action', handler)
      
      expect(manager.hasAction('custom-event', 'custom-action')).toBe(true)
    })

    it('应该覆盖相同动作的处理器', () => {
      const manager = getEventManager()
      const handler1: EventHandler = vi.fn()
      const handler2: EventHandler = vi.fn()
      
      manager.registerAction('click', 'same-action', handler1)
      manager.registerAction('click', 'same-action', handler2)
      
      expect(manager.hasAction('click', 'same-action')).toBe(true)
    })
  })

  describe('onClick', () => {
    it('应该注册点击事件处理器', () => {
      const manager = getEventManager()
      const handler: EventHandler = vi.fn()
      
      manager.onClick('my-click-action', handler)
      
      expect(manager.hasAction('click', 'my-click-action')).toBe(true)
    })

    it('应该支持链式调用', () => {
      const manager = getEventManager()
      const handler: EventHandler = vi.fn()
      
      const result = manager.onClick('action', handler)
      
      expect(result).toBe(manager)
    })
  })

  describe('registerClickHandlers', () => {
    it('应该批量注册点击事件处理器', () => {
      const manager = getEventManager()
      const handlers = {
        'action1': vi.fn(),
        'action2': vi.fn(),
        'action3': vi.fn()
      }
      
      manager.registerClickHandlers(handlers)
      
      expect(manager.hasAction('click', 'action1')).toBe(true)
      expect(manager.hasAction('click', 'action2')).toBe(true)
      expect(manager.hasAction('click', 'action3')).toBe(true)
    })

    it('应该支持链式调用', () => {
      const manager = getEventManager()
      const handlers = { 'action': vi.fn() }
      
      const result = manager.registerClickHandlers(handlers)
      
      expect(result).toBe(manager)
    })

    it('应该处理空对象', () => {
      const manager = getEventManager()
      
      expect(() => manager.registerClickHandlers({})).not.toThrow()
    })
  })

  describe('removeAction', () => {
    it('应该移除已注册的处理器', () => {
      const manager = getEventManager()
      const handler: EventHandler = vi.fn()
      
      manager.registerAction('click', 'to-remove', handler)
      const result = manager.removeAction('click', 'to-remove')
      
      expect(result).toBe(true)
      expect(manager.hasAction('click', 'to-remove')).toBe(false)
    })

    it('应该对不存在的动作返回 false', () => {
      const manager = getEventManager()
      
      const result = manager.removeAction('click', 'nonexistent')
      
      expect(result).toBe(false)
    })

    it('应该对不存在的事件类型返回 false', () => {
      const manager = getEventManager()
      
      const result = manager.removeAction('nonexistent-event', 'action')
      
      expect(result).toBe(false)
    })
  })

  describe('hasAction', () => {
    it('应该对已注册的动作返回 true', () => {
      const manager = getEventManager()
      manager.registerAction('click', 'existing', vi.fn())
      
      expect(manager.hasAction('click', 'existing')).toBe(true)
    })

    it('应该对未注册的动作返回 false', () => {
      const manager = getEventManager()
      
      expect(manager.hasAction('click', 'nonexistent')).toBe(false)
    })

    it('应该对不存在的事件类型返回 false', () => {
      const manager = getEventManager()
      
      expect(manager.hasAction('nonexistent-event', 'action')).toBe(false)
    })
  })

  describe('getRegisteredActions', () => {
    it('应该返回所有已注册的动作', () => {
      const manager = getEventManager()
      manager.registerAction('click', 'click-action-1', vi.fn())
      manager.registerAction('click', 'click-action-2', vi.fn())
      manager.registerAction('change', 'change-action', vi.fn())
      
      const actions = manager.getRegisteredActions()
      
      expect(actions['click']).toContain('click-action-1')
      expect(actions['click']).toContain('click-action-2')
      expect(actions['change']).toContain('change-action')
    })

    it('应该返回空数组对于没有处理器的事件类型', () => {
      const manager = getEventManager()
      
      const actions = manager.getRegisteredActions()
      
      // Default event types are initialized but empty
      expect(actions['click']).toEqual([])
      expect(actions['change']).toEqual([])
      expect(actions['input']).toEqual([])
      expect(actions['submit']).toEqual([])
    })
  })

  describe('init', () => {
    it('应该初始化事件委托', () => {
      const manager = getEventManager()
      manager.registerAction('click', 'test-action', vi.fn())
      
      expect(() => manager.init()).not.toThrow()
    })

    it('应该跳过重复初始化', () => {
      const manager = getEventManager()
      const consoleSpy = vi.spyOn(console, 'log')
      
      manager.init()
      manager.init() // Second call should be skipped
      
      expect(consoleSpy).toHaveBeenCalledWith('[EventManager] 已初始化，跳过')
      consoleSpy.mockRestore()
    })

    it('应该注册默认处理器', () => {
      const manager = getEventManager()
      manager.init()
      
      // Check some default handlers are registered
      expect(manager.hasAction('click', 'switch-tab')).toBe(true)
      expect(manager.hasAction('click', 'open-settings')).toBe(true)
      expect(manager.hasAction('click', 'close-settings')).toBe(true)
      expect(manager.hasAction('click', 'open-about')).toBe(true)
      expect(manager.hasAction('click', 'close-about')).toBe(true)
    })
  })

  describe('Event Delegation', () => {
    it('应该通过事件委托触发处理器', async () => {
      const manager = getEventManager()
      const handler = vi.fn()
      
      manager.registerAction('click', 'delegated-action', handler)
      manager.init()
      
      // Create element with data-action
      const button = document.createElement('button')
      button.setAttribute('data-action', 'delegated-action')
      button.setAttribute('data-custom', 'value')
      document.body.appendChild(button)
      
      // Trigger click
      button.click()
      
      // Wait for async handler
      await new Promise(resolve => setTimeout(resolve, 10))
      
      expect(handler).toHaveBeenCalled()
      expect(handler.mock.calls[0][1]).toBe(button)
      expect(handler.mock.calls[0][2]).toHaveProperty('action', 'delegated-action')
    })

    it('应该传递数据集给处理器', async () => {
      const manager = getEventManager()
      const handler = vi.fn()
      
      manager.registerAction('click', 'data-action', handler)
      manager.init()
      
      const button = document.createElement('button')
      button.setAttribute('data-action', 'data-action')
      button.setAttribute('data-id', '123')
      button.setAttribute('data-name', 'test')
      document.body.appendChild(button)
      
      button.click()
      await new Promise(resolve => setTimeout(resolve, 10))
      
      const dataArg = handler.mock.calls[0][2]
      expect(dataArg.id).toBe('123')
      expect(dataArg.name).toBe('test')
    })

    it('应该处理嵌套元素的点击', async () => {
      const manager = getEventManager()
      const handler = vi.fn()
      
      manager.registerAction('click', 'parent-action', handler)
      manager.init()
      
      // Create parent with data-action and child element
      const parent = document.createElement('div')
      parent.setAttribute('data-action', 'parent-action')
      const child = document.createElement('span')
      child.textContent = 'Click me'
      parent.appendChild(child)
      document.body.appendChild(parent)
      
      // Click child element
      child.click()
      await new Promise(resolve => setTimeout(resolve, 10))
      
      expect(handler).toHaveBeenCalled()
    })

    it('应该忽略没有 data-action 的元素', async () => {
      const manager = getEventManager()
      const handler = vi.fn()
      
      manager.registerAction('click', 'some-action', handler)
      manager.init()
      
      const button = document.createElement('button')
      // No data-action attribute
      document.body.appendChild(button)
      
      button.click()
      await new Promise(resolve => setTimeout(resolve, 10))
      
      expect(handler).not.toHaveBeenCalled()
    })

    it('应该忽略未注册的动作', async () => {
      const manager = getEventManager()
      const handler = vi.fn()
      
      manager.registerAction('click', 'registered-action', handler)
      manager.init()
      
      const button = document.createElement('button')
      button.setAttribute('data-action', 'unregistered-action')
      document.body.appendChild(button)
      
      button.click()
      await new Promise(resolve => setTimeout(resolve, 10))
      
      expect(handler).not.toHaveBeenCalled()
    })

    it('应该捕获处理器中的错误', async () => {
      const manager = getEventManager()
      const errorHandler = vi.fn(() => {
        throw new Error('Handler error')
      })
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      
      manager.registerAction('click', 'error-action', errorHandler)
      manager.init()
      
      const button = document.createElement('button')
      button.setAttribute('data-action', 'error-action')
      document.body.appendChild(button)
      
      // Should not throw
      expect(() => button.click()).not.toThrow()
      await new Promise(resolve => setTimeout(resolve, 10))
      
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  describe('destroy', () => {
    it('应该移除所有事件监听器', () => {
      const manager = getEventManager()
      manager.registerAction('click', 'action', vi.fn())
      manager.init()
      
      expect(() => manager.destroy()).not.toThrow()
    })

    it('应该清除所有处理器', () => {
      const manager = getEventManager()
      manager.registerAction('click', 'action1', vi.fn())
      manager.registerAction('change', 'action2', vi.fn())
      manager.init()
      
      manager.destroy()
      
      const actions = manager.getRegisteredActions()
      expect(actions['click']).toEqual([])
      expect(actions['change']).toEqual([])
    })

    it('销毁后应该可以重新初始化', () => {
      const manager = getEventManager()
      manager.registerAction('click', 'action', vi.fn())
      manager.init()
      manager.destroy()
      
      manager.registerAction('click', 'new-action', vi.fn())
      expect(() => manager.init()).not.toThrow()
    })
  })

  describe('setBootstrap', () => {
    it('应该设置 AppBootstrap 引用', () => {
      const manager = getEventManager()
      const mockBootstrap = { getPages: vi.fn(() => ({})) }
      
      expect(() => manager.setBootstrap(mockBootstrap as any)).not.toThrow()
    })
  })

  describe('Debug Mode', () => {
    it('应该在调试模式下输出日志', () => {
      const consoleSpy = vi.spyOn(console, 'log')
      const manager = getEventManager({ debug: true })
      
      manager.registerAction('click', 'debug-action', vi.fn())
      
      expect(consoleSpy).toHaveBeenCalledWith(
        '[EventManager] 注册动作: click:debug-action'
      )
      consoleSpy.mockRestore()
    })
  })

  describe('initEventManagerGlobal', () => {
    it('应该暴露到 window 对象', () => {
      const manager = initEventManagerGlobal()
      
      expect(window.eventManager).toBe(manager)
      expect(window.eventManagerTS).toBe(manager)
      expect(window.EventManagerTS).toBe(EventManager)
    })

    it('应该返回单例实例', () => {
      const manager1 = initEventManagerGlobal()
      const manager2 = getEventManager()
      
      expect(manager1).toBe(manager2)
    })
  })

  describe('Default Handlers', () => {
    it('open-about 应该显示关于模态框', async () => {
      const manager = getEventManager()
      manager.init()
      
      // Create modal
      const modal = document.createElement('div')
      modal.id = 'aboutModal'
      modal.classList.add('hidden')
      document.body.appendChild(modal)
      
      // Create button
      const button = document.createElement('button')
      button.setAttribute('data-action', 'open-about')
      document.body.appendChild(button)
      
      button.click()
      await new Promise(resolve => setTimeout(resolve, 10))
      
      expect(modal.classList.contains('hidden')).toBe(false)
    })

    it('close-about 应该隐藏关于模态框', async () => {
      const manager = getEventManager()
      manager.init()
      
      // Create visible modal
      const modal = document.createElement('div')
      modal.id = 'aboutModal'
      document.body.appendChild(modal)
      
      // Create button
      const button = document.createElement('button')
      button.setAttribute('data-action', 'close-about')
      document.body.appendChild(button)
      
      button.click()
      await new Promise(resolve => setTimeout(resolve, 10))
      
      expect(modal.classList.contains('hidden')).toBe(true)
    })

    it('reload-page 应该注册处理器', () => {
      const manager = getEventManager()
      manager.init()
      
      // Verify the reload-page handler is registered
      expect(manager.hasAction('click', 'reload-page')).toBe(true)
    })
  })

  describe('Multiple Event Types', () => {
    it('应该支持 change 事件', () => {
      const manager = getEventManager()
      const handler = vi.fn()
      
      manager.registerAction('change', 'select-change', handler)
      
      expect(manager.hasAction('change', 'select-change')).toBe(true)
    })

    it('应该支持 input 事件', () => {
      const manager = getEventManager()
      const handler = vi.fn()
      
      manager.registerAction('input', 'text-input', handler)
      
      expect(manager.hasAction('input', 'text-input')).toBe(true)
    })

    it('应该支持 submit 事件', () => {
      const manager = getEventManager()
      const handler = vi.fn()
      
      manager.registerAction('submit', 'form-submit', handler)
      
      expect(manager.hasAction('submit', 'form-submit')).toBe(true)
    })
  })

  describe('Edge Cases', () => {
    it('应该处理空配置', () => {
      expect(() => getEventManager()).not.toThrow()
    })

    it('应该处理 undefined 配置', () => {
      expect(() => getEventManager(undefined)).not.toThrow()
    })

    it('应该处理没有处理器的初始化', () => {
      resetEventManager()
      const manager = createEventManager()
      
      expect(() => manager.init()).not.toThrow()
    })

    it('应该处理多次销毁调用', () => {
      const manager = getEventManager()
      manager.init()
      
      manager.destroy()
      expect(() => manager.destroy()).not.toThrow()
    })

    it('应该处理空 data-action 属性', async () => {
      const manager = getEventManager()
      const handler = vi.fn()
      manager.registerAction('click', '', handler)
      manager.init()
      
      const button = document.createElement('button')
      button.setAttribute('data-action', '')
      document.body.appendChild(button)
      
      button.click()
      await new Promise(resolve => setTimeout(resolve, 10))
      
      // Empty action should not trigger handler (action check is falsy)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('Custom Delegate Root', () => {
    it('应该支持自定义委托根元素', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      
      const manager = createEventManager({ delegateRoot: container })
      const handler = vi.fn()
      
      manager.registerAction('click', 'container-action', handler)
      manager.init()
      
      // Button inside container
      const button = document.createElement('button')
      button.setAttribute('data-action', 'container-action')
      container.appendChild(button)
      
      button.click()
      await new Promise(resolve => setTimeout(resolve, 10))
      
      expect(handler).toHaveBeenCalled()
    })
  })
})
