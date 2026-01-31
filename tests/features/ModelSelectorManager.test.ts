// tests/features/ModelSelectorManager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ModelSelectorManager,
  createModelSelectorManager,
  getModelSelectorManager
} from '../../src/renderer/src/features/model-selector/ModelSelectorManager'

// Mock Choices.js
class MockChoices {
  element: HTMLElement
  static instances: MockChoices[] = []

  constructor(element: HTMLElement, _options: any) {
    this.element = element
    MockChoices.instances.push(this)
  }

  setChoiceByValue = vi.fn()
  destroy = vi.fn()

  static clearInstances() {
    MockChoices.instances = []
  }
}

// Mock window.aiImageAPI
const mockApiImageAPI = {
  getAllModels: vi.fn(() => ({
    'model-1': { name: 'Model 1', displayName: 'Test Model 1' },
    'model-2': { name: 'Model 2', displayName: 'Test Model 2', time: '30s', isNew: true }
  })),
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

describe('ModelSelectorManager', () => {
  let manager: ModelSelectorManager

  beforeEach(() => {
    // Setup DOM
    document.body.innerHTML = `
      <select id="modelSelector"></select>
      <select id="modelSelectorMobile"></select>
      <div id="ratioButtons"></div>
      <div id="resolutionContainer" class="hidden">
        <div id="resolutionButtons"></div>
      </div>
      <select id="batchRatio"></select>
      <label id="batchCountLabel"></label>
    `

    // Setup global mocks
    ;(window as any).Choices = MockChoices
    ;(window as any).aiImageAPI = mockApiImageAPI
    ;(window as any).i18n = {
      translations: { 'zh-CN': { aspectRatios: {}, resolutions: {} } },
      currentLang: 'zh-CN'
    }

    MockChoices.clearInstances()
    vi.clearAllMocks()

    manager = createModelSelectorManager({
      showToast: vi.fn()
    })
  })

  afterEach(() => {
    manager.destroy()
    document.body.innerHTML = ''
    delete (window as any).Choices
    delete (window as any).aiImageAPI
    delete (window as any).i18n
  })

  describe('init', () => {
    it('should initialize with Choices.js when available', () => {
      manager.init()

      expect(MockChoices.instances).toHaveLength(2)
      expect(manager.isInitialized()).toBe(true)
    })

    it('should retry if Choices.js is not available', () => {
      vi.useFakeTimers()
      delete (window as any).Choices

      manager.init(0)

      // First retry
      ;(window as any).Choices = MockChoices
      vi.advanceTimersByTime(100)

      expect(MockChoices.instances.length).toBeGreaterThan(0)

      vi.useRealTimers()
    })

    it('should populate options correctly', () => {
      manager.init()

      const desktopSelect = document.getElementById('modelSelector') as HTMLSelectElement
      expect(desktopSelect.options.length).toBe(2)
      expect(desktopSelect.options[0].value).toBe('model-1')
      expect(desktopSelect.options[1].value).toBe('model-2')
    })
  })

  describe('setCurrentModel', () => {
    it('should update both selectors', () => {
      manager.init()

      manager.setCurrentModel('model-2')

      expect(manager.getCurrentModelKey()).toBe('model-2')
    })
  })

  describe('renderRatioOptions', () => {
    it('should render ratio buttons', () => {
      const modelConfig = {
        name: 'Test',
        displayName: 'Test Model',
        ratios: [
          { key: '1:1', label: '正方形' },
          { key: '16:9', label: '横版' }
        ]
      }

      manager.renderRatioOptions(modelConfig)

      const container = document.getElementById('ratioButtons')
      expect(container?.children.length).toBe(2)
    })

    it('should use default ratios when none provided', () => {
      const modelConfig = {
        name: 'Test',
        displayName: 'Test Model'
      }

      manager.renderRatioOptions(modelConfig)

      const container = document.getElementById('ratioButtons')
      expect(container?.children.length).toBeGreaterThan(0)
    })
  })

  describe('renderResolutionOptions', () => {
    it('should hide container when model does not support resolution control', () => {
      const modelConfig = {
        name: 'Test',
        displayName: 'Test Model',
        capabilities: {}
      }

      manager.renderResolutionOptions(modelConfig)

      const container = document.getElementById('resolutionContainer')
      expect(container?.classList.contains('hidden')).toBe(true)
    })

    it('should show and populate when model supports resolution control', () => {
      const modelConfig = {
        name: 'Test',
        displayName: 'Test Model',
        capabilities: { resolutionControl: true },
        resolutions: [
          { key: '1K', label: '1K' },
          { key: '2K', label: '2K' }
        ]
      }

      manager.renderResolutionOptions(modelConfig)

      const container = document.getElementById('resolutionContainer')
      expect(container?.classList.contains('hidden')).toBe(false)

      const buttons = document.getElementById('resolutionButtons')
      expect(buttons?.children.length).toBe(2)
    })
  })

  describe('renderBatchRatioOptions', () => {
    it('should populate batch ratio select', () => {
      const modelConfig = {
        name: 'Test',
        displayName: 'Test Model',
        ratios: [
          { key: '1:1', label: '1:1' },
          { key: '4:3', label: '4:3' }
        ]
      }

      manager.renderBatchRatioOptions(modelConfig)

      const select = document.getElementById('batchRatio') as HTMLSelectElement
      expect(select.options.length).toBe(2)
    })
  })

  describe('setupSeedreamCountHint', () => {
    it('should add hint for Seedream model', () => {
      const modelConfig = {
        name: 'Seedream Test',
        displayName: 'Seedream'
      }

      manager.setupSeedreamCountHint(modelConfig)

      const hint = document.getElementById('batchCountHint')
      expect(hint).not.toBeNull()
    })

    it('should not add hint for non-Seedream model', () => {
      const modelConfig = {
        name: 'Regular Model',
        displayName: 'Regular'
      }

      manager.setupSeedreamCountHint(modelConfig)

      const hint = document.getElementById('batchCountHint')
      expect(hint).toBeNull()
    })
  })

  describe('refresh', () => {
    it('should reinitialize selectors', () => {
      manager.init()
      const initialCount = MockChoices.instances.length

      manager.refresh()

      expect(MockChoices.instances.length).toBeGreaterThan(initialCount)
    })
  })

  describe('destroy', () => {
    it('should clean up Choices instances', () => {
      manager.init()

      manager.destroy()

      expect(manager.isInitialized()).toBe(false)
    })
  })

  describe('getModelSelectorManager singleton', () => {
    it('should return the same instance', () => {
      const manager1 = getModelSelectorManager()
      const manager2 = getModelSelectorManager()

      expect(manager1).toBe(manager2)
    })
  })
})
