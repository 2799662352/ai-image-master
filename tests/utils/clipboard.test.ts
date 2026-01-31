// tests/utils/clipboard.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { 
  ClipboardManager, 
  createClipboardManager,
  copyToClipboard,
  pasteFromClipboard
} from '../../src/renderer/src/utils/clipboard'

describe('ClipboardManager', () => {
  let clipboardManager: ClipboardManager
  let showToast: ReturnType<typeof vi.fn>

  beforeEach(() => {
    showToast = vi.fn()
    clipboardManager = createClipboardManager({ showToast })
    
    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue('test text'),
        read: vi.fn().mockResolvedValue([])
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('copyText', () => {
    it('should copy text to clipboard', async () => {
      const result = await clipboardManager.copyText('Hello World')
      
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Hello World')
      expect(result).toBe(true)
      expect(showToast).toHaveBeenCalledWith('已复制到剪贴板', 'success')
    })

    it('should return false when copy fails', async () => {
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Copy failed'))
      
      const result = await clipboardManager.copyText('Hello World')
      
      expect(result).toBe(false)
      expect(showToast).toHaveBeenCalledWith('复制失败，请手动复制', 'error')
    })
  })

  describe('readText', () => {
    it('should read text from clipboard', async () => {
      const result = await clipboardManager.readText()
      
      expect(navigator.clipboard.readText).toHaveBeenCalled()
      expect(result).toBe('test text')
    })

    it('should return null when read fails', async () => {
      vi.spyOn(navigator.clipboard, 'readText').mockRejectedValue(new Error('Read failed'))
      
      const result = await clipboardManager.readText()
      
      expect(result).toBeNull()
    })
  })

  describe('handlePasteEvent', () => {
    it('should extract text from paste event', () => {
      const mockDataTransfer = {
        getData: vi.fn().mockReturnValue('pasted text'),
        items: []
      } as unknown as DataTransfer
      
      const event = {
        clipboardData: mockDataTransfer
      } as ClipboardEvent
      
      const result = clipboardManager.handlePasteEvent(event)
      
      expect(result.success).toBe(true)
      expect(result.type).toBe('text')
      expect(result.text).toBe('pasted text')
    })

    it('should extract images from paste event', () => {
      const mockFile = new File([''], 'image.png', { type: 'image/png' })
      const mockItem = {
        type: 'image/png',
        getAsFile: () => mockFile
      }
      
      const mockDataTransfer = {
        getData: vi.fn().mockReturnValue(''),
        items: [mockItem]
      } as unknown as DataTransfer
      
      const onPasteImage = vi.fn()
      const manager = createClipboardManager({ onPasteImage })
      
      const event = {
        clipboardData: mockDataTransfer
      } as ClipboardEvent
      
      const result = manager.handlePasteEvent(event)
      
      expect(result.success).toBe(true)
      expect(result.type).toBe('image')
      expect(result.images).toHaveLength(1)
      expect(onPasteImage).toHaveBeenCalledWith([mockFile])
    })

    it('should return none when no clipboard data', () => {
      const event = {
        clipboardData: null
      } as ClipboardEvent
      
      const result = clipboardManager.handlePasteEvent(event)
      
      expect(result.success).toBe(false)
      expect(result.type).toBe('none')
      expect(result.error).toBe('无剪贴板数据')
    })

    it('should return none when clipboard is empty', () => {
      const mockDataTransfer = {
        getData: vi.fn().mockReturnValue(''),
        items: []
      } as unknown as DataTransfer
      
      const event = {
        clipboardData: mockDataTransfer
      } as ClipboardEvent
      
      const result = clipboardManager.handlePasteEvent(event)
      
      expect(result.success).toBe(false)
      expect(result.type).toBe('none')
    })
  })

  describe('extractImagesFromClipboard', () => {
    it('should extract image files from DataTransfer', () => {
      const mockFile = new File([''], 'image.png', { type: 'image/png' })
      const mockDataTransfer = {
        items: [
          { type: 'image/png', getAsFile: () => mockFile },
          { type: 'text/plain', getAsFile: () => null }
        ]
      } as unknown as DataTransfer
      
      const images = clipboardManager.extractImagesFromClipboard(mockDataTransfer)
      
      expect(images).toHaveLength(1)
      expect(images[0]).toBe(mockFile)
    })
  })

  describe('hasClipboardImage', () => {
    it('should return true when clipboard has image', async () => {
      vi.spyOn(navigator.clipboard, 'read').mockResolvedValue([
        { types: ['image/png'], getType: vi.fn() } as any
      ])
      
      const result = await clipboardManager.hasClipboardImage()
      expect(result).toBe(true)
    })

    it('should return false when clipboard has no image', async () => {
      vi.spyOn(navigator.clipboard, 'read').mockResolvedValue([
        { types: ['text/plain'], getType: vi.fn() } as any
      ])
      
      const result = await clipboardManager.hasClipboardImage()
      expect(result).toBe(false)
    })

    it('should return false when read fails', async () => {
      vi.spyOn(navigator.clipboard, 'read').mockRejectedValue(new Error('Permission denied'))
      
      const result = await clipboardManager.hasClipboardImage()
      expect(result).toBe(false)
    })
  })

  describe('readImage', () => {
    it('should read image blob from clipboard', async () => {
      const mockBlob = new Blob([''], { type: 'image/png' })
      vi.spyOn(navigator.clipboard, 'read').mockResolvedValue([
        { 
          types: ['image/png'], 
          getType: vi.fn().mockResolvedValue(mockBlob) 
        } as any
      ])
      
      const result = await clipboardManager.readImage()
      expect(result).toBe(mockBlob)
    })

    it('should return null when no image in clipboard', async () => {
      vi.spyOn(navigator.clipboard, 'read').mockResolvedValue([
        { types: ['text/plain'], getType: vi.fn() } as any
      ])
      
      const result = await clipboardManager.readImage()
      expect(result).toBeNull()
    })
  })

  describe('isInUploadContext', () => {
    it('should return true when upload element is focused', () => {
      const uploadElement = document.createElement('div')
      uploadElement.id = 'referenceImageArea'
      document.body.appendChild(uploadElement)
      
      // Simulate focus
      Object.defineProperty(document, 'activeElement', {
        value: uploadElement,
        writable: true
      })
      
      const result = clipboardManager.isInUploadContext(['referenceImageArea'], 0)
      expect(result).toBe(true)
      
      document.body.removeChild(uploadElement)
    })

    it('should return true when recently interacted', () => {
      const recentTime = Date.now() - 1000 // 1 second ago
      const result = clipboardManager.isInUploadContext([], recentTime, 5000)
      expect(result).toBe(true)
    })

    it('should return false when no upload context', () => {
      const oldTime = Date.now() - 10000 // 10 seconds ago
      const result = clipboardManager.isInUploadContext([], oldTime, 5000)
      expect(result).toBe(false)
    })
  })

  describe('helper functions', () => {
    describe('copyToClipboard', () => {
      it('should copy text using singleton', async () => {
        const result = await copyToClipboard('test')
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('test')
        expect(result).toBe(true)
      })
    })

    describe('pasteFromClipboard', () => {
      it('should read text using singleton', async () => {
        const result = await pasteFromClipboard()
        expect(navigator.clipboard.readText).toHaveBeenCalled()
        expect(result).toBe('test text')
      })
    })
  })
})
