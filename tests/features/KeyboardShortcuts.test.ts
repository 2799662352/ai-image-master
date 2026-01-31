// tests/features/KeyboardShortcuts.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { KeyboardShortcuts, createKeyboardShortcuts } from '../../src/renderer/src/features/keyboard'

// Create a mock ClipboardEvent for JSDOM environments
const createMockClipboardEvent = (type: string): ClipboardEvent => {
  const event = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: vi.fn().mockReturnValue(''),
      setData: vi.fn(),
      items: [],
      files: []
    },
    writable: false
  })
  return event
}

// Store original values
let originalActiveElement: PropertyDescriptor | undefined
let mockActiveElement: Element | null = null
let addEventListenerSpy: ReturnType<typeof vi.spyOn>
let removeEventListenerSpy: ReturnType<typeof vi.spyOn>
let getElementByIdSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // Setup window mock
  ;(window as any).closeCustomSiteModal = vi.fn()
  
  // Spy on document methods
  addEventListenerSpy = vi.spyOn(document, 'addEventListener')
  removeEventListenerSpy = vi.spyOn(document, 'removeEventListener')
  getElementByIdSpy = vi.spyOn(document, 'getElementById')
  
  // Mock activeElement using Object.defineProperty
  mockActiveElement = null
  originalActiveElement = Object.getOwnPropertyDescriptor(document, 'activeElement')
  Object.defineProperty(document, 'activeElement', {
    get: () => mockActiveElement,
    configurable: true
  })
})

afterEach(() => {
  // Restore activeElement
  if (originalActiveElement) {
    Object.defineProperty(document, 'activeElement', originalActiveElement)
  }
  
  // Restore spies
  addEventListenerSpy.mockRestore()
  removeEventListenerSpy.mockRestore()
  getElementByIdSpy.mockRestore()
  
  // Clean up window
  delete (window as any).closeCustomSiteModal
  
  vi.clearAllMocks()
})

describe('KeyboardShortcuts', () => {
  const createDefaultConfig = () => ({
    getCurrentTab: vi.fn().mockReturnValue('generate'),
    getPages: vi.fn().mockReturnValue({
      generate: { generateImage: vi.fn() },
      batch: { batchGenerate: vi.fn() },
      edit: { editImage: vi.fn() }
    }),
    closeSettings: vi.fn(),
    closeAbout: vi.fn(),
    closeActivity: vi.fn()
  })

  describe('constructor', () => {
    it('should create instance with config', () => {
      const config = createDefaultConfig()
      const shortcuts = createKeyboardShortcuts(config)
      expect(shortcuts).toBeInstanceOf(KeyboardShortcuts)
    })
  })

  describe('init', () => {
    it('should add keydown event listener', () => {
      const shortcuts = createKeyboardShortcuts(createDefaultConfig())
      shortcuts.init()
      
      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'keydown',
        expect.any(Function)
      )
    })

    it('should add paste event listener', () => {
      const shortcuts = createKeyboardShortcuts(createDefaultConfig())
      shortcuts.init()
      
      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'paste',
        expect.any(Function)
      )
    })
  })

  describe('handleKeyboard', () => {
    describe('Ctrl+Enter shortcut', () => {
      it('should call generateImage on generate tab', () => {
        const config = createDefaultConfig()
        config.getCurrentTab.mockReturnValue('generate')
        
        const generateImage = vi.fn()
        config.getPages.mockReturnValue({
          generate: { generateImage }
        })
        
        const shortcuts = createKeyboardShortcuts(config)
        
        const event = new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true
        })
        
        shortcuts.handleKeyboard(event)
        
        expect(generateImage).toHaveBeenCalled()
      })

      it('should call batchGenerate on batch tab', () => {
        const config = createDefaultConfig()
        config.getCurrentTab.mockReturnValue('batch')
        
        const batchGenerate = vi.fn()
        config.getPages.mockReturnValue({
          batch: { batchGenerate }
        })
        
        const shortcuts = createKeyboardShortcuts(config)
        
        const event = new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true
        })
        
        shortcuts.handleKeyboard(event)
        
        expect(batchGenerate).toHaveBeenCalled()
      })

      it('should call editImage on edit tab', () => {
        const config = createDefaultConfig()
        config.getCurrentTab.mockReturnValue('edit')
        
        const editImage = vi.fn()
        config.getPages.mockReturnValue({
          edit: { editImage }
        })
        
        const shortcuts = createKeyboardShortcuts(config)
        
        const event = new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true
        })
        
        shortcuts.handleKeyboard(event)
        
        expect(editImage).toHaveBeenCalled()
      })

      it('should work with Meta key (macOS)', () => {
        const config = createDefaultConfig()
        const generateImage = vi.fn()
        config.getPages.mockReturnValue({
          generate: { generateImage }
        })
        
        const shortcuts = createKeyboardShortcuts(config)
        
        const event = new KeyboardEvent('keydown', {
          key: 'Enter',
          metaKey: true
        })
        
        shortcuts.handleKeyboard(event)
        
        expect(generateImage).toHaveBeenCalled()
      })
    })

    describe('Escape shortcut', () => {
      it('should close custom site modal if visible', () => {
        const modal = {
          classList: {
            contains: vi.fn().mockReturnValue(false) // not hidden = visible
          }
        }
        getElementByIdSpy.mockReturnValue(modal as unknown as HTMLElement)
        
        const config = createDefaultConfig()
        const shortcuts = createKeyboardShortcuts(config)
        
        const event = new KeyboardEvent('keydown', { key: 'Escape' })
        shortcuts.handleKeyboard(event)
        
        expect((window as any).closeCustomSiteModal).toHaveBeenCalled()
      })

      it('should close settings if no custom site modal', () => {
        // First call for customSiteModal returns null
        getElementByIdSpy.mockImplementation((id: string) => {
          if (id === 'customSiteModal') return null
          if (id === 'settingsModal') {
            return {
              classList: { contains: vi.fn().mockReturnValue(false) }
            } as unknown as HTMLElement
          }
          return null
        })
        
        const config = createDefaultConfig()
        const shortcuts = createKeyboardShortcuts(config)
        
        const event = new KeyboardEvent('keydown', { key: 'Escape' })
        shortcuts.handleKeyboard(event)
        
        expect(config.closeSettings).toHaveBeenCalled()
      })

      it('should always try to close about and activity', () => {
        getElementByIdSpy.mockReturnValue(null)
        
        const config = createDefaultConfig()
        const shortcuts = createKeyboardShortcuts(config)
        
        const event = new KeyboardEvent('keydown', { key: 'Escape' })
        shortcuts.handleKeyboard(event)
        
        expect(config.closeAbout).toHaveBeenCalled()
        expect(config.closeActivity).toHaveBeenCalled()
      })
    })
  })

  describe('handlePaste', () => {
    it('should not process paste in textarea', () => {
      const textarea = document.createElement('textarea')
      mockActiveElement = textarea
      
      const config = createDefaultConfig()
      const handlePasteEvent = vi.fn()
      config.getPages.mockReturnValue({
        generate: { handlePasteEvent }
      })
      
      const shortcuts = createKeyboardShortcuts(config)
      
      const event = createMockClipboardEvent('paste')
      shortcuts.handlePaste(event)
      
      expect(handlePasteEvent).not.toHaveBeenCalled()
    })

    it('should not process paste in input', () => {
      const input = document.createElement('input')
      mockActiveElement = input
      
      const config = createDefaultConfig()
      const handlePasteEvent = vi.fn()
      config.getPages.mockReturnValue({
        generate: { handlePasteEvent }
      })
      
      const shortcuts = createKeyboardShortcuts(config)
      
      const event = createMockClipboardEvent('paste')
      shortcuts.handlePaste(event)
      
      expect(handlePasteEvent).not.toHaveBeenCalled()
    })
  })

  describe('isInImageUploadContext', () => {
    it('should return false when not in upload context', () => {
      mockActiveElement = null
      getElementByIdSpy.mockReturnValue(null)
      
      const shortcuts = createKeyboardShortcuts(createDefaultConfig())
      
      expect(shortcuts.isInImageUploadContext()).toBe(false)
    })

    it('should return true when activeElement is in upload area', () => {
      const uploadArea = document.createElement('div')
      const childElement = document.createElement('button')
      uploadArea.appendChild(childElement)
      
      mockActiveElement = childElement
      getElementByIdSpy.mockImplementation((id: string) => {
        if (id === 'referenceImageArea') return uploadArea
        return null
      })
      
      const shortcuts = createKeyboardShortcuts(createDefaultConfig())
      
      expect(shortcuts.isInImageUploadContext()).toBe(true)
    })
  })

  describe('registerShortcut', () => {
    it('should register custom shortcut', () => {
      const config = createDefaultConfig()
      const shortcuts = createKeyboardShortcuts(config)
      
      const handler = vi.fn()
      const unregister = shortcuts.registerShortcut('ctrl+s', handler)
      
      expect(typeof unregister).toBe('function')
    })

    it('should call custom handler when shortcut triggered', () => {
      const config = createDefaultConfig()
      const shortcuts = createKeyboardShortcuts(config)
      
      const handler = vi.fn()
      shortcuts.registerShortcut('ctrl+s', handler)
      
      const event = new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true
      })
      
      shortcuts.handleKeyboard(event)
      
      expect(handler).toHaveBeenCalledWith(event)
    })

    it('should return unregister function', () => {
      const config = createDefaultConfig()
      const shortcuts = createKeyboardShortcuts(config)
      
      const handler = vi.fn()
      const unregister = shortcuts.registerShortcut('ctrl+s', handler)
      
      unregister()
      
      const event = new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true
      })
      
      shortcuts.handleKeyboard(event)
      
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('unregisterShortcut', () => {
    it('should unregister shortcut', () => {
      const config = createDefaultConfig()
      const shortcuts = createKeyboardShortcuts(config)
      
      const handler = vi.fn()
      shortcuts.registerShortcut('ctrl+s', handler)
      shortcuts.unregisterShortcut('ctrl+s')
      
      const event = new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true
      })
      
      shortcuts.handleKeyboard(event)
      
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('recordUploadInteraction', () => {
    it('should record interaction time', () => {
      const shortcuts = createKeyboardShortcuts(createDefaultConfig())
      
      shortcuts.recordUploadInteraction()
      
      // After recording, should be in upload context temporarily
      expect(shortcuts.isInImageUploadContext()).toBe(true)
    })
  })

  describe('destroy', () => {
    it('should remove event listeners', () => {
      const shortcuts = createKeyboardShortcuts(createDefaultConfig())
      shortcuts.init()
      
      shortcuts.destroy()
      
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'keydown',
        expect.any(Function)
      )
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'paste',
        expect.any(Function)
      )
    })

    it('should clear custom shortcuts', () => {
      const shortcuts = createKeyboardShortcuts(createDefaultConfig())
      
      const handler = vi.fn()
      shortcuts.registerShortcut('ctrl+s', handler)
      
      shortcuts.destroy()
      
      const event = new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true
      })
      
      shortcuts.handleKeyboard(event)
      
      expect(handler).not.toHaveBeenCalled()
    })
  })
})
