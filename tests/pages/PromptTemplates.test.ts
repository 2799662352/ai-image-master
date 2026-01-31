// tests/pages/PromptTemplates.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PromptTemplates, createPromptTemplates, getPromptTemplates, type PromptTemplate } from '../../src/renderer/src/pages'

// Mock DOM
const mockDocument = {
  getElementById: vi.fn(),
  querySelectorAll: vi.fn(),
  createElement: vi.fn(),
  addEventListener: vi.fn(),
  body: {
    appendChild: vi.fn(),
    style: {}
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
  i18n: {
    t: vi.fn((key: string) => key)
  },
  pageStateManager: {
    loadState: vi.fn().mockResolvedValue(null),
    saveState: vi.fn(),
    savePageState: vi.fn(),
    getPageState: vi.fn().mockReturnValue(null)
  },
  toastManagerTS: {
    show: vi.fn()
  }
}

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
  classList: {
    add: vi.fn(),
    remove: vi.fn(),
    contains: vi.fn().mockReturnValue(false)
  },
  setAttribute: vi.fn(),
  getAttribute: vi.fn(),
  querySelector: vi.fn().mockReturnValue(null),
  querySelectorAll: vi.fn().mockReturnValue([]),
  dataset: {},
  textContent: '',
  dispatchEvent: vi.fn(),
  ...extras
})

// Setup mocks
beforeEach(() => {
  vi.stubGlobal('document', mockDocument)
  vi.stubGlobal('window', mockWindow)

  // Reset all mocks
  vi.clearAllMocks()

  // Default getElementById behavior
  mockDocument.getElementById.mockImplementation((id: string) => {
    if (id === 'promptTemplateModal') {
      return createMockElement({ id: 'promptTemplateModal' })
    }
    if (id === 'templateGrid') {
      return createMockElement({ id: 'templateGrid' })
    }
    if (id === 'templateLoading') {
      return createMockElement({ id: 'templateLoading' })
    }
    if (id === 'templateEmpty') {
      return createMockElement({ id: 'templateEmpty' })
    }
    if (id === 'promptInput') {
      return createMockElement({ id: 'promptInput', value: '' })
    }
    if (id === 'batchPrompts') {
      return createMockElement({ id: 'batchPrompts', value: '' })
    }
    return null
  })

  mockDocument.createElement.mockImplementation((tag: string) => {
    return createMockElement({ tagName: tag.toUpperCase() })
  })

  mockDocument.querySelectorAll.mockReturnValue([])

  // Mock fetch for template loading
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      '热门': [
        { id: 1, title: '测试模板1', prompt: '测试提示词1', preview: 'test.jpg', tags: ['标签1'] },
        { id: 2, title: '测试模板2', prompt: '测试提示词2', preview: 'test2.jpg', tags: ['标签2'] }
      ],
      '电商': [
        { id: 101, title: '电商模板', prompt: '电商提示词', preview: 'ecom.jpg', tags: ['电商'] }
      ]
    })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PromptTemplates', () => {
  describe('Constructor and Initialization', () => {
    it('should create instance and initialize', () => {
      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      expect(promptTemplates).toBeInstanceOf(PromptTemplates)
    })

    it('should bind events during initialization', () => {
      const app = createMockApp()
      const mockModal = createMockElement({ id: 'promptTemplateModal' })
      mockModal.querySelectorAll.mockReturnValue([])
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'promptTemplateModal') return mockModal
        return createMockElement({ id })
      })

      const promptTemplates = new PromptTemplates(app)

      // Modal should have event listeners attached
      expect(mockModal.addEventListener).toHaveBeenCalled()
    })
  })

  describe('Template Loading', () => {
    it('should load templates from JSON on first modal open', async () => {
      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      expect(promptTemplates.isLoaded()).toBe(false)

      await promptTemplates.loadTemplates()

      expect(global.fetch).toHaveBeenCalledWith('data/prompt-templates.json')
    })

    it('should use default templates if fetch fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))

      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      await promptTemplates.loadTemplates()

      const categories = promptTemplates.getCategories()
      expect(categories.length).toBeGreaterThan(0)
    })

    it('should have default templates available', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))

      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      await promptTemplates.loadTemplates()

      expect(promptTemplates.getTemplateCount()).toBeGreaterThan(0)
    })
  })

  describe('Category Management', () => {
    it('should switch category correctly', async () => {
      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      await promptTemplates.loadTemplates()

      promptTemplates.switchCategory('电商')
      expect(promptTemplates.getCurrentCategory()).toBe('电商')
    })

    it('should get template count for specific category', async () => {
      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      await promptTemplates.loadTemplates()

      const count = promptTemplates.getTemplateCount('热门')
      expect(count).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Template Application', () => {
    it('should apply template in single mode', async () => {
      const mockInput = createMockElement({ id: 'promptInput', value: '' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'promptInput') return mockInput
        if (id === 'promptTemplateModal') return createMockElement({ id: 'promptTemplateModal' })
        return createMockElement({ id })
      })

      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      const template: PromptTemplate = {
        id: 1,
        title: '测试模板',
        prompt: '测试提示词内容',
        preview: 'test.jpg',
        tags: ['测试']
      }

      // Set target input manually for test
      ;(promptTemplates as any).targetInput = mockInput
      ;(promptTemplates as any).isBatchMode = false

      promptTemplates.applyTemplate(template)

      expect(mockInput.value).toBe('测试提示词内容')
      // i18n mock returns the key, so we check for any toast with 'success' type
      expect(app.showToast).toHaveBeenCalledWith(expect.any(String), 'success')
    })

    it('should append template in batch mode', async () => {
      const mockInput = createMockElement({ id: 'batchPrompts', value: '已有内容' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'batchPrompts') return mockInput
        if (id === 'promptTemplateModal') return createMockElement({ id: 'promptTemplateModal' })
        return createMockElement({ id })
      })

      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      const template: PromptTemplate = {
        id: 1,
        title: '测试模板',
        prompt: '新提示词',
        preview: 'test.jpg',
        tags: ['测试']
      }

      ;(promptTemplates as any).targetInput = mockInput
      ;(promptTemplates as any).isBatchMode = true

      promptTemplates.applyTemplate(template)

      expect(mockInput.value).toBe('已有内容\n新提示词')
    })
  })

  describe('Modal Management', () => {
    it('should show modal and prevent body scroll', async () => {
      const mockModal = createMockElement({
        id: 'promptTemplateModal',
        classList: {
          add: vi.fn(),
          remove: vi.fn(),
          contains: vi.fn().mockReturnValue(true)
        }
      })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'promptTemplateModal') return mockModal
        return createMockElement({ id })
      })

      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      await promptTemplates.showTemplateModal()

      expect(mockModal.classList.remove).toHaveBeenCalledWith('hidden')
    })

    it('should hide modal correctly', () => {
      const mockModal = createMockElement({ id: 'promptTemplateModal' })
      mockDocument.getElementById.mockImplementation((id: string) => {
        if (id === 'promptTemplateModal') return mockModal
        return createMockElement({ id })
      })

      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      promptTemplates.hideTemplateModal()

      expect(mockModal.classList.add).toHaveBeenCalledWith('hidden')
    })
  })

  describe('State Management', () => {
    it('should save state correctly', () => {
      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      promptTemplates.saveState()

      expect(mockWindow.pageStateManager.savePageState).toHaveBeenCalledWith('promptTemplates', expect.any(Object))
    })

    it('should collect state correctly', async () => {
      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      await promptTemplates.loadTemplates()
      promptTemplates.switchCategory('电商')

      const state = promptTemplates.collectState()

      expect(state.currentCategory).toBe('电商')
    })
  })

  describe('Factory Functions', () => {
    it('should create instance via factory function', () => {
      const app = createMockApp()
      const instance = createPromptTemplates(app)

      expect(instance).toBeInstanceOf(PromptTemplates)
    })

    it('should return same instance via getter', () => {
      const app = createMockApp()
      createPromptTemplates(app)
      const instance = getPromptTemplates()

      expect(instance).toBeInstanceOf(PromptTemplates)
    })
  })

  describe('Lifecycle Methods', () => {
    it('should handle onActivate', () => {
      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      expect(() => promptTemplates.onActivate()).not.toThrow()
    })

    it('should handle onDeactivate', () => {
      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      expect(() => promptTemplates.onDeactivate()).not.toThrow()
    })

    it('should handle onLanguageChange', () => {
      const app = createMockApp()
      const promptTemplates = new PromptTemplates(app)

      expect(() => promptTemplates.onLanguageChange()).not.toThrow()
    })
  })
})
