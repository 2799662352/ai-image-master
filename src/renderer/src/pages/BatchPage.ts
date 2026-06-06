// src/renderer/src/pages/BatchPage.ts
/**
 * 批量生成页面模块 (TypeScript)
 * @description 处理多提示词批量生成功能
 */

import { BasePage, type AppInterface } from './BasePage'
import { extractPriceFromModel } from '../utils/model-price'

// Types
export type BatchMode = 'card' | 'multi'

export interface BatchReferenceImage {
  base64: string
  originalFile?: File
  fileName: string
  fileSize: number
  mimeType: string
  id: number
  width: number
  height: number
  uploadTime?: string
  needsCompression: boolean
}

export interface BatchResult {
  prompt: string
  urls: string[]
  success: boolean
  error?: any
  errorMessage?: string
  index: number
}

// ---------------------------------------------------------------------------
// Per-item history dispatch — used to fan out one history record per image
// the moment its `batchItemComplete` event fires, instead of waiting for
// the whole batch to finish. This decouples the testable dispatch policy
// from the BatchPage class so we don't need to instantiate the whole
// 1700-line DOM-bound page to verify upload-on-completion semantics.
// ---------------------------------------------------------------------------

export type BatchItemResult = Pick<
  BatchResult,
  'index' | 'prompt' | 'urls' | 'success'
> & { errorMessage?: string }

export type AddToHistoryFn = (
  type: string,
  prompt: string,
  urls: string[],
  ratio: string,
) => unknown

export interface DispatchOptions {
  historyType: string
  ratio: string
  /**
   * The host's `addToHistory` (usually `this.app.addToHistory`). Allowed to
   * be undefined for defensive runtime safety — e.g. during hot reload or
   * teardown when the host App reference is briefly missing.
   */
  addToHistory: AddToHistoryFn | undefined
}

/**
 * Fan out a single `batchItemComplete` result into one `addToHistory` call
 * per URL, so each image starts uploading to Tencent COS the instant it
 * finishes generating rather than queuing until the whole batch settles.
 *
 * Returns the number of history calls dispatched (mostly for tests).
 */
export function dispatchBatchItemToHistory(
  result: BatchItemResult,
  { historyType, ratio, addToHistory }: DispatchOptions,
): number {
  if (!addToHistory) return 0
  if (!result.success) return 0
  if (!Array.isArray(result.urls) || result.urls.length === 0) return 0
  for (const url of result.urls) {
    addToHistory(historyType, result.prompt, [url], ratio)
  }
  return result.urls.length
}

export interface BatchPageState {
  mode: BatchMode
  cardPrompt: string
  batchPrompts: string
  cardCount: string
  batchRatio: string
  batchResolution: string
  batchConcurrency: string
  batchCount: string
  batchReferenceImages: BatchReferenceImage[]
}

export interface ProgressToast {
  update: (message: string) => void
  close: () => void
}

export interface ImageDimensions {
  width: number
  height: number
}

export class BatchPage extends BasePage {
  private currentResolution: string = '2K'
  private batchReferenceImages: BatchReferenceImage[] = []
  private maxReferenceImages: number = 16
  private isProcessingBatchFiles: boolean = false
  private isBatchFileSelectionActive: boolean = false
  private currentBatchResults: BatchResult[] = []
  private isBatchGenerating: boolean = false
  private currentBatchMode: BatchMode = 'card'
  private currentBatchUploadId: string | null = null
  // Per-run history dispatch context — set by execute*Generation BEFORE
  // batchItemComplete events can fire, then read inside addSingleResult()
  // so each finished image is forwarded to addToHistory immediately
  // rather than queuing until the whole batch settles.
  private currentBatchHistoryType: string = 'batch'
  private currentBatchHistoryRatio: string = '1:1'

  constructor(app: AppInterface) {
    super(app)
    this.init()
  }

  init(): void {
    // 守护:如果存在 batch-react-root,说明 React 已接管(donor-punk 主题),
    // vanilla 的事件绑定全部 skip,避免双向冲突
    if (typeof document !== 'undefined' && document.getElementById('batch-react-root')) {
      console.log('[BatchPage.ts] 检测到 batch-react-root,跳过 vanilla 初始化(React 接管)')
      this.isInitialized = true
      return
    }
    this.bindEvents()
    this.bindStateAutoSave()
    this.isInitialized = true
  }

  bindEvents(): void {
    // 批量生成按钮
    this.addEventListenerSafe('batchGenerateBtn', 'click', () => this.batchGenerate())

    // 监听批量进度事件
    window.addEventListener('batchProgress', ((e: CustomEvent) => this.updateBatchProgress(e.detail)) as EventListener)

    // 监听单个项目完成事件
    window.addEventListener('batchItemComplete', ((e: CustomEvent) => this.addSingleResult(e.detail)) as EventListener)

    // 批量参考图上传相关事件
    this.bindBatchReferenceImageEvents()

    // 模式切换事件
    document.querySelectorAll('input[name="batchMode"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement
        this.switchBatchMode(target.value as BatchMode)
      })
    })

    // 抽卡数量滑块事件
    const cardCountSlider = this.getElement<HTMLInputElement>('cardCount')
    if (cardCountSlider) {
      cardCountSlider.addEventListener('input', () => this.updateCardCostEstimate())
    }

    // 二次确认对话框事件
    this.addEventListenerSafe('cancelCardConfirm', 'click', () => {
      this.getElement('cardConfirmModal')?.classList.add('hidden')
    })

    this.addEventListenerSafe('confirmCardGenerate', 'click', () => {
      this.getElement('cardConfirmModal')?.classList.add('hidden')
      this.executeCardGeneration()
    })

    // 多提示词模式的模板按钮
    this.addEventListenerSafe('batchPromptTemplateBtn2', 'click', () => {
      window.dispatchEvent(
        new CustomEvent('showPromptTemplates', {
          detail: { targetInput: 'batchPrompts' }
        })
      )
    })
  }

  saveState(): void {
    this.saveCurrentStateImmediate()
  }

  async restoreState(): Promise<void> {
    if (this.stateRestored) return

    try {
      const pageStateManager = (window as any).pageStateManager
      if (pageStateManager) {
        const savedState = await pageStateManager.loadState('batch')
        if (savedState) {
          this.applyState(savedState as BatchPageState)
        }
      }
      this.stateRestored = true
    } catch (error) {
      console.error('恢复 BatchPage 状态失败:', error)
    }
  }

  // ==================== 语言切换 ====================

  onLanguageChange(lang: string): void {
    console.log('BatchPage: 语言切换为', lang)
    this.updateBatchReferenceImagesPreview()
    this.updateCardCostEstimate()
    this.updateEmptyStateText()
  }

  private updateEmptyStateText(): void {
    const batchResults = this.getElement('batchResults')
    if (batchResults && batchResults.querySelector('.col-span-full')) {
      const emptyDiv = batchResults.querySelector('.col-span-full')
      const pElement = emptyDiv?.querySelector('p')
      if (pElement) {
        pElement.textContent = this.t('batch.labels.emptyResults')
      }
    }
  }

  // ==================== 文件选择和上传 ====================

  private triggerBatchFileSelection(): void {
    if (this.isProcessingBatchFiles) {
      console.log(this.t('batch.upload.processing'))
      return
    }

    if (this.isBatchFileSelectionActive) {
      console.log(this.t('batch.upload.selectionActive'))
      return
    }

    this.isBatchFileSelectionActive = true
    console.log('设置批量文件选择激活标志位')

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.style.display = 'none'

    const inputId = 'batch-dynamic-input-' + Date.now() + '-' + Math.random()
    input.id = inputId

    const cleanup = (): void => {
      this.isBatchFileSelectionActive = false
      console.log('重置批量文件选择激活标志位')
      if (input.parentNode) {
        input.parentNode.removeChild(input)
        console.log('已清理批量动态input:', inputId)
      }
    }

    input.addEventListener('change', (e: Event) => {
      console.log('批量动态input change事件触发:', inputId)
      const target = e.target as HTMLInputElement
      if (target.files && target.files.length > 0 && !this.isProcessingBatchFiles) {
        const files = Array.from(target.files)
        this.handleMultipleBatchReferenceImageUpload(files)
      }
      cleanup()
    })

    input.addEventListener('cancel', () => {
      console.log('用户取消批量文件选择:', inputId)
      cleanup()
    })

    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (this.isBatchFileSelectionActive) {
          console.log('检测到批量焦点丢失，可能用户取消了选择:', inputId)
          cleanup()
        }
      }, 100)
    })

    document.body.appendChild(input)
    console.log('创建批量动态input并触发点击:', inputId)
    input.click()
  }

  private bindBatchReferenceImageEvents(): void {
    const batchReferenceImageArea = this.getElement('batchReferenceImageArea')
    const addMoreBatchReferenceArea = this.getElement('addMoreBatchReferenceArea')

    if (!batchReferenceImageArea) {
      console.error('batchReferenceImageArea 元素未找到，可能DOM还未完全加载')
      return
    }

    const handleUploadAreaClick = (e: Event): void => {
      e.stopPropagation()
      const target = e.target as HTMLElement

      if (target.closest('.remove-batch-reference-btn')) return
      if (target.closest('[data-dynamic-add-button="true"]')) {
        console.log('点击了批量动态添加更多按钮，跳过主区域处理')
        return
      }
      if (target.closest('.relative.bg-white\\/10')) {
        console.log('点击了已上传的批量图片，已禁用点击上传功能')
        return
      }

      console.log('点击批量上传区域')
      this.triggerBatchFileSelection()
    }

    batchReferenceImageArea.addEventListener('click', handleUploadAreaClick)

    if (addMoreBatchReferenceArea) {
      addMoreBatchReferenceArea.addEventListener('click', (e: Event) => {
        e.stopPropagation()
        console.log('点击添加更多批量参考图区域')

        if (this.batchReferenceImages.length < this.maxReferenceImages) {
          this.triggerBatchFileSelection()
        } else {
          const currentModel = this.getApi()?.getCurrentModel()
          if (currentModel && currentModel.apiType === 'flux-kontext') {
            this.showToast(this.t('batch.messages.fluxModelLimit'), 'info')
          } else {
            this.showToast(this.t('batch.messages.maxImagesReached', { max: this.maxReferenceImages }), 'warning')
          }
        }
      })
    }

    this.bindBatchPasteEvents()
  }

  private bindBatchPasteEvents(): void {
    const batchReferenceImageArea = this.getElement('batchReferenceImageArea')
    if (!batchReferenceImageArea) return

    batchReferenceImageArea.setAttribute('tabindex', '0')
    batchReferenceImageArea.setAttribute('role', 'button')
    batchReferenceImageArea.setAttribute('aria-label', this.t('batch.labels.uploadAriaLabel'))

    batchReferenceImageArea.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        this.triggerBatchFileSelection()
      }
    })

    batchReferenceImageArea.addEventListener('dragenter', (e: DragEvent) => {
      e.preventDefault()
      batchReferenceImageArea.classList.add('border-white/70', 'bg-white/5')
    })

    batchReferenceImageArea.addEventListener('dragleave', (e: DragEvent) => {
      e.preventDefault()
      batchReferenceImageArea.classList.remove('border-white/70', 'bg-white/5')
    })

    batchReferenceImageArea.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault()
    })

    batchReferenceImageArea.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault()
      batchReferenceImageArea.classList.remove('border-white/70', 'bg-white/5')

      const files = Array.from(e.dataTransfer?.files || [])
      if (files.length > 0) {
        this.handleMultipleBatchReferenceImageUpload(files)
      }
    })
  }

  async handleBatchPasteEvent(e: ClipboardEvent): Promise<void> {
    const clipboardItems = e.clipboardData?.items
    if (!clipboardItems) return

    console.log('检测到批量粘贴事件，剪贴板项目数量:', clipboardItems.length)

    const imageFiles: File[] = []

    for (let i = 0; i < clipboardItems.length; i++) {
      const item = clipboardItems[i]
      console.log('批量剪贴板项目类型:', item.type)

      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }

    if (imageFiles.length === 0) {
      this.showToast(this.t('batch.messages.noImageInClipboard'), 'warning')
      return
    }

    if (this.batchReferenceImages.length >= this.maxReferenceImages) {
      const currentModel = this.getApi()?.getCurrentModel()
      if (currentModel && currentModel.apiType === 'flux-kontext') {
        this.showToast(this.t('batch.messages.fluxModelLimit'), 'info')
      } else {
        this.showToast(this.t('batch.messages.maxImagesReached', { max: this.maxReferenceImages }), 'warning')
      }
      return
    }

    console.log('从剪贴板获取到批量图片数量:', imageFiles.length)
    e.preventDefault()

    try {
      await this.handleMultipleBatchReferenceImageUpload(imageFiles)
      this.showToast(this.t('batch.messages.pasteSuccess', { count: imageFiles.length }), 'success')
    } catch (error) {
      console.error('处理批量粘贴图片时出错:', error)
      this.showToast(this.t('batch.messages.pasteFailed'), 'error')
    }
  }

  // ==================== 图片处理 ====================

  private async handleMultipleBatchReferenceImageUpload(files: File[]): Promise<void> {
    const currentModel = this.getApi()?.getCurrentModel()
    if (currentModel && currentModel.apiType === 'flux-kontext') {
      this.maxReferenceImages = 1
    } else {
      this.maxReferenceImages = 16
    }

    const uploadId = Date.now() + '-batch-' + Math.random().toString(36).substr(2, 9)
    console.log(`🔄 开始批量图片上传任务: ${uploadId}, 文件数量: ${files.length}`)

    if (this.isProcessingBatchFiles) {
      console.log(`⏭️ 检测到重复批量上传，忽略任务: ${uploadId}`)
      return
    }

    this.isProcessingBatchFiles = true
    this.currentBatchUploadId = uploadId

    try {
      const startTime = Date.now()
      const validFiles: File[] = []

      for (const file of files) {
        try {
          this.validateImageFile(file)

          const isDuplicate = this.batchReferenceImages.some(
            (img) => img.fileName === file.name && Math.abs(img.fileSize - file.size) < 1024
          )

          if (isDuplicate) {
            this.showToast(this.t('batch.messages.duplicateFile', { name: file.name }), 'warning')
            continue
          }

          if (this.batchReferenceImages.length + validFiles.length >= this.maxReferenceImages) {
            if (validFiles.length === 0) {
              if (currentModel && currentModel.apiType === 'flux-kontext') {
                throw new Error(this.t('batch.messages.fluxModelLimitError'))
              } else {
                throw new Error(this.t('batch.messages.maxImagesReachedError', { max: this.maxReferenceImages }))
              }
            }

            if (currentModel && currentModel.apiType === 'flux-kontext') {
              this.showToast(this.t('batch.messages.fluxModelLimit'), 'info')
            } else {
              this.showToast(this.t('batch.messages.uploadLimitReached', { max: this.maxReferenceImages }), 'warning')
            }
            break
          }

          validFiles.push(file)
        } catch (error: any) {
          this.showToast(error.message, 'error')
        }
      }

      if (validFiles.length === 0) return

      const progressToast = this.showProgressToast(
        this.t('batch.messages.processingImages', { count: validFiles.length })
      )

      const concurrencyLimit = Math.min(this.uploadConfig.maxConcurrency, validFiles.length)
      console.log(`🚀 批量并发处理配置: ${concurrencyLimit}个文件同时处理`)
      const results: BatchReferenceImage[] = []

      for (let i = 0; i < validFiles.length; i += concurrencyLimit) {
        const batch = validFiles.slice(i, i + concurrencyLimit)
        const batchPromises = batch.map(async (file) => {
          try {
            if (this.currentBatchUploadId !== uploadId) {
              throw new Error(this.t('batch.messages.uploadCancelled'))
            }

            const base64 = await this.fileToBase64Enhanced(file)
            const dimensions = await this.getBatchImageDimensions(file)

            return {
              base64,
              originalFile: file,
              fileName: file.name,
              fileSize: file.size,
              mimeType: (file.type || 'image/jpeg').toLowerCase(),
              id: Date.now() + Math.random(),
              width: dimensions.width,
              height: dimensions.height,
              uploadTime: new Date().toISOString(),
              needsCompression: file.size > 2 * 1024 * 1024
            } as BatchReferenceImage
          } catch (error: any) {
            console.error(`❌ 处理批量文件 ${file.name} 失败:`, error)
            this.showToast(`${file.name} 处理失败: ${error.message}`, 'error')
            return null
          }
        })

        const batchResults = await Promise.allSettled(batchPromises)
        const successResults = batchResults
          .filter(
            (result): result is PromiseFulfilledResult<BatchReferenceImage | null> =>
              result.status === 'fulfilled' && result.value !== null
          )
          .map((result) => result.value as BatchReferenceImage)

        results.push(...successResults)

        const processed = Math.min(i + concurrencyLimit, validFiles.length)
        progressToast.update(
          this.t('batch.messages.processedProgress', {
            processed,
            total: validFiles.length,
            concurrent: Math.min(concurrencyLimit, validFiles.length - i)
          })
        )
      }

      this.batchReferenceImages.push(...results)
      this.updateBatchReferenceImagesPreview()
      this.updateBatchIntelligentResizeIfNeeded()
      progressToast.close()

      const processTime = ((Date.now() - startTime) / 1000).toFixed(1)
      const successCount = results.length

      if (successCount > 0) {
        const message =
          successCount === 1
            ? this.t('batch.messages.uploadSuccess', { time: processTime })
            : this.t('batch.messages.uploadSuccessMultiple', { count: successCount, time: processTime })
        this.showToast(message, 'success')
      }

      console.log(`✅ 批量上传任务完成: ${uploadId}, 成功: ${successCount}/${validFiles.length}, 耗时: ${processTime}秒`)
    } catch (error: any) {
      console.error(`❌ 批量上传任务失败: ${uploadId}`, error)
      this.showToast(this.t('batch.messages.uploadFailed', { error: error.message }), 'error')
    } finally {
      this.isProcessingBatchFiles = false
      this.currentBatchUploadId = null
    }
  }

  private async fileToBase64Enhanced(file: File): Promise<string> {
    const maxRetries = this.uploadConfig.retryAttempts
    const retryDelay = 1000

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()

          reader.onload = () => {
            try {
              const result = reader.result
              if (!result || typeof result !== 'string') {
                throw new Error('FileReader返回无效结果')
              }

              const base64 = result.split(',')[1]
              if (!base64 || base64.length < 100) {
                throw new Error('Base64数据异常短，可能转换失败')
              }

              if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
                throw new Error('Base64格式验证失败')
              }

              resolve(base64)
            } catch (error) {
              reject(error)
            }
          }

          reader.onerror = () => {
            reject(new Error(`文件读取失败: ${reader.error?.message || '未知错误'}`))
          }

          reader.onabort = () => {
            reject(new Error('文件读取被中断'))
          }

          setTimeout(() => {
            reader.abort()
            reject(new Error('文件读取超时'))
          }, this.uploadConfig.timeout)

          reader.readAsDataURL(file)
        })

        await this.validateBase64Image(base64, file.name, (file.type || 'image/jpeg').toLowerCase())
        console.log(`✅ 文件 ${file.name} Base64转换成功 (第${attempt}次尝试)`)
        return base64
      } catch (error: any) {
        console.warn(`⚠️ 文件 ${file.name} Base64转换失败 (第${attempt}/${maxRetries}次): ${error.message}`)

        if (attempt === maxRetries) {
          throw new Error(`文件转换失败，已重试${maxRetries}次: ${error.message}`)
        }

        await this.delay(retryDelay * attempt)
      }
    }

    throw new Error('Unexpected error in fileToBase64Enhanced')
  }

  private async validateBase64Image(base64: string, fileName: string, mimeType: string = 'image/jpeg'): Promise<boolean> {
    try {
      const testImg = new Image()
      let dataUrl = base64
      if (!dataUrl.startsWith('data:image/')) {
        dataUrl = `data:${mimeType};base64,${base64}`
      }

      return new Promise((resolve, reject) => {
        testImg.onload = () => {
          if (testImg.width > 0 && testImg.height > 0) {
            console.log(`✅ ${fileName} Base64数据验证通过: ${testImg.width}x${testImg.height}`)
            resolve(true)
          } else {
            reject(new Error('图片尺寸无效'))
          }
        }

        testImg.onerror = () => {
          reject(new Error('Base64数据无法解析为有效图片'))
        }

        setTimeout(() => {
          reject(new Error('图片验证超时'))
        }, 10000)

        testImg.src = dataUrl
      })
    } catch (error: any) {
      throw new Error(`图片数据验证失败: ${error.message}`)
    }
  }

  private validateImageFile(file: File): void {
    if (!file.type.startsWith('image/')) {
      throw new Error(this.t('batch.messages.notImageFile', { name: file.name }))
    }

    const maxSize = 50 * 1024 * 1024
    if (file.size > maxSize) {
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1)
      throw new Error(this.t('batch.messages.fileTooLarge', { name: file.name, size: fileSizeMB }))
    }

    const supportedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/bmp']
    if (!supportedTypes.includes(file.type.toLowerCase())) {
      throw new Error(this.t('batch.messages.unsupportedFormat', { name: file.name }))
    }

    if (file.name.length > 100) {
      console.warn(this.t('batch.messages.filenameTooLong', { name: file.name }))
    }

    if (file.size < 1024) {
      throw new Error(this.t('batch.messages.fileTooSmall', { name: file.name }))
    }

    console.log(`✅ 文件验证通过: ${file.name} (${file.type}, ${(file.size / 1024).toFixed(1)}KB)`)
  }

  private async getBatchImageDimensions(file: File): Promise<ImageDimensions> {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        console.log('📐 获取批量图片尺寸:', file.name, img.width + 'x' + img.height)
        URL.revokeObjectURL(img.src)
        resolve({ width: img.width, height: img.height })
      }
      img.onerror = () => {
        console.warn('⚠️ 无法获取批量图片尺寸，使用默认值:', file.name)
        URL.revokeObjectURL(img.src)
        resolve({ width: 1024, height: 1024 })
      }
      img.src = URL.createObjectURL(file)
    })
  }

  // ==================== UI 更新 ====================

  private updateBatchReferenceImagesPreview(): void {
    const currentModel = this.getApi()?.getCurrentModel()
    if (currentModel && currentModel.apiType === 'flux-kontext') {
      this.maxReferenceImages = 1
    } else {
      this.maxReferenceImages = 16
    }

    const uploadPrompt = this.getElement('batchReferenceUploadPrompt')
    const preview = this.getElement('batchReferenceImagesPreview')
    const imagesList = this.getElement('batchReferenceImagesList')

    if (this.batchReferenceImages.length === 0) {
      uploadPrompt?.classList.remove('hidden')
      preview?.classList.add('hidden')
      return
    }

    uploadPrompt?.classList.add('hidden')
    preview?.classList.remove('hidden')

    if (imagesList) {
      imagesList.innerHTML = ''

      this.batchReferenceImages.forEach((imageData, index) => {
        const imageItem = document.createElement('div')
        imageItem.className = 'relative bg-white/10 rounded-lg p-2 group'
        const mimeType = (imageData.mimeType || 'image/jpeg').toLowerCase()
        const imageUrl = `data:${mimeType};base64,${imageData.base64}`
        const altText = this.t('batch.labels.referenceImageAlt', { index: index + 1 })
        const removeTitle = this.t('batch.buttons.removeReference')
        const removeAriaLabel = this.t('batch.labels.removeReferenceAria', { index: index + 1 })
        imageItem.innerHTML = `
          <div class="relative">
            <div class="preview-trigger cursor-pointer relative group/img" data-preview-index="${index}" title="点击预览">
              <img src="${imageUrl}"
                   class="w-full aspect-square object-cover rounded-lg transition-transform duration-300 group-hover/img:scale-105"
                   alt="${altText}">
              <div class="absolute inset-0 bg-black/0 group-hover/img:bg-black/40 transition-all duration-300 rounded-lg flex items-center justify-center">
                <i class="fas fa-search-plus text-white text-lg opacity-0 group-hover/img:opacity-100 transition-opacity duration-300"></i>
              </div>
            </div>
            <button class="remove-batch-reference-btn absolute -top-1 -right-1 bg-red-500 hover:bg-red-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs transition-colors opacity-0 group-hover:opacity-100 z-10"
                    title="${removeTitle}"
                    aria-label="${removeAriaLabel}"
                    data-image-id="${imageData.id}">
              <i class="fas fa-times text-xs"></i>
            </button>
          </div>
        `
        imagesList.appendChild(imageItem)
      })

      if (this.batchReferenceImages.length < this.maxReferenceImages) {
        const addButton = document.createElement('div')
        addButton.className =
          'border-2 border-dashed border-white/30 hover:border-white/50 rounded-lg p-2 cursor-pointer transition-all flex items-center justify-center aspect-square group'
        addButton.setAttribute('data-dynamic-add-button', 'true')
        const addMoreText = this.t('batch.buttons.addMoreReference')
        addButton.innerHTML = `
          <div class="text-center">
            <i class="fas fa-plus text-white opacity-50 group-hover:opacity-70 text-xl mb-1"></i>
            <p class="text-white opacity-50 group-hover:opacity-70 text-xs">${addMoreText}</p>
            <p class="text-white opacity-30 group-hover:opacity-50 text-xs">(${this.batchReferenceImages.length}/${this.maxReferenceImages})</p>
          </div>
        `
        addButton.addEventListener('click', (e: Event) => {
          e.stopPropagation()
          console.log('点击批量动态添加更多按钮')
          this.triggerBatchFileSelection()
        })
        imagesList.appendChild(addButton)
      }

      const removeButtons = imagesList.querySelectorAll('.remove-batch-reference-btn')
      removeButtons.forEach((btn) => {
        btn.addEventListener('click', (e: Event) => {
          e.stopPropagation()
          const target = (e.target as HTMLElement).closest('.remove-batch-reference-btn') as HTMLElement
          const imageId = parseFloat(target?.dataset.imageId || '0')
          this.removeBatchReferenceImage(imageId)
        })
      })

      // 绑定图片预览事件
      const previewTriggers = imagesList.querySelectorAll('.preview-trigger')
      previewTriggers.forEach((trigger) => {
        trigger.addEventListener('click', (e: Event) => {
          e.stopPropagation()
          const target = (e.target as HTMLElement).closest('.preview-trigger') as HTMLElement
          const previewIndex = parseInt(target?.dataset.previewIndex || '0', 10)
          this.previewBatchReferenceImage(previewIndex)
        })
      })
    }

    this.saveCurrentState()
  }

  private previewBatchReferenceImage(index: number): void {
    if (index < 0 || index >= this.batchReferenceImages.length) return
    
    // 构建所有参考图的 URL 数组
    const urls = this.batchReferenceImages.map((img) => {
      const mimeType = (img.mimeType || 'image/jpeg').toLowerCase()
      return `data:${mimeType};base64,${img.base64}`
    })
    
    // 使用 ImageViewer 预览
    const imageViewer = (window as any).imageViewerTS
    if (imageViewer?.open) {
      imageViewer.open(urls, index)
    } else if ((this.app as any).viewImage) {
      ;(this.app as any).viewImage(urls, index)
    }
  }

  private removeBatchReferenceImage(imageId: number): void {
    const index = this.batchReferenceImages.findIndex((img) => img.id === imageId)
    if (index > -1) {
      const removedImage = this.batchReferenceImages.splice(index, 1)[0]
      this.updateBatchReferenceImagesPreview()
      this.showToast(this.t('batch.messages.imageRemoved', { name: removedImage.fileName }), 'info')
    }
  }

  clearAllBatchReferenceImages(): void {
    this.batchReferenceImages = []
    this.updateBatchReferenceImagesPreview()
  }

  // ==================== 模式切换 ====================

  switchBatchMode(mode: BatchMode): void {
    this.currentBatchMode = mode
    const cardUI = this.getElement('cardModeUI')
    const multiUI = this.getElement('multiModeUI')

    const cardModeLabel = this.getElement('cardModeLabel')
    const multiModeLabel = this.getElement('multiModeLabel')

    if (mode === 'card') {
      cardUI?.classList.remove('hidden')
      multiUI?.classList.add('hidden')

      if (cardModeLabel) {
        cardModeLabel.className =
          'flex items-center cursor-pointer px-4 py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-lg text-white font-medium shadow-md hover:shadow-lg transition-all'
      }
      if (multiModeLabel) {
        multiModeLabel.className =
          'flex items-center cursor-pointer px-4 py-3 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-all'
      }

      this.updateCardCostEstimate()
    } else {
      cardUI?.classList.add('hidden')
      multiUI?.classList.remove('hidden')

      if (cardModeLabel) {
        cardModeLabel.className =
          'flex items-center cursor-pointer px-4 py-3 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-all'
      }
      if (multiModeLabel) {
        multiModeLabel.className =
          'flex items-center cursor-pointer px-4 py-3 bg-gradient-to-r from-blue-500 to-purple-500 rounded-lg text-white font-medium shadow-md hover:shadow-lg transition-all'
      }
    }

    this.saveCurrentState()
  }

  // ==================== 费用预估 ====================

  private updateCardCostEstimate(): void {
    const cardCountSlider = this.getElement<HTMLInputElement>('cardCount')
    const count = parseInt(cardCountSlider?.value || '5')
    const currentModel = this.getApi()?.getCurrentModel()

    if (!currentModel) return

    const price = this.extractPriceFromModel(currentModel)
    const totalCost = (price * count).toFixed(3)

    if (cardCountSlider) {
      const min = parseInt(cardCountSlider.min)
      const max = parseInt(cardCountSlider.max)
      const percentage = ((count - min) / (max - min)) * 100
      cardCountSlider.style.setProperty('--range-progress', `${percentage}%`)
    }

    const cardCountDisplay = this.getElement('cardCountDisplay')
    const cardModelName = this.getElement('cardModelName')
    const cardUnitPrice = this.getElement('cardUnitPrice')
    const cardQuantity = this.getElement('cardQuantity')
    const cardTotalCost = this.getElement('cardTotalCost')

    if (cardCountDisplay) cardCountDisplay.textContent = this.t('batch.labels.quantityCount', { count })
    if (cardModelName) cardModelName.textContent = currentModel.name
    if (cardUnitPrice) cardUnitPrice.textContent = `$${price.toFixed(3)}`
    if (cardQuantity) cardQuantity.textContent = String(count)
    if (cardTotalCost) cardTotalCost.textContent = `$${totalCost}`
  }

  private extractPriceFromModel(model: any): number {
    return extractPriceFromModel(model)
  }

  // ==================== 抽卡模式 ====================

  private showCardConfirmDialog(): void {
    const prompt = this.getElement<HTMLTextAreaElement>('cardPromptInput')?.value.trim()
    if (!prompt) {
      this.showToast(this.t('batch.messages.promptRequired'), 'error')
      return
    }

    const api = this.getApi()
    if (!api?.apiKey) {
      this.showToast(this.t('batch.messages.apiKeyRequired'), 'error')
      ;(this.app as any).openSettings?.()
      return
    }

    const count = parseInt(this.getElement<HTMLInputElement>('cardCount')?.value || '5')
    const currentModel = api.getCurrentModel()
    const price = this.extractPriceFromModel(currentModel)
    const totalCost = (price * count).toFixed(3)

    const confirmCardCount = this.getElement('confirmCardCount')
    const confirmModelName = this.getElement('confirmModelName')
    const confirmUnitPrice = this.getElement('confirmUnitPrice')
    const confirmQuantity = this.getElement('confirmQuantity')
    const confirmCallCount = this.getElement('confirmCallCount')
    const confirmTotalCost = this.getElement('confirmTotalCost')

    if (confirmCardCount) confirmCardCount.textContent = `${count} 张`
    if (confirmModelName) confirmModelName.textContent = currentModel.name
    if (confirmUnitPrice) confirmUnitPrice.textContent = `$${price.toFixed(3)}`
    if (confirmQuantity) confirmQuantity.textContent = String(count)
    if (confirmCallCount) confirmCallCount.textContent = String(count)
    if (confirmTotalCost) confirmTotalCost.textContent = `$${totalCost}`

    this.getElement('cardConfirmModal')?.classList.remove('hidden')
  }

  private async executeCardGeneration(): Promise<void> {
    const prompt = this.getElement<HTMLTextAreaElement>('cardPromptInput')?.value.trim() || ''
    const count = parseInt(this.getElement<HTMLInputElement>('cardCount')?.value || '5')
    const ratio = this.getElement<HTMLSelectElement>('batchRatio')?.value || 'auto'
    const concurrency = parseInt(this.getElement<HTMLSelectElement>('batchConcurrency')?.value || '3')

    const api = this.getApi()
    const currentModel = api?.getCurrentModel()
    const supportsResolution = currentModel?.capabilities?.resolutionControl
    const batchResolutionSelect = this.getElement<HTMLSelectElement>('batchResolution')
    const resolution = supportsResolution && batchResolutionSelect ? batchResolutionSelect.value : null

    console.log(`🎰 抽卡生成参数: 模型=${currentModel?.name}, 分辨率=${resolution}, 比例=${ratio}, 数量=${count}`)

    const batchBtn = this.getElement<HTMLButtonElement>('batchGenerateBtn')
    const batchProgress = this.getElement('batchProgress')
    const batchResults = this.getElement('batchResults')

    this.isBatchGenerating = true
    this.currentBatchResults = []
    // Wire up per-item dispatcher BEFORE batchGenerate fires any events.
    this.currentBatchHistoryType = 'batch-card'
    this.currentBatchHistoryRatio = ratio

    if (batchBtn) {
      batchBtn.disabled = true
      batchBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>${this.t('batch.progress.cardGenerating')}`
    }
    batchProgress?.classList.remove('hidden')
    if (batchResults) batchResults.innerHTML = ''

    try {
      const prompts = Array(count).fill(prompt)

      let results
      if (this.batchReferenceImages.length > 0) {
        const preparedImages = await this.prepareReferenceImagesForGeneration()
        results = await api.batchGenerateWithReference(prompts, preparedImages, ratio, concurrency, 1, resolution)
      } else {
        results = await api.batchGenerate(prompts, ratio, concurrency, 1, resolution)
      }

      const finalResults = this.currentBatchResults.filter((r) => r)
      // NOTE: addToHistory is no longer called here in aggregate — each
      // image was already routed to addToHistory the moment its
      // batchItemComplete event fired (see addSingleResult). The local
      // `results` / `finalResults` variables are kept around because some
      // downstream paths inspect them for success counts and toast copy.
      void results

      const successCount = finalResults.filter((r) => r.success).length
      this.showToast(this.t('batch.messages.cardComplete', { success: successCount, total: count }), 'success')
    } catch (error: any) {
      if ((window as any).errorHandlerTS) {
        ;(window as any).errorHandlerTS.showDetailedError(error, this.t('batch.messages.cardGenerationError'))
      } else {
        this.showToast(error.message || this.t('batch.messages.cardGenerationError'), 'error')
      }
    } finally {
      this.isBatchGenerating = false
      if (batchBtn) {
        batchBtn.disabled = false
        batchBtn.innerHTML = `<i class="fas fa-layer-group mr-2"></i>${this.t('batch.buttons.startGenerate')}`
      }
      batchProgress?.classList.add('hidden')
    }
  }

  // ==================== 多提示词模式 ====================

  private async executeMultiPromptGeneration(): Promise<void> {
    const rawText = this.getElement<HTMLTextAreaElement>('batchPrompts')?.value.trim() || ''
    const prompts = rawText
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p)

    if (prompts.length === 0) {
      this.showToast(this.t('batch.messages.batchPromptsRequired'), 'error')
      return
    }

    const api = this.getApi()
    if (!api?.apiKey) {
      this.showToast(this.t('batch.messages.apiKeyRequired'), 'error')
      ;(this.app as any).openSettings?.()
      return
    }

    const ratio = this.getElement<HTMLSelectElement>('batchRatio')?.value || 'auto'
    const concurrency = parseInt(this.getElement<HTMLSelectElement>('batchConcurrency')?.value || '3')
    const batchCount = parseInt(this.getElement<HTMLSelectElement>('batchCount')?.value || '1')

    const currentModel = api.getCurrentModel()
    const supportsResolution = currentModel?.capabilities?.resolutionControl
    const batchResolutionSelect = this.getElement<HTMLSelectElement>('batchResolution')
    const resolution = supportsResolution && batchResolutionSelect ? batchResolutionSelect.value : null

    console.log(
      `🎨 批量生成参数: 模型=${currentModel?.name}, 支持分辨率=${supportsResolution}, 选择分辨率=${resolution}, 比例=${ratio}`
    )

    const batchBtn = this.getElement<HTMLButtonElement>('batchGenerateBtn')
    const batchProgress = this.getElement('batchProgress')
    const batchResults = this.getElement('batchResults')

    this.isBatchGenerating = true
    this.currentBatchResults = []
    // Wire up per-item dispatcher BEFORE batchGenerate fires any events.
    this.currentBatchHistoryType =
      this.batchReferenceImages.length > 0 ? 'batch-with-reference' : 'batch'
    this.currentBatchHistoryRatio = ratio

    if (batchBtn) {
      batchBtn.disabled = true
      batchBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>${this.t('batch.progress.batchGenerating')}`
    }
    batchProgress?.classList.remove('hidden')
    if (batchResults) batchResults.innerHTML = ''

    try {
      let results
      if (this.batchReferenceImages.length > 0) {
        const preparedImages = await this.prepareReferenceImagesForGeneration()
        results = await api.batchGenerateWithReference(prompts, preparedImages, ratio, concurrency, batchCount, resolution)
      } else {
        results = await api.batchGenerate(prompts, ratio, concurrency, batchCount, resolution)
      }

      const finalResults = this.currentBatchResults.filter((r) => r)
      // NOTE: addToHistory is no longer called here in aggregate — each
      // image was already routed to addToHistory the moment its
      // batchItemComplete event fired (see addSingleResult).
      void results

      const totalImagesGenerated = finalResults
        .filter((r) => r.success)
        .reduce((total, r) => total + (r.urls ? r.urls.length : 0), 0)
      const totalExpected = prompts.length * batchCount

      this.showToast(
        this.t('batch.messages.batchComplete', { success: totalImagesGenerated, total: totalExpected }),
        'success'
      )
    } catch (error: any) {
      if ((window as any).errorHandlerTS) {
        ;(window as any).errorHandlerTS.showDetailedError(error, this.t('batch.messages.batchGenerationError'))
      } else {
        this.showToast(error.message || this.t('batch.messages.batchGenerationError'), 'error')
      }
    } finally {
      this.isBatchGenerating = false
      if (batchBtn) {
        batchBtn.disabled = false
        batchBtn.innerHTML = `<i class="fas fa-layer-group mr-2"></i>${this.t('batch.buttons.startGenerate')}`
      }
      batchProgress?.classList.add('hidden')
    }
  }

  // ==================== 批量生成入口 ====================

  async batchGenerate(): Promise<void> {
    if (this.currentBatchMode === 'card') {
      this.showCardConfirmDialog()
    } else {
      await this.executeMultiPromptGeneration()
    }
  }

  // ==================== 进度更新 ====================

  private updateBatchProgress(detail: { completed: number; total: number; currentBatch: number; totalBatches: number }): void {
    const progressBar = this.getElement<HTMLElement>('batchProgressBar')
    const progressText = this.getElement('batchProgressText')

    const percentage = (detail.completed / detail.total) * 100
    if (progressBar) progressBar.style.width = `${percentage}%`

    const batchCount = parseInt(this.getElement<HTMLSelectElement>('batchCount')?.value || '1')
    const expectedImages = detail.total * batchCount
    const completedImages = detail.completed * batchCount

    if (progressText) {
      progressText.textContent = this.t('batch.progress.status', {
        currentBatch: detail.currentBatch,
        totalBatches: detail.totalBatches,
        completed: detail.completed,
        total: detail.total,
        completedImages,
        expectedImages
      })
    }
  }

  // ==================== 结果显示 ====================

  private addSingleResult(detail: { result: BatchResult }): void {
    if (!this.isBatchGenerating) return

    const container = this.getElement('batchResults')
    if (!container) return

    const result = detail.result
    this.currentBatchResults[result.index] = result

    // Fire-and-forget: kick off Tencent COS upload for THIS image right
    // now, without waiting for the rest of the batch to finish. Each URL
    // becomes its own history record + its own IPC → cosClient.putObject.
    // See `dispatchBatchItemToHistory` above the class for the policy.
    dispatchBatchItemToHistory(result, {
      historyType: this.currentBatchHistoryType,
      ratio: this.currentBatchHistoryRatio,
      addToHistory: this.app?.addToHistory?.bind(this.app),
    })

    const resultCard = document.createElement('div')
    resultCard.className = 'bg-white/5 rounded-lg p-4 animate-fade-in'
    resultCard.dataset.index = String(result.index)

    if (result.success && result.urls && result.urls.length > 0) {
      const imagesText = this.t('batch.labels.imageCount', { count: result.urls.length })
      const imageCountBadge =
        result.urls.length > 1
          ? `<div class="absolute top-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded-full">${imagesText}</div>`
          : ''
      const downloadText = this.t('batch.buttons.download')
      const batchDownloadText = this.t('batch.buttons.batchDownload')
      const viewText = this.t('batch.buttons.view')
      const successText = this.t('batch.labels.generateSuccess')
      const batchAltText = this.t('batch.labels.batchGenerateAlt', { index: result.index + 1 })

      resultCard.innerHTML = `
        <div class="relative group">
          <img src="${result.urls[0]}" alt="${batchAltText}" class="w-full h-32 object-cover rounded-lg mb-2" loading="lazy">
          ${imageCountBadge}
          <div class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-2">
            ${
              result.urls.length === 1
                ? `
              <button data-action="download-image" data-url="${result.urls[0]}" class="bg-white/20 hover:bg-white/30 text-white p-2 rounded-lg transition-all" title="${downloadText}">
                <i class="fas fa-download"></i>
              </button>
            `
                : `
              <button data-action="batch-download" data-urls='${JSON.stringify(result.urls)}' data-prompt="${result.prompt.replace(/"/g, '&quot;')}" class="bg-white/20 hover:bg-white/30 text-white p-2 rounded-lg transition-all" title="${batchDownloadText}">
                <i class="fas fa-file-archive"></i>
              </button>
            `
            }
            <button data-action="view-image" data-urls='${JSON.stringify(result.urls)}' data-index="0" class="bg-white/20 hover:bg-white/30 text-white p-2 rounded-lg transition-all" title="${viewText}">
              <i class="fas fa-expand"></i>
            </button>
          </div>
        </div>
        <p class="text-white text-xs truncate">${result.prompt}</p>
        <div class="flex items-center justify-between mt-2">
          <span class="text-green-400 text-xs">
            <i class="fas fa-check-circle mr-1"></i>${successText}
          </span>
          <span class="text-gray-400 text-xs">#${result.index + 1}</span>
        </div>
      `
    } else {
      const errorInfo = this.formatErrorInfo(result)
      const failedText = this.t('batch.labels.generateFailed')
      const detailsText = this.t('batch.buttons.details')
      const errorContextText = this.t('batch.labels.batchItemError', { index: result.index + 1 })

      resultCard.innerHTML = `
        <div class="h-32 bg-red-500/20 rounded-lg flex items-center justify-center mb-2 relative">
          <i class="fas fa-exclamation-triangle text-red-400"></i>
          <div class="absolute top-1 right-1 text-gray-400 text-xs">#${result.index + 1}</div>
        </div>
        <p class="text-white text-xs truncate mb-2">${result.prompt}</p>
        <div class="bg-red-600/20 rounded p-2 mb-2">
          <p class="text-red-300 text-xs font-medium">${errorInfo.title}</p>
          <p class="text-red-400 text-xs opacity-90">${errorInfo.message.substring(0, 50)}${errorInfo.message.length > 50 ? '...' : ''}</p>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-red-400 text-xs">
            <i class="fas fa-times-circle mr-1"></i>${failedText}
          </span>
          <button onclick="window.batchPageTS?.showDetailedBatchError(${result.index}, '${errorContextText}')"
                  class="text-blue-400 hover:text-blue-300 text-xs underline">
            ${detailsText}
          </button>
        </div>
      `
    }

    this.insertResultAtIndex(container, resultCard, result.index)

    if (result.success && result.urls) {
      this.getApi()?.preloadImages?.(result.urls)
    }
  }

  private formatErrorInfo(result: BatchResult): { title: string; message: string; details: any[] } {
    const api = this.getApi()

    if (result.error instanceof Error) {
      return api?.formatDetailedError?.(result.error) || { title: '生成失败', message: result.error.message, details: [] }
    } else if (typeof result.error === 'object' && result.error !== null) {
      if (result.error.detailedError || result.error.message) {
        const reconstructedError = new Error(result.error.message || result.errorMessage || '生成失败')
        ;(reconstructedError as any).detailedError = result.error.detailedError
        ;(reconstructedError as any).operation = result.error.operation
        ;(reconstructedError as any).parameters = result.error.parameters
        return api?.formatDetailedError?.(reconstructedError) || { title: '生成失败', message: result.errorMessage || '未知错误', details: [] }
      }
      return { title: '生成失败', message: result.errorMessage || result.error.toString() || '未知错误', details: [] }
    }
    return { title: '生成失败', message: result.errorMessage || result.error || '未知错误', details: [] }
  }

  showDetailedBatchError(resultIndex: number, context: string): void {
    const result = this.currentBatchResults[resultIndex]
    if (!result || result.success) {
      this.showToast(this.t('batch.messages.errorNotFound'), 'error')
      return
    }

    let errorToShow: Error
    if (result.error instanceof Error) {
      errorToShow = result.error
    } else if (typeof result.error === 'object' && result.error !== null) {
      errorToShow = new Error(result.error.message || result.errorMessage || '生成失败')
      ;(errorToShow as any).detailedError = result.error.detailedError
      ;(errorToShow as any).operation = result.error.operation
      ;(errorToShow as any).parameters = result.error.parameters
    } else {
      errorToShow = new Error(result.errorMessage || result.error || '生成失败')
      ;(errorToShow as any).detailedError = {
        status: null,
        statusText: 'Unknown Error',
        url: '',
        method: 'POST',
        errorData: { error: { message: result.errorMessage || result.error || '生成失败' } },
        rawResponse: JSON.stringify({ error: '原始响应不可用' }, null, 2),
        attempt: 1,
        maxRetries: 1,
        timestamp: new Date().toISOString(),
        operation: 'batchGenerate'
      }
    }

    if ((window as any).errorHandlerTS) {
      ;(window as any).errorHandlerTS.showDetailedError(errorToShow, context)
    } else {
      this.showToast(errorToShow.message, 'error')
    }
  }

  private insertResultAtIndex(container: HTMLElement, newCard: HTMLElement, index: number): void {
    const existingCards = Array.from(container.children)
    let insertPosition = 0

    for (let i = 0; i < existingCards.length; i++) {
      const cardIndex = parseInt((existingCards[i] as HTMLElement).dataset.index || '0')
      if (cardIndex > index) {
        insertPosition = i
        break
      }
      insertPosition = i + 1
    }

    if (insertPosition >= existingCards.length) {
      container.appendChild(newCard)
    } else {
      container.insertBefore(newCard, existingCards[insertPosition])
    }
  }

  // ==================== 批量下载 ====================

  async downloadBatchImages(urls: string[], prompt: string): Promise<void> {
    try {
      const promptPrefix = prompt.replace(/[^\w\u4e00-\u9fa5]/g, '').substring(0, 20)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
      const zipFilename = `${promptPrefix}_${timestamp}.zip`

      this.showToast(this.t('batch.messages.downloadStarting'), 'info')

      const api = this.getApi()
      const result = await api?.downloadImagesAsZip?.(
        urls,
        zipFilename,
        (completed: number, total: number) => {
          this.showToast(this.t('batch.messages.downloading', { completed, total }), 'info')
        },
        api.model
      )

      this.showToast(result?.message || this.t('batch.messages.downloadComplete'), 'success')
    } catch (error: any) {
      this.showToast(error.message, 'error')

      if (error.message.includes('右键图片选择')) {
        this.showDownloadHelpDialog(urls, prompt)
      }
    }
  }

  private showDownloadHelpDialog(urls: string[], prompt: string): void {
    const modal = document.createElement('div')
    modal.className = 'fixed inset-0 bg-black/50 z-[50000] flex items-center justify-center p-4'
    const helpTitle = this.t('batch.downloadHelp.title')
    const helpWarning = this.t('batch.downloadHelp.warning')
    const helpInstructions = this.t('batch.downloadHelp.instructions')
    const step1 = this.t('batch.downloadHelp.step1')
    const step2 = this.t('batch.downloadHelp.step2')
    const step3 = this.t('batch.downloadHelp.step3')
    const step4 = this.t('batch.downloadHelp.step4')
    const viewImagesBtn = this.t('batch.downloadHelp.viewImages')
    const gotItBtn = this.t('batch.downloadHelp.gotIt')

    modal.innerHTML = `
      <div class="bg-white rounded-xl p-6 w-full max-w-md mx-4">
        <h3 class="text-xl font-bold mb-4 text-gray-800">
          <i class="fas fa-question-circle text-blue-500 mr-2"></i>
          ${helpTitle}
        </h3>
        <div class="space-y-3 text-gray-600 text-sm">
          <p><strong>${helpWarning}</strong></p>
          <p>${helpInstructions}</p>
          <ol class="list-decimal list-inside space-y-1 ml-2">
            <li>${step1}</li>
            <li>${step2}</li>
            <li>${step3}</li>
            <li>${step4}</li>
          </ol>
        </div>
        <div class="flex space-x-3 mt-6">
          <button data-action="view-image" data-urls='${JSON.stringify(urls)}' data-index="0" class="flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-md transition-colors">
            <i class="fas fa-eye mr-2"></i>${viewImagesBtn}
          </button>
          <button data-action="dismiss-parent" class="bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-md transition-colors">
            ${gotItBtn}
          </button>
        </div>
      </div>
    `

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove()
      }
    })

    document.body.appendChild(modal)
  }

  // ==================== 模型切换 ====================

  onModelChanged(): void {
    console.log('批量页面：检测到模型切换')

    const currentModel = this.getApi()?.getCurrentModel()
    if (!currentModel) return

    if (currentModel.apiType === 'flux-kontext') {
      this.maxReferenceImages = 1
    } else {
      this.maxReferenceImages = 16
    }

    if (this.currentBatchMode === 'card') {
      this.updateCardCostEstimate()
    }

    const batchRatioSelect = this.getElement<HTMLSelectElement>('batchRatio')
    if (batchRatioSelect && currentModel.apiType === 'gemini-native') {
      batchRatioSelect.value = 'auto'
      console.log('批量页面：Gemini模型已设置默认尺寸为自适应')
    }

    this.updateBatchReferenceImagesPreview()
  }

  // ==================== 智能尺寸 ====================

  private updateBatchIntelligentResizeIfNeeded(): void {
    const currentModel = this.getApi()?.getCurrentModel()
    const capabilities = currentModel?.capabilities || {}

    console.log('🔍 检查批量是否需要更新智能尺寸 - 模型:', currentModel?.name, '智能尺寸:', capabilities.intelligentResize)

    if (capabilities.intelligentResize && this.app) {
      console.log('✅ 批量需要更新智能尺寸，开始执行...')
      setTimeout(() => {
        ;(this.app as any).setupBatchIntelligentResizeMode?.()
      }, 100)
    } else {
      console.log('❌ 批量不需要更新智能尺寸 - intelligentResize:', capabilities.intelligentResize, 'app:', !!this.app)
    }
  }

  // ==================== 图片压缩 ====================

  private async compressImageIfNeeded(file: File): Promise<File> {
    const MAX_SIZE_MB = 2
    const fileSizeMB = file.size / (1024 * 1024)

    if (fileSizeMB <= MAX_SIZE_MB) {
      console.log(`文件 ${file.name} 大小为 ${fileSizeMB.toFixed(2)}MB，无需压缩`)
      return file
    }

    try {
      // V18: 使用延迟加载获取 imageCompression
      const getImageCompression = (window as any).getImageCompression
      if (typeof getImageCompression !== 'function') {
        console.warn('图片压缩库加载器未就绪，跳过压缩')
        return file
      }
      
      const imageCompression = await getImageCompression()
      
      const options = {
        maxSizeMB: 2,
        maxWidthOrHeight: 2048,
        useWebWorker: true,
        // 使用本地文件避免 CSP 限制（Worker 默认从 CDN 加载脚本会被阻止）
        libURL: './cdn/browser-image-compression/browser-image-compression.js',
        fileType: file.type,
        initialQuality: 0.9,
        alwaysKeepResolution: false
      }

      console.log(`⏩ 开始压缩文件: ${file.name}, 原大小: ${fileSizeMB.toFixed(2)}MB`)
      const startTime = Date.now()

      const compressedFile = await imageCompression(file, options)

      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      const compressedSizeMB = compressedFile.size / (1024 * 1024)
      const compressionRatio = ((1 - compressedFile.size / file.size) * 100).toFixed(1)

      console.log(
        `✅ 压缩完成: ${file.name}\n` +
        `   原大小: ${fileSizeMB.toFixed(2)}MB\n` +
        `   压缩后: ${compressedSizeMB.toFixed(2)}MB\n` +
        `   压缩率: ${compressionRatio}%\n` +
        `   ⏱️ 耗时: ${duration}秒`
      )

      return compressedFile
    } catch (error: any) {
      console.error('图片压缩失败:', error)
      this.showToast(this.t('batch.messages.compressionFailed', { error: error.message }), 'warning')
      return file
    }
  }

  private async prepareReferenceImagesForGeneration(): Promise<BatchReferenceImage[]> {
    if (this.batchReferenceImages.length === 0) return []

    const processedImages: BatchReferenceImage[] = []
    const imagesToCompress = this.batchReferenceImages.filter((img) => img.needsCompression)

    console.log(`🖼️ 准备参考图片用于生成...`)
    console.log(`📊 需要压缩的图片: ${imagesToCompress.length}/${this.batchReferenceImages.length}`)

    let toastId: ProgressToast | null = null
    let toastRemoved = false
    const startTime = Date.now()
    const MAX_TOAST_DISPLAY_TIME = 3000

    if (imagesToCompress.length > 0) {
      const compressingText = this.t('batch.messages.compressing', { count: imagesToCompress.length })
      const compressionNote = this.t('batch.messages.compressionNote')
      toastId = this.showProgressToast(`${compressingText}<br><span class="text-sm opacity-80">${compressionNote}</span>`)

      setTimeout(() => {
        if (toastId && !toastRemoved) {
          toastId.close()
          console.log('⏰ Toast显示已达3秒，自动移除')
          toastRemoved = true
        }
      }, MAX_TOAST_DISPLAY_TIME)
    }

    try {
      for (const imageData of this.batchReferenceImages) {
        try {
          if (imageData.needsCompression && imageData.originalFile) {
            console.log(`🗜️ 压缩参考图: ${imageData.fileName}`)
            const compressedFile = await this.compressImageIfNeeded(imageData.originalFile)
            const compressedBase64 = await this.fileToBase64Enhanced(compressedFile)

            processedImages.push({
              ...imageData,
              base64: compressedBase64,
              fileSize: compressedFile.size
            })
          } else {
            processedImages.push(imageData)
          }
        } catch (error) {
          console.error(`❌ 处理参考图失败: ${imageData.fileName}`, error)
          processedImages.push(imageData)
        }
      }

      if (toastId && !toastRemoved) {
        toastId.close()
        toastRemoved = true
      }

      if (imagesToCompress.length > 0) {
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
        console.log(`✅ 压缩完成！共压缩 ${imagesToCompress.length} 张图片，耗时 ${totalTime} 秒`)
        this.showToast(this.t('batch.messages.compressionComplete', { count: imagesToCompress.length }), 'success')
      }
    } finally {
      if (toastId && !toastRemoved) {
        try {
          toastId.close()
        } catch (e) {
          console.warn('Toast清理失败:', e)
        }
      }
    }

    return processedImages
  }

  // ==================== Progress Toast ====================

  private showProgressToast(message: string): ProgressToast {
    const progressId = 'batch-upload-progress-' + Date.now()
    const progressElement = document.createElement('div')
    progressElement.id = progressId
    progressElement.className = 'fixed top-20 right-4 bg-orange-500 text-white p-4 rounded-lg shadow-lg z-[10001]'
    progressElement.innerHTML = `
      <div class="flex items-center space-x-3">
        <i class="fas fa-spinner fa-spin"></i>
        <span class="progress-text">${message}</span>
      </div>
    `

    document.body.appendChild(progressElement)

    return {
      update: (newMessage: string) => {
        const textElement = progressElement.querySelector('.progress-text')
        if (textElement) textElement.textContent = newMessage
      },
      close: () => {
        progressElement.remove()
      }
    }
  }

  // ==================== 状态持久化 ====================

  private collectState(): BatchPageState {
    const cardPromptInput = this.getElement<HTMLTextAreaElement>('cardPromptInput')
    const batchPromptsInput = this.getElement<HTMLTextAreaElement>('batchPrompts')
    const cardCountSlider = this.getElement<HTMLInputElement>('cardCount')
    const batchRatioSelect = this.getElement<HTMLSelectElement>('batchRatio')
    const batchResolutionSelect = this.getElement<HTMLSelectElement>('batchResolution')
    const batchConcurrencySelect = this.getElement<HTMLSelectElement>('batchConcurrency')
    const batchCountSelect = this.getElement<HTMLSelectElement>('batchCount')

    return {
      mode: this.currentBatchMode,
      cardPrompt: cardPromptInput?.value || '',
      batchPrompts: batchPromptsInput?.value || '',
      cardCount: cardCountSlider?.value || '5',
      batchRatio: batchRatioSelect?.value || 'auto',
      batchResolution: batchResolutionSelect?.value || '2K',
      batchConcurrency: batchConcurrencySelect?.value || '3',
      batchCount: batchCountSelect?.value || '1',
      batchReferenceImages: this.batchReferenceImages.map((img) => ({
        base64: img.base64,
        fileName: img.fileName,
        fileSize: img.fileSize,
        mimeType: img.mimeType,
        id: img.id,
        width: img.width,
        height: img.height,
        needsCompression: img.needsCompression
      }))
    }
  }

  private applyState(state: BatchPageState): void {
    if (!state) return

    console.log('📥 恢复 BatchPage 状态:', state)

    if (state.mode) {
      this.currentBatchMode = state.mode
      this.switchBatchMode(state.mode)
      const modeRadio = document.querySelector(`input[name="batchMode"][value="${state.mode}"]`) as HTMLInputElement | null
      if (modeRadio) {
        modeRadio.checked = true
      }
    }

    const cardPromptInput = this.getElement<HTMLTextAreaElement>('cardPromptInput')
    if (cardPromptInput && state.cardPrompt) {
      cardPromptInput.value = state.cardPrompt
    }

    const batchPromptsInput = this.getElement<HTMLTextAreaElement>('batchPrompts')
    if (batchPromptsInput && state.batchPrompts) {
      batchPromptsInput.value = state.batchPrompts
    }

    const cardCountSlider = this.getElement<HTMLInputElement>('cardCount')
    if (cardCountSlider && state.cardCount) {
      cardCountSlider.value = state.cardCount
      this.updateCardCostEstimate()
    }

    const batchRatioSelect = this.getElement<HTMLSelectElement>('batchRatio')
    if (batchRatioSelect && state.batchRatio) {
      batchRatioSelect.value = state.batchRatio
    }

    const batchResolutionSelect = this.getElement<HTMLSelectElement>('batchResolution')
    if (batchResolutionSelect && state.batchResolution) {
      batchResolutionSelect.value = state.batchResolution
      this.currentResolution = state.batchResolution
    }

    const batchConcurrencySelect = this.getElement<HTMLSelectElement>('batchConcurrency')
    if (batchConcurrencySelect && state.batchConcurrency) {
      batchConcurrencySelect.value = state.batchConcurrency
    }

    const batchCountSelect = this.getElement<HTMLSelectElement>('batchCount')
    if (batchCountSelect && state.batchCount) {
      batchCountSelect.value = state.batchCount
    }

    if (state.batchReferenceImages && Array.isArray(state.batchReferenceImages)) {
      this.batchReferenceImages = state.batchReferenceImages.filter((img) => img && img.base64)
      this.updateBatchReferenceImagesPreview()
    }

    this.stateRestored = true
  }

  private saveCurrentState(): void {
    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager) {
      const state = this.collectState()
      pageStateManager.saveState('batch', state)
    }
  }

  private saveCurrentStateImmediate(): void {
    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager) {
      const state = this.collectState()
      pageStateManager.saveStateImmediate('batch', state)
    }
  }

  private bindStateAutoSave(): void {
    const cardPromptInput = this.getElement('cardPromptInput')
    if (cardPromptInput) {
      cardPromptInput.addEventListener('input', () => this.saveCurrentState())
    }

    const batchPromptsInput = this.getElement('batchPrompts')
    if (batchPromptsInput) {
      batchPromptsInput.addEventListener('input', () => this.saveCurrentState())
    }

    const cardCountSlider = this.getElement('cardCount')
    if (cardCountSlider) {
      cardCountSlider.addEventListener('input', () => this.saveCurrentState())
    }

    const batchRatioSelect = this.getElement('batchRatio')
    if (batchRatioSelect) {
      batchRatioSelect.addEventListener('change', () => this.saveCurrentState())
    }

    const batchResolutionSelect = this.getElement('batchResolution')
    if (batchResolutionSelect) {
      batchResolutionSelect.addEventListener('change', () => this.saveCurrentState())
    }

    const batchConcurrencySelect = this.getElement('batchConcurrency')
    if (batchConcurrencySelect) {
      batchConcurrencySelect.addEventListener('change', () => this.saveCurrentState())
    }

    const batchCountSelect = this.getElement('batchCount')
    if (batchCountSelect) {
      batchCountSelect.addEventListener('change', () => this.saveCurrentState())
    }
  }

  // ==================== 页面生命周期 ====================

  onActivate(): void {
    console.log('批量生成页面已激活')

    const currentModel = this.getApi()?.getCurrentModel()
    if (currentModel && currentModel.apiType === 'flux-kontext') {
      this.maxReferenceImages = 1
    } else {
      this.maxReferenceImages = 16
    }

    const doRestore = async (): Promise<void> => {
      if (!this.stateRestored) {
        await this.restoreState()
      }

      this.updateBatchReferenceImagesPreview()
      this.updateBatchIntelligentResizeIfNeeded()

      if (this.currentBatchMode === 'card') {
        this.updateCardCostEstimate()
      }

      const batchRatioSelect = this.getElement<HTMLSelectElement>('batchRatio')
      const model = this.getApi()?.getCurrentModel()
      if (batchRatioSelect && model && model.apiType === 'gemini-native' && !this.stateRestored) {
        batchRatioSelect.value = 'auto'
      }

      const batchResults = this.getElement('batchResults')
      if (batchResults && !batchResults.innerHTML.trim()) {
        const emptyText = this.t('batch.labels.emptyResults')
        batchResults.innerHTML = `
          <div class="col-span-full text-center text-white opacity-50 py-8">
            <i class="fas fa-layer-group text-4xl mb-4"></i>
            <p>${emptyText}</p>
          </div>
        `
      }
    }

    this.requestIdleCallback(() => doRestore(), { timeout: 1000 })
  }

  onDeactivate(): void {
    this.saveCurrentStateImmediate()
    console.log('批量生成页面已失活')
  }

  // ==================== Public getters ====================

  getBatchReferenceImages(): BatchReferenceImage[] {
    return this.batchReferenceImages
  }

  getCurrentBatchMode(): BatchMode {
    return this.currentBatchMode
  }

  getCurrentResolution(): string {
    return this.currentResolution
  }
}

// Factory functions
let batchPageInstance: BatchPage | null = null

export function createBatchPage(app: AppInterface): BatchPage {
  batchPageInstance = new BatchPage(app)
  return batchPageInstance
}

export function getBatchPage(): BatchPage | null {
  return batchPageInstance
}

export default BatchPage
