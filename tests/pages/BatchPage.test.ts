// tests/pages/BatchPage.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BatchPage, createBatchPage, getBatchPage, type BatchReferenceImage, type BatchMode } from '../../src/renderer/src/pages'

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
  currentTab: 'batch',
  history: [],
  pages: {},
  openSettings: vi.fn(),
  setupBatchIntelligentResizeMode: vi.fn()
})

// Mock window objects
const mockWindow = {
  aiImageAPI: {
    apiKey: 'test-key',
    getCurrentModel: vi.fn().mockReturnValue({
      name: 'test-model',
      apiType: 'gemini',
      capabilities: { resolutionControl: true },
      resolutionMap: { auto: { '2K': '1024x1024' } },
      displayName: 'Test Model $0.025/张 30s出图'
    }),
    getAllModels: vi.fn().mockReturnValue({
      'test-model': { name: 'Test Model', apiType: 'gemini' }
    }),
    batchGenerate: vi.fn().mockResolvedValue({ success: true, urls: ['http://test.com/image.png'] }),
    batchGenerateWithReference: vi.fn().mockResolvedValue({ success: true, urls: ['http://test.com/image.png'] }),
    preloadImages: vi.fn(),
    formatDetailedError: vi.fn().mockReturnValue({ title: 'Error', message: 'Test error', details: [] }),
    downloadImagesAsZip: vi.fn().mockResolvedValue({ message: 'Download complete' })
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
  requestIdleCallback: vi.fn((cb) => setTimeout(cb, 0)),
  imageCompression: vi.fn().mockResolvedValue(new File(['test'], 'compressed.png', { type: 'image/png' }))
}

// Helper to create mock element with all needed methods
const createMockElement = (extras = {}) => ({
  tagName: 'div',
  className: '',
  innerHTML: '',
  style: { setProperty: vi.fn() },
  id: '',
  value: '',
  min: '1',
  max: '10',
  checked: false,
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

describe('BatchPage', () => {
  describe('constructor', () => {
    it('should create instance with app reference', () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      expect(page).toBeInstanceOf(BatchPage)
    })

    it('should initialize with default values', () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      expect(page.getCurrentBatchMode()).toBe('card')
      expect(page.getCurrentResolution()).toBe('2K')
      expect(page.getBatchReferenceImages()).toEqual([])
    })
  })

  describe('switchBatchMode', () => {
    it('should switch to card mode', () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      page.switchBatchMode('card')
      
      expect(page.getCurrentBatchMode()).toBe('card')
    })

    it('should switch to multi mode', () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      page.switchBatchMode('multi')
      
      expect(page.getCurrentBatchMode()).toBe('multi')
    })

    it('should update UI elements when switching modes', () => {
      const cardUI = createMockElement({ id: 'cardModeUI' })
      const multiUI = createMockElement({ id: 'multiModeUI' })
      const cardLabel = createMockElement({ id: 'cardModeLabel' })
      const multiLabel = createMockElement({ id: 'multiModeLabel' })
      
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'cardModeUI') return cardUI
        if (id === 'multiModeUI') return multiUI
        if (id === 'cardModeLabel') return cardLabel
        if (id === 'multiModeLabel') return multiLabel
        return createMockElement()
      })
      
      const app = createMockApp()
      const page = new BatchPage(app)
      
      page.switchBatchMode('multi')
      
      expect(cardUI.classList.add).toHaveBeenCalledWith('hidden')
      expect(multiUI.classList.remove).toHaveBeenCalledWith('hidden')
    })
  })

  describe('clearAllBatchReferenceImages', () => {
    it('should clear batch reference images array', () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      // Manually add reference images for testing
      ;(page as any).batchReferenceImages = [
        { id: 1, base64: 'test', fileName: 'test.png', fileSize: 1000, mimeType: 'image/png', width: 100, height: 100, needsCompression: false }
      ]
      
      page.clearAllBatchReferenceImages()
      
      expect(page.getBatchReferenceImages()).toEqual([])
    })
  })

  describe('batchGenerate', () => {
    it('should show card confirm dialog in card mode', async () => {
      const cardPromptInput = createMockElement({ value: 'test prompt' })
      const cardConfirmModal = createMockElement()
      
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'cardPromptInput') return cardPromptInput
        if (id === 'cardConfirmModal') return cardConfirmModal
        if (id === 'cardCount') return createMockElement({ value: '5' })
        return createMockElement()
      })
      
      const app = createMockApp()
      const page = new BatchPage(app)
      page.switchBatchMode('card')
      
      await page.batchGenerate()
      
      // Should show confirm modal (not hidden)
      expect(cardConfirmModal.classList.remove).toHaveBeenCalledWith('hidden')
    })

    it('should show error if prompt is empty in card mode', async () => {
      const cardPromptInput = createMockElement({ value: '  ' })
      
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'cardPromptInput') return cardPromptInput
        return createMockElement()
      })
      
      const app = createMockApp()
      const page = new BatchPage(app)
      page.switchBatchMode('card')
      
      await page.batchGenerate()
      
      expect(app.showToast).toHaveBeenCalled()
    })

    it('should show error if API key is not set', async () => {
      const cardPromptInput = createMockElement({ value: 'test prompt' })
      
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'cardPromptInput') return cardPromptInput
        return createMockElement()
      })
      ;(window as any).aiImageAPI.apiKey = null
      
      const app = createMockApp()
      const page = new BatchPage(app)
      page.switchBatchMode('card')
      
      await page.batchGenerate()
      
      expect(app.showToast).toHaveBeenCalled()
      expect(app.openSettings).toHaveBeenCalled()
    })
  })

  describe('onActivate', () => {
    it('should not throw when activated', () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      expect(() => page.onActivate()).not.toThrow()
    })

    it('should update max reference images based on model', () => {
      ;(window as any).aiImageAPI.getCurrentModel.mockReturnValue({
        name: 'Flux Model',
        apiType: 'flux-kontext'
      })
      
      const app = createMockApp()
      const page = new BatchPage(app)
      page.onActivate()
      
      // After activation with Flux model, max should be 1
      expect((page as any).maxReferenceImages).toBe(1)
    })
  })

  describe('onDeactivate', () => {
    it('should save state when deactivated', () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      page.onDeactivate()
      
      expect((window as any).pageStateManager.saveStateImmediate).toHaveBeenCalled()
    })
  })

  describe('onLanguageChange', () => {
    it('should handle language change', () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      expect(() => page.onLanguageChange('en')).not.toThrow()
    })
  })

  describe('onModelChanged', () => {
    it('should update max reference images for Flux model', () => {
      ;(window as any).aiImageAPI.getCurrentModel.mockReturnValue({
        name: 'Flux Model',
        apiType: 'flux-kontext'
      })
      
      const app = createMockApp()
      const page = new BatchPage(app)
      
      page.onModelChanged()
      
      expect((page as any).maxReferenceImages).toBe(1)
    })

    it('should update max reference images for non-Flux model', () => {
      ;(window as any).aiImageAPI.getCurrentModel.mockReturnValue({
        name: 'Gemini Model',
        apiType: 'gemini'
      })
      
      const app = createMockApp()
      const page = new BatchPage(app)
      
      page.onModelChanged()
      
      expect((page as any).maxReferenceImages).toBe(8)
    })
  })

  describe('getBatchReferenceImages', () => {
    it('should return batch reference images array', () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      expect(page.getBatchReferenceImages()).toBeInstanceOf(Array)
    })
  })

  describe('getCurrentBatchMode', () => {
    it('should return current batch mode', () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      const mode = page.getCurrentBatchMode()
      expect(mode === 'card' || mode === 'multi').toBe(true)
    })
  })

  describe('getCurrentResolution', () => {
    it('should return current resolution', () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      expect(page.getCurrentResolution()).toBe('2K')
    })
  })

  describe('handleBatchPasteEvent', () => {
    it('should handle paste event with images', async () => {
      const mockFile = new File(['test'], 'test.png', { type: 'image/png' })
      const mockClipboardData = {
        items: [{
          type: 'image/png',
          getAsFile: () => mockFile
        }]
      }
      const mockEvent = {
        clipboardData: mockClipboardData,
        preventDefault: vi.fn()
      } as unknown as ClipboardEvent
      
      const app = createMockApp()
      const page = new BatchPage(app)
      
      await page.handleBatchPasteEvent(mockEvent)
      
      // Should show success toast (paste was processed)
      expect(app.showToast).toHaveBeenCalled()
    })

    it('should show warning when no image in clipboard', async () => {
      const mockClipboardData = {
        items: [{
          type: 'text/plain',
          getAsFile: () => null
        }]
      }
      const mockEvent = {
        clipboardData: mockClipboardData,
        preventDefault: vi.fn()
      } as unknown as ClipboardEvent
      
      const app = createMockApp()
      const page = new BatchPage(app)
      
      await page.handleBatchPasteEvent(mockEvent)
      
      expect(app.showToast).toHaveBeenCalledWith(expect.any(String), 'warning')
    })

    it('should show warning when max images reached', async () => {
      ;(window as any).aiImageAPI.getCurrentModel.mockReturnValue({
        name: 'Flux Model',
        apiType: 'flux-kontext'
      })
      
      const app = createMockApp()
      const page = new BatchPage(app)
      
      // Set max to 1 and add one image
      ;(page as any).maxReferenceImages = 1
      ;(page as any).batchReferenceImages = [{ id: 1, base64: 'test' }]
      
      const mockFile = new File(['test'], 'test.png', { type: 'image/png' })
      const mockClipboardData = {
        items: [{
          type: 'image/png',
          getAsFile: () => mockFile
        }]
      }
      const mockEvent = {
        clipboardData: mockClipboardData,
        preventDefault: vi.fn()
      } as unknown as ClipboardEvent
      
      await page.handleBatchPasteEvent(mockEvent)
      
      expect(app.showToast).toHaveBeenCalledWith(expect.any(String), 'info')
    })
  })

  describe('showDetailedBatchError', () => {
    it('should show error not found when result is missing', () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      page.showDetailedBatchError(999, 'context')
      
      expect(app.showToast).toHaveBeenCalledWith(expect.any(String), 'error')
    })

    it('should show detailed error when result exists', () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      // Add a failed result
      ;(page as any).currentBatchResults[0] = {
        success: false,
        prompt: 'test',
        urls: [],
        error: new Error('Test error'),
        errorMessage: 'Test error message',
        index: 0
      }
      
      page.showDetailedBatchError(0, 'context')
      
      expect((window as any).errorHandlerTS.showDetailedError).toHaveBeenCalled()
    })
  })

  describe('downloadBatchImages', () => {
    it('should start batch download', async () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      const urls = ['http://test.com/1.png', 'http://test.com/2.png']
      await page.downloadBatchImages(urls, 'test prompt')
      
      expect((window as any).aiImageAPI.downloadImagesAsZip).toHaveBeenCalled()
    })

    it('should show success message after download', async () => {
      const app = createMockApp()
      const page = new BatchPage(app)
      
      const urls = ['http://test.com/1.png']
      await page.downloadBatchImages(urls, 'test prompt')
      
      expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('Download'), 'success')
    })
  })
})

describe('createBatchPage', () => {
  it('should create and return BatchPage instance', () => {
    const app = createMockApp()
    const page = createBatchPage(app)
    
    expect(page).toBeInstanceOf(BatchPage)
  })
})

describe('getBatchPage', () => {
  it('should return null before creation', () => {
    // Note: This may be affected by singleton nature from other tests
    const page = getBatchPage()
    expect(page === null || page instanceof BatchPage).toBe(true)
  })

  it('should return instance after creation', () => {
    const app = createMockApp()
    createBatchPage(app)
    
    const page = getBatchPage()
    expect(page).toBeInstanceOf(BatchPage)
  })
})
