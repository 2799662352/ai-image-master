// src/renderer/src/core/EventBus.ts
/**
 * 事件总线
 * 提供应用级的事件发布/订阅机制
 */

export type EventHandler<T = any> = (data: T) => void

export interface EventSubscription {
  event: string
  handler: EventHandler
  once: boolean
}

export class EventBus {
  private events: Map<string, Set<EventSubscription>>
  private eventHistory: Map<string, any[]>
  private maxHistorySize: number

  constructor(options?: { maxHistorySize?: number }) {
    this.events = new Map()
    this.eventHistory = new Map()
    this.maxHistorySize = options?.maxHistorySize ?? 10
  }

  /**
   * 订阅事件
   * @param event 事件名称
   * @param handler 事件处理函数
   * @returns 取消订阅函数
   */
  on<T = any>(event: string, handler: EventHandler<T>): () => void {
    if (!this.events.has(event)) {
      this.events.set(event, new Set())
    }

    const subscription: EventSubscription = {
      event,
      handler: handler as EventHandler,
      once: false
    }

    this.events.get(event)!.add(subscription)

    // 返回取消订阅函数
    return () => this.off(event, handler)
  }

  /**
   * 订阅一次性事件
   * @param event 事件名称
   * @param handler 事件处理函数
   * @returns 取消订阅函数
   */
  once<T = any>(event: string, handler: EventHandler<T>): () => void {
    if (!this.events.has(event)) {
      this.events.set(event, new Set())
    }

    const subscription: EventSubscription = {
      event,
      handler: handler as EventHandler,
      once: true
    }

    this.events.get(event)!.add(subscription)

    return () => this.off(event, handler)
  }

  /**
   * 取消订阅事件
   * @param event 事件名称
   * @param handler 事件处理函数（可选，不传则取消所有该事件的订阅）
   */
  off<T = any>(event: string, handler?: EventHandler<T>): void {
    const subscriptions = this.events.get(event)
    if (!subscriptions) return

    if (handler) {
      // 移除特定处理函数
      for (const sub of subscriptions) {
        if (sub.handler === handler) {
          subscriptions.delete(sub)
          break
        }
      }
    } else {
      // 清除所有该事件的订阅
      this.events.delete(event)
    }
  }

  /**
   * 发布事件
   * @param event 事件名称
   * @param data 事件数据
   */
  emit<T = any>(event: string, data?: T): void {
    // 记录事件历史
    this.recordHistory(event, data)

    const subscriptions = this.events.get(event)
    if (!subscriptions || subscriptions.size === 0) {
      return
    }

    // 收集需要移除的一次性订阅
    const toRemove: EventSubscription[] = []

    // 执行所有订阅的处理函数
    for (const sub of subscriptions) {
      try {
        sub.handler(data)
      } catch (error) {
        console.error(`[EventBus] Error in handler for event "${event}":`, error)
      }

      if (sub.once) {
        toRemove.push(sub)
      }
    }

    // 移除一次性订阅
    for (const sub of toRemove) {
      subscriptions.delete(sub)
    }
  }

  /**
   * 记录事件历史
   */
  private recordHistory(event: string, data: any): void {
    if (!this.eventHistory.has(event)) {
      this.eventHistory.set(event, [])
    }

    const history = this.eventHistory.get(event)!
    history.push({
      timestamp: Date.now(),
      data
    })

    // 限制历史记录大小
    if (history.length > this.maxHistorySize) {
      history.shift()
    }
  }

  /**
   * 获取事件历史
   */
  getHistory(event: string): any[] {
    return this.eventHistory.get(event) || []
  }

  /**
   * 清除事件历史
   */
  clearHistory(event?: string): void {
    if (event) {
      this.eventHistory.delete(event)
    } else {
      this.eventHistory.clear()
    }
  }

  /**
   * 检查是否有订阅者
   */
  hasListeners(event: string): boolean {
    const subscriptions = this.events.get(event)
    return !!subscriptions && subscriptions.size > 0
  }

  /**
   * 获取事件的订阅者数量
   */
  listenerCount(event: string): number {
    const subscriptions = this.events.get(event)
    return subscriptions?.size ?? 0
  }

  /**
   * 获取所有事件名称
   */
  eventNames(): string[] {
    return Array.from(this.events.keys())
  }

  /**
   * 等待事件
   * @param event 事件名称
   * @param timeout 超时时间（毫秒）
   */
  waitFor<T = any>(event: string, timeout?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null

      const cleanup = this.once<T>(event, (data) => {
        if (timeoutId) clearTimeout(timeoutId)
        resolve(data)
      })

      if (timeout) {
        timeoutId = setTimeout(() => {
          cleanup()
          reject(new Error(`EventBus: Timeout waiting for event "${event}"`))
        }, timeout)
      }
    })
  }

  /**
   * 创建命名空间事件总线
   */
  namespace(ns: string): NamespacedEventBus {
    return new NamespacedEventBus(this, ns)
  }

  /**
   * 清除所有订阅
   */
  clear(): void {
    this.events.clear()
    this.eventHistory.clear()
  }

  /**
   * 销毁事件总线
   */
  destroy(): void {
    this.clear()
  }
}

/**
 * 命名空间事件总线
 * 自动为事件名添加命名空间前缀
 */
export class NamespacedEventBus {
  private bus: EventBus
  private namespace: string

  constructor(bus: EventBus, namespace: string) {
    this.bus = bus
    this.namespace = namespace
  }

  private prefixEvent(event: string): string {
    return `${this.namespace}:${event}`
  }

  on<T = any>(event: string, handler: EventHandler<T>): () => void {
    return this.bus.on(this.prefixEvent(event), handler)
  }

  once<T = any>(event: string, handler: EventHandler<T>): () => void {
    return this.bus.once(this.prefixEvent(event), handler)
  }

  off<T = any>(event: string, handler?: EventHandler<T>): void {
    this.bus.off(this.prefixEvent(event), handler)
  }

  emit<T = any>(event: string, data?: T): void {
    this.bus.emit(this.prefixEvent(event), data)
  }

  waitFor<T = any>(event: string, timeout?: number): Promise<T> {
    return this.bus.waitFor(this.prefixEvent(event), timeout)
  }
}

// 预定义的应用事件类型
export const AppEvents = {
  // 模型相关
  MODEL_CHANGED: 'model:changed',
  MODEL_LOADED: 'model:loaded',

  // 历史相关
  HISTORY_ADDED: 'history:added',
  HISTORY_DELETED: 'history:deleted',
  HISTORY_CLEARED: 'history:cleared',

  // 设置相关
  SETTINGS_CHANGED: 'settings:changed',
  API_KEY_CHANGED: 'settings:apiKeyChanged',
  LANGUAGE_CHANGED: 'settings:languageChanged',

  // 生成相关
  GENERATE_START: 'generate:start',
  GENERATE_PROGRESS: 'generate:progress',
  GENERATE_COMPLETE: 'generate:complete',
  GENERATE_ERROR: 'generate:error',

  // 路由相关
  ROUTE_CHANGED: 'route:changed',

  // 应用生命周期
  APP_READY: 'app:ready',
  APP_ERROR: 'app:error'
} as const

// 创建单例
let instance: EventBus | null = null

export function getEventBus(): EventBus {
  if (!instance) {
    instance = new EventBus()
  }
  return instance
}

export function createEventBus(options?: { maxHistorySize?: number }): EventBus {
  return new EventBus(options)
}
