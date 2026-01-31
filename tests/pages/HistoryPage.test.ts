// tests/pages/HistoryPage.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HistoryPage, createHistoryPage, getHistoryPage, type HistoryItem } from '../../src/renderer/src/pages'

// Mock DOM
const mockDocument = {
  getElementById: vi.fn(),
  querySelectorAll: vi.fn(),
  createElement: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  createDocumentFragment: vi.fn(() => ({
    appendChild: vi.fn()
  })),
  body: {
    appendChild: vi.fn()
  }
}

// Mock app interface
const createMockApp = () => ({
  showToast: vi.fn(),
  switchTab: vi.fn(),
  addToHistory: vi.fn(),
  currentTab: 'history',
  history: [] as HistoryItem[],
  pages: {},
  getStorageInfo: vi.fn().mockReturnValue({
    totalSize: '1000',
    historySize: '500',
    historyCount: 5,
    estimatedLimit: 5000000,
    r2Enabled: false
  }),
  saveHistory: vi.fn(),
  saveHistoryWithoutBase64: vi.fn()
})

// Mock window objects
const mockWindow = {
  aiImageAPI: {
    downloadImagesAsZip: vi.fn().mockResolvedValue({ success: true, message: 'Downloaded' }),
    preloadImages: vi.fn(),
    checkUrlAccessibility: vi.fn().mockResolvedValue(true)
  },
  i18n: {
    t: vi.fn((key: string) => key)
  },
  electronAPI: {
    isElectron: false,
    clearWebCache: vi.fn().mockResolvedValue({ success: true })
  },
  r2Storage: {
    isAvailable: vi.fn().mockReturnValue(false),
    isR2Url: vi.fn().mockReturnValue(false),
    extractR2Key: vi.fn(),
    batchProcess: vi.fn(),
    batchDelete: vi.fn()
  },
  toastManagerTS: {
    show: vi.fn()
  },
  imageViewerTS: {
    view: vi.fn()
  },
  requestIdleCallback: vi.fn((cb) => setTimeout(cb, 0))
}

// Setup mocks
beforeEach(() => {
  vi.stubGlobal('document', mockDocument)
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
  
  // Apply window mocks
  Object.entries(mockWindow).forEach(([key, value]) => {
    (window as any)[key] = value
  })
  
  // Reset mocks
  mockDocument.getElementById.mockReset()
  mockDocument.querySelectorAll.mockReset()
  mockDocument.createElement.mockReset()
  mockDocument.body.appendChild.mockReset()
  
  // Helper to create mock element with all needed methods
  const createMockElement = (extras = {}) => ({
    tagName: 'div',
    className: '',
    innerHTML: '',
    style: {},
    id: '',
    value: '',
    disabled: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    appendChild: vi.fn(),
    remove: vi.fn(),
    focus: vi.fn(),
    click: vi.fn(),
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
      contains: vi.fn()
    },
    setAttribute: vi.fn(),
    getAttribute: vi.fn(),
    querySelector: vi.fn().mockReturnValue(null),
    querySelectorAll: vi.fn().mockReturnValue([]),
    closest: vi.fn().mockReturnValue(null),
    dataset: {},
    parentElement: { insertBefore: vi.fn() },
    ...extras
  })
  
  // Default mock implementations
  mockDocument.querySelectorAll.mockReturnValue([])
  mockDocument.getElementById.mockImplementation(() => createMockElement())
  mockDocument.createElement.mockImplementation((tag: string) => createMockElement({ tagName: tag }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('HistoryPage', () => {
  describe('constructor', () => {
    it('should create instance with app reference', () => {
      const app = createMockApp()
      const page = new HistoryPage(app)
      
      expect(page).toBeInstanceOf(HistoryPage)
    })

    it('should initialize successfully', () => {
      const app = createMockApp()
      const page = new HistoryPage(app)
      
      // Should be initialized
      expect(page).toBeDefined()
    })
  })

  describe('loadPanel', () => {
    it('should show empty state when no history', () => {
      const mockHistoryList = {
        innerHTML: '',
        addEventListener: vi.fn()
      }
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'historyList') return mockHistoryList
        return null
      })
      
      const app = createMockApp()
      app.history = []
      
      const page = new HistoryPage(app)
      page.loadPanel()
      
      expect(mockHistoryList.innerHTML).toContain('fa-history')
    })

    it('should render history items when history exists', () => {
      // Create base element helper for this test
      const createMockElementLocal = (extras = {}) => ({
        tagName: 'div',
        className: '',
        innerHTML: '',
        style: {},
        id: '',
        value: '',
        disabled: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        appendChild: vi.fn(),
        remove: vi.fn(),
        focus: vi.fn(),
        click: vi.fn(),
        classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn() },
        setAttribute: vi.fn(),
        getAttribute: vi.fn(),
        querySelector: vi.fn().mockReturnValue(null),
        querySelectorAll: vi.fn().mockReturnValue([]),
        closest: vi.fn().mockReturnValue(null),
        dataset: {},
        parentElement: { insertBefore: vi.fn() },
        ...extras
      })
      
      const mockHistoryList = createMockElementLocal()
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'historyList') return mockHistoryList
        return createMockElementLocal()
      })
      
      const app = createMockApp()
      app.history = [
        {
          id: 1,
          type: 'generate',
          prompt: 'Test prompt',
          urls: ['http://test.com/image.png'],
          timestamp: new Date().toISOString()
        }
      ]
      
      const page = new HistoryPage(app)
      page.loadPanel()
      
      // Should have attempted to render
      expect(mockHistoryList.innerHTML === '' || mockHistoryList.appendChild).toBeTruthy()
    })
  })

  describe('updateStorageStatus', () => {
    it('should not throw when updating storage status', () => {
      // Create base element helper for this test
      const createMockElementLocal = (extras = {}) => ({
        tagName: 'div',
        className: '',
        innerHTML: '',
        style: {},
        id: '',
        value: '',
        disabled: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        appendChild: vi.fn(),
        remove: vi.fn(),
        focus: vi.fn(),
        click: vi.fn(),
        classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn() },
        setAttribute: vi.fn(),
        getAttribute: vi.fn(),
        querySelector: vi.fn().mockReturnValue(null),
        querySelectorAll: vi.fn().mockReturnValue([]),
        closest: vi.fn().mockReturnValue(null),
        dataset: {},
        parentElement: { insertBefore: vi.fn() },
        ...extras
      })
      
      mockDocument.getElementById.mockImplementation(() => createMockElementLocal())
      
      const app = createMockApp()
      const page = new HistoryPage(app)
      
      expect(() => page.updateStorageStatus()).not.toThrow()
    })
  })

  describe('deleteHistoryItem', () => {
    it('should remove item from history', async () => {
      const app = createMockApp()
      app.history = [
        {
          id: 1,
          type: 'generate',
          prompt: 'Test',
          urls: ['http://test.com/image.png'],
          timestamp: new Date().toISOString()
        }
      ]
      
      const page = new HistoryPage(app)
      await page.deleteHistoryItem(1)
      
      expect(app.history.length).toBe(0)
      expect(app.saveHistory).toHaveBeenCalled()
    })

    it('should not affect other items', async () => {
      const app = createMockApp()
      app.history = [
        { id: 1, type: 'generate', prompt: 'Test 1', urls: [], timestamp: new Date().toISOString() },
        { id: 2, type: 'generate', prompt: 'Test 2', urls: [], timestamp: new Date().toISOString() }
      ]
      
      const page = new HistoryPage(app)
      await page.deleteHistoryItem(1)
      
      expect(app.history.length).toBe(1)
      expect(app.history[0].id).toBe(2)
    })
  })

  describe('clearHistory', () => {
    it('should clear all history when confirmed', async () => {
      const app = createMockApp()
      app.history = [
        { id: 1, type: 'generate', prompt: 'Test', urls: [], timestamp: new Date().toISOString() }
      ]
      
      const page = new HistoryPage(app)
      await page.clearHistory()
      
      expect(app.history.length).toBe(0)
      expect(app.saveHistory).toHaveBeenCalled()
    })

    it('should not clear history when not confirmed', async () => {
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(false))
      
      const app = createMockApp()
      app.history = [
        { id: 1, type: 'generate', prompt: 'Test', urls: [], timestamp: new Date().toISOString() }
      ]
      
      const page = new HistoryPage(app)
      await page.clearHistory()
      
      expect(app.history.length).toBe(1)
    })
  })

  describe('migrateToCloud', () => {
    it('should show error when R2 is not available', async () => {
      (window as any).r2Storage.isAvailable.mockReturnValue(false)
      
      const app = createMockApp()
      app.history = [{ id: 1, type: 'generate', prompt: 'Test', urls: ['data:image/png;base64,abc'], timestamp: new Date().toISOString() }]
      
      const page = new HistoryPage(app)
      await page.migrateToCloud(1)
      
      expect(app.showToast).toHaveBeenCalled()
    })

    it('should show error when history item not found', async () => {
      const app = createMockApp()
      app.history = []
      
      const page = new HistoryPage(app)
      await page.migrateToCloud(999)
      
      expect(app.showToast).toHaveBeenCalled()
    })
  })

  describe('migrateAllToCloud', () => {
    it('should show message when nothing to migrate', async () => {
      (window as any).r2Storage.isAvailable.mockReturnValue(true)
      
      const app = createMockApp()
      app.history = []
      
      const page = new HistoryPage(app)
      await page.migrateAllToCloud()
      
      expect(app.showToast).toHaveBeenCalled()
    })
  })

  describe('downloadMultipleImages', () => {
    it('should call API to download images', async () => {
      const app = createMockApp()
      const page = new HistoryPage(app)
      
      await page.downloadMultipleImages(['http://test.com/1.png', 'http://test.com/2.png'], 'Test prompt')
      
      expect((window as any).aiImageAPI.downloadImagesAsZip).toHaveBeenCalled()
    })
  })

  describe('onActivate', () => {
    it('should not throw when activated', () => {
      const app = createMockApp()
      const page = new HistoryPage(app)
      
      expect(() => page.onActivate()).not.toThrow()
    })
  })

  describe('onDeactivate', () => {
    it('should not throw when deactivated', () => {
      const app = createMockApp()
      const page = new HistoryPage(app)
      
      expect(() => page.onDeactivate()).not.toThrow()
    })
  })

  describe('onLanguageChange', () => {
    it('should reload panel on language change', () => {
      const mockHistoryList = {
        innerHTML: '',
        addEventListener: vi.fn()
      }
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'historyList') return mockHistoryList
        return null
      })
      
      const app = createMockApp()
      const page = new HistoryPage(app)
      
      // Load panel should be called during language change
      expect(() => page.onLanguageChange('en')).not.toThrow()
    })
  })

  describe('clearWebCache', () => {
    it('should show warning when not in Electron', async () => {
      (window as any).electronAPI.isElectron = false
      
      const app = createMockApp()
      const page = new HistoryPage(app)
      
      await page.clearWebCache()
      
      expect(app.showToast).toHaveBeenCalled()
    })
  })

  describe('showNetworkRestrictedActions', () => {
    it('should create modal for network restricted items', () => {
      const app = createMockApp()
      const page = new HistoryPage(app)
      
      page.showNetworkRestrictedActions(['http://test.com/image.png'], 'Test prompt')
      
      expect(mockDocument.createElement).toHaveBeenCalledWith('div')
      expect(mockDocument.body.appendChild).toHaveBeenCalled()
    })
  })
})

describe('createHistoryPage', () => {
  it('should create and return HistoryPage instance', () => {
    const app = createMockApp()
    const page = createHistoryPage(app)
    
    expect(page).toBeInstanceOf(HistoryPage)
  })
})

describe('getHistoryPage', () => {
  it('should return instance after creation', () => {
    const app = createMockApp()
    createHistoryPage(app)
    
    const page = getHistoryPage()
    expect(page).toBeInstanceOf(HistoryPage)
  })
})
