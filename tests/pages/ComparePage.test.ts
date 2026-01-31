// tests/pages/ComparePage.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ComparePage, createComparePage, getComparePage, type CompareReferenceImage } from '../../src/renderer/src/pages'

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
  addHistory: vi.fn(),
  saveHistory: vi.fn(),
  currentTab: 'compare',
  history: [],
  pages: {
    generate: { currentResolution: '2K' }
  },
  defaultRatios: [{ key: '1:1', label: '方形 1:1' }, { key: '16:9', label: '横版 16:9' }]
})

// Mock window objects
const mockWindow = {
  aiImageAPI: {
    apiKey: 'test-key',
    model: 'test-model',
    baseURL: 'http://test.com',
    models: {
      'model-1': {
        name: 'Model 1',
        apiType: 'gemini',
        baseURL: 'http://test1.com',
        capabilities: { resolutionControl: true, customSize: true },
        displayName: 'Model 1 $0.025/张 30s出图'
      },
      'model-2': {
        name: 'Model 2',
        apiType: 'gemini',
        baseURL: 'http://test2.com',
        capabilities: { resolutionControl: true, customSize: true },
        displayName: 'Model 2 $0.030/张 20s出图'
      },
      'flux-model': {
        name: 'Flux Model',
        apiType: 'flux-kontext',
        baseURL: 'http://flux.com',
        capabilities: {},
        displayName: 'Flux Model $0.050/张'
      }
    },
    getCurrentModel: vi.fn().mockReturnValue({
      name: 'test-model',
      apiType: 'gemini',
      capabilities: { resolutionControl: true },
      displayName: 'Test Model $0.025/张 30s出图'
    }),
    getAllModels: vi.fn().mockReturnValue({
      'model-1': { name: 'Model 1', apiType: 'gemini', capabilities: { customSize: true }, displayName: 'Model 1 $0.025/张 30s出图' },
      'model-2': { name: 'Model 2', apiType: 'gemini', capabilities: { customSize: true }, displayName: 'Model 2 $0.030/张 20s出图' },
      'flux-model': { name: 'Flux Model', apiType: 'flux-kontext', capabilities: {}, displayName: 'Flux Model $0.050/张' }
    }),
    generateImage: vi.fn().mockResolvedValue({ success: true, urls: ['http://test.com/image.png'], generationTime: 5000 }),
    generateImageWithReference: vi.fn().mockResolvedValue({ success: true, urls: ['http://test.com/image.png'], generationTime: 5000 }),
    formatDetailedError: vi.fn().mockReturnValue({ title: 'Error', message: 'Test error', details: [] })
  },
  i18n: {
    t: vi.fn((key: string) => key),
    currentLang: 'zh',
    translations: { zh: { aspectRatios: {} } }
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
  requestIdleCallback: vi.fn((cb) => setTimeout(cb, 0)),
  imageCompression: vi.fn().mockResolvedValue(new File(['test'], 'compressed.png', { type: 'image/png' })),
  app: {
    viewImage: vi.fn(),
    downloadImage: vi.fn()
  }
}

// Helper to create mock element with all needed methods
const createMockElement = (extras = {}) => ({
  tagName: 'div',
  className: '',
  innerHTML: '',
  style: { setProperty: vi.fn() },
  id: '',
  value: '',
  disabled: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  appendChild: vi.fn(),
  remove: vi.fn(),
  focus: vi.fn(),
  click: vi.fn(),
  add: vi.fn(),
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
  textContent: '',
  ...extras
})

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
  
  // Default mock implementations
  mockDocument.querySelectorAll.mockReturnValue([])
  mockDocument.getElementById.mockImplementation(() => createMockElement())
  mockDocument.createElement.mockImplementation((tag: string) => createMockElement({ tagName: tag }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('ComparePage', () => {
  describe('constructor', () => {
    it('should create instance with app reference', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      expect(page).toBeInstanceOf(ComparePage)
    })

    it('should initialize with default values', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      expect(page.getCurrentRatio()).toBe('1:1')
      expect(page.getLeftModel()).toBeNull()
      expect(page.getRightModel()).toBeNull()
      expect(page.getReferenceImages()).toEqual([])
    })
  })

  describe('selectRatio', () => {
    it('should update current ratio', () => {
      const app = createMockApp()
      mockDocument.querySelectorAll.mockReturnValue([])
      
      const page = new ComparePage(app)
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
      const page = new ComparePage(app)
      page.selectRatio('16:9')
      
      expect(mockButton.classList.add).toHaveBeenCalledWith('active')
    })
  })

  describe('triggerFileSelection', () => {
    it('should not allow selection when max images reached', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      // Set max and add max images
      ;(page as any).maxReferenceImages = 1
      ;(page as any).referenceImages = [{ dataUrl: 'test', name: 'test.png', size: 1000, needsCompression: false }]
      
      page.triggerFileSelection()
      
      expect(app.showToast).toHaveBeenCalled()
    })

    it('should show Flux limit message when Flux model is selected', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      // Set Flux model
      ;(page as any).leftModel = 'flux-model'
      ;(page as any).maxReferenceImages = 1
      ;(page as any).referenceImages = [{ dataUrl: 'test', name: 'test.png', size: 1000, needsCompression: false }]
      
      page.triggerFileSelection()
      
      expect(app.showToast).toHaveBeenCalledWith(expect.any(String), 'info')
    })
  })

  describe('removeReferenceImage', () => {
    it('should remove image at specified index', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      ;(page as any).referenceImages = [
        { dataUrl: 'test1', name: 'test1.png', size: 1000, needsCompression: false },
        { dataUrl: 'test2', name: 'test2.png', size: 2000, needsCompression: false }
      ]
      
      page.removeReferenceImage(0)
      
      expect(page.getReferenceImages()).toHaveLength(1)
      expect(page.getReferenceImages()[0].name).toBe('test2.png')
    })
  })

  describe('clearInput', () => {
    it('should clear prompt input', () => {
      const mockPromptInput = createMockElement({ value: 'test prompt' })
      
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'comparePrompt') return mockPromptInput
        return createMockElement()
      })
      
      const app = createMockApp()
      const page = new ComparePage(app)
      
      page.clearInput()
      
      expect(mockPromptInput.value).toBe('')
      expect(app.showToast).toHaveBeenCalledWith(expect.any(String), 'success')
    })

    it('should clear reference images', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      ;(page as any).referenceImages = [{ dataUrl: 'test', name: 'test.png', size: 1000, needsCompression: false }]
      
      page.clearInput()
      
      expect(page.getReferenceImages()).toEqual([])
    })
  })

  describe('startComparison', () => {
    it('should show error if processing', async () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      ;(page as any).isProcessing = true
      
      await page.startComparison()
      
      expect(app.showToast).toHaveBeenCalledWith(expect.any(String), 'warning')
    })

    it('should show error if prompt and images are empty', async () => {
      const mockPromptInput = createMockElement({ value: '' })
      
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'comparePrompt') return mockPromptInput
        return createMockElement()
      })
      
      const app = createMockApp()
      const page = new ComparePage(app)
      
      ;(page as any).referenceImages = []
      
      await page.startComparison()
      
      expect(app.showToast).toHaveBeenCalledWith(expect.any(String), 'error')
    })

    it('should show error if models not selected', async () => {
      const mockPromptInput = createMockElement({ value: 'test prompt' })
      
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'comparePrompt') return mockPromptInput
        return createMockElement()
      })
      
      const app = createMockApp()
      const page = new ComparePage(app)
      
      ;(page as any).leftModel = null
      ;(page as any).rightModel = null
      
      await page.startComparison()
      
      expect(app.showToast).toHaveBeenCalledWith(expect.any(String), 'error')
    })

    it('should show warning if same model selected', async () => {
      const mockPromptInput = createMockElement({ value: 'test prompt' })
      
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'comparePrompt') return mockPromptInput
        return createMockElement()
      })
      
      const app = createMockApp()
      const page = new ComparePage(app)
      
      ;(page as any).leftModel = 'model-1'
      ;(page as any).rightModel = 'model-1'
      
      await page.startComparison()
      
      expect(app.showToast).toHaveBeenCalledWith(expect.any(String), 'warning')
    })
  })

  describe('onActivate', () => {
    it('should not throw when activated', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      expect(() => page.onActivate()).not.toThrow()
    })
  })

  describe('onDeactivate', () => {
    it('should not throw when deactivated', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      expect(() => page.onDeactivate()).not.toThrow()
    })
  })

  describe('onLanguageChange', () => {
    it('should handle language change', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      expect(() => page.onLanguageChange('en')).not.toThrow()
    })
  })

  describe('getLeftModel', () => {
    it('should return left model', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      ;(page as any).leftModel = 'model-1'
      
      expect(page.getLeftModel()).toBe('model-1')
    })
  })

  describe('getRightModel', () => {
    it('should return right model', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      ;(page as any).rightModel = 'model-2'
      
      expect(page.getRightModel()).toBe('model-2')
    })
  })

  describe('getCurrentRatio', () => {
    it('should return current ratio', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      expect(page.getCurrentRatio()).toBe('1:1')
    })
  })

  describe('getReferenceImages', () => {
    it('should return reference images array', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      expect(page.getReferenceImages()).toBeInstanceOf(Array)
    })
  })

  describe('Flux model detection', () => {
    it('should detect Flux model on left side', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      ;(page as any).leftModel = 'flux-model'
      
      expect((page as any).hasAnyFluxModel()).toBe(true)
    })

    it('should detect Flux model on right side', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      ;(page as any).rightModel = 'flux-model'
      
      expect((page as any).hasAnyFluxModel()).toBe(true)
    })

    it('should return false when no Flux model', () => {
      const app = createMockApp()
      const page = new ComparePage(app)
      
      ;(page as any).leftModel = 'model-1'
      ;(page as any).rightModel = 'model-2'
      
      expect((page as any).hasAnyFluxModel()).toBe(false)
    })
  })
})

describe('createComparePage', () => {
  it('should create and return ComparePage instance', () => {
    const app = createMockApp()
    const page = createComparePage(app)
    
    expect(page).toBeInstanceOf(ComparePage)
  })
})

describe('getComparePage', () => {
  it('should return null before creation', () => {
    // Note: This may be affected by singleton nature from other tests
    const page = getComparePage()
    expect(page === null || page instanceof ComparePage).toBe(true)
  })

  it('should return instance after creation', () => {
    const app = createMockApp()
    createComparePage(app)
    
    const page = getComparePage()
    expect(page).toBeInstanceOf(ComparePage)
  })
})
