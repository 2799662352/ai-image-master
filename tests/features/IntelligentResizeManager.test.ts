// tests/features/IntelligentResizeManager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  IntelligentResizeManager,
  createIntelligentResizeManager,
  getIntelligentResizeManager
} from '../../src/renderer/src/features/intelligent-resize/IntelligentResizeManager'

// Mock window.aiImageAPI
const mockApiImageAPI = {
  calculateGeminiOutputSize: vi.fn((width: number, height: number) => {
    const maxSize = 1024
    const ratio = width / height
    if (ratio > 1) {
      return { width: maxSize, height: Math.round(maxSize / ratio) }
    } else {
      return { width: Math.round(maxSize * ratio), height: maxSize }
    }
  })
}

describe('IntelligentResizeManager', () => {
  let manager: IntelligentResizeManager

  beforeEach(() => {
    // Setup DOM
    document.body.innerHTML = `
      <div id="ratioContainer">
        <div class="ratio-buttons-container">
          <button class="ratio-btn" data-ratio="1:1">1:1</button>
          <button class="ratio-btn" data-ratio="16:9">16:9</button>
        </div>
      </div>
      <select id="batchRatio">
        <option value="1:1">1:1</option>
        <option value="16:9">16:9</option>
      </select>
    `

    // Setup global mocks
    ;(window as any).aiImageAPI = mockApiImageAPI
    ;(window as any).generatePage = {
      referenceImages: []
    }

    vi.clearAllMocks()

    manager = createIntelligentResizeManager({
      removeDisabledIndicator: vi.fn()
    })
  })

  afterEach(() => {
    manager.destroy()
    document.body.innerHTML = ''
    delete (window as any).aiImageAPI
    delete (window as any).generatePage
  })

  describe('formatRatio', () => {
    it('should format 1:1 ratio', () => {
      expect(manager.formatRatio(1)).toBe('(约1:1)')
    })

    it('should format 2:3 ratio', () => {
      expect(manager.formatRatio(2 / 3)).toBe('(约2:3)')
    })

    it('should format 3:2 ratio', () => {
      expect(manager.formatRatio(3 / 2)).toBe('(约3:2)')
    })

    it('should format wide ratio', () => {
      expect(manager.formatRatio(2)).toBe('(约2.0:1)')
    })

    it('should format tall ratio', () => {
      expect(manager.formatRatio(0.5)).toBe('(约1:2.0)')
    })
  })

  describe('setupIntelligentResizeMode', () => {
    it('should reset ratio button styles', () => {
      const btn = document.querySelector('.ratio-btn') as HTMLElement
      btn.style.opacity = '0.5'
      btn.style.pointerEvents = 'none'

      manager.setupIntelligentResizeMode()

      expect(btn.style.opacity).toBe('1')
      expect(btn.style.pointerEvents).toBe('auto')
    })
  })

  describe('updateIntelligentResizeUI', () => {
    it('should show upload prompt when no reference images', () => {
      manager.updateIntelligentResizeUI()

      const hint = document.querySelector('.intelligent-resize-hint')
      expect(hint).not.toBeNull()
      expect(hint?.innerHTML).toContain('请上传参考图片')
    })

    it('should show loading state when reference images exist', () => {
      ;(window as any).generatePage.referenceImages = [
        { fileName: 'test.jpg', width: 1920, height: 1080 }
      ]

      manager.updateIntelligentResizeUI()

      const hint = document.querySelector('.intelligent-resize-hint')
      expect(hint).not.toBeNull()
    })
  })

  describe('showReferenceImageSizeHint', () => {
    it('should display size information when image has dimensions', () => {
      ;(window as any).generatePage.referenceImages = [
        { fileName: 'test.jpg', width: 1920, height: 1080 }
      ]

      const hintElement = document.createElement('div')

      manager.showReferenceImageSizeHint(hintElement)

      expect(hintElement.innerHTML).toContain('1920')
      expect(hintElement.innerHTML).toContain('1080')
      expect(hintElement.innerHTML).toContain('预计输出')
    })

    it('should show loading state when image has no dimensions', () => {
      ;(window as any).generatePage.referenceImages = [
        { fileName: 'test.jpg' }
      ]

      const hintElement = document.createElement('div')

      manager.showReferenceImageSizeHint(hintElement)

      expect(hintElement.innerHTML).toContain('正在分析')
    })

    it('should return early when no reference images', () => {
      ;(window as any).generatePage.referenceImages = []

      const hintElement = document.createElement('div')
      hintElement.innerHTML = 'original'

      manager.showReferenceImageSizeHint(hintElement)

      expect(hintElement.innerHTML).toBe('original')
    })
  })

  describe('setupBatchIntelligentResizeMode', () => {
    it('should configure batch ratio select for intelligent mode', () => {
      manager.setPages({
        batch: { batchReferenceImages: [] }
      })

      manager.setupBatchIntelligentResizeMode()

      const select = document.getElementById('batchRatio') as HTMLSelectElement
      expect(select.classList.contains('intelligent-batch-display')).toBe(true)
      expect(select.style.pointerEvents).toBe('none')
    })

    it('should show size info when batch reference images exist', () => {
      manager.setPages({
        batch: {
          batchReferenceImages: [
            { fileName: 'batch.jpg', width: 800, height: 600 }
          ]
        }
      })

      manager.setupBatchIntelligentResizeMode()

      const description = document.querySelector('.batch-intelligent-description')
      expect(description).not.toBeNull()
      expect(description?.innerHTML).toContain('800')
    })
  })

  describe('showBatchReferenceImageSizeHint', () => {
    it('should display batch image size information', () => {
      const hintElement = document.createElement('div')
      const batchImages = [{ fileName: 'batch.jpg', width: 1600, height: 900 }]

      manager.showBatchReferenceImageSizeHint(hintElement, batchImages)

      expect(hintElement.innerHTML).toContain('1600')
      expect(hintElement.innerHTML).toContain('900')
    })

    it('should handle empty batch images', () => {
      const hintElement = document.createElement('div')
      hintElement.innerHTML = 'original'

      manager.showBatchReferenceImageSizeHint(hintElement, [])

      expect(hintElement.innerHTML).toBe('original')
    })
  })

  describe('setPages', () => {
    it('should set page references', () => {
      const pages = {
        generate: { referenceImages: [] },
        batch: { batchReferenceImages: [] }
      }

      manager.setPages(pages)

      // Verify by calling methods that use pages
      manager.updateIntelligentResizeUI()
      // Should not throw
    })
  })

  describe('destroy', () => {
    it('should remove intelligent resize hints', () => {
      document.body.innerHTML += '<div class="intelligent-resize-hint"></div>'
      document.body.innerHTML += '<div class="batch-intelligent-description"></div>'

      manager.destroy()

      expect(document.querySelector('.intelligent-resize-hint')).toBeNull()
      expect(document.querySelector('.batch-intelligent-description')).toBeNull()
    })
  })

  describe('getIntelligentResizeManager singleton', () => {
    it('should return the same instance', () => {
      const manager1 = getIntelligentResizeManager()
      const manager2 = getIntelligentResizeManager()

      expect(manager1).toBe(manager2)
    })
  })
})
