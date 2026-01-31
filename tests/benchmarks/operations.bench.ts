// tests/benchmarks/operations.bench.ts
/**
 * 关键操作性能基准测试
 * 
 * 测量应用中关键操作的性能:
 * - 历史记录加载/渲染
 * - 图片处理
 * - 模型切换
 * - 页面切换
 * 
 * 运行: npm run test:bench
 */

import { bench, describe, beforeEach } from 'vitest'

// 模拟历史记录数据
interface HistoryItem {
  id: string
  type: string
  prompt: string
  urls: string[]
  timestamp: number
  model: string
}

const createMockHistoryItem = (index: number): HistoryItem => ({
  id: `hist-${index}`,
  type: 'text2img',
  prompt: `Test prompt ${index} - A beautiful landscape with mountains and rivers`,
  urls: [`https://example.com/image-${index}.png`],
  timestamp: Date.now() - index * 1000,
  model: 'flux-schnell'
})

const createMockHistory = (count: number): HistoryItem[] => {
  return Array.from({ length: count }, (_, i) => createMockHistoryItem(i))
}

describe('History Operations Benchmarks', () => {
  let history100: HistoryItem[]
  let history500: HistoryItem[]
  let history1000: HistoryItem[]

  beforeEach(() => {
    history100 = createMockHistory(100)
    history500 = createMockHistory(500)
    history1000 = createMockHistory(1000)
  })

  bench('Load 100 history items', () => {
    // 模拟历史记录加载
    const items = history100.map(item => ({
      ...item,
      formattedDate: new Date(item.timestamp).toLocaleDateString()
    }))
    return items
  }, {
    time: 1000,
    iterations: 100
  })

  bench('Load 500 history items', () => {
    const items = history500.map(item => ({
      ...item,
      formattedDate: new Date(item.timestamp).toLocaleDateString()
    }))
    return items
  }, {
    time: 1000,
    iterations: 50
  })

  bench('Load 1000 history items', () => {
    const items = history1000.map(item => ({
      ...item,
      formattedDate: new Date(item.timestamp).toLocaleDateString()
    }))
    return items
  }, {
    time: 2000,
    iterations: 20
  })

  bench('Filter history by model', () => {
    const filtered = history500.filter(item => item.model === 'flux-schnell')
    return filtered
  }, {
    time: 500,
    iterations: 100
  })

  bench('Sort history by timestamp', () => {
    const sorted = [...history500].sort((a, b) => b.timestamp - a.timestamp)
    return sorted
  }, {
    time: 500,
    iterations: 100
  })

  bench('Search history by prompt', () => {
    const searchTerm = 'landscape'
    const results = history500.filter(item => 
      item.prompt.toLowerCase().includes(searchTerm.toLowerCase())
    )
    return results
  }, {
    time: 500,
    iterations: 100
  })
})

describe('Image Processing Benchmarks', () => {
  bench('Base64 string creation (small)', () => {
    // 模拟小图片 Base64 创建
    const data = new Uint8Array(1024) // 1KB
    const base64 = btoa(String.fromCharCode(...data.slice(0, 100)))
    return base64
  }, {
    time: 500,
    iterations: 1000
  })

  bench('URL validation', () => {
    const urls = [
      'https://example.com/image1.png',
      'https://example.com/image2.jpg',
      'data:image/png;base64,abc123',
      'blob:https://example.com/abc-def'
    ]
    
    const isValidUrl = (url: string) => {
      try {
        if (url.startsWith('data:') || url.startsWith('blob:')) return true
        new URL(url)
        return true
      } catch {
        return false
      }
    }
    
    return urls.map(isValidUrl)
  }, {
    time: 500,
    iterations: 1000
  })

  bench('Image dimensions extraction simulation', () => {
    // 模拟从 URL 提取图片尺寸信息
    const extractDimensions = (url: string) => {
      // 模拟解析 URL 中的尺寸参数
      const match = url.match(/(\d+)x(\d+)/)
      if (match) {
        return { width: parseInt(match[1]), height: parseInt(match[2]) }
      }
      return { width: 1024, height: 1024 }
    }
    
    return extractDimensions('https://example.com/image_512x512.png')
  }, {
    time: 500,
    iterations: 1000
  })
})

describe('Model Selection Benchmarks', () => {
  const models = [
    { key: 'flux-schnell', name: 'Flux Schnell', capabilities: { multipleImages: true } },
    { key: 'flux-pro', name: 'Flux Pro', capabilities: { multipleImages: true } },
    { key: 'seedream', name: 'Seedream', capabilities: { multipleImages: false } },
    { key: 'gemini-imagen', name: 'Gemini Imagen', capabilities: { intelligentResize: true } }
  ]

  bench('Model lookup by key', () => {
    const modelMap = new Map(models.map(m => [m.key, m]))
    
    modelMap.get('flux-schnell')
    modelMap.get('flux-pro')
    modelMap.get('seedream')
  }, {
    time: 500,
    iterations: 1000
  })

  bench('Model filtering by capability', () => {
    const multiImageModels = models.filter(m => m.capabilities.multipleImages)
    return multiImageModels
  }, {
    time: 500,
    iterations: 1000
  })

  bench('Model switch state update', () => {
    interface ModelState {
      currentModel: string
      ratios: string[]
      resolutions: string[]
    }
    
    const updateModelState = (model: typeof models[0]): ModelState => ({
      currentModel: model.key,
      ratios: ['1:1', '2:3', '3:2'],
      resolutions: ['1K', '2K', '4K']
    })
    
    models.forEach(m => updateModelState(m))
  }, {
    time: 500,
    iterations: 1000
  })
})

describe('Page Navigation Benchmarks', () => {
  bench('Tab state management', () => {
    const tabs = ['generate', 'batch', 'history', 'compare', 'understand']
    let currentTab = 'generate'
    
    const switchTab = (newTab: string) => {
      if (tabs.includes(newTab)) {
        currentTab = newTab
        return true
      }
      return false
    }
    
    tabs.forEach(switchTab)
  }, {
    time: 500,
    iterations: 1000
  })

  bench('Page state serialization', () => {
    const pageState = {
      generate: { prompt: 'test', ratio: '1:1', model: 'flux-schnell' },
      batch: { prompts: ['a', 'b', 'c'], ratio: '1:1' },
      history: { filter: 'all', sort: 'newest' }
    }
    
    const serialized = JSON.stringify(pageState)
    const deserialized = JSON.parse(serialized)
    return deserialized
  }, {
    time: 500,
    iterations: 1000
  })

  bench('URL hash update simulation', () => {
    const updateHash = (tab: string) => {
      // 模拟 URL hash 更新（不实际修改）
      const newHash = `#${tab}`
      return newHash
    }
    
    const tabs = ['generate', 'history', 'batch', 'compare']
    return tabs.map(updateHash)
  }, {
    time: 500,
    iterations: 1000
  })
})

describe('Format Utilities Benchmarks', () => {
  bench('formatFileSize', () => {
    const formatFileSize = (bytes: number): string => {
      if (bytes === 0) return '0 B'
      const k = 1024
      const sizes = ['B', 'KB', 'MB', 'GB']
      const i = Math.floor(Math.log(bytes) / Math.log(k))
      return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
    }
    
    formatFileSize(1024)
    formatFileSize(1048576)
    formatFileSize(1073741824)
  }, {
    time: 500,
    iterations: 1000
  })

  bench('formatDate', () => {
    const formatDate = (timestamp: number): string => {
      return new Date(timestamp).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    }
    
    const now = Date.now()
    formatDate(now)
    formatDate(now - 86400000) // 1 day ago
    formatDate(now - 604800000) // 1 week ago
  }, {
    time: 500,
    iterations: 1000
  })

  bench('formatRelativeTime', () => {
    const formatRelativeTime = (timestamp: number): string => {
      const diff = Date.now() - timestamp
      const seconds = Math.floor(diff / 1000)
      
      if (seconds < 60) return '刚刚'
      if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
      if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
      return `${Math.floor(seconds / 86400)} 天前`
    }
    
    const now = Date.now()
    formatRelativeTime(now - 30000) // 30 seconds
    formatRelativeTime(now - 1800000) // 30 minutes
    formatRelativeTime(now - 7200000) // 2 hours
  }, {
    time: 500,
    iterations: 1000
  })
})
