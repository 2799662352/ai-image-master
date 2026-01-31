// tests/core/Router.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Router, createRouter } from '../../src/renderer/src/core/Router'

describe('Router', () => {
  let router: Router

  beforeEach(() => {
    // 设置 DOM 环境
    document.body.innerHTML = `
      <button class="tab-btn" data-tab="generate">Generate</button>
      <button class="tab-btn" data-tab="history">History</button>
      <button class="tab-btn" data-tab="settings">Settings</button>
      <div id="generatePanel" class="tab-panel"></div>
      <div id="historyPanel" class="tab-panel hidden"></div>
      <div id="settingsPanel" class="tab-panel hidden"></div>
    `

    router = createRouter({
      defaultTab: 'generate',
      validTabs: ['generate', 'history', 'settings']
    })
  })

  afterEach(() => {
    router.destroy()
    document.body.innerHTML = ''
  })

  describe('navigate', () => {
    it('应该切换到有效的标签页', () => {
      const result = router.navigate('history')
      
      expect(result).toBe(true)
      expect(router.getCurrentTab()).toBe('history')
    })

    it('应该更新 tab 按钮的 active 状态', () => {
      router.navigate('history')
      
      const historyBtn = document.querySelector('[data-tab="history"]')
      const generateBtn = document.querySelector('[data-tab="generate"]')
      
      expect(historyBtn?.classList.contains('active')).toBe(true)
      expect(generateBtn?.classList.contains('active')).toBe(false)
    })

    it('应该显示目标面板并隐藏其他面板', () => {
      router.navigate('history')
      
      const historyPanel = document.getElementById('historyPanel')
      const generatePanel = document.getElementById('generatePanel')
      
      expect(historyPanel?.classList.contains('hidden')).toBe(false)
      expect(generatePanel?.classList.contains('hidden')).toBe(true)
    })

    it('应该拒绝无效的标签页', () => {
      const result = router.navigate('invalid')
      
      expect(result).toBe(false)
      expect(router.getCurrentTab()).toBe('generate')
    })

    it('应该返回 true 如果已在目标页面', () => {
      router.navigate('generate')
      const result = router.navigate('generate')
      
      expect(result).toBe(true)
    })
  })

  describe('register', () => {
    it('应该注册页面模块', () => {
      const mockPage = {
        onActivate: vi.fn(),
        onDeactivate: vi.fn()
      }
      
      router.register('generate', mockPage)
      
      expect(router.getPage('generate')).toBe(mockPage)
    })

    it('应该批量注册页面模块', () => {
      const mockPages = {
        generate: { onActivate: vi.fn() },
        history: { onActivate: vi.fn() }
      }
      
      router.registerAll(mockPages)
      
      expect(router.getPage('generate')).toBe(mockPages.generate)
      expect(router.getPage('history')).toBe(mockPages.history)
    })
  })

  describe('onChange', () => {
    it('应该在路由变更时触发回调', () => {
      const callback = vi.fn()
      router.onChange(callback)
      
      router.navigate('history')
      
      expect(callback).toHaveBeenCalledWith('history', 'generate')
    })

    it('应该返回取消订阅函数', () => {
      const callback = vi.fn()
      const unsubscribe = router.onChange(callback)
      
      unsubscribe()
      router.navigate('history')
      
      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe('getPreviousTab', () => {
    it('应该返回之前的标签页', () => {
      router.navigate('history')
      router.navigate('settings')
      
      expect(router.getPreviousTab()).toBe('history')
    })
  })

  describe('isValidTab', () => {
    it('应该验证有效标签', () => {
      expect(router.isValidTab('generate')).toBe(true)
      expect(router.isValidTab('invalid')).toBe(false)
    })
  })

  describe('addValidTab', () => {
    it('应该添加新的有效标签', () => {
      router.addValidTab('newTab')
      
      expect(router.isValidTab('newTab')).toBe(true)
    })

    it('应该不重复添加已存在的标签', () => {
      const config = router.getConfig()
      const initialCount = config.validTabs.length
      
      router.addValidTab('generate')
      
      expect(router.getConfig().validTabs.length).toBe(initialCount)
    })
  })
})
