// src/renderer/src/pages/GeneratePage.ts
/**
 * 图片生成页面模块 (TypeScript)
 * @description 处理单张图片生成功能
 */

import { BasePage, type AppInterface } from './BasePage'
import { compressImage } from '../utils/image-compress'

// Types
export interface ReferenceImage {
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

export interface GeneratePageState {
  prompt: string
  ratio: string
  resolution: string
  generateCount: string
  referenceImages: ReferenceImage[]
  lastGeneratedUrls: string[]
}

export interface ProgressToast {
  update: (message: string) => void
  close: () => void
}

export interface GenerateResult {
  success: boolean
  urls: string[]
}

export interface ImageDimensions {
  width: number
  height: number
}

export class GeneratePage extends BasePage {
  private currentRatio: string = 'auto'
  private currentResolution: string = '2K'
  private referenceImages: ReferenceImage[] = []
  private maxReferenceImages: number = 8
  private isProcessingFiles: boolean = false
  private isFileSelectionActive: boolean = false
  private lastGeneratedUrls: string[] = []
  private r2UploadListener: ((event: CustomEvent) => void) | null = null
  private currentUploadId: string | null = null

  constructor(app: AppInterface) {
    super(app)
    this.init()
  }

  init(): void {
    this.bindEvents()
    this.bindResultTabEvents()
    this.bindStateAutoSave()
    this.isInitialized = true
  }

  bindEvents(): void {
    // 图片生成按钮
    const generateBtn = this.getElement('generateBtn')
    if (generateBtn) {
      console.log('[GeneratePage] ✅ 生成按钮已绑定点击事件')
      generateBtn.addEventListener('click', (e) => {
        console.log('[GeneratePage] 🎯 生成按钮被点击')
        e.preventDefault()
        e.stopPropagation()
        this.generateImage()
      })
    } else {
      console.warn('[GeneratePage] ⚠️ 生成按钮未找到: generateBtn')
    }

    // 清空输入按钮
    const clearInputBtn = this.getElement('clearInputBtn')
    if (clearInputBtn) {
      clearInputBtn.addEventListener('click', () => this.clearInput())
    }

    // 比例按钮容器
    const ratioButtonsContainer = this.getElement('ratioButtons')
    if (ratioButtonsContainer) {
      ratioButtonsContainer.addEventListener('click', (e: Event) => {
        const target = e.target as HTMLElement
        const button = target.closest('.ratio-btn') as HTMLElement | null
        if (!button || button.hasAttribute('disabled')) return
        const ratio = button.dataset.ratio
        if (ratio) this.selectRatio(ratio)
      })
    }

    // 分辨率按钮容器
    const resolutionButtonsContainer = this.getElement('resolutionButtons')
    if (resolutionButtonsContainer) {
      resolutionButtonsContainer.addEventListener('click', (e: Event) => {
        const target = e.target as HTMLElement
        const button = target.closest('.ratio-btn') as HTMLElement | null
        if (!button || button.hasAttribute('disabled')) return
        const resolution = button.dataset.resolution
        if (resolution) this.selectResolution(resolution)
      })
    }

    // 参考图上传相关事件
    this.bindReferenceImageEvents()
  }

  saveState(): void {
    this.saveCurrentStateImmediate()
  }

  async restoreState(): Promise<void> {
    if (this.stateRestored) return

    try {
      const pageStateManager = (window as any).pageStateManager
      if (pageStateManager) {
        const savedState = await pageStateManager.loadState('generate')
        if (savedState) {
          this.applyState(savedState as GeneratePageState)
        }
      }
      this.stateRestored = true
    } catch (error) {
      console.error('恢复 GeneratePage 状态失败:', error)
    }
  }

  // ==================== 文件选择和上传 ====================

  private triggerFileSelection(): void {
    if (this.isProcessingFiles) {
      console.log(this.t('generate.messages.processingFile'))
      return
    }

    if (this.isFileSelectionActive) {
      console.log(this.t('generate.messages.fileSelectionActive'))
      return
    }

    this.isFileSelectionActive = true
    console.log('设置文件选择激活标志位')

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.style.display = 'none'

    const inputId = 'dynamic-input-' + Date.now() + '-' + Math.random()
    input.id = inputId

    const cleanup = (): void => {
      this.isFileSelectionActive = false
      console.log('重置文件选择激活标志位')
      if (input.parentNode) {
        input.parentNode.removeChild(input)
        console.log('已清理动态input:', inputId)
      }
    }

    input.addEventListener('change', (e: Event) => {
      console.log('动态input change事件触发:', inputId)
      const target = e.target as HTMLInputElement
      if (target.files && target.files.length > 0 && !this.isProcessingFiles) {
        const files = Array.from(target.files)
        this.handleMultipleReferenceImageUpload(files)
      }
      cleanup()
    })

    input.addEventListener('cancel', () => {
      console.log('用户取消文件选择:', inputId)
      cleanup()
    })

    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (this.isFileSelectionActive) {
          console.log('检测到焦点丢失，可能用户取消了选择:', inputId)
          cleanup()
        }
      }, 100)
    })

    document.body.appendChild(input)
    console.log('创建动态input并触发点击:', inputId)
    input.click()
  }

  private bindReferenceImageEvents(): void {
    const referenceImageArea = this.getElement('referenceImageArea')
    const addMoreReferenceArea = this.getElement('addMoreReferenceArea')

    if (!referenceImageArea) {
      console.error(this.t('generate.errors.pageElementNotFound'))
      return
    }

    const handleUploadAreaClick = (e: Event): void => {
      e.stopPropagation()
      const target = e.target as HTMLElement

      if (target.closest('.remove-reference-btn')) return
      if (target.closest('[data-dynamic-add-button="true"]')) {
        console.log('点击了动态添加更多按钮，跳过主区域处理')
        return
      }
      if (target.closest('.preview-trigger')) {
        // 点击预览触发器，不处理（由 preview handler 处理）
        return
      }
      if (target.closest('.relative.bg-white.bg-opacity-10')) {
        console.log('点击了已上传的图片，已禁用点击上传功能')
        return
      }

      console.log('点击上传区域')
      this.triggerFileSelection()
    }

    referenceImageArea.addEventListener('click', handleUploadAreaClick)
    this.bindPasteEvents()

    if (addMoreReferenceArea) {
      addMoreReferenceArea.addEventListener('click', (e: Event) => {
        e.stopPropagation()
        console.log('点击添加更多参考图区域')

        if (this.referenceImages.length < this.maxReferenceImages) {
          this.triggerFileSelection()
        } else {
          const currentModel = this.getApi()?.getCurrentModel()
          if (currentModel && currentModel.apiType === 'flux-kontext') {
            this.showToast(this.t('generate.messages.fluxModelLimitInfo'), 'info')
          } else {
            this.showToast(this.t('generate.messages.reachedMaxImages', { max: this.maxReferenceImages }), 'warning')
          }
        }
      })
    }
  }

  private bindPasteEvents(): void {
    const referenceImageArea = this.getElement('referenceImageArea')
    if (!referenceImageArea) return

    referenceImageArea.setAttribute('tabindex', '0')
    referenceImageArea.setAttribute('role', 'button')
    referenceImageArea.setAttribute('aria-label', this.t('generate.labels.uploadPrompt'))

    referenceImageArea.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        this.triggerFileSelection()
      }
    })

    referenceImageArea.addEventListener('dragenter', (e: DragEvent) => {
      e.preventDefault()
      referenceImageArea.classList.add('border-opacity-70', 'bg-white', 'bg-opacity-5')
    })

    referenceImageArea.addEventListener('dragleave', (e: DragEvent) => {
      e.preventDefault()
      referenceImageArea.classList.remove('border-opacity-70', 'bg-white', 'bg-opacity-5')
    })

    referenceImageArea.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault()
    })

    referenceImageArea.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault()
      referenceImageArea.classList.remove('border-opacity-70', 'bg-white', 'bg-opacity-5')

      const files = Array.from(e.dataTransfer?.files || [])
      if (files.length > 0) {
        this.handleMultipleReferenceImageUpload(files)
      }
    })
  }

  // ==================== 图片处理 ====================

  async handlePasteEvent(e: ClipboardEvent): Promise<void> {
    const clipboardItems = e.clipboardData?.items
    if (!clipboardItems) return

    console.log('检测到粘贴事件，剪贴板项目数量:', clipboardItems.length)

    const imageFiles: File[] = []

    for (let i = 0; i < clipboardItems.length; i++) {
      const item = clipboardItems[i]
      console.log('剪贴板项目类型:', item.type)

      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }

    if (imageFiles.length === 0) {
      this.showToast(this.t('generate.messages.noImageInClipboard'), 'warning')
      return
    }

    if (this.referenceImages.length >= this.maxReferenceImages) {
      const currentModel = this.getApi()?.getCurrentModel()
      if (currentModel && currentModel.apiType === 'flux-kontext') {
        this.showToast(this.t('generate.messages.fluxModelLimitInfo'), 'info')
      } else {
        this.showToast(this.t('generate.messages.reachedMaxImages', { max: this.maxReferenceImages }), 'warning')
      }
      return
    }

    console.log('从剪贴板获取到图片数量:', imageFiles.length)
    e.preventDefault()

    try {
      await this.handleMultipleReferenceImageUpload(imageFiles)
      this.showToast(this.t('generate.messages.pastedImagesSuccess', { count: imageFiles.length }), 'success')
    } catch (error) {
      console.error('处理粘贴图片时出错:', error)
      this.showToast(this.t('generate.messages.pasteError'), 'error')
    }
  }

  private async handleMultipleReferenceImageUpload(files: File[]): Promise<void> {
    // 动态调整最大图片数量
    const currentModel = this.getApi()?.getCurrentModel()
    if (currentModel && currentModel.apiType === 'flux-kontext') {
      this.maxReferenceImages = 1
    } else {
      this.maxReferenceImages = 8
    }

    const uploadId = Date.now() + '-' + Math.random().toString(36).substr(2, 9)
    console.log(`🔄 开始图片上传任务: ${uploadId}, 文件数量: ${files.length}`)

    if (this.isProcessingFiles) {
      console.log(`⏭️ ${this.t('generate.messages.skipDuplicateUpload')}: ${uploadId}`)
      return
    }

    this.isProcessingFiles = true
    this.currentUploadId = uploadId

    try {
      const startTime = Date.now()
      const validFiles: File[] = []

      for (const file of files) {
        try {
          this.validateImageFile(file)

          const isDuplicate = this.referenceImages.some(
            (img) => img.fileName === file.name && Math.abs(img.fileSize - file.size) < 1024
          )

          if (isDuplicate) {
            this.showToast(this.t('generate.messages.fileDuplicate', { filename: file.name }), 'warning')
            continue
          }

          if (this.referenceImages.length + validFiles.length >= this.maxReferenceImages) {
            if (validFiles.length === 0) {
              if (currentModel && currentModel.apiType === 'flux-kontext') {
                throw new Error(this.t('generate.messages.fluxModelLimitInfo'))
              } else {
                throw new Error(this.t('generate.messages.reachedMaxImages', { max: this.maxReferenceImages }))
              }
            }

            if (currentModel && currentModel.apiType === 'flux-kontext') {
              this.showToast(this.t('generate.messages.fluxModelLimitInfo'), 'info')
            } else {
              this.showToast(this.t('generate.messages.uploadLimitReached', { max: this.maxReferenceImages }), 'warning')
            }
            break
          }

          validFiles.push(file)
        } catch (error: any) {
          this.showToast(error.message, 'error')
        }
      }

      if (validFiles.length === 0) return

      const progressToast = this.showProgressToast(`${this.t('generate.messages.processingFile')} ${validFiles.length} 张图片...`)

      const concurrencyLimit = Math.min(this.uploadConfig.maxConcurrency, validFiles.length)
      console.log(`🚀 并发处理配置: ${concurrencyLimit}个文件同时处理`)
      const results: ReferenceImage[] = []

      for (let i = 0; i < validFiles.length; i += concurrencyLimit) {
        const batch = validFiles.slice(i, i + concurrencyLimit)
        const batchPromises = batch.map(async (file) => {
          try {
            if (this.currentUploadId !== uploadId) {
              throw new Error(this.t('generate.messages.uploadCancelled'))
            }

            const base64 = await this.fileToBase64Enhanced(file)
            const dimensions = await this.getImageDimensions(file)

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
            } as ReferenceImage
          } catch (error: any) {
            console.error(`❌ 处理文件 ${file.name} 失败:`, error)
            this.showToast(`${file.name} 处理失败: ${error.message}`, 'error')
            return null
          }
        })

        const batchResults = await Promise.allSettled(batchPromises)
        const successResults = batchResults
          .filter((result): result is PromiseFulfilledResult<ReferenceImage | null> =>
            result.status === 'fulfilled' && result.value !== null
          )
          .map((result) => result.value as ReferenceImage)

        results.push(...successResults)

        const processed = Math.min(i + concurrencyLimit, validFiles.length)
        progressToast.update(`已处理 ${processed} / ${validFiles.length} 张图片 (并发:${Math.min(concurrencyLimit, validFiles.length - i)})`)
      }

      this.referenceImages.push(...results)
      this.updateReferenceImagesPreview()
      progressToast.close()

      const processTime = ((Date.now() - startTime) / 1000).toFixed(1)
      const successCount = results.length

      if (successCount > 0) {
        const message =
          successCount === 1
            ? this.t('generate.messages.uploadSuccess', { time: processTime })
            : this.t('generate.messages.uploadSuccessMultiple', { count: successCount, time: processTime })
        this.showToast(message, 'success')
      }

      console.log(`✅ 上传任务完成: ${uploadId}, 成功: ${successCount}/${validFiles.length}, 耗时: ${processTime}秒`)
    } catch (error: any) {
      console.error(`❌ 上传任务失败: ${uploadId}`, error)
      this.showToast(this.t('generate.messages.uploadFailed', { error: error.message }), 'error')
    } finally {
      this.isProcessingFiles = false
      this.currentUploadId = null
    }
  }

  private validateImageFile(file: File): void {
    const maxSize = 20 * 1024 * 1024 // 20MB
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

    if (!allowedTypes.includes(file.type.toLowerCase())) {
      throw new Error(this.t('generate.errors.invalidFileType'))
    }

    if (file.size > maxSize) {
      throw new Error(this.t('generate.errors.fileTooLarge', { size: (maxSize / 1024 / 1024).toFixed(0) }))
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
                throw new Error(this.t('generate.errors.invalidFileReaderResult'))
              }

              const base64 = result.split(',')[1]
              if (!base64 || base64.length < 100) {
                throw new Error(this.t('generate.messages.invalidBase64'))
              }

              if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
                throw new Error(this.t('generate.messages.base64ValidationFailed'))
              }

              resolve(base64)
            } catch (error) {
              reject(error)
            }
          }

          reader.onerror = () => {
            reject(new Error(this.t('generate.errors.readerErrorMessage', { error: reader.error?.message || '未知错误' })))
          }

          reader.onabort = () => {
            reject(new Error(this.t('generate.messages.fileReadAborted')))
          }

          setTimeout(() => {
            reader.abort()
            reject(new Error(this.t('generate.messages.fileReadTimeout')))
          }, this.uploadConfig.timeout)

          reader.readAsDataURL(file)
        })

        console.log(`✅ 文件 ${file.name} Base64转换成功 (第${attempt}次尝试)`)
        return base64
      } catch (error: any) {
        console.warn(`⚠️ 文件 ${file.name} Base64转换失败 (第${attempt}/${maxRetries}次): ${error.message}`)

        if (attempt === maxRetries) {
          throw new Error(this.t('generate.messages.conversionFailed', { retries: maxRetries, error: error.message }))
        }

        await this.delay(retryDelay * attempt)
      }
    }

    throw new Error('Unexpected error in fileToBase64Enhanced')
  }

  private async getImageDimensions(file: File): Promise<ImageDimensions> {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        resolve({ width: img.width, height: img.height })
        URL.revokeObjectURL(img.src)
      }
      img.onerror = () => {
        resolve({ width: 0, height: 0 })
        URL.revokeObjectURL(img.src)
      }
      img.src = URL.createObjectURL(file)
    })
  }

  // ==================== 比例和分辨率选择 ====================

  selectRatio(ratio: string): void {
    const ratioButtons = document.querySelectorAll('#ratioButtons .ratio-btn')
    ratioButtons.forEach((btn) => {
      btn.classList.remove('active')
      if ((btn as HTMLElement).dataset.ratio === ratio) {
        btn.classList.add('active')
      }
    })
    this.currentRatio = ratio
    this.updateFinalResolutionDisplay()
    this.saveCurrentState()
  }

  selectResolution(resolution: string): void {
    const resolutionButtons = document.querySelectorAll('#resolutionButtons .ratio-btn')
    resolutionButtons.forEach((btn) => {
      btn.classList.remove('active')
      if ((btn as HTMLElement).dataset.resolution === resolution) {
        btn.classList.add('active')
      }
    })
    this.currentResolution = resolution

    try {
      localStorage.setItem('gemini_resolution', resolution)
    } catch (error) {
      console.error('保存分辨率设置失败:', error)
    }

    this.updateFinalResolutionDisplay()
    this.saveCurrentState()
  }

  private updateFinalResolutionDisplay(): void {
    const currentModel = this.getApi()?.getCurrentModel()
    if (!currentModel?.capabilities?.resolutionControl || !currentModel.resolutionMap) return

    const displayElement = this.getElement('finalResolutionDisplay')
    const valueElement = this.getElement('finalResolutionValue')
    if (!displayElement || !valueElement) return

    const actualResolution = currentModel.resolutionMap[this.currentRatio]?.[this.currentResolution]
    if (actualResolution) {
      valueElement.textContent = actualResolution
      displayElement.classList.remove('hidden')
    } else {
      displayElement.classList.add('hidden')
    }
  }

  // ==================== 图片生成 ====================

  async generateImage(): Promise<void> {
    const promptInput = this.getElement<HTMLTextAreaElement>('promptInput')
    const prompt = promptInput?.value.trim() || ''

    if (!prompt) {
      this.showToast(this.t('generate.messages.promptRequired'), 'error')
      return
    }

    const api = this.getApi()
    if (!api?.apiKey) {
      this.showToast(this.t('generate.messages.apiKeyNotSet'), 'error')
      this.app?.switchTab?.('settings', true)
      return
    }

    const generateCountSelect = this.getElement<HTMLSelectElement>('generateCount')
    const generateCount = parseInt(generateCountSelect?.value || '1') || 1

    const generateBtn = this.getElement<HTMLButtonElement>('generateBtn')
    const imageResult = this.getElement('imageResult')
    const loadingProgress = this.getElement('loadingProgress')
    const progressBar = this.getElement('progressBar')
    const progressText = this.getElement('progressText')

    if (!generateBtn) {
      console.error('生成按钮不存在')
      this.showToast(this.t('generate.messages.pageLoadIncomplete'), 'error')
      return
    }

    generateBtn.disabled = true
    generateBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>${this.t('generate.buttons.generating')}`

    if (loadingProgress) loadingProgress.classList.remove('hidden')

    const progressInterval = this.simulateProgress(progressBar, progressText)

    try {
      let result: GenerateResult

      const currentModel = api.getCurrentModel()
      const supportsResolution = currentModel?.capabilities?.resolutionControl
      const resolution = supportsResolution ? this.currentResolution : null

      if (resolution && supportsResolution) {
        let timeEstimate = ''
        if (resolution === '4K') {
          timeEstimate = this.t('generate.messages.estimatedTime4K')
        } else if (resolution === '2K') {
          timeEstimate = this.t('generate.messages.estimatedTime2K')
        } else if (resolution === '1K') {
          timeEstimate = this.t('generate.messages.estimatedTime1K')
        }

        if (timeEstimate && progressText) {
          console.log(`[生成提示] ${resolution} 分辨率图片生成，${timeEstimate}`)
          progressText.textContent = this.t('generate.messages.generatingWithEstimate', { estimate: timeEstimate })
        }
      }

      if (this.referenceImages.length > 0) {
        const preparedImages = await this.prepareReferenceImagesForGeneration()
        result = await api.generateImageWithReference(prompt, preparedImages, this.currentRatio, generateCount, resolution)
      } else {
        result = await api.generateImage(prompt, this.currentRatio, generateCount, resolution)
      }

      if (result.success && result.images && result.images.length > 0) {
        this.displayGeneratedImages(result.images, imageResult)

        const historyType = this.referenceImages.length > 0 ? 'generate-with-reference' : 'generate'
        this.app.addToHistory(historyType, prompt, result.images, this.currentRatio)

        const successMessage =
          this.referenceImages.length > 0
            ? this.t('generate.messages.generateWithReferenceSuccess', { count: this.referenceImages.length })
            : this.t('generate.messages.generateSuccess')
        this.showToast(successMessage, 'success')
      } else {
        throw new Error(this.t('generate.messages.invalidResult'))
      }
    } catch (error: any) {
      if ((window as any).errorHandlerTS) {
        ;(window as any).errorHandlerTS.showDetailedError(error, this.t('generate.messages.generateError'))
      } else {
        this.showToast(error.message || this.t('generate.messages.generateError'), 'error')
      }

      if (imageResult) {
        this.showErrorResult(imageResult, error)
      }
    } finally {
      if (progressInterval) clearInterval(progressInterval)

      if (generateBtn) {
        generateBtn.disabled = false
        generateBtn.innerHTML = `<i class="fas fa-magic mr-2"></i>${this.t('generate.buttons.generateButton')}`
      }

      if (loadingProgress) loadingProgress.classList.add('hidden')
      if (progressBar) (progressBar as HTMLElement).style.width = '0%'
      if (progressText) progressText.textContent = this.t('generate.messages.generatingProgress')
    }
  }

  private async prepareReferenceImagesForGeneration(): Promise<ReferenceImage[]> {
    if (this.referenceImages.length === 0) return []

    const processedImages: ReferenceImage[] = []
    const imagesToCompress = this.referenceImages.filter((img) => img.needsCompression)

    console.log(`🖼️ 准备参考图片用于生成...`)
    console.log(`📊 需要压缩的图片: ${imagesToCompress.length}/${this.referenceImages.length}`)

    for (const imageData of this.referenceImages) {
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

    return processedImages
  }

  private async compressImageIfNeeded(file: File): Promise<File> {
    try {
      return await compressImage(file)
    } catch (error: any) {
      console.error('图片压缩失败:', error)
      this.showToast(this.t('generate.messages.compressionFailed', { error: error.message }), 'warning')
      return file
    }
  }

  // ==================== UI 更新 ====================

  private updateReferenceImagesPreview(): void {
    const currentModel = this.getApi()?.getCurrentModel()
    if (currentModel && currentModel.apiType === 'flux-kontext') {
      this.maxReferenceImages = 1
    } else {
      this.maxReferenceImages = 8
    }

    console.log('updateReferenceImagesPreview 开始执行，参考图数量:', this.referenceImages.length, '最大限制:', this.maxReferenceImages)

    const uploadPrompt = this.getElement('referenceUploadPrompt')
    const preview = this.getElement('referenceImagesPreview')
    const imagesList = this.getElement('referenceImagesList')

    if (this.referenceImages.length === 0) {
      if (uploadPrompt) uploadPrompt.classList.remove('hidden')
      if (preview) preview.classList.add('hidden')
      console.log('参考图为空，显示上传提示')
      return
    }

    if (uploadPrompt) uploadPrompt.classList.add('hidden')
    if (preview) preview.classList.remove('hidden')

    if (imagesList) {
      imagesList.innerHTML = ''

      this.referenceImages.forEach((imageData, index) => {
        const imageItem = document.createElement('div')
        imageItem.className = 'relative bg-white bg-opacity-10 rounded-lg p-2 group'
        const mimeType = (imageData.mimeType || 'image/jpeg').toLowerCase()
        const imageUrl = `data:${mimeType};base64,${imageData.base64}`
        imageItem.innerHTML = `
          <div class="relative">
            <div class="preview-trigger cursor-pointer relative group/img" data-preview-index="${index}">
              <img src="${imageUrl}"
                   class="w-full aspect-square object-cover rounded-lg transition-transform duration-300 group-hover/img:scale-105"
                   alt="${this.t('generate.labels.referenceImageLabel', { index: index + 1 })}">
              <div class="absolute inset-0 bg-black/0 group-hover/img:bg-black/40 transition-all duration-300 rounded-lg flex items-center justify-center">
                <i class="fas fa-search-plus text-white text-lg opacity-0 group-hover/img:opacity-100 transition-opacity duration-300"></i>
              </div>
            </div>
            ${imageData.needsCompression ? `
              <div class="absolute top-1 left-1 bg-orange-500 bg-opacity-90 text-white text-xs px-2 py-0.5 rounded flex items-center space-x-1 pointer-events-none">
                <i class="fas fa-compress-alt"></i>
                <span>${(imageData.fileSize / (1024 * 1024)).toFixed(1)}MB</span>
              </div>
            ` : ''}
            <button class="remove-reference-btn absolute -top-1 -right-1 bg-red-500 hover:bg-red-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs transition-colors opacity-0 group-hover:opacity-100"
                    title="移除此参考图"
                    data-image-id="${imageData.id}">
              <i class="fas fa-times text-xs"></i>
            </button>
          </div>
        `
        imagesList.appendChild(imageItem)
      })

      // 添加"添加更多"按钮
      if (this.referenceImages.length < this.maxReferenceImages) {
        const addButton = document.createElement('div')
        addButton.className = 'border-2 border-dashed border-white border-opacity-30 hover:border-opacity-50 rounded-lg p-2 cursor-pointer transition-all flex items-center justify-center aspect-square group'
        addButton.setAttribute('data-dynamic-add-button', 'true')
        addButton.innerHTML = `
          <div class="text-center">
            <i class="fas fa-plus text-white opacity-50 group-hover:opacity-70 text-xl mb-1"></i>
            <p class="text-white opacity-50 group-hover:opacity-70 text-xs">${this.t('generate.labels.addMoreReferences')}</p>
            <p class="text-white opacity-30 group-hover:opacity-50 text-xs">${this.referenceImages.length}/${this.maxReferenceImages}</p>
          </div>
        `
        addButton.addEventListener('click', (e) => {
          e.stopPropagation()
          console.log('点击动态添加更多按钮')
          this.triggerFileSelection()
        })
        imagesList.appendChild(addButton)
      }

      // 绑定移除按钮事件
      const removeButtons = imagesList.querySelectorAll('.remove-reference-btn')
      removeButtons.forEach((btn) => {
        btn.addEventListener('click', (e: Event) => {
          e.stopPropagation()
          const target = (e.target as HTMLElement).closest('.remove-reference-btn') as HTMLElement
          const imageId = parseFloat(target?.dataset.imageId || '0')
          this.removeReferenceImage(imageId)
        })
      })

      // 绑定图片预览事件
      const previewTriggers = imagesList.querySelectorAll('.preview-trigger')
      previewTriggers.forEach((trigger) => {
        trigger.addEventListener('click', (e: Event) => {
          e.stopPropagation()
          const target = (e.target as HTMLElement).closest('.preview-trigger') as HTMLElement
          const previewIndex = parseInt(target?.dataset.previewIndex || '0', 10)
          this.previewReferenceImage(previewIndex)
        })
      })
    }

    this.updateIntelligentResizeIfNeeded()
    this.saveCurrentState()

    console.log('updateReferenceImagesPreview 执行完成')
  }

  private updateIntelligentResizeIfNeeded(): void {
    const currentModel = this.getApi()?.getCurrentModel()
    const capabilities = currentModel?.capabilities || {}

    console.log('🔍 检查是否需要更新智能尺寸 - 模型:', currentModel?.name, '智能尺寸:', capabilities.intelligentResize)

    if (capabilities.intelligentResize && this.app) {
      console.log('✅ 需要更新智能尺寸，开始执行...')
      setTimeout(() => {
        ;(this.app as any).updateIntelligentResizeUI?.()
      }, 100)
    }
  }

  private removeReferenceImage(imageId: number): void {
    const index = this.referenceImages.findIndex((img) => img.id === imageId)
    if (index > -1) {
      const removedImage = this.referenceImages.splice(index, 1)[0]
      this.updateReferenceImagesPreview()
      this.showToast(this.t('generate.messages.referenceImageRemoved', { filename: removedImage.fileName }), 'info')
    }
  }

  private previewReferenceImage(index: number): void {
    if (index < 0 || index >= this.referenceImages.length) return
    
    // 构建所有参考图的 URL 数组
    const urls = this.referenceImages.map((img) => {
      const mimeType = (img.mimeType || 'image/jpeg').toLowerCase()
      return `data:${mimeType};base64,${img.base64}`
    })
    
    // 使用 ImageViewer 预览
    const imageViewer = (window as any).imageViewerTS
    if (imageViewer?.view) {
      imageViewer.view(urls, index)
    } else if ((this.app as any).viewImage) {
      ;(this.app as any).viewImage(urls, index)
    }
  }

  clearAllReferenceImages(): void {
    this.referenceImages = []
    this.updateReferenceImagesPreview()
  }

  clearInput(): void {
    const promptInput = this.getElement<HTMLTextAreaElement>('promptInput')
    if (promptInput) {
      promptInput.value = ''
      promptInput.focus()
      this.showToast(this.t('generate.messages.inputCleared'), 'success')
    }
  }

  // ==================== 结果显示 ====================

  private displayGeneratedImages(urls: string[], container: HTMLElement | null): void {
    if (!container) return

    this.lastGeneratedUrls = urls
    this.setupR2UploadListener()

    const resultTabs = this.getElement('resultTabs')
    if (resultTabs) resultTabs.classList.remove('hidden')

    this.showResultTab('result')
    container.innerHTML = ''

    if (urls.length === 1) {
      const imageContainer = document.createElement('div')
      imageContainer.className = 'relative group result-item'
      imageContainer.style.zIndex = '1'

      const img = document.createElement('img')
      img.src = urls[0]
      img.className = 'w-full h-auto rounded-lg shadow-lg'
      img.alt = '生成的图片'

      const uploadIndicator = document.createElement('div')
      uploadIndicator.className = 'upload-indicator uploading absolute top-2 right-2 bg-black bg-opacity-50 rounded-full p-2 text-white'
      uploadIndicator.innerHTML = '<i class="fas fa-cloud-upload-alt fa-spin"></i>'
      uploadIndicator.title = this.t('generate.labels.uploadIndicatorTooltip')

      const overlay = document.createElement('div')
      overlay.className = 'absolute inset-0 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-2'

      const downloadBtn = document.createElement('button')
      downloadBtn.className = 'bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all'
      downloadBtn.innerHTML = '<i class="fas fa-download"></i>'
      downloadBtn.onclick = () => (this.app as any).downloadImage?.(urls[0])

      const viewBtn = document.createElement('button')
      viewBtn.className = 'bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all'
      viewBtn.innerHTML = '<i class="fas fa-expand"></i>'
      viewBtn.onclick = () => (window as any).imageViewerTS?.view?.(urls, 0) || (this.app as any).viewImage?.(urls, 0)

      overlay.appendChild(downloadBtn)
      overlay.appendChild(viewBtn)

      imageContainer.appendChild(img)
      imageContainer.appendChild(uploadIndicator)
      imageContainer.appendChild(overlay)
      container.appendChild(imageContainer)
    } else {
      const gridContainer = document.createElement('div')
      gridContainer.className = 'grid grid-cols-2 gap-3'

      urls.forEach((url, index) => {
        const imageContainer = document.createElement('div')
        imageContainer.className = 'relative group bg-white bg-opacity-5 rounded-lg p-2 result-item'
        imageContainer.style.zIndex = '1'

        const img = document.createElement('img')
        img.src = url
        img.className = 'w-full h-40 object-cover rounded-lg shadow-lg'
        img.alt = `生成的图片 ${index + 1}`

        const uploadIndicator = document.createElement('div')
        uploadIndicator.className = 'upload-indicator uploading absolute top-3 right-3 bg-black bg-opacity-50 rounded-full p-1.5 text-white text-xs'
        uploadIndicator.innerHTML = '<i class="fas fa-cloud-upload-alt fa-spin"></i>'
        uploadIndicator.title = this.t('generate.labels.uploadIndicatorTooltip')

        const overlay = document.createElement('div')
        overlay.className = 'absolute inset-2 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-2 rounded-lg'

        const downloadBtn = document.createElement('button')
        downloadBtn.className = 'bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all'
        downloadBtn.innerHTML = '<i class="fas fa-download"></i>'
        downloadBtn.onclick = () => (this.app as any).downloadImage?.(url)

        const viewBtn = document.createElement('button')
        viewBtn.className = 'bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all'
        viewBtn.innerHTML = '<i class="fas fa-expand"></i>'
        viewBtn.onclick = () => (window as any).imageViewerTS?.view?.(urls, index) || (this.app as any).viewImage?.(urls, index)

        overlay.appendChild(downloadBtn)
        overlay.appendChild(viewBtn)

        imageContainer.appendChild(img)
        imageContainer.appendChild(uploadIndicator)
        imageContainer.appendChild(overlay)
        gridContainer.appendChild(imageContainer)
      })

      container.appendChild(gridContainer)
    }
  }

  private showErrorResult(container: HTMLElement, error: any): void {
    const api = this.getApi()
    const errorInfo = api?.formatDetailedError?.(error) || {
      title: this.t('generate.messages.generateError'),
      message: error.message || 'Unknown error',
      details: []
    }

    container.innerHTML = `
      <div class="text-center text-white">
        <div class="bg-red-500 bg-opacity-20 rounded-lg p-6 border border-red-400 border-opacity-30">
          <div class="bg-red-500 bg-opacity-30 rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4">
            <i class="fas fa-exclamation-triangle text-2xl text-red-200"></i>
          </div>
          <h3 class="text-lg font-semibold text-red-200 mb-2">${errorInfo.title}</h3>
          <p class="text-red-300 text-sm mb-4 opacity-90">${errorInfo.message}</p>
          <button onclick="window.generatePageTS?.generateImage()" class="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg text-sm transition-colors">
            <i class="fas fa-redo mr-1"></i>${this.t('generate.buttons.retryGenerate')}
          </button>
        </div>
      </div>
    `
  }

  private simulateProgress(progressBar: HTMLElement | null, progressText: HTMLElement | null): number | null {
    if (!progressBar || !progressText) return null

    let progress = 0
    let stage = 0
    const stages = [
      this.t('generate.messages.connectingServer'),
      this.t('generate.messages.analyzingPrompt'),
      this.t('generate.messages.startGenerating'),
      this.t('generate.messages.creatingArt'),
      this.t('generate.messages.generatingInProgress'),
      this.t('generate.messages.optimizingQuality'),
      this.t('generate.messages.almostComplete')
    ]

    const interval = window.setInterval(() => {
      if (progress < 30) {
        progress += Math.random() * 8 + 2
      } else if (progress < 70) {
        progress += Math.random() * 2 + 0.5
      } else if (progress < 90) {
        progress += Math.random() * 0.5 + 0.1
      }

      if (progress > 95) progress = 95

      progressBar.style.width = `${progress}%`

      const newStage = Math.floor((progress / 100) * stages.length)
      if (newStage !== stage && newStage < stages.length) {
        stage = newStage
        progressText.textContent = stages[stage]
      }
    }, 1000)

    setTimeout(() => clearInterval(interval), 300000)

    return interval
  }

  // ==================== Result Tabs ====================

  private bindResultTabEvents(): void {
    const resultTab = this.getElement('resultTab')
    const originalTab = this.getElement('originalTab')
    const compareTab = this.getElement('compareTab')

    if (resultTab) resultTab.addEventListener('click', () => this.showResultTab('result'))
    if (originalTab) originalTab.addEventListener('click', () => this.showResultTab('original'))
    if (compareTab) compareTab.addEventListener('click', () => this.showResultTab('compare'))
  }

  private showResultTab(tabType: 'result' | 'original' | 'compare'): void {
    document.querySelectorAll('.tab-result-btn').forEach((btn) => btn.classList.remove('active'))

    const imageResult = this.getElement('imageResult')
    const originalImages = this.getElement('originalImages')
    const compareView = this.getElement('compareView')

    if (imageResult) imageResult.classList.add('hidden')
    if (originalImages) originalImages.classList.add('hidden')
    if (compareView) compareView.classList.add('hidden')

    switch (tabType) {
      case 'result':
        this.getElement('resultTab')?.classList.add('active')
        if (imageResult) imageResult.classList.remove('hidden')
        break
      case 'original':
        this.getElement('originalTab')?.classList.add('active')
        if (originalImages) originalImages.classList.remove('hidden')
        this.updateOriginalImagesDisplay()
        break
      case 'compare':
        this.getElement('compareTab')?.classList.add('active')
        if (compareView) compareView.classList.remove('hidden')
        this.updateCompareView()
        break
    }
  }

  private updateOriginalImagesDisplay(): void {
    const originalImagesContent = this.getElement('originalImagesContent')
    if (!originalImagesContent) return

    originalImagesContent.innerHTML = ''

    if (this.referenceImages.length === 0) {
      originalImagesContent.innerHTML = `
        <div class="text-center text-white opacity-50 py-8">
          <i class="fas fa-image text-3xl mb-3"></i>
          <p>${this.t('generate.messages.noReferencesUploaded')}</p>
        </div>
      `
      return
    }

    this.referenceImages.forEach((imageData, index) => {
      const imageDiv = document.createElement('div')
      imageDiv.className = 'relative group bg-white bg-opacity-5 rounded-lg p-2'
      const mimeType = (imageData.mimeType || 'image/jpeg').toLowerCase()
      imageDiv.innerHTML = `
        <img src="data:${mimeType};base64,${imageData.base64}"
             class="w-full h-auto rounded-lg"
             alt="${this.t('generate.labels.referenceImageLabel', { index: index + 1 })}">
        <div class="absolute top-2 left-2 bg-black bg-opacity-70 text-white text-xs px-2 py-1 rounded">
          ${this.t('generate.labels.referenceImageLabel', { index: index + 1 })}
        </div>
      `
      originalImagesContent.appendChild(imageDiv)
    })
  }

  private updateCompareView(): void {
    const beforeImages = this.getElement('beforeImages')
    const afterImages = this.getElement('afterImages')

    if (!beforeImages || !afterImages) return

    beforeImages.innerHTML = ''
    afterImages.innerHTML = ''

    if (this.referenceImages.length === 0) {
      beforeImages.innerHTML = `
        <div class="text-center text-white opacity-50 py-4">
          <i class="fas fa-image text-2xl mb-2"></i>
          <p class="text-sm">${this.t('generate.messages.noReferencesUploaded')}</p>
        </div>
      `
    } else {
      this.referenceImages.forEach((imageData, index) => {
        const imageDiv = document.createElement('div')
        imageDiv.className = 'relative bg-white bg-opacity-5 rounded-lg p-1'
        const mimeType = (imageData.mimeType || 'image/jpeg').toLowerCase()
        imageDiv.innerHTML = `
          <img src="data:${mimeType};base64,${imageData.base64}"
               class="w-full h-32 object-cover rounded-lg"
               alt="${this.t('generate.labels.referenceImageLabel', { index: index + 1 })}">
          <div class="absolute top-1 left-1 bg-black bg-opacity-70 text-white text-xs px-1 py-0.5 rounded">
            ${this.t('generate.labels.referenceImageLabel', { index: index + 1 })}
          </div>
        `
        beforeImages.appendChild(imageDiv)
      })
    }

    if (this.lastGeneratedUrls && this.lastGeneratedUrls.length > 0) {
      this.lastGeneratedUrls.forEach((url, index) => {
        const imageDiv = document.createElement('div')
        imageDiv.className = 'relative group bg-white bg-opacity-5 rounded-lg p-1'
        imageDiv.innerHTML = `
          <img src="${url}"
               class="w-full h-32 object-cover rounded-lg"
               alt="${this.t('generate.labels.generateResultLabel', { index: index + 1 })}">
          <div class="absolute top-1 left-1 bg-black bg-opacity-70 text-white text-xs px-1 py-0.5 rounded">
            ${this.t('generate.labels.generateResultLabel', { index: index + 1 })}
          </div>
        `
        afterImages.appendChild(imageDiv)
      })
    } else {
      afterImages.innerHTML = `
        <div class="text-center text-white opacity-50 py-4">
          <i class="fas fa-image text-2xl mb-2"></i>
          <p class="text-sm">${this.t('generate.messages.noGeneratedImages')}</p>
        </div>
      `
    }
  }

  // ==================== R2 Upload ====================

  private setupR2UploadListener(): void {
    if (this.r2UploadListener) {
      window.removeEventListener('r2UploadComplete', this.r2UploadListener as EventListener)
    }

    this.r2UploadListener = (event: CustomEvent) => {
      const { originalUrls, r2Urls } = event.detail
      this.updateImageUploadStatus(originalUrls, r2Urls)
    }

    window.addEventListener('r2UploadComplete', this.r2UploadListener as EventListener)
  }

  private updateImageUploadStatus(originalUrls: string[], r2Urls: string[]): void {
    const resultImages = document.querySelectorAll('#imageResult .result-item img')

    resultImages.forEach((img: Element) => {
      const imgSrc = (img as HTMLImageElement).src

      const index = originalUrls.findIndex((url: string) => {
        if (imgSrc.startsWith('data:') && url.startsWith('data:')) {
          return imgSrc === url
        } else if (!imgSrc.startsWith('data:') && !url.startsWith('data:')) {
          return imgSrc === url
        }
        return false
      })

      if (index !== -1 && r2Urls[index]) {
        const resultItem = img.closest('.result-item')
        if (resultItem) {
          const uploadIndicator = resultItem.querySelector('.upload-indicator')
          if (uploadIndicator) {
            uploadIndicator.classList.remove('uploading')
            uploadIndicator.classList.add('uploaded')
            uploadIndicator.innerHTML = '<i class="fas fa-cloud-check"></i>'
            ;(uploadIndicator as HTMLElement).title = this.t('generate.labels.uploadCompleteTooltip')
          }
          ;(img as HTMLElement).dataset.r2Url = r2Urls[index]
        }
      }
    })
  }

  // ==================== Progress Toast ====================

  private showProgressToast(message: string): ProgressToast {
    const progressId = 'upload-progress-' + Date.now()
    const progressElement = document.createElement('div')
    progressElement.id = progressId
    progressElement.className = 'fixed top-20 right-4 bg-blue-500 text-white p-4 rounded-lg shadow-lg z-[10001]'
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

  private collectState(): GeneratePageState {
    const promptInput = this.getElement<HTMLTextAreaElement>('promptInput')
    const generateCountSelect = this.getElement<HTMLSelectElement>('generateCount')

    return {
      prompt: promptInput?.value || '',
      ratio: this.currentRatio,
      resolution: this.currentResolution,
      generateCount: generateCountSelect?.value || '1',
      referenceImages: this.referenceImages.map((img) => ({
        base64: img.base64,
        fileName: img.fileName,
        fileSize: img.fileSize,
        mimeType: img.mimeType,
        id: img.id,
        width: img.width,
        height: img.height,
        needsCompression: img.needsCompression
      })),
      lastGeneratedUrls: this.lastGeneratedUrls
    }
  }

  private applyState(state: GeneratePageState): void {
    if (!state) return

    console.log('📥 恢复 GeneratePage 状态:', state)

    const promptInput = this.getElement<HTMLTextAreaElement>('promptInput')
    if (promptInput && state.prompt) {
      promptInput.value = state.prompt
    }

    if (state.ratio) {
      this.currentRatio = state.ratio
      this.selectRatio(state.ratio)
    }

    if (state.resolution) {
      this.currentResolution = state.resolution
      this.selectResolution(state.resolution)
    }

    const generateCountSelect = this.getElement<HTMLSelectElement>('generateCount')
    if (generateCountSelect && state.generateCount) {
      generateCountSelect.value = state.generateCount
    }

    if (state.referenceImages && Array.isArray(state.referenceImages)) {
      this.referenceImages = state.referenceImages.filter((img) => img && img.base64)
      this.updateReferenceImagesPreview()
    }

    if (state.lastGeneratedUrls && Array.isArray(state.lastGeneratedUrls)) {
      this.lastGeneratedUrls = state.lastGeneratedUrls
    }

    this.stateRestored = true
  }

  private saveCurrentState(): void {
    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager) {
      const state = this.collectState()
      pageStateManager.saveState('generate', state)
    }
  }

  private saveCurrentStateImmediate(): void {
    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager) {
      const state = this.collectState()
      pageStateManager.saveStateImmediate('generate', state)
    }
  }

  private bindStateAutoSave(): void {
    const promptInput = this.getElement('promptInput')
    if (promptInput) {
      promptInput.addEventListener('input', () => this.saveCurrentState())
    }

    const generateCountSelect = this.getElement('generateCount')
    if (generateCountSelect) {
      generateCountSelect.addEventListener('change', () => this.saveCurrentState())
    }
  }

  // ==================== 页面生命周期 ====================

  onActivate(): void {
    console.log(this.t('generate.messages.pageActivated'))
    this.updateReferenceImageLimitDisplay()

    const doRestore = async (): Promise<void> => {
      if (!this.stateRestored) {
        await this.restoreState()
      }

      if (!this.lastGeneratedUrls || this.lastGeneratedUrls.length === 0) {
        this.resetResultDisplay()
      }

      this.updateReferenceImagesPreview()
      this.updateIntelligentResizeIfNeeded()
      this.setupR2UploadListener()
    }

    this.requestIdleCallback(() => doRestore(), { timeout: 1000 })
  }

  onDeactivate(): void {
    this.saveCurrentStateImmediate()
    console.log(this.t('generate.messages.pageDeactivated'))

    if (this.r2UploadListener) {
      window.removeEventListener('r2UploadComplete', this.r2UploadListener as EventListener)
      this.r2UploadListener = null
    }
  }

  onLanguageChange(lang: string): void {
    console.log(`GeneratePage: Language changed to ${lang}`)
    this.updateReferenceImageLimitDisplay()
  }

  private updateReferenceImageLimitDisplay(): void {
    const limitElement = this.getElement('referenceImageLimit')
    if (!limitElement) return

    const currentModel = this.getApi()?.getCurrentModel()
    const maxImages = currentModel && currentModel.apiType === 'flux-kontext' ? 1 : 3

    limitElement.textContent = this.t('generate.labels.supportedFormats', { max: maxImages })

    if (currentModel && currentModel.apiType === 'flux-kontext') {
      limitElement.innerHTML = `<span class="text-orange-300">${this.t('generate.labels.fluxModelInfo')}</span>`
    }
  }

  private resetResultDisplay(): void {
    const resultTabs = this.getElement('resultTabs')
    if (resultTabs) resultTabs.classList.add('hidden')

    document.querySelectorAll('.tab-result-btn').forEach((btn) => btn.classList.remove('active'))
    this.getElement('resultTab')?.classList.add('active')

    const imageResult = this.getElement('imageResult')
    const originalImages = this.getElement('originalImages')
    const compareView = this.getElement('compareView')

    if (imageResult) imageResult.classList.remove('hidden')
    if (originalImages) originalImages.classList.add('hidden')
    if (compareView) compareView.classList.add('hidden')

    if (imageResult) {
      imageResult.innerHTML = `
        <div class="text-center text-white opacity-50">
          <i class="fas fa-image text-4xl mb-4"></i>
          <p>${this.t('generate.labels.generatedImagesPlaceholder')}</p>
        </div>
      `
    }
  }

  // Public getters for external access
  getReferenceImages(): ReferenceImage[] {
    return this.referenceImages
  }

  getLastGeneratedUrls(): string[] {
    return this.lastGeneratedUrls
  }

  getCurrentRatio(): string {
    return this.currentRatio
  }

  getCurrentResolution(): string {
    return this.currentResolution
  }
}

// Factory functions
let generatePageInstance: GeneratePage | null = null

export function createGeneratePage(app: AppInterface): GeneratePage {
  generatePageInstance = new GeneratePage(app)
  return generatePageInstance
}

export function getGeneratePage(): GeneratePage | null {
  return generatePageInstance
}

export default GeneratePage
