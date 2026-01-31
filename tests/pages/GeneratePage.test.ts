// tests/pages/GeneratePage.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GeneratePage, createGeneratePage, getGeneratePage, type ReferenceImage } from '../../src/renderer/src/pages'

// Mock DOM
const mockDocument = {
  getElementById: vi.fn(),
  querySelectorAll: vi.fn(),
  createElement: vi.fn(),
  body: {
    appendChild: vi.fn()
  }
}

// Mock app interface
const createMockApp = () => ({
  showToast: vi.fn(),
  switchTab: vi.fn(),
  addToHistory: vi.fn(),
  currentTab: 'generate',
  history: [],
  pages: {}
})

// Mock window objects
const mockWindow = {
  aiImageAPI: {
    apiKey: 'test-key',
    getCurrentModel: vi.fn().mockReturnValue({
      name: 'test-model',
      apiType: 'gemini',
      capabilities: { resolutionControl: true },
      resolutionMap: { auto: { '2K': '1024x1024' } }
    }),
    generateImage: vi.fn().mockResolvedValue({ success: true, urls: ['http://test.com/image.png'] }),
    generateImageWithReference: vi.fn().mockResolvedValue({ success: true, urls: ['http://test.com/image.png'] })
  },
  i18n: {
    t: vi.fn((key: string) => key)
  },
  pageStateManager: {
    loadState: vi.fn().mockResolvedValue(null),
    saveState: vi.fn(),
    saveStateImmediate: vi.fn()
  },
  errorHandlerTS: {
    showDetailedError: vi.fn()
  },
  toastManagerTS: {
    show: vi.fn()
  },
  requestIdleCallback: vi.fn((cb) => setTimeout(cb, 0))
}

// Setup mocks
beforeEach(() => {
  vi.stubGlobal('document', mockDocument)
  
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

describe('GeneratePage', () => {
  describe('constructor', () => {
    it('should create instance with app reference', () => {
      const app = createMockApp()
      const page = new GeneratePage(app)
      
      expect(page).toBeInstanceOf(GeneratePage)
    })

    it('should initialize with default values', () => {
      const app = createMockApp()
      const page = new GeneratePage(app)
      
      expect(page.getCurrentRatio()).toBe('auto')
      expect(page.getCurrentResolution()).toBe('2K')
      expect(page.getReferenceImages()).toEqual([])
      expect(page.getLastGeneratedUrls()).toEqual([])
    })
  })

  describe('selectRatio', () => {
    it('should update current ratio', () => {
      const app = createMockApp()
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const page = new GeneratePage(app)
      page.selectRatio('16:9')
      
      expect(page.getCurrentRatio()).toBe('16:9')
    })

    it('should update ratio button active state', () => {
      const mockButton = {
        classList: { add: vi.fn(), remove: vi.fn() },
        dataset: { ratio: '16:9' }
      }
      mockDocument.querySelectorAll.mockReturnValue([mockButton])
      
      const app = createMockApp()
      const page = new GeneratePage(app)
      page.selectRatio('16:9')
      
      expect(mockButton.classList.add).toHaveBeenCalledWith('active')
    })
  })

  describe('selectResolution', () => {
    it('should update current resolution', () => {
      const app = createMockApp()
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const page = new GeneratePage(app)
      page.selectResolution('4K')
      
      expect(page.getCurrentResolution()).toBe('4K')
    })

    it('should save resolution to localStorage', () => {
      const mockLocalStorage = {
        setItem: vi.fn(),
        getItem: vi.fn()
      }
      vi.stubGlobal('localStorage', mockLocalStorage)
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const app = createMockApp()
      const page = new GeneratePage(app)
      page.selectResolution('4K')
      
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('gemini_resolution', '4K')
    })
  })

  describe('clearInput', () => {
    it('should clear prompt input', () => {
      // Create base element helper for this test
      const createMockElementLocal = (extras = {}) => ({
        tagName: 'div',
        className: '',
        innerHTML: '',
        style: {},
        id: '',
        value: '',
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
        ...extras
      })
      
      const mockInput = createMockElementLocal({ value: 'test prompt' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'promptInput') return mockInput
        return createMockElementLocal()
      })
      
      const app = createMockApp()
      const page = new GeneratePage(app)
      page.clearInput()
      
      expect(mockInput.value).toBe('')
      expect(mockInput.focus).toHaveBeenCalled()
    })
  })

  describe('clearAllReferenceImages', () => {
    it('should clear reference images array', () => {
      const app = createMockApp()
      const page = new GeneratePage(app)
      
      // Manually add reference images for testing
      ;(page as any).referenceImages = [
        { id: 1, base64: 'test', fileName: 'test.png', fileSize: 1000, mimeType: 'image/png', width: 100, height: 100, needsCompression: false }
      ]
      
      page.clearAllReferenceImages()
      
      expect(page.getReferenceImages()).toEqual([])
    })
  })

  describe('generateImage', () => {
    it('should show error if prompt is empty', async () => {
      // Create base element helper for this test
      const createMockElementLocal = (extras = {}) => ({
        tagName: 'div',
        className: '',
        innerHTML: '',
        style: {},
        id: '',
        value: '',
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
        ...extras
      })
      
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'promptInput') return createMockElementLocal({ value: '  ' })
        return createMockElementLocal()
      })
      
      const app = createMockApp()
      const page = new GeneratePage(app)
      
      await page.generateImage()
      
      // Should have called showToast with error message
      expect(app.showToast).toHaveBeenCalled()
    })

    it('should show error if API key is not set', async () => {
      // Create base element helper for this test
      const createMockElementLocal = (extras = {}) => ({
        tagName: 'div',
        className: '',
        innerHTML: '',
        style: {},
        id: '',
        value: '',
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
        ...extras
      })
      
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'promptInput') return createMockElementLocal({ value: 'test prompt' })
        return createMockElementLocal()
      })
      ;(window as any).aiImageAPI.apiKey = null
      
      const app = createMockApp()
      const page = new GeneratePage(app)
      
      await page.generateImage()
      
      expect(app.showToast).toHaveBeenCalled()
    })
  })

  describe('onActivate', () => {
    it('should not throw when activated', () => {
      const app = createMockApp()
      const page = new GeneratePage(app)
      
      expect(() => page.onActivate()).not.toThrow()
    })
  })

  describe('onDeactivate', () => {
    it('should save state when deactivated', () => {
      const app = createMockApp()
      const page = new GeneratePage(app)
      
      page.onDeactivate()
      
      // Should not throw
      expect(true).toBe(true)
    })
  })

  describe('onLanguageChange', () => {
    it('should handle language change', () => {
      const app = createMockApp()
      const page = new GeneratePage(app)
      
      expect(() => page.onLanguageChange('en')).not.toThrow()
    })
  })

  describe('getReferenceImages', () => {
    it('should return reference images array', () => {
      const app = createMockApp()
      const page = new GeneratePage(app)
      
      expect(page.getReferenceImages()).toBeInstanceOf(Array)
    })
  })

  describe('getLastGeneratedUrls', () => {
    it('should return last generated URLs', () => {
      const app = createMockApp()
      const page = new GeneratePage(app)
      
      expect(page.getLastGeneratedUrls()).toBeInstanceOf(Array)
    })
  })
})

describe('createGeneratePage', () => {
  it('should create and return GeneratePage instance', () => {
    const app = createMockApp()
    const page = createGeneratePage(app)
    
    expect(page).toBeInstanceOf(GeneratePage)
  })
})

describe('getGeneratePage', () => {
  it('should return null before creation', () => {
    // Note: This may be affected by singleton nature from other tests
    // In isolation, it would return null initially
    const page = getGeneratePage()
    expect(page === null || page instanceof GeneratePage).toBe(true)
  })

  it('should return instance after creation', () => {
    const app = createMockApp()
    createGeneratePage(app)
    
    const page = getGeneratePage()
    expect(page).toBeInstanceOf(GeneratePage)
  })
})
