// tests/features/TabManager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TabManager, createTabManager, getTabManager, type PageModule, type TabManagerConfig } from '../../src/renderer/src/features/tab-manager'

// Mock DOM elements
const createMockPanel = () => ({
  classList: {
    add: vi.fn(),
    remove: vi.fn()
  },
  id: ''
})

const createMockButton = (tabName: string) => ({
  classList: {
    add: vi.fn(),
    remove: vi.fn()
  },
  dataset: { tab: tabName },
  addEventListener: vi.fn()
})

// Mock document
const mockDocument = {
  getElementById: vi.fn(),
  querySelectorAll: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn()
}

// Reset singleton between tests
let tabManagerSingleton: TabManager | null = null

// Setup DOM mocks
beforeEach(() => {
  vi.stubGlobal('document', mockDocument)
  
  // Reset mocks
  mockDocument.getElementById.mockReset()
  mockDocument.querySelectorAll.mockReset()
  mockDocument.addEventListener.mockReset()
  mockDocument.removeEventListener.mockReset()
  
  // Default mock implementations
  mockDocument.querySelectorAll.mockReturnValue([])
  
  // Reset window location and history
  if (typeof window !== 'undefined') {
    (window as any).location = {
      hash: '',
      pathname: '/',
      href: 'http://localhost/',
      origin: 'http://localhost'
    };
    (window as any).history = {
      pushState: vi.fn(),
      replaceState: vi.fn()
    }
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('TabManager', () => {
  describe('constructor', () => {
    it('should create instance with default config', () => {
      const manager = createTabManager()
      expect(manager).toBeInstanceOf(TabManager)
      expect(manager.getCurrentTab()).toBe('generate')
    })

    it('should accept custom default tab', () => {
      const manager = createTabManager({ defaultTab: 'history' })
      expect(manager.getCurrentTab()).toBe('history')
    })

    it('should accept custom valid tabs', () => {
      const manager = createTabManager({ validTabs: ['tab1', 'tab2'] })
      expect(manager.getValidTabs()).toEqual(['tab1', 'tab2'])
    })

    it('should use default valid tabs when not provided', () => {
      const manager = createTabManager()
      const tabs = manager.getValidTabs()
      expect(tabs).toEqual(['generate', 'batch', 'compare', 'history', 'understand'])
    })

    it('should accept showToast callback in config', () => {
      const showToast = vi.fn()
      const manager = createTabManager({ showToast })
      
      // Verify showToast is stored (will be used when switching fails)
      mockDocument.getElementById.mockReturnValue(null)
      manager.switchTab('batch')
      expect(showToast).toHaveBeenCalledWith('功能 batch 暂不可用', 'error')
    })
  })

  describe('getCurrentTab', () => {
    it('should return current tab name', () => {
      const manager = createTabManager({ defaultTab: 'batch' })
      expect(manager.getCurrentTab()).toBe('batch')
    })

    it('should return updated tab after switch', () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.switchTab('history')
      
      expect(manager.getCurrentTab()).toBe('history')
    })
  })

  describe('isCurrentTab', () => {
    it('should return true for current tab', () => {
      const manager = createTabManager({ defaultTab: 'generate' })
      expect(manager.isCurrentTab('generate')).toBe(true)
    })

    it('should return false for non-current tab', () => {
      const manager = createTabManager({ defaultTab: 'generate' })
      expect(manager.isCurrentTab('history')).toBe(false)
    })

    it('should correctly identify current tab after switch', () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.switchTab('batch')
      
      expect(manager.isCurrentTab('batch')).toBe(true)
      expect(manager.isCurrentTab('generate')).toBe(false)
    })
  })

  describe('getValidTabs', () => {
    it('should return default valid tabs', () => {
      const manager = createTabManager()
      const tabs = manager.getValidTabs()
      expect(tabs).toContain('generate')
      expect(tabs).toContain('batch')
      expect(tabs).toContain('history')
      expect(tabs).toContain('compare')
      expect(tabs).toContain('understand')
    })

    it('should return copy of valid tabs (not reference)', () => {
      const manager = createTabManager()
      const tabs1 = manager.getValidTabs()
      const tabs2 = manager.getValidTabs()
      expect(tabs1).not.toBe(tabs2)
      expect(tabs1).toEqual(tabs2)
    })

    it('should return custom valid tabs when configured', () => {
      const customTabs = ['custom1', 'custom2', 'custom3']
      const manager = createTabManager({ validTabs: customTabs })
      expect(manager.getValidTabs()).toEqual(customTabs)
    })
  })

  describe('switchTab', () => {
    it('should not switch to invalid tab', () => {
      const manager = createTabManager({ defaultTab: 'generate' })
      const consoleSpy = vi.spyOn(console, 'warn')
      
      manager.switchTab('invalid-tab')
      
      expect(manager.getCurrentTab()).toBe('generate')
      expect(consoleSpy).toHaveBeenCalledWith('无效的标签名: invalid-tab')
    })

    it('should not switch if panel does not exist', () => {
      mockDocument.getElementById.mockReturnValue(null)
      
      const showToast = vi.fn()
      const manager = createTabManager({ defaultTab: 'generate', showToast })
      const consoleSpy = vi.spyOn(console, 'warn')
      
      manager.switchTab('batch')
      
      expect(manager.getCurrentTab()).toBe('generate')
      expect(showToast).toHaveBeenCalledWith('功能 batch 暂不可用', 'error')
      expect(consoleSpy).toHaveBeenCalledWith('面板 batchPanel 不存在，无法切换')
    })

    it('should switch tab when panel exists', () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      
      const mockButton = createMockButton('history')
      mockDocument.querySelectorAll.mockImplementation((selector: string) => {
        if (selector === '.tab-btn') return [mockButton]
        if (selector === '.tab-panel') return [mockPanel]
        return []
      })
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.switchTab('history')
      
      expect(manager.getCurrentTab()).toBe('history')
    })

    it('should not switch to same tab', () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ defaultTab: 'generate' })
      const callback = vi.fn()
      manager.onTabChange(callback)
      
      manager.switchTab('generate')
      
      // Callback should not be called when switching to same tab
      expect(callback).not.toHaveBeenCalled()
    })

    it('should update URL hash when updateUrl is true', () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.switchTab('history', true)
      
      expect(window.history.pushState).toHaveBeenCalledWith(null, '', '#history')
    })

    it('should not update URL hash when updateUrl is false', () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.switchTab('history', false)
      
      expect(window.history.pushState).not.toHaveBeenCalled()
    })

    it('should update tab button classes', () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      
      const historyButton = createMockButton('history')
      const generateButton = createMockButton('generate')
      
      mockDocument.querySelectorAll.mockImplementation((selector: string) => {
        if (selector === '.tab-btn') return [historyButton, generateButton]
        if (selector === '.tab-panel') return [mockPanel]
        return []
      })
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.switchTab('history')
      
      // Both buttons should have 'active' removed
      expect(historyButton.classList.remove).toHaveBeenCalledWith('active')
      expect(generateButton.classList.remove).toHaveBeenCalledWith('active')
      
      // Only history button should get 'active' added
      expect(historyButton.classList.add).toHaveBeenCalledWith('active')
    })

    it('should hide all panels and show target panel', () => {
      const targetPanel = createMockPanel()
      const otherPanel = createMockPanel()
      
      mockDocument.getElementById.mockReturnValue(targetPanel)
      mockDocument.querySelectorAll.mockImplementation((selector: string) => {
        if (selector === '.tab-btn') return []
        if (selector === '.tab-panel') return [targetPanel, otherPanel]
        return []
      })
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.switchTab('history')
      
      // All panels should be hidden
      expect(targetPanel.classList.add).toHaveBeenCalledWith('hidden')
      expect(otherPanel.classList.add).toHaveBeenCalledWith('hidden')
      
      // Target panel should be shown
      expect(targetPanel.classList.remove).toHaveBeenCalledWith('hidden')
    })

    it('should trigger tab change callbacks via requestAnimationFrame', async () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ defaultTab: 'generate' })
      const callback = vi.fn()
      manager.onTabChange(callback)
      
      manager.switchTab('history')
      
      // Wait for requestAnimationFrame callbacks
      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledWith('history', 'generate')
      }, { timeout: 100 })
    })

    it('should handle callback errors gracefully', async () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ defaultTab: 'generate' })
      const errorCallback = vi.fn(() => { throw new Error('Test error') })
      const normalCallback = vi.fn()
      const consoleSpy = vi.spyOn(console, 'error')
      
      manager.onTabChange(errorCallback)
      manager.onTabChange(normalCallback)
      
      manager.switchTab('history')
      
      // Wait for requestAnimationFrame callbacks
      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith('Tab change callback error:', expect.any(Error))
      }, { timeout: 100 })
    })
  })

  describe('onTabChange', () => {
    it('should register callback', () => {
      const manager = createTabManager()
      const callback = vi.fn()
      
      const unsubscribe = manager.onTabChange(callback)
      expect(typeof unsubscribe).toBe('function')
    })

    it('should return unsubscribe function that removes callback', async () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager()
      const callback = vi.fn()
      
      const unsubscribe = manager.onTabChange(callback)
      unsubscribe()
      
      manager.switchTab('history')
      
      // Wait a bit to ensure callbacks would have fired
      await new Promise(r => setTimeout(r, 50))
      
      expect(callback).not.toHaveBeenCalled()
    })

    it('should handle multiple callbacks', async () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'generatePanel' || id === 'historyPanel') {
          return mockPanel
        }
        return null
      })
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ 
        defaultTab: 'generate',
        validTabs: ['generate', 'history', 'batch']
      })
      const callback1 = vi.fn()
      const callback2 = vi.fn()
      
      manager.onTabChange(callback1)
      manager.onTabChange(callback2)
      
      manager.switchTab('history')
      
      // 回调在双重 requestAnimationFrame 中异步调用
      // 等待两帧动画
      await new Promise(resolve => requestAnimationFrame(() => {
        requestAnimationFrame(resolve)
      }))
      
      expect(callback1).toHaveBeenCalledWith('history', 'generate')
      expect(callback2).toHaveBeenCalledWith('history', 'generate')
    })

    it('should safely handle unsubscribe when callback not found', () => {
      const manager = createTabManager()
      const callback = vi.fn()
      
      const unsubscribe = manager.onTabChange(callback)
      
      // Double unsubscribe should not throw
      unsubscribe()
      unsubscribe()
      
      expect(true).toBe(true)
    })
  })

  describe('setPages', () => {
    it('should set pages reference', () => {
      const manager = createTabManager()
      const pages = {
        generate: { onActivate: vi.fn(), onDeactivate: vi.fn() }
      }
      
      manager.setPages(pages)
      
      // No direct way to verify, but should not throw
      expect(true).toBe(true)
    })

    it('should allow pages with loadPanel method', () => {
      const manager = createTabManager()
      const pages: Record<string, PageModule> = {
        generate: { 
          onActivate: vi.fn(), 
          onDeactivate: vi.fn(),
          loadPanel: vi.fn()
        }
      }
      
      manager.setPages(pages)
      expect(true).toBe(true)
    })
  })

  describe('Page lifecycle', () => {
    it('should call onDeactivate on previous page when switching', async () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const generatePage: PageModule = { onDeactivate: vi.fn(), onActivate: vi.fn() }
      const historyPage: PageModule = { onDeactivate: vi.fn(), onActivate: vi.fn() }
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.setPages({ generate: generatePage, history: historyPage })
      
      manager.switchTab('history')
      
      await vi.waitFor(() => {
        expect(generatePage.onDeactivate).toHaveBeenCalled()
      }, { timeout: 100 })
    })

    it('should call onActivate on new page when switching', async () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const generatePage: PageModule = { onDeactivate: vi.fn(), onActivate: vi.fn() }
      const historyPage: PageModule = { onDeactivate: vi.fn(), onActivate: vi.fn() }
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.setPages({ generate: generatePage, history: historyPage })
      
      manager.switchTab('history')
      
      await vi.waitFor(() => {
        expect(historyPage.onActivate).toHaveBeenCalled()
      }, { timeout: 100 })
    })

    it('should handle page without onDeactivate method', async () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const generatePage: PageModule = {} // No onDeactivate
      const historyPage: PageModule = { onActivate: vi.fn() }
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.setPages({ generate: generatePage, history: historyPage })
      
      // Should not throw
      manager.switchTab('history')
      
      await vi.waitFor(() => {
        expect(historyPage.onActivate).toHaveBeenCalled()
      }, { timeout: 100 })
    })

    it('should handle page without onActivate method', async () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'generatePanel' || id === 'historyPanel') {
          return mockPanel
        }
        return null
      })
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const generatePage: PageModule = { onDeactivate: vi.fn() }
      const historyPage: PageModule = {} // No onActivate
      const consoleSpy = vi.spyOn(console, 'warn')
      
      const manager = createTabManager({ 
        defaultTab: 'generate',
        validTabs: ['generate', 'history']
      })
      manager.setPages({ generate: generatePage, history: historyPage })
      
      manager.switchTab('history')
      
      // 等待两帧动画
      await new Promise(resolve => requestAnimationFrame(() => {
        requestAnimationFrame(resolve)
      }))
      
      expect(consoleSpy).toHaveBeenCalledWith('⚠️ 页面 history 未找到或未完全初始化')
    })

    it('should handle onDeactivate throwing error', async () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const generatePage: PageModule = { 
        onDeactivate: vi.fn(() => { throw new Error('Deactivate error') }),
        onActivate: vi.fn()
      }
      const historyPage: PageModule = { onActivate: vi.fn() }
      const consoleSpy = vi.spyOn(console, 'error')
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.setPages({ generate: generatePage, history: historyPage })
      
      manager.switchTab('history')
      
      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith('页面 generate 失活失败:', expect.any(Error))
      }, { timeout: 100 })
    })

    it('should handle onActivate throwing error', async () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const generatePage: PageModule = { onDeactivate: vi.fn() }
      const historyPage: PageModule = { 
        onActivate: vi.fn(() => { throw new Error('Activate error') })
      }
      const consoleSpy = vi.spyOn(console, 'error')
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.setPages({ generate: generatePage, history: historyPage })
      
      manager.switchTab('history')
      
      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith('页面 history 激活失败:', expect.any(Error))
      }, { timeout: 100 })
    })

    it('should handle missing page in pages object', async () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const consoleSpy = vi.spyOn(console, 'warn')
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.setPages({}) // Empty pages
      
      manager.switchTab('history')
      
      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith('⚠️ 页面 history 未找到或未完全初始化')
      }, { timeout: 100 })
    })
  })

  describe('initHashRouter', () => {
    it('should add hashchange event listener', () => {
      const manager = createTabManager()
      manager.initHashRouter()
      
      expect(window.addEventListener).toHaveBeenCalledWith(
        'hashchange',
        expect.any(Function)
      )
    })

    it('should handle initial hash on router init', () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      // Set initial hash
      ;(window as any).location.hash = '#history'
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.initHashRouter()
      
      expect(manager.getCurrentTab()).toBe('history')
    })

    it('should switch to default tab when hash is empty', () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      ;(window as any).location.hash = ''
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.initHashRouter()
      
      expect(manager.getCurrentTab()).toBe('generate')
    })

    it('should ignore invalid hash values', () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      ;(window as any).location.hash = '#invalid-tab'
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.initHashRouter()
      
      // Should remain on default tab
      expect(manager.getCurrentTab()).toBe('generate')
    })

    it('should respond to hashchange events', () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      let hashChangeHandler: (() => void) | null = null
      ;(window as any).addEventListener = vi.fn((event: string, handler: () => void) => {
        if (event === 'hashchange') {
          hashChangeHandler = handler
        }
      })
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.initHashRouter()
      
      // Simulate hash change
      ;(window as any).location.hash = '#batch'
      if (hashChangeHandler) {
        hashChangeHandler()
      }
      
      expect(manager.getCurrentTab()).toBe('batch')
    })
  })

  describe('bindTabButtons', () => {
    it('should bind click events to tab buttons', () => {
      const mockButton = createMockButton('history')
      mockDocument.querySelectorAll.mockReturnValue([mockButton])
      
      const manager = createTabManager()
      manager.bindTabButtons()
      
      expect(mockButton.addEventListener).toHaveBeenCalledWith(
        'click',
        expect.any(Function)
      )
    })

    it('should handle button click and switch tab', () => {
      const mockPanel = createMockPanel()
      const mockButton = createMockButton('history')
      
      let clickHandler: ((e: any) => void) | null = null
      mockButton.addEventListener = vi.fn((event: string, handler: (e: any) => void) => {
        if (event === 'click') {
          clickHandler = handler
        }
      })
      
      mockDocument.querySelectorAll.mockImplementation((selector: string) => {
        if (selector === '.tab-btn') return [mockButton]
        if (selector === '.tab-panel') return [mockPanel]
        return []
      })
      mockDocument.getElementById.mockReturnValue(mockPanel)
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.bindTabButtons()
      
      // Simulate click
      if (clickHandler) {
        clickHandler({ currentTarget: mockButton })
      }
      
      expect(manager.getCurrentTab()).toBe('history')
    })

    it('should warn when button has no data-tab attribute', () => {
      const mockButton = { 
        addEventListener: vi.fn(),
        dataset: {} // No tab attribute
      }
      
      let clickHandler: ((e: any) => void) | null = null
      mockButton.addEventListener = vi.fn((event: string, handler: (e: any) => void) => {
        if (event === 'click') {
          clickHandler = handler
        }
      })
      
      mockDocument.querySelectorAll.mockReturnValue([mockButton])
      const consoleSpy = vi.spyOn(console, 'warn')
      
      const manager = createTabManager()
      manager.bindTabButtons()
      
      // Simulate click
      if (clickHandler) {
        clickHandler({ currentTarget: mockButton })
      }
      
      expect(consoleSpy).toHaveBeenCalledWith('按钮缺少 data-tab 属性:', mockButton)
    })

    it('should bind multiple buttons', () => {
      const mockButton1 = createMockButton('history')
      const mockButton2 = createMockButton('batch')
      
      mockDocument.querySelectorAll.mockReturnValue([mockButton1, mockButton2])
      
      const manager = createTabManager()
      manager.bindTabButtons()
      
      expect(mockButton1.addEventListener).toHaveBeenCalledWith('click', expect.any(Function))
      expect(mockButton2.addEventListener).toHaveBeenCalledWith('click', expect.any(Function))
    })
  })

  describe('destroy', () => {
    it('should clean up resources', () => {
      const manager = createTabManager()
      manager.setPages({ test: { onActivate: vi.fn() } })
      manager.onTabChange(vi.fn())
      
      manager.destroy()
      
      // Should not throw and should clean up
      expect(true).toBe(true)
    })

    it('should remove all callbacks after destroy', async () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ defaultTab: 'generate' })
      const callback = vi.fn()
      manager.onTabChange(callback)
      
      manager.destroy()
      
      // Switch tab after destroy
      manager.switchTab('history')
      
      // Wait for potential callbacks
      await new Promise(r => setTimeout(r, 50))
      
      // Callback should not be called since it was cleared
      expect(callback).not.toHaveBeenCalled()
    })

    it('should clear pages after destroy', async () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const historyPage: PageModule = { onActivate: vi.fn() }
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.setPages({ history: historyPage })
      
      manager.destroy()
      manager.switchTab('history')
      
      // Wait for activation
      await new Promise(r => setTimeout(r, 50))
      
      // onActivate should not be called since pages were cleared
      expect(historyPage.onActivate).not.toHaveBeenCalled()
    })
  })

  describe('edge cases', () => {
    it('should handle rapid tab switching', () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ defaultTab: 'generate' })
      
      // Rapid switches
      manager.switchTab('history')
      manager.switchTab('batch')
      manager.switchTab('compare')
      manager.switchTab('understand')
      
      expect(manager.getCurrentTab()).toBe('understand')
    })

    it('should handle updateTabUI when targetPanel returns null after initial check', () => {
      // First call returns a valid panel (for switchTab validation)
      // Subsequent calls in updateTabUI return null
      let callCount = 0
      mockDocument.getElementById.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return createMockPanel() // First call for validation passes
        }
        return null // Second call in updateTabUI returns null
      })
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ defaultTab: 'generate' })
      
      // Should not throw even when panel becomes null during UI update
      expect(() => manager.switchTab('history')).not.toThrow()
      expect(manager.getCurrentTab()).toBe('history')
    })

    it('should handle empty valid tabs array', () => {
      const manager = createTabManager({ validTabs: [] })
      const consoleSpy = vi.spyOn(console, 'warn')
      
      manager.switchTab('generate')
      
      // Should warn about invalid tab since validTabs is empty
      expect(consoleSpy).toHaveBeenCalledWith('无效的标签名: generate')
    })

    it('should handle undefined panel classList remove call', () => {
      const mockPanel = createMockPanel()
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'historyPanel') return mockPanel
        return null
      })
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ defaultTab: 'generate' })
      
      // Should not throw even if some operations might fail silently
      expect(() => manager.switchTab('history')).not.toThrow()
    })
  })
})

describe('getTabManager', () => {
  // Use module-level reset for singleton tests
  beforeEach(async () => {
    // Import fresh module to reset singleton
    vi.resetModules()
  })

  it('should return singleton instance', async () => {
    // Re-import to get fresh singleton
    const { getTabManager: getTabManagerFresh } = await import('../../src/renderer/src/features/tab-manager')
    
    const instance1 = getTabManagerFresh({ defaultTab: 'generate' })
    const instance2 = getTabManagerFresh()
    
    expect(instance1).toBe(instance2)
  })

  it('should use config from first initialization', async () => {
    const { getTabManager: getTabManagerFresh } = await import('../../src/renderer/src/features/tab-manager')
    
    const instance1 = getTabManagerFresh({ defaultTab: 'history' })
    const instance2 = getTabManagerFresh({ defaultTab: 'batch' })
    
    // Both should be history (first config wins)
    expect(instance1.getCurrentTab()).toBe('history')
    expect(instance2.getCurrentTab()).toBe('history')
  })
})

describe('createTabManager', () => {
  it('should create new instance each time', () => {
    const instance1 = createTabManager({ defaultTab: 'generate' })
    const instance2 = createTabManager({ defaultTab: 'history' })
    
    expect(instance1).not.toBe(instance2)
    expect(instance1.getCurrentTab()).toBe('generate')
    expect(instance2.getCurrentTab()).toBe('history')
  })

  it('should work with no config', () => {
    const instance = createTabManager()
    expect(instance).toBeInstanceOf(TabManager)
    expect(instance.getCurrentTab()).toBe('generate')
  })
})
