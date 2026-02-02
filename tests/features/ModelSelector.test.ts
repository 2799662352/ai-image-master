/** @vitest-environment jsdom */
// tests/features/ModelSelector.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ModelSelector,
  createModelSelector,
  type ModelSelectorOptions,
  type ModelInfo
} from '../../src/renderer/src/features/model-selector/ModelSelector'

// Mock Choices.js - Complete mock class
class MockChoices {
  element: HTMLElement
  options: any
  passedElement: { element: HTMLElement }
  static instances: MockChoices[] = []

  constructor(element: HTMLElement | string, options?: any) {
    this.element =
      typeof element === 'string'
        ? (document.querySelector(element) as HTMLElement)
        : element
    this.options = options
    this.passedElement = { element: this.element }
    MockChoices.instances.push(this)

    // Call callbackOnInit if provided
    if (options?.callbackOnInit) {
      options.callbackOnInit()
    }
  }

  setChoices = vi.fn()
  clearChoices = vi.fn()
  clearStore = vi.fn()
  setChoiceByValue = vi.fn()
  getValue = vi.fn(() => ({ value: 'test' }))
  destroy = vi.fn()
  init = vi.fn()
  enable = vi.fn()
  disable = vi.fn()

  static clearInstances() {
    MockChoices.instances = []
  }
}

// Mock window.aiImageAPI
const mockAiImageAPI = {
  getAllModels: vi.fn(
    (): Record<string, ModelInfo> => ({
      'model-1': { name: 'Model 1', displayName: 'Test Model 1' },
      'model-2': { name: 'Model 2', displayName: 'Test Model 2', time: '30s', isNew: true }
    })
  ),
  model: 'model-1',
  getCurrentModel: vi.fn(() => ({
    name: 'Model 1',
    displayName: 'Test Model 1',
    capabilities: { multipleImages: true, customSize: true }
  })),
  saveModel: vi.fn(() => true),
  models: {
    'model-1': { name: 'Model 1', displayName: 'Test Model 1' },
    'model-2': { name: 'Model 2', displayName: 'Test Model 2', time: '30s', isNew: true }
  }
}

describe('ModelSelector', () => {
  let selector: ModelSelector

  beforeEach(() => {
    // Setup DOM
    document.body.innerHTML = `
      <select id="modelSelector"></select>
      <select id="modelSelectorMobile"></select>
    `

    // Setup global mocks using vi.stubGlobal for proper typeof checks
    vi.stubGlobal('Choices', MockChoices)
    vi.stubGlobal('aiImageAPI', mockAiImageAPI)
    // Also set on window for window.aiImageAPI access
    ;(window as any).aiImageAPI = mockAiImageAPI

    MockChoices.clearInstances()
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (selector) {
      selector.destroy()
    }
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    delete (window as any).aiImageAPI
  })

  describe('constructor', () => {
    it('should create instance with default options', () => {
      selector = new ModelSelector()

      expect(selector).toBeInstanceOf(ModelSelector)
      expect(selector.isInitialized()).toBe(false)
    })

    it('should create instance with custom options', () => {
      const onModelChange = vi.fn()
      const getModelDisplayName = vi.fn((key: string) => `Custom: ${key}`)

      selector = new ModelSelector({
        onModelChange,
        getModelDisplayName
      })

      expect(selector).toBeInstanceOf(ModelSelector)
    })
  })

  describe('createModelSelector factory', () => {
    it('should create a new ModelSelector instance', () => {
      selector = createModelSelector()

      expect(selector).toBeInstanceOf(ModelSelector)
    })

    it('should pass options to the instance', () => {
      const onModelChange = vi.fn()
      selector = createModelSelector({ onModelChange })

      expect(selector).toBeInstanceOf(ModelSelector)
    })
  })

  describe('init', () => {
    it('should initialize both desktop and mobile selectors', () => {
      selector = new ModelSelector()
      selector.init()

      expect(MockChoices.instances).toHaveLength(2)
      expect(selector.isInitialized()).toBe(true)
    })

    it('should retry if Choices.js is not available', () => {
      vi.useFakeTimers()
      // Unstub Choices to simulate it not being loaded yet
      vi.unstubAllGlobals()
      // Re-stub aiImageAPI as it was also unstubbed
      vi.stubGlobal('aiImageAPI', mockAiImageAPI)
      ;(window as any).aiImageAPI = mockAiImageAPI

      selector = new ModelSelector()
      selector.init(0)

      // Verify no instances created yet (Choices not available)
      expect(MockChoices.instances.length).toBe(0)

      // Now stub Choices and advance timers
      vi.stubGlobal('Choices', MockChoices)
      vi.advanceTimersByTime(100)

      expect(MockChoices.instances.length).toBeGreaterThan(0)

      vi.useRealTimers()
    })

    it('should give up after MAX_RETRIES when Choices.js never loads', () => {
      vi.useFakeTimers()
      // Unstub Choices to simulate it not being loaded
      vi.unstubAllGlobals()
      vi.stubGlobal('aiImageAPI', mockAiImageAPI)
      ;(window as any).aiImageAPI = mockAiImageAPI
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      selector = new ModelSelector()
      selector.init(0)

      // Advance timers beyond MAX_RETRIES (30 * 100ms = 3000ms)
      for (let i = 0; i < 35; i++) {
        vi.advanceTimersByTime(100)
      }

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Choices.js 加载超时')
      )
      expect(selector.isInitialized()).toBe(false)

      vi.useRealTimers()
      consoleErrorSpy.mockRestore()
    })

    it('should retry if DOM elements are not ready', () => {
      vi.useFakeTimers()
      document.body.innerHTML = '' // Remove DOM elements

      selector = new ModelSelector()
      selector.init()

      expect(MockChoices.instances.length).toBe(0)

      // Add DOM elements and advance timer
      document.body.innerHTML = `
        <select id="modelSelector"></select>
        <select id="modelSelectorMobile"></select>
      `
      vi.advanceTimersByTime(100)

      expect(MockChoices.instances.length).toBe(2)

      vi.useRealTimers()
    })

    it('should populate options correctly', () => {
      selector = new ModelSelector()
      selector.init()

      const desktopSelect = document.getElementById('modelSelector') as HTMLSelectElement
      expect(desktopSelect.options.length).toBe(2)
      expect(desktopSelect.options[0].value).toBe('model-1')
      expect(desktopSelect.options[1].value).toBe('model-2')
    })

    it('should mark current model as selected', () => {
      selector = new ModelSelector()
      selector.init()

      const desktopSelect = document.getElementById('modelSelector') as HTMLSelectElement
      expect(desktopSelect.options[0].selected).toBe(true)
      expect(desktopSelect.options[0].value).toBe('model-1')
    })

    it('should use custom getModelDisplayName when provided', () => {
      const getModelDisplayName = vi.fn((key: string) => `Custom Display: ${key}`)
      selector = new ModelSelector({ getModelDisplayName })
      selector.init()

      const desktopSelect = document.getElementById('modelSelector') as HTMLSelectElement
      expect(desktopSelect.options[0].textContent).toContain('Custom Display')
      expect(getModelDisplayName).toHaveBeenCalled()
    })

    it('should handle initialization error gracefully', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // Make getAllModels throw an error
      mockAiImageAPI.getAllModels.mockImplementationOnce(() => {
        throw new Error('API Error')
      })

      selector = new ModelSelector()
      selector.init()

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('模型选择器初始化失败'),
        expect.any(Error)
      )

      consoleErrorSpy.mockRestore()
    })

    it('should handle missing API gracefully', () => {
      delete (window as any).aiImageAPI
      vi.stubGlobal('aiImageAPI', undefined)

      selector = new ModelSelector()
      selector.init()

      // Should still initialize but with empty models
      expect(selector.isInitialized()).toBe(true)
    })
  })

  describe('setCurrentModel', () => {
    it('should update both desktop and mobile selectors', () => {
      selector = new ModelSelector()
      selector.init()

      selector.setCurrentModel('model-2')

      expect(MockChoices.instances[0].setChoiceByValue).toHaveBeenCalledWith('model-2')
      expect(MockChoices.instances[1].setChoiceByValue).toHaveBeenCalledWith('model-2')
    })

    it('should not throw if selectors are not initialized', () => {
      selector = new ModelSelector()

      expect(() => selector.setCurrentModel('model-2')).not.toThrow()
    })

    it('should only update desktop if mobile is not initialized', () => {
      selector = new ModelSelector()
      selector.init()

      // Manually set mobileChoice to null
      ;(selector as any).mobileChoice = null

      selector.setCurrentModel('model-2')

      expect(MockChoices.instances[0].setChoiceByValue).toHaveBeenCalledWith('model-2')
    })
  })

  describe('refresh', () => {
    it('should reinitialize selectors with current models', () => {
      selector = new ModelSelector()
      selector.init()
      const initialCount = MockChoices.instances.length

      selector.refresh()

      expect(MockChoices.instances.length).toBeGreaterThan(initialCount)
    })

    it('should destroy old instances before creating new ones', () => {
      selector = new ModelSelector()
      selector.init()

      const oldDesktopInstance = MockChoices.instances[0]
      const oldMobileInstance = MockChoices.instances[1]

      selector.refresh()

      expect(oldDesktopInstance.destroy).toHaveBeenCalled()
      expect(oldMobileInstance.destroy).toHaveBeenCalled()
    })

    it('should handle missing DOM elements gracefully', () => {
      selector = new ModelSelector()
      selector.init()

      document.body.innerHTML = '' // Remove DOM

      expect(() => selector.refresh()).not.toThrow()
    })
  })

  describe('destroy', () => {
    it('should clean up Choices instances', () => {
      selector = new ModelSelector()
      selector.init()

      const desktopInstance = MockChoices.instances[0]
      const mobileInstance = MockChoices.instances[1]

      selector.destroy()

      expect(desktopInstance.destroy).toHaveBeenCalled()
      expect(mobileInstance.destroy).toHaveBeenCalled()
      expect(selector.isInitialized()).toBe(false)
    })

    it('should handle destroy when not initialized', () => {
      selector = new ModelSelector()

      expect(() => selector.destroy()).not.toThrow()
      expect(selector.isInitialized()).toBe(false)
    })

    it('should set instances to null after destroy', () => {
      selector = new ModelSelector()
      selector.init()
      selector.destroy()

      // Internal state should be null
      expect((selector as any).desktopChoice).toBeNull()
      expect((selector as any).mobileChoice).toBeNull()
    })
  })

  describe('isInitialized', () => {
    it('should return false before initialization', () => {
      selector = new ModelSelector()

      expect(selector.isInitialized()).toBe(false)
    })

    it('should return true after initialization', () => {
      selector = new ModelSelector()
      selector.init()

      expect(selector.isInitialized()).toBe(true)
    })

    it('should return false after destroy', () => {
      selector = new ModelSelector()
      selector.init()
      selector.destroy()

      expect(selector.isInitialized()).toBe(false)
    })
  })

  describe('event handling', () => {
    it('should call onModelChange when choice event is fired', () => {
      const onModelChange = vi.fn()
      selector = new ModelSelector({ onModelChange })
      selector.init()

      const desktopSelect = document.getElementById('modelSelector') as HTMLSelectElement
      const choiceEvent = new CustomEvent('choice', {
        detail: { choice: { value: 'model-2' } }
      })
      desktopSelect.dispatchEvent(choiceEvent)

      expect(onModelChange).toHaveBeenCalledWith('model-2')
    })

    it('should call onModelChange when change event is fired', () => {
      const onModelChange = vi.fn()
      selector = new ModelSelector({ onModelChange })
      selector.init()

      const desktopSelect = document.getElementById('modelSelector') as HTMLSelectElement
      desktopSelect.value = 'model-2'
      desktopSelect.dispatchEvent(new Event('change'))

      expect(onModelChange).toHaveBeenCalledWith('model-2')
    })

    it('should not call onModelChange when choice event has no value', () => {
      const onModelChange = vi.fn()
      selector = new ModelSelector({ onModelChange })
      selector.init()

      const desktopSelect = document.getElementById('modelSelector') as HTMLSelectElement
      const choiceEvent = new CustomEvent('choice', {
        detail: { choice: {} }
      })
      desktopSelect.dispatchEvent(choiceEvent)

      expect(onModelChange).not.toHaveBeenCalled()
    })

    it('should not call onModelChange when change event target has no value', () => {
      const onModelChange = vi.fn()
      selector = new ModelSelector({ onModelChange })
      selector.init()

      const desktopSelect = document.getElementById('modelSelector') as HTMLSelectElement
      desktopSelect.value = ''
      desktopSelect.dispatchEvent(new Event('change'))

      expect(onModelChange).not.toHaveBeenCalled()
    })
  })

  describe('Choices.js template creation', () => {
    it('should create item template correctly', () => {
      selector = new ModelSelector()
      selector.init()

      const choicesInstance = MockChoices.instances[0]
      const templateCallback = choicesInstance.options.callbackOnCreateTemplates

      expect(templateCallback).toBeDefined()

      // Create a mock template function
      const mockTemplate = vi.fn((html: string) => {
        const div = document.createElement('div')
        div.innerHTML = html.trim()
        return div.firstChild
      })

      const templates = templateCallback(mockTemplate)

      expect(templates.item).toBeDefined()
      expect(templates.choice).toBeDefined()
    })

    it('should render item template with model name', () => {
      selector = new ModelSelector()
      selector.init()

      const choicesInstance = MockChoices.instances[0]
      const templateCallback = choicesInstance.options.callbackOnCreateTemplates

      const mockTemplate = vi.fn((html: string) => {
        const div = document.createElement('div')
        div.innerHTML = html.trim()
        return div.firstChild
      })

      const templates = templateCallback(mockTemplate)
      const result = templates.item(
        { classNames: { item: 'item-class' } },
        { label: 'GPT-4 - Best model' }
      )

      expect(mockTemplate).toHaveBeenCalled()
      const templateCall = mockTemplate.mock.calls[0][0]
      expect(templateCall).toContain('GPT-4')
      expect(templateCall).toContain('fa-robot')
    })

    it('should render choice template with badges for new models', () => {
      selector = new ModelSelector()
      selector.init()

      const choicesInstance = MockChoices.instances[0]
      const templateCallback = choicesInstance.options.callbackOnCreateTemplates

      const mockTemplate = vi.fn((html: string) => {
        const div = document.createElement('div')
        div.innerHTML = html.trim()
        return div.firstChild
      })

      const templates = templateCallback(mockTemplate)
      templates.choice(
        { classNames: { item: 'item-class', itemChoice: 'choice-class', itemSelectable: 'selectable', itemDisabled: 'disabled' } },
        { label: 'Model 2 - Test Model 2', value: 'model-2', id: '2', disabled: false }
      )

      const templateCall = mockTemplate.mock.calls[0][0]
      expect(templateCall).toContain('Model 2')
      expect(templateCall).toContain('model-badge-new')
      expect(templateCall).toContain('model-badge-time')
      expect(templateCall).toContain('30s')
    })

    it('should render choice template for disabled items', () => {
      selector = new ModelSelector()
      selector.init()

      const choicesInstance = MockChoices.instances[0]
      const templateCallback = choicesInstance.options.callbackOnCreateTemplates

      const mockTemplate = vi.fn((html: string) => {
        const div = document.createElement('div')
        div.innerHTML = html.trim()
        return div.firstChild
      })

      const templates = templateCallback(mockTemplate)
      templates.choice(
        { classNames: { item: 'item-class', itemChoice: 'choice-class', itemSelectable: 'selectable', itemDisabled: 'disabled' } },
        { label: 'Model 1 - Test', value: 'model-1', id: '1', disabled: true }
      )

      const templateCall = mockTemplate.mock.calls[0][0]
      expect(templateCall).toContain('aria-disabled="true"')
      expect(templateCall).toContain('data-choice-disabled')
    })
  })

  describe('reinitialization behavior', () => {
    it('should destroy old desktop instance before creating new one', () => {
      selector = new ModelSelector()
      selector.init()

      const oldInstance = MockChoices.instances[0]

      // Manually call initDesktop again via refresh
      selector.refresh()

      expect(oldInstance.destroy).toHaveBeenCalled()
    })

    it('should destroy old mobile instance before creating new one', () => {
      selector = new ModelSelector()
      selector.init()

      const oldInstance = MockChoices.instances[1]

      selector.refresh()

      expect(oldInstance.destroy).toHaveBeenCalled()
    })
  })

  describe('edge cases', () => {
    it('should handle empty models object', () => {
      mockAiImageAPI.getAllModels.mockReturnValueOnce({})

      selector = new ModelSelector()
      selector.init()

      const desktopSelect = document.getElementById('modelSelector') as HTMLSelectElement
      expect(desktopSelect.options.length).toBe(0)
    })

    it('should handle model without displayName', () => {
      mockAiImageAPI.getAllModels.mockReturnValueOnce({
        'model-x': { name: 'Model X' } as ModelInfo
      })

      selector = new ModelSelector()
      selector.init()

      const desktopSelect = document.getElementById('modelSelector') as HTMLSelectElement
      expect(desktopSelect.options[0].textContent).toContain('Model X')
    })

    it('should handle models without time or isNew properties', () => {
      mockAiImageAPI.getAllModels.mockReturnValueOnce({
        'basic-model': { name: 'Basic', displayName: 'Basic Model' }
      })
      ;(window as any).aiImageAPI.models = {
        'basic-model': { name: 'Basic', displayName: 'Basic Model' }
      }

      selector = new ModelSelector()
      selector.init()

      const choicesInstance = MockChoices.instances[0]
      const templateCallback = choicesInstance.options.callbackOnCreateTemplates

      const mockTemplate = vi.fn((html: string) => {
        const div = document.createElement('div')
        div.innerHTML = html.trim()
        return div.firstChild
      })

      const templates = templateCallback(mockTemplate)
      templates.choice(
        { classNames: { item: 'item-class', itemChoice: 'choice-class', itemSelectable: 'selectable', itemDisabled: 'disabled' } },
        { label: 'Basic - Basic Model', value: 'basic-model', id: '1', disabled: false }
      )

      const templateCall = mockTemplate.mock.calls[0][0]
      expect(templateCall).not.toContain('model-badge-new')
      expect(templateCall).not.toContain('model-badge-time')
    })

    it('should handle choice event with missing detail', () => {
      const onModelChange = vi.fn()
      selector = new ModelSelector({ onModelChange })
      selector.init()

      const desktopSelect = document.getElementById('modelSelector') as HTMLSelectElement
      const choiceEvent = new CustomEvent('choice', {
        detail: null
      })
      desktopSelect.dispatchEvent(choiceEvent)

      expect(onModelChange).not.toHaveBeenCalled()
    })
  })
})
