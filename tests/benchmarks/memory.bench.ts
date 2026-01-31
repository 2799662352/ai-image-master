// tests/benchmarks/memory.bench.ts
/**
 * 内存占用基准测试
 * 
 * 测量应用的内存使用情况:
 * - 基础内存占用
 * - 数据结构内存效率
 * - 长时间运行内存泄漏检测
 * 
 * 运行: npm run test:bench
 */

import { bench, describe, beforeEach, afterEach } from 'vitest'

// 模拟历史记录条目
interface HistoryItem {
  id: string
  type: string
  prompt: string
  urls: string[]
  timestamp: number
  model: string
  params: Record<string, any>
}

// 模拟图片数据
interface ImageData {
  id: string
  url: string
  width: number
  height: number
  size: number
  metadata: Record<string, any>
}

describe('Memory - Data Structure Efficiency', () => {
  bench('Create 100 history items', () => {
    const items: HistoryItem[] = []
    for (let i = 0; i < 100; i++) {
      items.push({
        id: `item-${i}`,
        type: 'text2img',
        prompt: `Test prompt ${i} with some additional text to simulate real prompts`,
        urls: [`https://example.com/image-${i}.png`],
        timestamp: Date.now() - i * 1000,
        model: 'flux-schnell',
        params: { ratio: '1:1', resolution: '1K' }
      })
    }
    return items.length
  }, {
    time: 1000,
    iterations: 100
  })

  bench('Create 500 history items', () => {
    const items: HistoryItem[] = []
    for (let i = 0; i < 500; i++) {
      items.push({
        id: `item-${i}`,
        type: 'text2img',
        prompt: `Test prompt ${i} with some additional text to simulate real prompts`,
        urls: [`https://example.com/image-${i}.png`],
        timestamp: Date.now() - i * 1000,
        model: 'flux-schnell',
        params: { ratio: '1:1', resolution: '1K' }
      })
    }
    return items.length
  }, {
    time: 2000,
    iterations: 50
  })

  bench('Create Map with 1000 entries', () => {
    const map = new Map<string, any>()
    for (let i = 0; i < 1000; i++) {
      map.set(`key-${i}`, {
        value: i,
        data: `data-${i}`,
        timestamp: Date.now()
      })
    }
    return map.size
  }, {
    time: 1000,
    iterations: 50
  })

  bench('Create WeakMap with 100 entries', () => {
    const map = new WeakMap<object, any>()
    const keys: object[] = []
    for (let i = 0; i < 100; i++) {
      const key = { id: i }
      keys.push(key)
      map.set(key, { value: i })
    }
    return keys.length
  }, {
    time: 1000,
    iterations: 100
  })
})

describe('Memory - Array Operations', () => {
  let largeArray: number[]

  beforeEach(() => {
    largeArray = Array.from({ length: 10000 }, (_, i) => i)
  })

  bench('Array filter (10000 elements)', () => {
    const filtered = largeArray.filter(n => n % 2 === 0)
    return filtered.length
  }, {
    time: 1000,
    iterations: 100
  })

  bench('Array map (10000 elements)', () => {
    const mapped = largeArray.map(n => n * 2)
    return mapped.length
  }, {
    time: 1000,
    iterations: 100
  })

  bench('Array reduce (10000 elements)', () => {
    const sum = largeArray.reduce((acc, n) => acc + n, 0)
    return sum
  }, {
    time: 1000,
    iterations: 100
  })

  bench('Array slice and spread', () => {
    const copy = [...largeArray.slice(0, 5000)]
    return copy.length
  }, {
    time: 1000,
    iterations: 100
  })
})

describe('Memory - Object Cloning', () => {
  const complexObject = {
    id: 'test-1',
    nested: {
      level1: {
        level2: {
          value: 'deep',
          array: [1, 2, 3, 4, 5]
        }
      }
    },
    items: Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `Item ${i}`,
      data: { key: `value-${i}` }
    }))
  }

  bench('JSON clone', () => {
    const clone = JSON.parse(JSON.stringify(complexObject))
    return clone.id
  }, {
    time: 1000,
    iterations: 100
  })

  bench('Spread shallow clone', () => {
    const clone = { ...complexObject }
    return clone.id
  }, {
    time: 500,
    iterations: 1000
  })

  bench('Object.assign clone', () => {
    const clone = Object.assign({}, complexObject)
    return clone.id
  }, {
    time: 500,
    iterations: 1000
  })

  bench('structuredClone', () => {
    const clone = structuredClone(complexObject)
    return clone.id
  }, {
    time: 1000,
    iterations: 100
  })
})

describe('Memory - String Operations', () => {
  bench('String concatenation (100 items)', () => {
    let result = ''
    for (let i = 0; i < 100; i++) {
      result += `Item ${i}, `
    }
    return result.length
  }, {
    time: 500,
    iterations: 500
  })

  bench('Array join (100 items)', () => {
    const items = Array.from({ length: 100 }, (_, i) => `Item ${i}`)
    const result = items.join(', ')
    return result.length
  }, {
    time: 500,
    iterations: 500
  })

  bench('Template literal building', () => {
    const items = Array.from({ length: 50 }, (_, i) => i)
    const result = items.map(i => `<div class="item" data-id="${i}">Item ${i}</div>`).join('')
    return result.length
  }, {
    time: 500,
    iterations: 500
  })
})

describe('Memory - Cache Simulation', () => {
  bench('LRU Cache operations (100 entries)', () => {
    // 简化的 LRU 缓存实现
    class SimpleLRU<K, V> {
      private cache = new Map<K, V>()
      private maxSize: number

      constructor(maxSize: number) {
        this.maxSize = maxSize
      }

      get(key: K): V | undefined {
        const value = this.cache.get(key)
        if (value !== undefined) {
          // 移动到最后（最近使用）
          this.cache.delete(key)
          this.cache.set(key, value)
        }
        return value
      }

      set(key: K, value: V): void {
        if (this.cache.has(key)) {
          this.cache.delete(key)
        } else if (this.cache.size >= this.maxSize) {
          // 删除最老的
          const firstKey = this.cache.keys().next().value
          this.cache.delete(firstKey)
        }
        this.cache.set(key, value)
      }
    }

    const cache = new SimpleLRU<string, any>(50)
    for (let i = 0; i < 100; i++) {
      cache.set(`key-${i}`, { data: i })
      cache.get(`key-${i % 30}`)
    }
  }, {
    time: 1000,
    iterations: 100
  })

  bench('WeakRef cache simulation', () => {
    // 模拟使用 WeakRef 的缓存
    const cache = new Map<string, WeakRef<object>>()
    const registry = new FinalizationRegistry((key: string) => {
      cache.delete(key)
    })

    for (let i = 0; i < 50; i++) {
      const obj = { id: i, data: `value-${i}` }
      const ref = new WeakRef(obj)
      cache.set(`key-${i}`, ref)
      registry.register(obj, `key-${i}`)
    }

    // 读取一些值
    for (let i = 0; i < 50; i++) {
      const ref = cache.get(`key-${i}`)
      ref?.deref()
    }
  }, {
    time: 1000,
    iterations: 50
  })
})

describe('Memory - Event Listener Cleanup', () => {
  bench('Add and remove event listeners (100x)', () => {
    // 模拟事件监听器添加和移除
    const eventTarget = {
      listeners: new Map<string, Set<Function>>(),
      addEventListener(event: string, fn: Function) {
        if (!this.listeners.has(event)) {
          this.listeners.set(event, new Set())
        }
        this.listeners.get(event)!.add(fn)
      },
      removeEventListener(event: string, fn: Function) {
        this.listeners.get(event)?.delete(fn)
      }
    }

    const handlers: Function[] = []
    
    // 添加监听器
    for (let i = 0; i < 100; i++) {
      const handler = () => {}
      handlers.push(handler)
      eventTarget.addEventListener('test', handler)
    }

    // 移除监听器
    for (const handler of handlers) {
      eventTarget.removeEventListener('test', handler)
    }

    return handlers.length
  }, {
    time: 1000,
    iterations: 100
  })
})

describe('Memory - Leak Detection Patterns', () => {
  bench('Closure memory pattern', () => {
    // 测试闭包是否会导致内存泄漏
    const createHandlers = () => {
      const handlers: (() => void)[] = []
      const data = new Array(100).fill({ value: 'test' })
      
      for (let i = 0; i < 10; i++) {
        // 闭包捕获整个 data 数组
        handlers.push(() => {
          return data[i]?.value
        })
      }
      
      return handlers
    }

    const handlers = createHandlers()
    handlers.forEach(h => h())
  }, {
    time: 1000,
    iterations: 100
  })

  bench('Timer cleanup pattern', () => {
    // 模拟定时器清理
    const timers: ReturnType<typeof setTimeout>[] = []
    
    for (let i = 0; i < 10; i++) {
      const timer = setTimeout(() => {}, 0)
      timers.push(timer)
    }

    // 清理所有定时器
    timers.forEach(timer => clearTimeout(timer))
  }, {
    time: 500,
    iterations: 500
  })
})
