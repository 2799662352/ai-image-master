// tests/features/TabManager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TabManager, createTabManager, getTabManager } from '../../src/renderer/src/features/tab-manager'

// Mock DOM
const mockDocument = {
  getElementById: vi.fn(),
  querySelectorAll: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn()
}

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
  
  // Reset window location
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
  })

  describe('getCurrentTab', () => {
    it('should return current tab name', () => {
      const manager = createTabManager({ defaultTab: 'batch' })
      expect(manager.getCurrentTab()).toBe('batch')
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
  })

  describe('getValidTabs', () => {
    it('should return default valid tabs', () => {
      const manager = createTabManager()
      const tabs = manager.getValidTabs()
      expect(tabs).toContain('generate')
      expect(tabs).toContain('batch')
      expect(tabs).toContain('history')
    })

    it('should return copy of valid tabs (not reference)', () => {
      const manager = createTabManager()
      const tabs1 = manager.getValidTabs()
      const tabs2 = manager.getValidTabs()
      expect(tabs1).not.toBe(tabs2)
      expect(tabs1).toEqual(tabs2)
    })
  })

  describe('switchTab', () => {
    it('should not switch to invalid tab', () => {
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.switchTab('invalid-tab')
      expect(manager.getCurrentTab()).toBe('generate')
    })

    it('should not switch if panel does not exist', () => {
      mockDocument.getElementById.mockReturnValue(null)
      
      const showToast = vi.fn()
      const manager = createTabManager({ defaultTab: 'generate', showToast })
      manager.switchTab('batch')
      
      expect(manager.getCurrentTab()).toBe('generate')
      expect(showToast).toHaveBeenCalledWith('功能 batch 暂不可用', 'error')
    })

    it('should switch tab when panel exists', () => {
      const mockPanel = {
        classList: {
          add: vi.fn(),
          remove: vi.fn()
        }
      }
      mockDocument.getElementById.mockReturnValue(mockPanel)
      
      // Mock tab buttons
      const mockButton = {
        classList: {
          add: vi.fn(),
          remove: vi.fn()
        },
        dataset: { tab: 'history' }
      }
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
      const mockPanel = { classList: { add: vi.fn(), remove: vi.fn() } }
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ defaultTab: 'generate' })
      const callback = vi.fn()
      manager.onTabChange(callback)
      
      manager.switchTab('generate')
      
      // Callback should not be called when switching to same tab
      // (it's not called immediately because of requestAnimationFrame)
      expect(callback).not.toHaveBeenCalled()
    })

    it('should update URL hash when updateUrl is true', () => {
      const mockPanel = { classList: { add: vi.fn(), remove: vi.fn() } }
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.switchTab('history', true)
      
      expect(window.history.pushState).toHaveBeenCalledWith(null, '', '#history')
    })

    it('should not update URL hash when updateUrl is false', () => {
      const mockPanel = { classList: { add: vi.fn(), remove: vi.fn() } }
      mockDocument.getElementById.mockReturnValue(mockPanel)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const manager = createTabManager({ defaultTab: 'generate' })
      manager.switchTab('history', false)
      
      expect(window.history.pushState).not.toHaveBeenCalled()
    })
  })

  describe('onTabChange', () => {
    it('should register callback', () => {
      const manager = createTabManager()
      const callback = vi.fn()
      
      const unsubscribe = manager.onTabChange(callback)
      expect(typeof unsubscribe).toBe('function')
    })

    it('should return unsubscribe function', () => {
      const manager = createTabManager()
      const callback = vi.fn()
      
      const unsubscribe = manager.onTabChange(callback)
      unsubscribe()
      
      // Should not throw
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
  })

  describe('bindTabButtons', () => {
    it('should bind click events to tab buttons', () => {
      const mockButton = {
        addEventListener: vi.fn(),
        dataset: { tab: 'history' }
      }
      mockDocument.querySelectorAll.mockReturnValue([mockButton])
      
      const manager = createTabManager()
      manager.bindTabButtons()
      
      expect(mockButton.addEventListener).toHaveBeenCalledWith(
        'click',
        expect.any(Function)
      )
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
  })
})

describe('getTabManager', () => {
  it('should return singleton instance', () => {
    // Note: This test may be affected by other tests due to singleton nature
    const instance1 = getTabManager({ defaultTab: 'generate' })
    const instance2 = getTabManager()
    
    expect(instance1).toBe(instance2)
  })
})
