// tests/core/EventBus.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventBus, createEventBus, AppEvents } from '../../src/renderer/src/core/EventBus'

describe('EventBus', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = createEventBus()
  })

  describe('on', () => {
    it('应该注册事件处理器', () => {
      const handler = vi.fn()
      eventBus.on('test', handler)
      
      eventBus.emit('test', { data: 'value' })
      
      expect(handler).toHaveBeenCalledWith({ data: 'value' })
    })

    it('应该返回取消订阅函数', () => {
      const handler = vi.fn()
      const unsubscribe = eventBus.on('test', handler)
      
      unsubscribe()
      eventBus.emit('test')
      
      expect(handler).not.toHaveBeenCalled()
    })

    it('应该支持多个处理器', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      
      eventBus.on('test', handler1)
      eventBus.on('test', handler2)
      eventBus.emit('test')
      
      expect(handler1).toHaveBeenCalled()
      expect(handler2).toHaveBeenCalled()
    })
  })

  describe('once', () => {
    it('应该只触发一次', () => {
      const handler = vi.fn()
      eventBus.once('test', handler)
      
      eventBus.emit('test')
      eventBus.emit('test')
      
      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe('off', () => {
    it('应该取消特定处理器', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      
      eventBus.on('test', handler1)
      eventBus.on('test', handler2)
      eventBus.off('test', handler1)
      eventBus.emit('test')
      
      expect(handler1).not.toHaveBeenCalled()
      expect(handler2).toHaveBeenCalled()
    })

    it('应该取消所有该事件的处理器', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      
      eventBus.on('test', handler1)
      eventBus.on('test', handler2)
      eventBus.off('test')
      eventBus.emit('test')
      
      expect(handler1).not.toHaveBeenCalled()
      expect(handler2).not.toHaveBeenCalled()
    })
  })

  describe('emit', () => {
    it('应该传递数据给处理器', () => {
      const handler = vi.fn()
      const testData = { key: 'value', num: 42 }
      
      eventBus.on('test', handler)
      eventBus.emit('test', testData)
      
      expect(handler).toHaveBeenCalledWith(testData)
    })

    it('应该处理没有订阅者的事件', () => {
      expect(() => eventBus.emit('nonexistent')).not.toThrow()
    })

    it('应该捕获处理器中的错误', () => {
      const errorHandler = vi.fn(() => {
        throw new Error('Test error')
      })
      const normalHandler = vi.fn()
      
      eventBus.on('test', errorHandler)
      eventBus.on('test', normalHandler)
      
      expect(() => eventBus.emit('test')).not.toThrow()
      expect(normalHandler).toHaveBeenCalled()
    })
  })

  describe('hasListeners', () => {
    it('应该检测是否有订阅者', () => {
      expect(eventBus.hasListeners('test')).toBe(false)
      
      eventBus.on('test', vi.fn())
      
      expect(eventBus.hasListeners('test')).toBe(true)
    })
  })

  describe('listenerCount', () => {
    it('应该返回订阅者数量', () => {
      expect(eventBus.listenerCount('test')).toBe(0)
      
      eventBus.on('test', vi.fn())
      eventBus.on('test', vi.fn())
      
      expect(eventBus.listenerCount('test')).toBe(2)
    })
  })

  describe('eventNames', () => {
    it('应该返回所有事件名称', () => {
      eventBus.on('event1', vi.fn())
      eventBus.on('event2', vi.fn())
      
      const names = eventBus.eventNames()
      
      expect(names).toContain('event1')
      expect(names).toContain('event2')
    })
  })

  describe('waitFor', () => {
    it('应该等待事件触发', async () => {
      const promise = eventBus.waitFor<string>('test')
      
      setTimeout(() => eventBus.emit('test', 'result'), 10)
      
      const result = await promise
      expect(result).toBe('result')
    })

    it('应该在超时时拒绝', async () => {
      const promise = eventBus.waitFor('test', 50)
      
      await expect(promise).rejects.toThrow('Timeout')
    })
  })

  describe('namespace', () => {
    it('应该创建命名空间事件总线', () => {
      const ns = eventBus.namespace('app')
      const handler = vi.fn()
      
      ns.on('ready', handler)
      eventBus.emit('app:ready', 'data')
      
      expect(handler).toHaveBeenCalledWith('data')
    })
  })

  describe('getHistory', () => {
    it('应该记录事件历史', () => {
      eventBus.emit('test', { value: 1 })
      eventBus.emit('test', { value: 2 })
      
      const history = eventBus.getHistory('test')
      
      expect(history.length).toBe(2)
      expect(history[0].data).toEqual({ value: 1 })
      expect(history[1].data).toEqual({ value: 2 })
    })
  })

  describe('clear', () => {
    it('应该清除所有订阅', () => {
      eventBus.on('test1', vi.fn())
      eventBus.on('test2', vi.fn())
      
      eventBus.clear()
      
      expect(eventBus.eventNames()).toHaveLength(0)
    })
  })

  describe('AppEvents', () => {
    it('应该定义常用事件常量', () => {
      expect(AppEvents.MODEL_CHANGED).toBe('model:changed')
      expect(AppEvents.HISTORY_ADDED).toBe('history:added')
      expect(AppEvents.ROUTE_CHANGED).toBe('route:changed')
    })
  })
})
