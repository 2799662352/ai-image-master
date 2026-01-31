// tests/features/UIStateManager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  UIStateManager,
  createUIStateManager,
  getUIStateManager
} from '../../src/renderer/src/features/ui-state/UIStateManager'

// Mock window.aiImageAPI
const mockApiImageAPI = {
  getCurrentModel: vi.fn(() => ({
    name: 'Test Model',
    displayName: 'Test',
    capabilities: { multipleImages: true, customSize: true }
  }))
}

describe('UIStateManager', () => {
  let manager: UIStateManager

  beforeEach(() => {
    // Setup DOM
    document.body.innerHTML = `
      <select id="generateCount">
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="4">4</option>
      </select>
      <select id="editCount">
        <option value="1">1</option>
        <option value="2">2</option>
      </select>
      <select id="batchCount">
        <option value="1">1</option>
        <option value="5">5</option>
        <option value="10">10</option>
      </select>
      <div id="ratioButtonsContainer">
        <div id="ratioButtons">
          <button class="ratio-btn" data-ratio="1:1">1:1</button>
          <button class="ratio-btn" data-ratio="16:9">16:9</button>
          <button class="ratio-btn" data-ratio="9:16">9:16</button>
        </div>
      </div>
      <div id="editRatioButtons">
        <button class="edit-ratio-btn" data-ratio="1:1">1:1</button>
        <button class="edit-ratio-btn" data-ratio="4:3">4:3</button>
      </div>
      <select id="batchRatio">
        <option value="1:1">1:1</option>
        <option value="16:9">16:9</option>
      </select>
    `

    // Setup global mocks
    ;(window as any).aiImageAPI = mockApiImageAPI

    vi.clearAllMocks()

    manager = createUIStateManager({
      setupIntelligentResizeMode: vi.fn(),
      setupBatchIntelligentResizeMode: vi.fn(),
      renderBatchRatioOptions: vi.fn()
    })
  })

  afterEach(() => {
    manager.destroy()
    document.body.innerHTML = ''
    delete (window as any).aiImageAPI
  })

  describe('toggleCountSelectors', () => {
    it('should disable count selectors when disabled=true', () => {
      manager.toggleCountSelectors(true)

      const generateCount = document.getElementById('generateCount') as HTMLSelectElement
      const editCount = document.getElementById('editCount') as HTMLSelectElement

      expect(generateCount.disabled).toBe(true)
      expect(editCount.disabled).toBe(true)
      expect(generateCount.value).toBe('1')
      expect(generateCount.style.opacity).toBe('0.4')
    })

    it('should enable count selectors when disabled=false', () => {
      // First disable
      manager.toggleCountSelectors(true)

      // Then enable
      manager.toggleCountSelectors(false)

      const generateCount = document.getElementById('generateCount') as HTMLSelectElement
      expect(generateCount.disabled).toBe(false)
      expect(generateCount.style.opacity).toBe('1')
    })

    it('should add disabled indicator when disabled', () => {
      manager.toggleCountSelectors(true)

      const generateCount = document.getElementById('generateCount') as HTMLSelectElement
      expect(generateCount.querySelector('.disabled-indicator')).not.toBeNull()
    })

    it('should handle Seedream model specially', () => {
      // Use mockReturnValue (not Once) because getCurrentModel is called multiple times in the loop
      mockApiImageAPI.getCurrentModel.mockReturnValue({
        name: 'Seedream XL',
        displayName: 'Seedream',
        capabilities: { multipleImages: false }
      })

      manager.toggleCountSelectors(false) // Even with false, should still disable for Seedream

      const batchCount = document.getElementById('batchCount') as HTMLSelectElement
      expect(batchCount.disabled).toBe(true)
      expect(batchCount.title).toContain('Seedream')

      // Reset mock to default for other tests
      mockApiImageAPI.getCurrentModel.mockReturnValue({
        name: 'Test Model',
        displayName: 'Test',
        capabilities: { multipleImages: true, customSize: true }
      })
    })
  })

  describe('toggleSizeSelectors', () => {
    it('should disable ratio buttons when disabled=true', () => {
      manager.toggleSizeSelectors(true, false)

      const ratioBtn = document.querySelector('#ratioButtons .ratio-btn') as HTMLElement
      expect(ratioBtn.style.opacity).toBe('0.3')
      expect(ratioBtn.style.pointerEvents).toBe('none')
    })

    it('should enable ratio buttons when disabled=false', () => {
      // First disable
      manager.toggleSizeSelectors(true, false)

      // Then enable
      manager.toggleSizeSelectors(false, false)

      const ratioBtn = document.querySelector('#ratioButtons .ratio-btn') as HTMLElement
      expect(ratioBtn.style.opacity).toBe('1')
      expect(ratioBtn.style.pointerEvents).toBe('auto')
    })

    it('should select 1:1 ratio when disabled', () => {
      manager.toggleSizeSelectors(true, false)

      const btn1 = document.querySelector('[data-ratio="1:1"]') as HTMLElement
      const btn16_9 = document.querySelector('[data-ratio="16:9"]') as HTMLElement

      expect(btn1.classList.contains('active')).toBe(true)
      expect(btn16_9.classList.contains('active')).toBe(false)
    })

    it('should call setupIntelligentResizeMode when intelligentResize=true', () => {
      const setupFn = vi.fn()
      const testManager = createUIStateManager({
        setupIntelligentResizeMode: setupFn
      })

      testManager.toggleSizeSelectors(false, true)

      expect(setupFn).toHaveBeenCalled()

      testManager.destroy()
    })

    it('should handle batch ratio selector', () => {
      manager.toggleSizeSelectors(true, false)

      const batchRatio = document.getElementById('batchRatio') as HTMLSelectElement
      expect(batchRatio.style.opacity).toBe('0.3')
      expect(batchRatio.value).toBe('1:1')
    })

    it('should call setupBatchIntelligentResizeMode for intelligent mode', () => {
      const batchSetupFn = vi.fn()
      const testManager = createUIStateManager({
        setupBatchIntelligentResizeMode: batchSetupFn
      })

      testManager.toggleSizeSelectors(false, true)

      expect(batchSetupFn).toHaveBeenCalled()

      testManager.destroy()
    })

    it('should restore batch selector for non-intelligent mode', () => {
      const batchRatio = document.getElementById('batchRatio') as HTMLSelectElement
      batchRatio.classList.add('intelligent-batch-display')

      manager.toggleSizeSelectors(false, false)

      expect(batchRatio.classList.contains('intelligent-batch-display')).toBe(false)
    })
  })

  describe('addDisabledIndicator', () => {
    it('should add indicator element', () => {
      const element = document.createElement('div')

      manager.addDisabledIndicator(element, 'ban')

      expect(element.querySelector('.disabled-indicator')).not.toBeNull()
      expect(element.innerHTML).toContain('fa-ban')
    })

    it('should not add duplicate indicators', () => {
      const element = document.createElement('div')

      manager.addDisabledIndicator(element, 'ban')
      manager.addDisabledIndicator(element, 'ban')

      expect(element.querySelectorAll('.disabled-indicator').length).toBe(1)
    })

    it('should support different icon types', () => {
      const element = document.createElement('div')

      manager.addDisabledIndicator(element, 'lock')

      expect(element.innerHTML).toContain('fa-lock')
    })

    it('should set relative position on parent', () => {
      const element = document.createElement('div')

      manager.addDisabledIndicator(element, 'ban')

      expect(element.style.position).toBe('relative')
    })
  })

  describe('removeDisabledIndicator', () => {
    it('should remove indicator element', () => {
      const element = document.createElement('div')
      manager.addDisabledIndicator(element, 'ban')

      manager.removeDisabledIndicator(element)

      expect(element.querySelector('.disabled-indicator')).toBeNull()
    })

    it('should handle element without indicator', () => {
      const element = document.createElement('div')

      // Should not throw
      manager.removeDisabledIndicator(element)
    })
  })

  describe('createEnhancedTooltip', () => {
    it('should create tooltip element with message', () => {
      const element = document.createElement('div')
      const tooltip = manager.createEnhancedTooltip(element, 'Test message')

      expect(tooltip.textContent).toContain('Test message')
      expect(tooltip.classList.contains('enhanced-tooltip')).toBe(true)
    })

    it('should include arrow element', () => {
      const element = document.createElement('div')
      const tooltip = manager.createEnhancedTooltip(element, 'Test')

      expect(tooltip.children.length).toBeGreaterThan(0)
    })

    it('should start hidden', () => {
      const element = document.createElement('div')
      const tooltip = manager.createEnhancedTooltip(element, 'Test')

      expect(tooltip.style.opacity).toBe('0')
    })
  })

  describe('showEnhancedTooltip', () => {
    it('should set opacity to 1', () => {
      const element = document.createElement('div')
      const tooltip = manager.createEnhancedTooltip(element, 'Test')

      manager.showEnhancedTooltip(tooltip)

      expect(tooltip.style.opacity).toBe('1')
    })
  })

  describe('hideEnhancedTooltip', () => {
    it('should set opacity to 0', () => {
      const element = document.createElement('div')
      const tooltip = manager.createEnhancedTooltip(element, 'Test')
      tooltip.style.opacity = '1'

      manager.hideEnhancedTooltip(tooltip)

      expect(tooltip.style.opacity).toBe('0')
    })
  })

  describe('destroy', () => {
    it('should remove all disabled indicators', () => {
      const element = document.createElement('div')
      manager.addDisabledIndicator(element, 'ban')
      document.body.appendChild(element)

      manager.destroy()

      expect(document.querySelector('.disabled-indicator')).toBeNull()
    })

    it('should remove all enhanced tooltips', () => {
      const tooltip = document.createElement('div')
      tooltip.className = 'enhanced-tooltip'
      document.body.appendChild(tooltip)

      manager.destroy()

      expect(document.querySelector('.enhanced-tooltip')).toBeNull()
    })
  })

  describe('getUIStateManager singleton', () => {
    it('should return the same instance', () => {
      const manager1 = getUIStateManager()
      const manager2 = getUIStateManager()

      expect(manager1).toBe(manager2)
    })
  })
})
