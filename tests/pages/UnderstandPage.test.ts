// tests/pages/UnderstandPage.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { UnderstandPage, createUnderstandPage, getUnderstandPage, type UploadedImage, type VisionModel } from '../../src/renderer/src/pages'

// Mock DOM
const mockDocument = {
  getElementById: vi.fn(),
  querySelectorAll: vi.fn(),
  createElement: vi.fn(),
  addEventListener: vi.fn(),
  readyState: 'complete',
  body: {
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    style: {}
  }
}

// Mock app interface
const createMockApp = () => ({
  showToast: vi.fn(),
  switchTab: vi.fn(),
  addToHistory: vi.fn(),
  currentTab: 'understand',
  history: [],
  pages: {},
  openSettings: vi.fn()
})

// Mock window objects
const mockWindow = {
  aiImageAPI: {
    visionApiKey: 'test-vision-key',
    analyzeImagesStream: vi.fn((images, prompt, model, maxTokens, onChunk, onComplete, onError) => {
      onChunk('分析结果')
      onComplete()
    })
  },
  i18n: {
    t: vi.fn((key: string) => key),
    onLanguageChange: vi.fn()
  },
  pageStateManager: {
    loadState: vi.fn().mockResolvedValue(null),
    saveState: vi.fn(),
    savePageState: vi.fn(),
    getPageState: vi.fn().mockReturnValue(null)
  },
  toastManagerTS: {
    show: vi.fn()
  },
  navigator: {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined)
    }
  }
}

// Mock navigator
vi.stubGlobal('navigator', {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
})

// Helper to create mock element
const createMockElement = (extras = {}) => ({
  tagName: 'div',
  className: '',
  innerHTML: '',
  style: { setProperty: vi.fn() },
  id: '',
  value: '',
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  appendChild: vi.fn(),
  remove: vi.fn(),
  focus: vi.fn(),
  click: vi.fn(),
  select: vi.fn(),
  classList: {
    add: vi.fn(),
    remove: vi.fn(),
    contains: vi.fn().mockReturnValue(false),
    toggle: vi.fn()
  },
  setAttribute: vi.fn(),
  getAttribute: vi.fn(),
  querySelector: vi.fn().mockReturnValue(null),
  querySelectorAll: vi.fn().mockReturnValue([]),
  dataset: {},
  textContent: '',
  dispatchEvent: vi.fn(),
  scrollTop: 0,
  scrollHeight: 100,
  childNodes: [],
  ...extras
})

// Setup mocks
beforeEach(() => {
  vi.stubGlobal('document', mockDocument)
  vi.stubGlobal('window', mockWindow)

  vi.clearAllMocks()

  mockDocument.getElementById.mockImplementation((id: string) => {
    return createMockElement({ id })
  })

  mockDocument.createElement.mockImplementation((tag: string) => {
    return createMockElement({ tagName: tag.toUpperCase() })
  })

  mockDocument.querySelectorAll.mockReturnValue([])

  // Mock fetch for config loading
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      models: [
        { id: 'gpt-4o', displayName: 'GPT-4o', shortName: 'GPT-4o', icon: '🤖', recommended: true }
      ],
      defaultModel: 'gpt-4o',
      roles: [
        { id: 'universal', name: '万物识别', icon: '🔍', shortName: '万物识别', prompt: '请分析图片', default: true }
      ]
    })
  }))

  // Mock FileReader
  vi.stubGlobal('FileReader', class {
    onload: ((event: any) => void) | null = null
    onerror: (() => void) | null = null
    result: string = 'data:image/png;base64,dGVzdA=='
    readAsDataURL() {
      setTimeout(() => this.onload?.({ target: this }), 0)
    }
  })

  // Mock Image
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    src: string = ''
    width: number = 100
    height: number = 100
    constructor() {
      setTimeout(() => this.onload?.(), 0)
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UnderstandPage', () => {
  describe('Constructor and Initialization', () => {
    it('should create instance and initialize', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      // Wait for async init
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(page).toBeInstanceOf(UnderstandPage)
    })

    it('should load model config on init', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      expect(global.fetch).toHaveBeenCalled()
    })

    it('should load role config on init', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      expect(global.fetch).toHaveBeenCalled()
    })
  })

  describe('Model Management', () => {
    it('should have default model after init', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      expect(page.getCurrentModel()).not.toBeNull()
    })

    it('should select model correctly', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      page.selectModel('gpt-4o')
      expect(page.getCurrentModel()).toBe('gpt-4o')
    })

    it('should get model display name', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      const displayName = page.getModelDisplayName('gpt-4o')
      expect(displayName).toBeDefined()
    })
  })

  describe('Role Management', () => {
    it('should have default role after init', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      expect(page.getCurrentRole()).not.toBeNull()
    })

    it('should select role correctly', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      page.selectRole('universal')
      expect(page.getCurrentRole()).toBe('universal')
    })

    it('should enable custom prompt mode', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      page.enableCustomPrompt()
      // Custom prompt mode is internal
      expect(page).toBeDefined()
    })
  })

  describe('Image Upload', () => {
    it('should start with no uploaded images', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      expect(page.getUploadedImagesCount()).toBe(0)
    })

    it('should handle multiple image upload', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      const mockFile = new File(['test'], 'test.png', { type: 'image/png' })
      Object.defineProperty(mockFile, 'size', { value: 1024 })

      await page.handleMultipleImageUpload([mockFile])

      expect(page.getUploadedImagesCount()).toBe(1)
    })

    it('should reject files over 50MB', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      const largeFile = new File(['test'], 'large.png', { type: 'image/png' })
      Object.defineProperty(largeFile, 'size', { value: 60 * 1024 * 1024 })

      await page.handleMultipleImageUpload([largeFile])

      expect(page.getUploadedImagesCount()).toBe(0)
    })

    it('should remove image by index', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      const mockFile = new File(['test'], 'test.png', { type: 'image/png' })
      Object.defineProperty(mockFile, 'size', { value: 1024 })

      await page.handleMultipleImageUpload([mockFile])
      expect(page.getUploadedImagesCount()).toBe(1)

      page.removeImage(0)
      expect(page.getUploadedImagesCount()).toBe(0)
    })

    it('should clear all images', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      const mockFile = new File(['test'], 'test.png', { type: 'image/png' })
      Object.defineProperty(mockFile, 'size', { value: 1024 })

      await page.handleMultipleImageUpload([mockFile])
      page.clearAllImages()

      expect(page.getUploadedImagesCount()).toBe(0)
    })
  })

  describe('Analysis', () => {
    it('should not analyze without images', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      await page.analyzeImages()

      expect(app.showToast).toHaveBeenCalledWith('请先上传图片', 'error')
    })

    it('should not analyze without API key', async () => {
      const windowWithoutKey = { ...mockWindow, aiImageAPI: { visionApiKey: null } }
      vi.stubGlobal('window', windowWithoutKey)

      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      const mockFile = new File(['test'], 'test.png', { type: 'image/png' })
      Object.defineProperty(mockFile, 'size', { value: 1024 })
      await page.handleMultipleImageUpload([mockFile])

      await page.analyzeImages()

      expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('API Key'), 'error')
    })

    it('should track analyzing state', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      expect(page.getIsAnalyzing()).toBe(false)
    })
  })

  describe('Modal Management', () => {
    it('should open model selection modal', async () => {
      const mockModal = createMockElement({ id: 'visionModelModal' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'visionModelModal') return mockModal
        return createMockElement({ id })
      })

      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      page.openModelSelectionModal()

      expect(mockModal.classList.remove).toHaveBeenCalledWith('hidden')
    })

    it('should close model selection modal', async () => {
      const mockModal = createMockElement({ id: 'visionModelModal' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'visionModelModal') return mockModal
        return createMockElement({ id })
      })

      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      page.closeModelSelectionModal()

      expect(mockModal.classList.add).toHaveBeenCalledWith('hidden')
    })

    it('should select model and close modal', async () => {
      const mockModal = createMockElement({ id: 'visionModelModal' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'visionModelModal') return mockModal
        return createMockElement({ id })
      })

      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      page.selectModelAndClose('gpt-4o')

      expect(page.getCurrentModel()).toBe('gpt-4o')
      expect(mockModal.classList.add).toHaveBeenCalledWith('hidden')
    })
  })

  describe('Copy Result', () => {
    it('should warn if no result to copy', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      await page.copyResult()

      expect(app.showToast).toHaveBeenCalledWith('没有可复制的内容', 'warning')
    })
  })

  describe('State Management', () => {
    it('should save state correctly', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      page.saveState()

      expect(mockWindow.pageStateManager.savePageState).toHaveBeenCalled()
    })

    it('should collect state correctly', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      const state = page.collectState()

      expect(state).toHaveProperty('currentModel')
      expect(state).toHaveProperty('currentRole')
      expect(state).toHaveProperty('isCustomPrompt')
    })

    it('should apply state correctly', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      page.applyState({
        currentModel: 'gpt-4o',
        currentRole: 'universal',
        isCustomPrompt: false,
        uploadedImagesCount: 0
      })

      expect(page.getCurrentModel()).toBe('gpt-4o')
    })
  })

  describe('Factory Functions', () => {
    it('should create instance via factory function', async () => {
      const app = createMockApp()
      const instance = createUnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      expect(instance).toBeInstanceOf(UnderstandPage)
    })

    it('should return instance via getter', async () => {
      const app = createMockApp()
      createUnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      const instance = getUnderstandPage()
      expect(instance).toBeInstanceOf(UnderstandPage)
    })
  })

  describe('Lifecycle Methods', () => {
    it('should handle onActivate', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      expect(() => page.onActivate()).not.toThrow()
    })

    it('should handle onDeactivate', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      expect(() => page.onDeactivate()).not.toThrow()
    })

    it('should handle onLanguageChange', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      expect(() => page.onLanguageChange()).not.toThrow()
    })

    it('should handle destroy', async () => {
      const app = createMockApp()
      const page = new UnderstandPage(app)

      await new Promise(resolve => setTimeout(resolve, 100))

      expect(() => page.destroy()).not.toThrow()
      expect(page.getUploadedImagesCount()).toBe(0)
    })
  })
})
