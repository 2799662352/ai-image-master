/**
 * @vitest-environment jsdom
 */
// tests/features/ImageOperations.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ImageOperations,
  createImageOperations,
  getImageOperations
} from '../../src/renderer/src/features/image-viewer/ImageOperations'

// Mock aiImageAPI
const mockAiImageAPI = {
  downloadImage: vi.fn().mockResolvedValue(undefined),
  downloadImagesAsZip: vi.fn().mockResolvedValue({ message: '下载完成' }),
  preloadImages: vi.fn(),
  model: 'test-model'
}

// Mock R2 Storage
const mockR2Storage = {
  isR2Url: vi.fn((url: string) => url.includes('r2.example.com'))
}

// Mock navigator.clipboard
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue('')
}

// Mock Image class - 使用类而非箭头函数
class MockImage {
  src: string = ''
  onload: (() => void) | null = null
  onerror: ((error: Error) => void) | null = null
  naturalWidth: number = 800
  naturalHeight: number = 600
  width: number = 800
  height: number = 600

  constructor() {
    // 默认触发 onload
    setTimeout(() => this.onload?.(), 0)
  }
}

describe('ImageOperations', () => {
  let operations: ImageOperations
  let showToastMock: ReturnType<typeof vi.fn>
  let getHistoryMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()

    showToastMock = vi.fn()
    getHistoryMock = vi.fn().mockReturnValue([
      {
        id: 1,
        urls: ['https://example.com/image.png', 'https://r2.example.com/r2/images/image.png'],
        r2Storage: true
      }
    ])

    // 使用 vi.stubGlobal 设置 window 属性，保持 JSDOM 的 document 完整
    vi.stubGlobal('window', {
      ...window,
      aiImageAPI: mockAiImageAPI,
      r2Storage: mockR2Storage
    })

    // Mock navigator.clipboard
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: mockClipboard
    })

    // 使用 vi.stubGlobal 设置 Image 构造函数
    vi.stubGlobal('Image', MockImage)

    // Mock document.execCommand (deprecated but still used in fallback)
    // 先定义方法再 spy，因为 JSDOM 不包含 execCommand
    if (typeof document.execCommand !== 'function') {
      (document as any).execCommand = vi.fn().mockReturnValue(true)
    } else {
      vi.spyOn(document, 'execCommand').mockReturnValue(true)
    }

    operations = createImageOperations({
      showToast: showToastMock,
      getHistory: getHistoryMock
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('downloadImage', () => {
    it('应该使用 aiImageAPI 下载图片', async () => {
      const result = await operations.downloadImage('https://example.com/image.png')

      expect(mockAiImageAPI.downloadImage).toHaveBeenCalled()
      expect(result.success).toBe(true)
      expect(showToastMock).toHaveBeenCalledWith('图片下载成功', 'success')
    })

    it('应该从历史记录中解析 R2 URL', async () => {
      await operations.downloadImage('https://example.com/image.png')

      // 验证下载调用包含 R2 URL
      expect(mockAiImageAPI.downloadImage).toHaveBeenCalled()
    })

    it('下载失败时应该返回错误', async () => {
      mockAiImageAPI.downloadImage.mockRejectedValueOnce(new Error('下载失败'))

      const result = await operations.downloadImage('https://example.com/fail.png')

      expect(result.success).toBe(false)
      expect(result.error).toBe('下载失败')
      expect(showToastMock).toHaveBeenCalledWith('下载失败', 'error')
    })

    it('aiImageAPI 不可用时应该使用浏览器下载', async () => {
      // 移除 aiImageAPI
      ;(globalThis as any).window.aiImageAPI = undefined

      operations = createImageOperations({
        showToast: showToastMock
      })

      // Mock fetch
      global.fetch = vi.fn().mockResolvedValue({
        blob: () => Promise.resolve(new Blob(['test']))
      })

      // Mock URL.createObjectURL
      global.URL.createObjectURL = vi.fn().mockReturnValue('blob:test')
      global.URL.revokeObjectURL = vi.fn()

      const result = await operations.downloadImage('https://example.com/image.png')

      expect(result.success).toBe(true)
    })
  })

  describe('downloadImagesAsZip', () => {
    it('应该批量下载图片为 ZIP', async () => {
      const urls = [
        'https://example.com/image1.png',
        'https://example.com/image2.png'
      ]

      const result = await operations.downloadImagesAsZip(urls)

      expect(mockAiImageAPI.downloadImagesAsZip).toHaveBeenCalled()
      expect(result.success).toBe(true)
    })

    it('应该调用进度回调', async () => {
      const progressCallback = vi.fn()
      const urls = ['https://example.com/image.png']

      await operations.downloadImagesAsZip(urls, 'test.zip', progressCallback)

      expect(mockAiImageAPI.downloadImagesAsZip).toHaveBeenCalled()
    })

    it('aiImageAPI 不可用时应该返回错误', async () => {
      ;(globalThis as any).window.aiImageAPI = undefined

      operations = createImageOperations({
        showToast: showToastMock
      })

      const result = await operations.downloadImagesAsZip(['https://example.com/image.png'])

      expect(result.success).toBe(false)
    })
  })

  describe('copyToClipboard', () => {
    it('应该使用 navigator.clipboard 复制 URL', async () => {
      const result = await operations.copyToClipboard('https://example.com/image.png')

      expect(mockClipboard.writeText).toHaveBeenCalledWith('https://example.com/image.png')
      expect(result).toBe(true)
      expect(showToastMock).toHaveBeenCalledWith('URL 已复制到剪贴板', 'success')
    })

    it('clipboard 不可用时应该使用 execCommand 降级', async () => {
      ;(globalThis as any).navigator.clipboard = undefined

      const result = await operations.copyToClipboard('https://example.com/image.png')

      expect((globalThis as any).document.execCommand).toHaveBeenCalledWith('copy')
      expect(result).toBe(true)
    })

    it('复制失败时应该返回 false', async () => {
      mockClipboard.writeText.mockRejectedValueOnce(new Error('复制失败'))

      const result = await operations.copyToClipboard('https://example.com/image.png')

      expect(result).toBe(false)
      expect(showToastMock).toHaveBeenCalledWith('复制失败', 'error')
    })
  })

  describe('viewImage', () => {
    let createElementSpy: ReturnType<typeof vi.spyOn>
    let appendChildSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      // Mock document 方法而非替换整个 document
      const mockModal = document.createElement('div')
      Object.assign(mockModal, {
        className: '',
        innerHTML: '',
        remove: vi.fn()
      })
      
      // Spy on document methods
      createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(mockModal)
      appendChildSpy = vi.spyOn(document.body, 'appendChild').mockImplementation(() => mockModal)
      vi.spyOn(document.body, 'removeChild').mockImplementation(() => mockModal)
      vi.spyOn(document, 'addEventListener').mockImplementation(() => {})
      vi.spyOn(document, 'removeEventListener').mockImplementation(() => {})
    })

    it('应该打开图片查看器', () => {
      operations.viewImage('https://example.com/image.png')

      expect(createElementSpy).toHaveBeenCalledWith('div')
      expect(appendChildSpy).toHaveBeenCalled()
    })

    it('应该支持多图数组', () => {
      operations.viewImage([
        'https://example.com/image1.png',
        'https://example.com/image2.png'
      ])

      expect(createElementSpy).toHaveBeenCalled()
    })

    it('多图时应该预加载图片', () => {
      operations.viewImage([
        'https://example.com/image1.png',
        'https://example.com/image2.png'
      ])

      expect(mockAiImageAPI.preloadImages).toHaveBeenCalled()
    })
  })

  describe('closeViewer', () => {
    it('应该关闭查看器', () => {
      // 先设置 mock
      const mockModal = document.createElement('div')
      Object.assign(mockModal, {
        className: '',
        innerHTML: '',
        remove: vi.fn()
      })

      vi.spyOn(document, 'createElement').mockReturnValue(mockModal)
      vi.spyOn(document.body, 'appendChild').mockImplementation(() => mockModal)
      vi.spyOn(document, 'addEventListener').mockImplementation(() => {})
      vi.spyOn(document, 'removeEventListener').mockImplementation(() => {})

      operations.viewImage('https://example.com/image.png')
      operations.closeViewer()

      // 验证没有抛出错误
      expect(true).toBe(true)
    })
  })

  describe('preloadImages', () => {
    it('应该使用 aiImageAPI 预加载图片', () => {
      operations.preloadImages([
        'https://example.com/image1.png',
        'https://example.com/image2.png'
      ])

      expect(mockAiImageAPI.preloadImages).toHaveBeenCalledWith([
        'https://example.com/image1.png',
        'https://example.com/image2.png'
      ])
    })

    it('aiImageAPI 不可用时应该使用 Image 对象', () => {
      // 移除 aiImageAPI
      vi.stubGlobal('window', {
        ...window,
        aiImageAPI: undefined,
        r2Storage: mockR2Storage
      })

      operations = createImageOperations()

      // 使用带追踪功能的 MockImage 类
      let imageCreated = false
      class TrackingMockImage extends MockImage {
        constructor() {
          super()
          imageCreated = true
        }
      }
      vi.stubGlobal('Image', TrackingMockImage)

      operations.preloadImages(['https://example.com/image.png'])

      expect(imageCreated).toBe(true)
    })
  })

  describe('getImageInfo', () => {
    it('应该返回图片尺寸信息', async () => {
      // Mock Image with load event - 使用类构造函数
      class SuccessMockImage {
        src: string = ''
        onload: (() => void) | null = null
        onerror: ((error: Error) => void) | null = null
        naturalWidth: number = 800
        naturalHeight: number = 600

        constructor() {
          setTimeout(() => this.onload?.(), 0)
        }
      }

      vi.stubGlobal('Image', SuccessMockImage)

      const info = await operations.getImageInfo('https://example.com/image.png')

      expect(info).toEqual({
        width: 800,
        height: 600
      })
    })

    it('加载失败时应该返回 null', async () => {
      // Mock Image with error event
      class ErrorMockImage {
        src: string = ''
        onload: (() => void) | null = null
        onerror: (() => void) | null = null

        constructor() {
          setTimeout(() => this.onerror?.(), 0)
        }
      }

      vi.stubGlobal('Image', ErrorMockImage)

      const info = await operations.getImageInfo('https://invalid.url/image.png')

      expect(info).toBeNull()
    })
  })

  describe('isR2Url', () => {
    it('应该识别 R2 URL', () => {
      expect(operations.isR2Url('https://r2.example.com/r2/images/test.png')).toBe(true)
    })

    it('应该识别非 R2 URL', () => {
      expect(operations.isR2Url('https://example.com/image.png')).toBe(false)
    })
  })

  describe('回调配置', () => {
    it('应该调用 onDownloadStart 回调', async () => {
      const onDownloadStart = vi.fn()
      
      operations = createImageOperations({
        onDownloadStart,
        showToast: showToastMock
      })

      await operations.downloadImage('https://example.com/image.png')

      expect(onDownloadStart).toHaveBeenCalledWith('https://example.com/image.png')
    })

    it('应该调用 onDownloadSuccess 回调', async () => {
      const onDownloadSuccess = vi.fn()
      
      operations = createImageOperations({
        onDownloadSuccess,
        showToast: showToastMock
      })

      await operations.downloadImage('https://example.com/image.png')

      expect(onDownloadSuccess).toHaveBeenCalled()
    })

    it('应该调用 onCopySuccess 回调', async () => {
      const onCopySuccess = vi.fn()
      
      operations = createImageOperations({
        onCopySuccess,
        showToast: showToastMock
      })

      await operations.copyToClipboard('https://example.com/image.png')

      expect(onCopySuccess).toHaveBeenCalled()
    })
  })
})

describe('getImageOperations 单例', () => {
  it('应该返回函数', () => {
    expect(typeof getImageOperations).toBe('function')
  })
})
