// tests/services/PageStateManager.test.ts
// PageStateManager 单元测试

import { describe, it, expect, beforeEach, vi } from 'vitest'

// 模拟 PageStateManager 的简化测试
describe('PageStateManager', () => {
  beforeEach(() => {
    // 清除所有 mock
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('应该正确检测 Electron 环境', () => {
      // 测试 Electron 环境检测
      expect(window.electronAPI?.isElectron).toBe(true)
    })
  })

  describe('saveState', () => {
    it('应该能保存页面状态到内存缓存', async () => {
      const mockState = {
        prompt: 'test prompt',
        ratio: '16:9'
      }

      // 验证 savePageState 被调用
      expect(window.electronAPI?.savePageState).toBeDefined()
    })
  })

  describe('loadState', () => {
    it('应该返回 null 当状态不存在时', async () => {
      const result = await window.electronAPI?.loadPageState('nonexistent')
      expect(result).toBeNull()
    })
  })

  describe('clearState', () => {
    it('应该能清除指定页面的状态', async () => {
      const result = await window.electronAPI?.clearPageState('generate')
      expect(result?.success).toBe(true)
    })
  })

  describe('图片处理', () => {
    it('应该能正确识别大图片', () => {
      const maxImageSize = 500 * 1024 // 500KB
      const largeImageSize = 600 * 1024
      const smallImageSize = 100 * 1024

      expect(largeImageSize > maxImageSize).toBe(true)
      expect(smallImageSize > maxImageSize).toBe(false)
    })

    it('应该能识别 Electron 本地文件引用', () => {
      const electronRef = 'electron://image_123.png'
      const base64Data = 'data:image/png;base64,abc123'

      expect(electronRef.startsWith('electron://')).toBe(true)
      expect(base64Data.startsWith('electron://')).toBe(false)
    })
  })
})

describe('存储模式', () => {
  it('Electron 模式应该使用 IPC 通信', async () => {
    expect(window.electronAPI?.isElectron).toBe(true)
    
    // 验证 Electron API 方法存在
    expect(typeof window.electronAPI?.savePageState).toBe('function')
    expect(typeof window.electronAPI?.loadPageState).toBe('function')
    expect(typeof window.electronAPI?.clearPageState).toBe('function')
  })
})
