// src/renderer/src/utils/clipboard.ts
// 剪贴板工具 - 从 app.js 提取

export interface ClipboardManagerConfig {
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void
  onPasteImage?: (images: File[]) => void
}

export interface PasteResult {
  success: boolean
  type: 'text' | 'image' | 'none'
  text?: string
  images?: File[]
  error?: string
}

/**
 * 剪贴板管理器
 */
export class ClipboardManager {
  private config: ClipboardManagerConfig

  constructor(config: ClipboardManagerConfig = {}) {
    this.config = config
  }

  /**
   * 复制文本到剪贴板
   */
  async copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      this.config.showToast?.('已复制到剪贴板', 'success')
      return true
    } catch (error) {
      console.error('复制失败:', error)
      this.config.showToast?.('复制失败，请手动复制', 'error')
      return false
    }
  }

  /**
   * 从剪贴板读取文本
   */
  async readText(): Promise<string | null> {
    try {
      const text = await navigator.clipboard.readText()
      return text
    } catch (error) {
      console.error('读取剪贴板失败:', error)
      return null
    }
  }

  /**
   * 处理粘贴事件
   */
  handlePasteEvent(event: ClipboardEvent): PasteResult {
    const clipboardData = event.clipboardData
    if (!clipboardData) {
      return { success: false, type: 'none', error: '无剪贴板数据' }
    }

    // 检查是否有图片
    const images = this.extractImagesFromClipboard(clipboardData)
    if (images.length > 0) {
      this.config.onPasteImage?.(images)
      return { success: true, type: 'image', images }
    }

    // 检查是否有文本
    const text = clipboardData.getData('text/plain')
    if (text) {
      return { success: true, type: 'text', text }
    }

    return { success: false, type: 'none' }
  }

  /**
   * 从剪贴板数据中提取图片
   */
  extractImagesFromClipboard(clipboardData: DataTransfer): File[] {
    const images: File[] = []
    const items = clipboardData.items

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          images.push(file)
        }
      }
    }

    return images
  }

  /**
   * 检查剪贴板是否有图片
   */
  async hasClipboardImage(): Promise<boolean> {
    try {
      const clipboardItems = await navigator.clipboard.read()
      for (const item of clipboardItems) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            return true
          }
        }
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * 从剪贴板读取图片
   */
  async readImage(): Promise<Blob | null> {
    try {
      const clipboardItems = await navigator.clipboard.read()
      for (const item of clipboardItems) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type)
            return blob
          }
        }
      }
      return null
    } catch (error) {
      console.error('读取剪贴板图片失败:', error)
      return null
    }
  }

  /**
   * 检查是否在上传上下文中（用于决定是否处理粘贴）
   */
  isInUploadContext(uploadElementIds: string[], lastInteractionTime: number, timeout: number = 5000): boolean {
    // 检查是否有上传元素被聚焦
    const activeElement = document.activeElement
    
    for (const id of uploadElementIds) {
      const element = document.getElementById(id)
      if (element) {
        // 检查元素是否被聚焦或者最近被点击
        if (activeElement === element || element.contains(activeElement)) {
          return true
        }
      }
    }

    // 检查最近是否有上传交互
    if (lastInteractionTime && Date.now() - lastInteractionTime < timeout) {
      return true
    }

    return false
  }
}

// 单例实例
let clipboardInstance: ClipboardManager | null = null

/**
 * 获取 ClipboardManager 单例
 */
export function getClipboardManager(config?: ClipboardManagerConfig): ClipboardManager {
  if (!clipboardInstance) {
    clipboardInstance = new ClipboardManager(config)
  }
  return clipboardInstance
}

/**
 * 创建新的 ClipboardManager 实例
 */
export function createClipboardManager(config?: ClipboardManagerConfig): ClipboardManager {
  return new ClipboardManager(config)
}

/**
 * 快速复制文本到剪贴板
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  return getClipboardManager().copyText(text)
}

/**
 * 快速从剪贴板读取文本
 */
export async function pasteFromClipboard(): Promise<string | null> {
  return getClipboardManager().readText()
}
