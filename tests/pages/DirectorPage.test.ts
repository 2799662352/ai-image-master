// tests/pages/DirectorPage.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DirectorPage, createDirectorPage, getDirectorPage, type LayoutType, type GenerationMode, type DirectorReferenceImage } from '../../src/renderer/src/pages'

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
  currentTab: 'director',
  history: [],
  pages: {},
  openSettings: vi.fn(),
  viewImage: vi.fn()
})

// Mock window objects
const mockWindow = {
  aiImageAPI: {
    apiKey: 'test-key',
    visionApiKey: 'test-vision-key',
    generateImageWithReference: vi.fn().mockResolvedValue({
      success: true,
      urls: ['http://test.com/comic.png']
    }),
    analyzeImagesStream: vi.fn((images, prompt, model, maxTokens, onChunk, onComplete, onError) => {
      onChunk('Analysis result')
      onComplete()
    })
  },
  i18n: {
    t: vi.fn((key: string) => key),
    onLanguageChange: vi.fn(),
    updateDOM: vi.fn()
  },
  pageStateManager: {
    loadState: vi.fn().mockResolvedValue(null),
    saveState: vi.fn(),
    savePageState: vi.fn(),
    getPageState: vi.fn().mockReturnValue(null),
    saveStateImmediate: vi.fn()
  },
  toastManagerTS: {
    show: vi.fn()
  },
  electronAPI: null,
  requestIdleCallback: vi.fn((cb) => setTimeout(cb, 0)),
  open: vi.fn()
}

// Helper to create mock element
const createMockElement = (extras = {}) => ({
  tagName: 'div',
  className: '',
  innerHTML: '',
  style: { setProperty: vi.fn(), width: '' },
  id: '',
  value: '',
  checked: false,
  disabled: false,
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
  closest: vi.fn().mockReturnValue(null),
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

  // Mock localStorage
  const localStorageData: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => localStorageData[key] || null),
    setItem: vi.fn((key: string, value: string) => { localStorageData[key] = value }),
    removeItem: vi.fn((key: string) => { delete localStorageData[key] })
  })

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

  // Mock fetch
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    blob: vi.fn().mockResolvedValue(new Blob(['test'], { type: 'image/png' }))
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DirectorPage', () => {
  describe('Constructor and Initialization', () => {
    it('should create instance and initialize', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      expect(page).toBeInstanceOf(DirectorPage)
    })

    it('should have default layout set to 6grid', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      expect(page.getCurrentLayout()).toBe('6grid')
    })

    it('should have default mode set to single', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      expect(page.getCurrentMode()).toBe('single')
    })

    it('should start with no reference images', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      expect(page.getReferenceImagesCount()).toBe(0)
    })

    it('should not be generating initially', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      expect(page.getIsGenerating()).toBe(false)
    })
  })

  describe('Layout Selection', () => {
    it('should select 6grid layout', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      page.selectLayout('6grid')
      expect(page.getCurrentLayout()).toBe('6grid')
    })

    it('should select 4grid layout', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      page.selectLayout('4grid')
      expect(page.getCurrentLayout()).toBe('4grid')
    })

    it('should select 2closeup layout', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      page.selectLayout('2closeup')
      expect(page.getCurrentLayout()).toBe('2closeup')
    })

    it('should select 9grid layout', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      page.selectLayout('9grid')
      expect(page.getCurrentLayout()).toBe('9grid')
    })
  })

  describe('Mode Switching', () => {
    it('should switch to single mode', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      page.switchMode('single')
      expect(page.getCurrentMode()).toBe('single')
    })

    it('should switch to multi mode', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      page.switchMode('multi')
      expect(page.getCurrentMode()).toBe('multi')
    })
  })

  describe('Reference Image Management', () => {
    it('should handle file upload', async () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      const mockFile = new File(['test'], 'test.png', { type: 'image/png' })
      Object.defineProperty(mockFile, 'size', { value: 1024 })

      await page.handleMultipleReferenceImageUpload([mockFile])
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(page.getReferenceImagesCount()).toBe(1)
    })

    it('should limit to max 8 reference images', async () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      const files: File[] = []
      for (let i = 0; i < 10; i++) {
        const file = new File(['test'], `test${i}.png`, { type: 'image/png' })
        Object.defineProperty(file, 'size', { value: 1024 })
        files.push(file)
      }

      await page.handleMultipleReferenceImageUpload(files)
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(page.getReferenceImagesCount()).toBeLessThanOrEqual(8)
    })

    it('should remove reference image by index', async () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      const mockFile = new File(['test'], 'test.png', { type: 'image/png' })
      Object.defineProperty(mockFile, 'size', { value: 1024 })

      await page.handleMultipleReferenceImageUpload([mockFile])
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(page.getReferenceImagesCount()).toBe(1)

      page.removeReferenceImage(0)
      expect(page.getReferenceImagesCount()).toBe(0)
    })

    it('should clear all reference images', async () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      const mockFile = new File(['test'], 'test.png', { type: 'image/png' })
      Object.defineProperty(mockFile, 'size', { value: 1024 })

      await page.handleMultipleReferenceImageUpload([mockFile])
      await new Promise(resolve => setTimeout(resolve, 100))

      page.clearReferenceImage()
      expect(page.getReferenceImagesCount()).toBe(0)
      expect(app.showToast).toHaveBeenCalledWith('已清除所有参考图', 'info')
    })
  })

  describe('Template Management', () => {
    it('should show template modal', () => {
      const mockModal = createMockElement({ id: 'directorTemplateModal' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'directorTemplateModal') return mockModal
        if (id === 'directorTemplateList') return createMockElement({ id })
        return createMockElement({ id })
      })

      const app = createMockApp()
      const page = new DirectorPage(app)

      page.showTemplateModal()

      expect(mockModal.classList.remove).toHaveBeenCalledWith('hidden')
    })

    it('should hide template modal', () => {
      const mockModal = createMockElement({ id: 'directorTemplateModal' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'directorTemplateModal') return mockModal
        return createMockElement({ id })
      })

      const app = createMockApp()
      const page = new DirectorPage(app)

      page.hideTemplateModal()

      expect(mockModal.classList.add).toHaveBeenCalledWith('hidden')
    })

    it('should select template', () => {
      const mockNameSpan = createMockElement({ id: 'directorTemplateName' })
      const mockClearBtn = createMockElement({ id: 'directorClearTemplate' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'directorTemplateName') return mockNameSpan
        if (id === 'directorClearTemplate') return mockClearBtn
        if (id === 'directorTemplateModal') return createMockElement({ id })
        return createMockElement({ id })
      })

      const app = createMockApp()
      const page = new DirectorPage(app)

      page.selectTemplate('anime')

      expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('动画截图风格'), 'success')
    })

    it('should clear template', () => {
      const mockNameSpan = createMockElement({ id: 'directorTemplateName' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'directorTemplateName') return mockNameSpan
        return createMockElement({ id })
      })

      const app = createMockApp()
      const page = new DirectorPage(app)

      page.selectTemplate('anime')
      page.clearTemplate()

      expect(mockNameSpan.textContent).toBe('默认（无模板）')
    })
  })

  describe('Gallery Management', () => {
    it('should show gallery modal', () => {
      const mockModal = createMockElement({ id: 'directorGalleryModal' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'directorGalleryModal') return mockModal
        return createMockElement({ id })
      })

      const app = createMockApp()
      const page = new DirectorPage(app)

      page.showGalleryModal()

      expect(mockModal.classList.remove).toHaveBeenCalledWith('hidden')
    })

    it('should hide gallery modal', () => {
      const mockModal = createMockElement({ id: 'directorGalleryModal' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'directorGalleryModal') return mockModal
        return createMockElement({ id })
      })

      const app = createMockApp()
      const page = new DirectorPage(app)

      page.hideGalleryModal()

      expect(mockModal.classList.add).toHaveBeenCalledWith('hidden')
    })
  })

  describe('Generation', () => {
    it('should not generate without reference images', async () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      await page.startGeneration()

      expect(app.showToast).toHaveBeenCalledWith('请先上传参考图', 'warning')
    })

    it('should not generate without API key', async () => {
      vi.stubGlobal('window', { ...mockWindow, aiImageAPI: { apiKey: null } })

      const app = createMockApp()
      const page = new DirectorPage(app)

      const mockFile = new File(['test'], 'test.png', { type: 'image/png' })
      Object.defineProperty(mockFile, 'size', { value: 1024 })
      await page.handleMultipleReferenceImageUpload([mockFile])
      await new Promise(resolve => setTimeout(resolve, 100))

      await page.startGeneration()

      expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('API Key'), 'error')
    })

    it('should track generated results count', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      expect(page.getGeneratedResultsCount()).toBe(0)
    })
  })

  describe('Download', () => {
    it('should handle download result', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      // Should not throw even if no results
      expect(() => page.downloadResult()).not.toThrow()
    })

    it('should handle download all results', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      page.downloadAllResults()

      expect(app.showToast).toHaveBeenCalledWith('没有可下载的图片', 'warning')
    })
  })

  describe('State Management', () => {
    it('should collect state correctly', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      const state = page.collectState()

      expect(state).toHaveProperty('mode')
      expect(state).toHaveProperty('layout')
      expect(state).toHaveProperty('ratio')
      expect(state).toHaveProperty('resolution')
      expect(state).toHaveProperty('template')
      expect(state).toHaveProperty('referenceImages')
    })

    it('should apply state correctly', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      page.applyState({
        mode: 'multi',
        layout: '4grid',
        ratio: '1:1',
        resolution: '4K',
        template: null,
        imageCount: '3',
        sceneDescription: '',
        multiScenePrompts: '',
        referenceImages: []
      })

      expect(page.getCurrentMode()).toBe('multi')
      expect(page.getCurrentLayout()).toBe('4grid')
    })

    it('should save state correctly', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      page.saveState()

      expect(mockWindow.pageStateManager.savePageState).toHaveBeenCalled()
    })
  })

  describe('Factory Functions', () => {
    it('should create instance via factory function', () => {
      const app = createMockApp()
      const instance = createDirectorPage(app)

      expect(instance).toBeInstanceOf(DirectorPage)
    })

    it('should return instance via getter', () => {
      const app = createMockApp()
      createDirectorPage(app)

      const instance = getDirectorPage()
      expect(instance).toBeInstanceOf(DirectorPage)
    })
  })

  describe('Lifecycle Methods', () => {
    it('should handle onActivate', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      expect(() => page.onActivate()).not.toThrow()
    })

    it('should handle onDeactivate', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      expect(() => page.onDeactivate()).not.toThrow()
    })

    it('should handle onLanguageChange', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      expect(() => page.onLanguageChange()).not.toThrow()
    })

    it('should handle destroy', () => {
      const app = createMockApp()
      const page = new DirectorPage(app)

      expect(() => page.destroy()).not.toThrow()
      expect(page.getReferenceImagesCount()).toBe(0)
    })
  })

  describe('UI Updates', () => {
    it('should update layout selection UI', () => {
      mockDocument.querySelectorAll.mockReturnValue([
        createMockElement({ dataset: { layout: '6grid' } }),
        createMockElement({ dataset: { layout: '4grid' } })
      ])

      const app = createMockApp()
      const page = new DirectorPage(app)

      expect(() => page.updateLayoutSelection()).not.toThrow()
    })

    it('should update prompt count', () => {
      const mockInput = createMockElement({ id: 'directorMultiSceneInput', value: 'Scene 1\n\nScene 2' })
      const mockCountSpan = createMockElement({ id: 'directorPromptCount' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'directorMultiSceneInput') return mockInput
        if (id === 'directorPromptCount') return mockCountSpan
        return createMockElement({ id })
      })

      const app = createMockApp()
      const page = new DirectorPage(app)

      page.updatePromptCount()

      expect(mockCountSpan.textContent).toBe('2 个场景')
    })

    it('should update image count display', () => {
      const mockSlider = createMockElement({ id: 'directorImageCount', value: '5' })
      const mockDisplay = createMockElement({ id: 'directorCountDisplay' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'directorImageCount') return mockSlider
        if (id === 'directorCountDisplay') return mockDisplay
        return createMockElement({ id })
      })

      const app = createMockApp()
      const page = new DirectorPage(app)

      page.updateImageCountDisplay()

      expect(mockDisplay.textContent).toBe('5张')
    })

    it('should update generate button state', () => {
      const mockBtn = createMockElement({ id: 'directorGenerateBtn', disabled: false })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'directorGenerateBtn') return mockBtn
        return createMockElement({ id })
      })

      const app = createMockApp()
      const page = new DirectorPage(app)

      page.updateGenerateButtonState()

      // Button should be disabled when no reference images
      expect(mockBtn.disabled).toBe(true)
    })
  })
})
