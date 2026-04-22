// src/renderer/src/pages/ComparePage.ts
/**
 * 模型对比页面模块 (TypeScript)
 * @description 支持两个模型同时生成对比
 */

import { BasePage, type AppInterface } from './BasePage'

// Types
export interface CompareReferenceImage {
  dataUrl: string
  name: string
  size: number
  originalFile?: File
  needsCompression: boolean
}

export interface CompareModel {
  id: string
  name: string
  displayName?: string
  apiType?: string
  baseURL?: string
  capabilities?: {
    resolutionControl?: boolean
    customSize?: boolean
    intelligentResize?: boolean
  }
  ratios?: Array<{ key: string; label: string; description?: string }>
  resolutionMap?: Record<string, Record<string, string>>
}

export interface CompareResult {
  success: boolean
  urls?: string[]
  url?: string
  generationTime?: number
}

export interface ComparisonData {
  leftModel: string
  rightModel: string
  leftModelName: string
  rightModelName: string
  prompt: string
  ratio: string
  leftUrl: string
  rightUrl: string
  leftGenerationTime?: number
  rightGenerationTime?: number
  referenceImages: string[]
  timestamp: number
}

export interface ComparePageState {
  leftModel: string | null
  rightModel: string | null
  currentRatio: string
  prompt: string
}

export class ComparePage extends BasePage {
  private leftModel: string | null = null
  private rightModel: string | null = null
  private currentRatio: string = '1:1'
  private referenceImages: CompareReferenceImage[] = []
  private maxReferenceImages: number = 8
  private isProcessing: boolean = false
  private isSelectingFile: boolean = false
  private currentComparison: ComparisonData | null = null
  private modelSelectorsInitialized: boolean = false

  constructor(app: AppInterface) {
    super(app)
    this.init()
  }

  init(): void {
    this.bindEvents()
    this.isInitialized = true
  }

  bindEvents(): void {
    // Events will be dynamically bound in onActivate
  }

  saveState(): void {
    // Compare page doesn't persist state
  }

  async restoreState(): Promise<void> {
    // Compare page doesn't restore state
  }

  // ==================== 语言切换 ====================

  onLanguageChange(lang: string): void {
    console.log('ComparePage: 语言切换为', lang)
    this.initModelSelectors()
    this.updateReferenceImageDisplay()
    this.updateRatioButtons()
  }

  // ==================== 页面生命周期 ====================

  onActivate(): void {
    console.log('模型对比页面已激活')
    this.setupEventListeners()

    // 仅在首次激活时初始化模型选择器，避免重复初始化
    if (!this.modelSelectorsInitialized) {
      setTimeout(() => {
        console.log('🔄 延迟初始化模型选择器开始...')
        this.initModelSelectors()
        this.updateRatioButtons()
        this.checkFluxModelsAndUpdateLimit()
        this.updateReferenceImageDisplay()
        this.modelSelectorsInitialized = true
      }, 100)
    } else {
      // 已初始化，只更新必要的 UI
      this.updateReferenceImageDisplay()
      this.checkFluxModelsAndUpdateLimit()
    }
  }

  onDeactivate(): void {
    console.log('模型对比页面已停用')
  }

  // ==================== 事件监听 ====================

  private setupEventListeners(): void {
    // 模型选择器
    const leftModelSelect = this.getElement<HTMLSelectElement>('leftModelSelect')
    const rightModelSelect = this.getElement<HTMLSelectElement>('rightModelSelect')

    if (leftModelSelect) {
      leftModelSelect.addEventListener('change', (e) => this.onLeftModelChange(e))
    }

    if (rightModelSelect) {
      rightModelSelect.addEventListener('change', (e) => this.onRightModelChange(e))
    }

    // 比例选择
    const compareRatioButtons = this.getElement('compareRatioButtons')
    if (compareRatioButtons) {
      compareRatioButtons.addEventListener('click', (e: Event) => {
        const target = e.target as HTMLElement
        const button = target.closest('.ratio-btn') as HTMLElement | null
        if (button && !button.hasAttribute('disabled')) {
          const ratio = button.dataset.ratio
          if (ratio) this.selectRatio(ratio)
        }
      })
    }

    // 参考图上传
    const compareReferenceArea = this.getElement('compareReferenceImageArea')
    if (compareReferenceArea) {
      compareReferenceArea.addEventListener('click', (e: Event) => {
        const target = e.target as HTMLElement
        if (target.closest('button')) return
        if (target.tagName === 'IMG' && target.closest('.relative')) return
        if (this.referenceImages.length === 0) {
          e.stopPropagation()
          this.triggerFileSelection()
        }
      })

      compareReferenceArea.addEventListener('dragover', (e) => this.handleDragOver(e))
      compareReferenceArea.addEventListener('drop', (e) => this.handleDrop(e))
      compareReferenceArea.addEventListener('dragleave', (e: DragEvent) => {
        if (e.target === compareReferenceArea) {
          compareReferenceArea.classList.remove('drag-over')
        }
      })
    }

    // 开始对比按钮
    this.addEventListenerSafe('compareBtn', 'click', () => this.startComparison())

    // 清空输入按钮
    this.addEventListenerSafe('clearCompareInputBtn', 'click', () => this.clearInput())

    // 评价按钮
    const evaluationButtons = document.querySelectorAll('.evaluation-btn')
    evaluationButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => this.handleEvaluation(e))
    })
  }

  // ==================== 模型选择器 ====================

  private initModelSelectors(): void {
    console.log('🔧 初始化模型选择器...')

    const api = this.getApi()
    const models = api?.getAllModels?.()
    const leftSelect = this.getElement<HTMLSelectElement>('leftModelSelect')
    const rightSelect = this.getElement<HTMLSelectElement>('rightModelSelect')

    console.log('📋 获取到的模型数据:', models)
    console.log('🎯 DOM元素检查:', { leftSelect: !!leftSelect, rightSelect: !!rightSelect })

    if (!leftSelect || !rightSelect) {
      console.error('❌ 模型选择器DOM元素未找到')
      return
    }

    if (!models || Object.keys(models).length === 0) {
      console.error('❌ 模型数据为空')
      return
    }

    const leftPlaceholder = this.t('compare.models.selectLeft')
    const rightPlaceholder = this.t('compare.models.selectRight')
    leftSelect.innerHTML = `<option value="">${leftPlaceholder}</option>`
    rightSelect.innerHTML = `<option value="">${rightPlaceholder}</option>`

    Object.entries(models).forEach(([key, model]: [string, any]) => {
      console.log(`➕ 添加模型: ${key} - ${model.name}`)
      const leftOption = new Option(model.name, key)
      const rightOption = new Option(model.name, key)
      leftSelect.add(leftOption)
      rightSelect.add(rightOption)
    })

    const defaultLeft = 'gemini-3-pro-image-preview'
    const defaultRight = 'seedream-4-5-251128'

    console.log(`🎯 尝试设置默认模型: 左=${defaultLeft}, 右=${defaultRight}`)
    console.log(`✅ 模型存在检查: 左=${!!models[defaultLeft]}, 右=${!!models[defaultRight]}`)

    if (models[defaultLeft] && models[defaultRight]) {
      leftSelect.value = defaultLeft
      rightSelect.value = defaultRight
      this.leftModel = defaultLeft
      this.rightModel = defaultRight
      console.log('✅ 默认模型设置成功')
    } else {
      const modelKeys = Object.keys(models)
      console.log('⚠️ 默认模型不存在，使用前两个可用模型:', modelKeys)

      if (modelKeys.length >= 2) {
        leftSelect.value = modelKeys[0]
        rightSelect.value = modelKeys[1]
        this.leftModel = modelKeys[0]
        this.rightModel = modelKeys[1]
        console.log(`✅ 备用模型设置成功: 左=${modelKeys[0]}, 右=${modelKeys[1]}`)
      }
    }

    this.updateModelInfo('left', this.leftModel)
    this.updateModelInfo('right', this.rightModel)

    console.log(`🎯 最终模型状态: 左=${this.leftModel}, 右=${this.rightModel}`)
  }

  private onLeftModelChange(e: Event): void {
    const target = e.target as HTMLSelectElement
    this.leftModel = target.value
    this.updateRatioButtons()
    this.updateModelInfo('left', this.leftModel)
    this.checkFluxModelsAndUpdateLimit()
  }

  private onRightModelChange(e: Event): void {
    const target = e.target as HTMLSelectElement
    this.rightModel = target.value
    this.updateRatioButtons()
    this.updateModelInfo('right', this.rightModel)
    this.checkFluxModelsAndUpdateLimit()
  }

  // ==================== Flux 模型检查 ====================

  private hasAnyFluxModel(): boolean {
    const api = this.getApi()
    if (!api) return false

    const models = api.getAllModels?.()

    if (this.leftModel && models?.[this.leftModel]) {
      if (models[this.leftModel].apiType === 'flux-kontext') return true
    }

    if (this.rightModel && models?.[this.rightModel]) {
      if (models[this.rightModel].apiType === 'flux-kontext') return true
    }

    return false
  }

  private checkFluxModelsAndUpdateLimit(): void {
    const hasFluxModel = this.hasAnyFluxModel()
    const oldLimit = this.maxReferenceImages

    this.maxReferenceImages = hasFluxModel ? 1 : 8

    if (oldLimit !== this.maxReferenceImages) {
      if (this.referenceImages.length > this.maxReferenceImages) {
        const removed = this.referenceImages.length - this.maxReferenceImages
        this.referenceImages = this.referenceImages.slice(0, this.maxReferenceImages)
        this.showToast(this.t('compare.messages.fluxLimitRemoved', { removed }), 'info')
      }
      this.updateReferenceImageDisplay()
    }
  }

  // ==================== 模型信息显示 ====================

  private updateModelInfo(side: 'left' | 'right', modelKey: string | null): void {
    const infoElement = this.getElement(`${side}ModelInfo`)
    if (!infoElement || !modelKey) return

    const api = this.getApi()
    const model = api?.getAllModels?.()?.[modelKey]
    if (!model) return

    const priceMatch = model.displayName?.match(/\$([0-9.]+)\/张/)
    const price = priceMatch ? priceMatch[1] : '未知'

    const speedMatch = model.displayName?.match(/(\d+s)出图/)
    const speed = speedMatch ? speedMatch[1] : '未知'

    infoElement.innerHTML = `
      <div class="text-xs text-white opacity-70">
        <span>${this.t('compare.models.speed', { speed })}</span> |
        <span>${this.t('compare.models.price', { price })}</span>
      </div>
    `
  }

  // ==================== 比例选择 ====================

  private updateRatioButtons(): void {
    if (!this.leftModel || !this.rightModel) {
      this.disableAllRatios()
      return
    }

    const commonRatios = this.getCommonRatios(this.leftModel, this.rightModel)
    const ratioContainer = this.getElement('compareRatioButtons')

    if (!ratioContainer) return

    ratioContainer.innerHTML = ''

    if (commonRatios.length === 0) {
      ratioContainer.innerHTML = `<div class="text-white opacity-70 text-sm">${this.t('compare.messages.noCommonRatios')}</div>`
      return
    }

    commonRatios.forEach((ratio, index) => {
      const button = document.createElement('button')
      button.className =
        'ratio-btn px-3 py-2 rounded-md text-sm font-medium transition-all bg-white/15 text-white hover:bg-white/25'
      button.dataset.ratio = ratio.key

      const i18n = (window as any).i18n
      const ratioData = i18n?.translations?.[i18n.currentLang]?.aspectRatios?.[ratio.key]
      const label = ratioData?.label || ratio.label
      const description = ratioData?.description || ratio.description

      button.innerHTML = `
        <span class="block">${label}</span>
        ${description ? `<span class="block text-xs opacity-70 mt-1">${description}</span>` : ''}
      `

      if (index === 0) {
        button.classList.add('active')
        this.currentRatio = ratio.key
      }

      ratioContainer.appendChild(button)
    })
  }

  private getCommonRatios(model1Key: string, model2Key: string): Array<{ key: string; label: string; description?: string }> {
    const api = this.getApi()
    const models = api?.getAllModels?.()

    const model1 = models?.[model1Key]
    const model2 = models?.[model2Key]

    if (!model1 || !model2) return []

    const ratios1 = this.getModelRatios(model1)
    const ratios2 = this.getModelRatios(model2)

    return ratios1.filter((r1) => ratios2.some((r2) => r2.key === r1.key))
  }

  private getModelRatios(model: any): Array<{ key: string; label: string; description?: string }> {
    if (model.ratios) return model.ratios
    if (model.capabilities?.customSize) {
      return (this.app as any).defaultRatios || [{ key: '1:1', label: '方形 1:1' }]
    }
    return [{ key: '1:1', label: '方形 1:1' }]
  }

  private disableAllRatios(): void {
    const buttons = document.querySelectorAll('#compareRatioButtons .ratio-btn')
    buttons.forEach((btn) => btn.setAttribute('disabled', 'true'))
  }

  selectRatio(ratio: string): void {
    this.currentRatio = ratio

    document.querySelectorAll('#compareRatioButtons .ratio-btn').forEach((btn) => {
      btn.classList.remove('active')
      if ((btn as HTMLElement).dataset.ratio === ratio) {
        btn.classList.add('active')
      }
    })
  }

  // ==================== 文件选择 ====================

  triggerFileSelection(): void {
    if (this.referenceImages.length >= this.maxReferenceImages) {
      if (this.hasAnyFluxModel()) {
        this.showToast(this.t('compare.messages.fluxModelLimit'), 'info')
      } else {
        this.showToast(this.t('compare.messages.maxImagesReached', { max: this.maxReferenceImages }), 'warning')
      }
      return
    }

    if (this.isSelectingFile) return
    this.isSelectingFile = true

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.style.display = 'none'

    input.addEventListener('change', (e: Event) => {
      const target = e.target as HTMLInputElement
      if (target.files && target.files.length > 0) {
        const files = Array.from(target.files)
        this.handleMultipleReferenceImageUpload(files)
      }
      if (input.parentNode) {
        input.parentNode.removeChild(input)
      }
      this.isSelectingFile = false
    })

    input.addEventListener('cancel', () => {
      this.isSelectingFile = false
    })

    setTimeout(() => {
      this.isSelectingFile = false
    }, 1000)

    document.body.appendChild(input)
    input.click()
  }

  private handleDragOver(e: DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'

    const area = this.getElement('compareReferenceImageArea')
    area?.classList.add('drag-over')
  }

  private handleDrop(e: DragEvent): void {
    e.preventDefault()
    e.stopPropagation()

    const area = this.getElement('compareReferenceImageArea')
    area?.classList.remove('drag-over')

    const files = Array.from(e.dataTransfer?.files || []).filter((file) => file.type.startsWith('image/'))
    if (files.length > 0) {
      this.handleMultipleReferenceImageUpload(files)
    }
  }

  private async handleMultipleReferenceImageUpload(files: File[]): Promise<void> {
    if (this.hasAnyFluxModel()) {
      this.maxReferenceImages = 1
    } else {
      this.maxReferenceImages = 8
    }

    const remainingSlots = this.maxReferenceImages - this.referenceImages.length
    const filesToProcess = files.slice(0, remainingSlots)

    if (files.length > remainingSlots) {
      if (this.hasAnyFluxModel()) {
        this.showToast(this.t('compare.messages.fluxModelLimit'), 'info')
      } else {
        this.showToast(
          this.t('compare.messages.uploadLimitReached', { remaining: remainingSlots, max: this.maxReferenceImages }),
          'warning'
        )
      }
    }

    for (const file of filesToProcess) {
      await this.processReferenceImage(file)
    }

    this.updateReferenceImageDisplay()
  }

  private async processReferenceImage(file: File): Promise<void> {
    try {
      this.validateImageFile(file)
    } catch (error: any) {
      this.showToast(error.message, 'error')
      return
    }

    return new Promise((resolve) => {
      const reader = new FileReader()

      reader.onload = (e: ProgressEvent<FileReader>) => {
        const imageData = e.target?.result as string
        const needsCompression = file.size > 2 * 1024 * 1024

        this.referenceImages.push({
          dataUrl: imageData,
          name: file.name,
          size: file.size,
          originalFile: file,
          needsCompression
        })
        resolve()
      }

      reader.onerror = () => {
        this.showToast(this.t('compare.messages.readFileFailed', { name: file.name }), 'error')
        resolve()
      }

      reader.readAsDataURL(file)
    })
  }

  private validateImageFile(file: File): void {
    if (!file.type.startsWith('image/')) {
      throw new Error(this.t('compare.messages.notImageFile', { name: file.name }))
    }

    const maxSize = 50 * 1024 * 1024
    if (file.size > maxSize) {
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1)
      throw new Error(this.t('compare.messages.fileTooLarge', { name: file.name, size: fileSizeMB }))
    }

    const supportedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/bmp']
    if (!supportedTypes.includes(file.type.toLowerCase())) {
      throw new Error(this.t('compare.messages.unsupportedFormat', { name: file.name }))
    }
  }

  // ==================== 参考图显示 ====================

  private updateReferenceImageDisplay(): void {
    const area = this.getElement('compareReferenceImageArea')
    if (!area) return

    if (this.referenceImages.length === 0) {
      area.className =
        'border-2 border-dashed border-white/20 rounded-md p-4 cursor-pointer hover:border-white/30 transition-all min-h-[120px] flex items-center justify-center'
      area.innerHTML = `
        <div id="compareReferenceUploadPrompt" class="space-y-2 text-center">
          <i class="fas fa-cloud-upload-alt text-2xl text-white opacity-50"></i>
          <p class="text-white opacity-70 text-sm">${this.t('compare.upload.clickOrDrag')}</p>
          <p class="text-white opacity-50 text-xs">${this.t('compare.upload.supportedFormats')}</p>
        </div>
      `
      return
    }

    area.className = 'border-2 border-dashed border-white/20 rounded-md p-4'
    area.innerHTML = `
      <div class="grid grid-cols-3 gap-2">
        ${this.referenceImages
          .map(
            (img, index) => `
          <div class="relative bg-white/10 rounded-lg p-2 group">
            <div class="relative">
              <img src="${img.dataUrl}"
                   class="w-full aspect-square object-cover rounded-lg"
                   alt="${this.t('compare.labels.referenceImage', { index: index + 1 })}">
              <button onclick="window.comparePageTS.removeReferenceImage(${index})"
                      class="absolute -top-1 -right-1 bg-red-500 hover:bg-red-600 text-white rounded-full w-5 h-5
                             flex items-center justify-center text-xs transition-colors opacity-0 group-hover:opacity-100"
                      title="${this.t('compare.buttons.removeReference')}">
                <i class="fas fa-times text-xs"></i>
              </button>
            </div>
          </div>
        `
          )
          .join('')}
        ${
          this.referenceImages.length < this.maxReferenceImages
            ? `
          <div onclick="window.comparePageTS.triggerFileSelection()"
               class="border-2 border-dashed border-white/30 hover:border-white/50
                      rounded-lg p-2 cursor-pointer transition-all flex items-center justify-center
                      aspect-square group">
            <div class="text-center">
              <i class="fas fa-plus text-white opacity-50 group-hover:opacity-70 text-xl mb-1"></i>
              <p class="text-white opacity-50 group-hover:opacity-70 text-xs">${this.t('compare.buttons.addMore')}</p>
              <p class="text-white opacity-30 group-hover:opacity-50 text-xs">(${this.referenceImages.length}/${this.maxReferenceImages})</p>
            </div>
          </div>
        `
            : ''
        }
      </div>
    `
  }

  removeReferenceImage(index: number): void {
    this.referenceImages.splice(index, 1)
    this.updateReferenceImageDisplay()
  }

  // ==================== 清空输入 ====================

  clearInput(): void {
    const promptInput = this.getElement<HTMLTextAreaElement>('comparePrompt')
    if (promptInput) promptInput.value = ''

    this.referenceImages = []
    this.updateReferenceImageDisplay()

    const resultContainer = this.getElement('compareResults')
    if (resultContainer) resultContainer.innerHTML = ''

    const evaluationArea = this.getElement('evaluationArea')
    evaluationArea?.classList.add('hidden')

    this.showToast(this.t('compare.messages.inputCleared'), 'success')
  }

  // ==================== 对比生成 ====================

  async startComparison(): Promise<void> {
    if (this.isProcessing) {
      this.showToast(this.t('compare.messages.processing'), 'warning')
      return
    }

    const promptInput = this.getElement<HTMLTextAreaElement>('comparePrompt')
    const prompt = promptInput?.value.trim() || ''

    if (!prompt && this.referenceImages.length === 0) {
      this.showToast(this.t('compare.messages.promptOrImageRequired'), 'error')
      return
    }

    if (!this.leftModel || !this.rightModel) {
      this.showToast(this.t('compare.messages.selectTwoModels'), 'error')
      return
    }

    if (this.leftModel === this.rightModel) {
      this.showToast(this.t('compare.messages.selectDifferentModels'), 'warning')
      return
    }

    this.isProcessing = true
    this.updateCompareButton(true)
    this.showLoadingState()

    try {
      const api = this.getApi()
      const hasReferenceImages = this.referenceImages.length > 0

      const promises = [
        this.generateWithModel(api, this.leftModel, prompt, this.currentRatio, hasReferenceImages),
        this.generateWithModel(api, this.rightModel, prompt, this.currentRatio, hasReferenceImages)
      ]

      const results = await Promise.allSettled(promises)
      this.handleComparisonResults(results, prompt)
    } catch (error: any) {
      console.error('对比生成失败:', error)
      this.showToast(this.t('compare.messages.comparisonFailed', { error: error.message }), 'error')
    } finally {
      this.isProcessing = false
      this.updateCompareButton(false)
    }
  }

  private async generateWithModel(
    api: any,
    modelKey: string,
    prompt: string,
    ratio: string,
    hasReferenceImages: boolean
  ): Promise<CompareResult> {
    const originalModel = api.model
    const originalBaseURL = api.baseURL

    try {
      api.model = modelKey
      api.baseURL = api.models[modelKey].baseURL

      const currentModel = api.models[modelKey]
      const supportsResolution = currentModel.capabilities?.resolutionControl
      const resolution = supportsResolution && (this.app as any).pages?.generate
        ? (this.app as any).pages.generate.currentResolution
        : null

      console.log(`[${modelKey}] 开始生成，参考图: ${hasReferenceImages}, 比例: ${ratio}, 分辨率: ${resolution || '默认'}`)

      let result: CompareResult
      if (hasReferenceImages) {
        console.log(`[${modelKey}] 使用参考图生成，参考图数量: ${this.referenceImages.length}`)
        const preparedImages = await this.prepareReferenceImagesForGeneration()
        result = await api.generateImageWithReference(prompt, preparedImages, ratio, 1, resolution)
      } else {
        console.log(`[${modelKey}] 纯文本生成`)
        result = await api.generateImage(prompt, ratio, 1, resolution)
      }

      console.log(`[${modelKey}] 生成结果:`, {
        success: result.success,
        urlsCount: result.urls?.length || 0
      })

      return result
    } catch (error) {
      console.error(`[${modelKey}] 生成过程出错:`, error)
      throw error
    } finally {
      api.model = originalModel
      api.baseURL = originalBaseURL
    }
  }

  private async prepareReferenceImagesForGeneration(): Promise<any[]> {
    const imagesToCompress = this.referenceImages.filter((img) => img.needsCompression)

    if (imagesToCompress.length === 0) {
      console.log('[压缩] 无需压缩的图片，直接使用')
      return this.referenceImages.map((img) => ({
        dataUrl: img.dataUrl,
        name: img.name,
        size: img.size
      }))
    }

    console.log(`[压缩] 发现 ${imagesToCompress.length} 张需要压缩的图片`)
    this.showToast(this.t('compare.messages.compressingImages', { count: imagesToCompress.length }), 'info')

    const processedImages: any[] = []

    for (const img of this.referenceImages) {
      if (!img.needsCompression) {
        processedImages.push({
          dataUrl: img.dataUrl,
          name: img.name,
          size: img.size
        })
        continue
      }

      try {
        if (!img.originalFile) {
          processedImages.push({ dataUrl: img.dataUrl, name: img.name, size: img.size })
          continue
        }

        const compressedFile = await this.compressImageIfNeeded(img.originalFile)
        const compressedBase64 = await this.fileToDataUrl(compressedFile)

        processedImages.push({
          dataUrl: compressedBase64,
          name: compressedFile.name,
          size: compressedFile.size
        })
      } catch (error) {
        console.error(`[压缩] 处理图片失败 ${img.name}:`, error)
        processedImages.push({
          dataUrl: img.dataUrl,
          name: img.name,
          size: img.size
        })
      }
    }

    this.showToast(this.t('compare.messages.compressionComplete'), 'success')
    return processedImages
  }

  private async compressImageIfNeeded(file: File): Promise<File> {
    const MAX_SIZE_MB = 2
    const fileSizeMB = file.size / (1024 * 1024)

    if (fileSizeMB <= MAX_SIZE_MB) {
      console.log(`[压缩] ${file.name} (${fileSizeMB.toFixed(2)}MB) 无需压缩`)
      return file
    }

    try {
      // V18: 使用延迟加载获取 imageCompression
      const getImageCompression = (window as any).getImageCompression
      if (typeof getImageCompression !== 'function') {
        console.warn('图片压缩库加载器未就绪，跳过压缩')
        this.showToast(this.t('compare.messages.compressionLibNotLoaded', { name: file.name }), 'warning')
        return file
      }
      
      const imageCompression = await getImageCompression()
      
      console.log(`[压缩] 开始压缩 ${file.name} (${fileSizeMB.toFixed(2)}MB)`)

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

      const compressedFile = await imageCompression(file, options)
      const compressedSizeMB = compressedFile.size / (1024 * 1024)

      console.log(`[压缩] 压缩完成: ${file.name}`)
      console.log(`[压缩] 原始大小: ${fileSizeMB.toFixed(2)}MB`)
      console.log(`[压缩] 压缩后: ${compressedSizeMB.toFixed(2)}MB`)
      console.log(`[压缩] 压缩率: ${((1 - compressedSizeMB / fileSizeMB) * 100).toFixed(1)}%`)

      return compressedFile
    } catch (error: any) {
      console.error(`[压缩] 压缩失败 ${file.name}:`, error)
      this.showToast(this.t('compare.messages.compressionFailed', { name: file.name }), 'warning')
      return file
    }
  }

  private fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (e) => resolve(e.target?.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  // ==================== 结果显示 ====================

  private showLoadingState(): void {
    const resultContainer = this.getElement('compareResults')
    if (!resultContainer) return

    resultContainer.innerHTML = `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="bg-white/10 rounded-xl p-6 animate-pulse">
          <div class="aspect-square bg-white/20 rounded-lg mb-4"></div>
          <div class="h-4 bg-white/20 rounded w-3/4 mb-2"></div>
          <div class="h-4 bg-white/20 rounded w-1/2"></div>
        </div>
        <div class="bg-white/10 rounded-xl p-6 animate-pulse">
          <div class="aspect-square bg-white/20 rounded-lg mb-4"></div>
          <div class="h-4 bg-white/20 rounded w-3/4 mb-2"></div>
          <div class="h-4 bg-white/20 rounded w-1/2"></div>
        </div>
      </div>
      <div class="text-center mt-6">
        <div class="inline-flex items-center space-x-2 text-white">
          <i class="fas fa-spinner fa-spin"></i>
          <span>${this.t('compare.messages.generating')}</span>
        </div>
      </div>
    `
  }

  private handleComparisonResults(results: PromiseSettledResult<CompareResult>[], prompt: string): void {
    const resultContainer = this.getElement('compareResults')
    if (!resultContainer) return

    const leftResult = results[0]
    const rightResult = results[1]

    let html = '<div class="grid grid-cols-1 md:grid-cols-2 gap-6">'
    html += this.buildResultCard('left', this.leftModel!, leftResult)
    html += this.buildResultCard('right', this.rightModel!, rightResult)
    html += '</div>'

    html += `
      <div class="hidden md:flex absolute left-1/2 top-1/2 transform -translate-x-1/2 -translate-y-1/2
                  bg-gradient-to-r from-purple-500 to-pink-500 text-white rounded-full w-16 h-16
                  items-center justify-center font-bold text-xl shadow-lg z-10">
        VS
      </div>
    `

    resultContainer.innerHTML = html

    if (leftResult.status === 'fulfilled' && rightResult.status === 'fulfilled') {
      this.showEvaluationButtons()

      const leftUrl = leftResult.value.urls?.[0] || leftResult.value.url || ''
      const rightUrl = rightResult.value.urls?.[0] || rightResult.value.url || ''

      const api = this.getApi()
      const models = api?.getAllModels?.()

      this.currentComparison = {
        leftModel: this.leftModel!,
        rightModel: this.rightModel!,
        leftModelName: models?.[this.leftModel!]?.name || this.leftModel!,
        rightModelName: models?.[this.rightModel!]?.name || this.rightModel!,
        prompt,
        ratio: this.currentRatio,
        leftUrl,
        rightUrl,
        leftGenerationTime: leftResult.value.generationTime,
        rightGenerationTime: rightResult.value.generationTime,
        referenceImages: this.referenceImages.map((img) => img.dataUrl),
        timestamp: Date.now()
      }

      this.saveComparisonToHistory()
    }
  }

  private buildResultCard(side: 'left' | 'right', modelKey: string, result: PromiseSettledResult<CompareResult>): string {
    const api = this.getApi()
    const model = api?.getAllModels?.()?.[modelKey]
    const isLeft = side === 'left'
    const borderColor = isLeft ? 'border-blue-500' : 'border-green-500'

    if (result.status === 'rejected') {
      console.error(`[${modelKey}] 生成失败:`, result.reason)

      const errorMessage = result.reason?.message || this.t('compare.labels.unknownError')
      let detailedError = ''

      if (result.reason?.detailedError) {
        const detail = result.reason.detailedError
        detailedError = `
          <div class="mt-2 text-xs opacity-50 max-h-20 overflow-y-auto">
            <p>${this.t('compare.labels.statusCode')}: ${detail.status || 'N/A'}</p>
            <p>URL: ${detail.url || 'N/A'}</p>
          </div>
        `
      }

      return `
        <div class="bg-white/10 rounded-xl p-6 border-2 ${borderColor}/30">
          <h3 class="text-white font-bold mb-4 flex items-center">
            <span class="inline-block w-2 h-2 ${isLeft ? 'bg-blue-500' : 'bg-green-500'} rounded-full mr-2"></span>
            ${model?.name || modelKey}
          </h3>
          <div class="aspect-square bg-red-500/20 rounded-lg flex items-center justify-center">
            <div class="text-center p-4">
              <i class="fas fa-exclamation-triangle text-4xl text-red-400 mb-4"></i>
              <p class="text-white opacity-70">${this.t('compare.labels.generateFailed')}</p>
              <p class="text-sm text-red-400 mt-2 break-words">${errorMessage}</p>
              ${detailedError}
            </div>
          </div>
        </div>
      `
    }

    const imageUrl = result.value.urls?.[0] || result.value.url || ''

    return `
      <div class="bg-white/10 rounded-xl p-6 border-2 ${borderColor}/30
                  hover:${borderColor}/50 transition-all">
        <h3 class="text-white font-bold mb-4 flex items-center justify-between">
          <span class="flex items-center">
            <span class="inline-block w-2 h-2 ${isLeft ? 'bg-blue-500' : 'bg-green-500'} rounded-full mr-2"></span>
            ${model?.name || modelKey}
          </span>
          <span class="text-xs opacity-70">${this.formatGenerationTime(result.value.generationTime)}</span>
        </h3>
        <div class="aspect-square bg-gray-800 rounded-lg overflow-hidden mb-4 group relative">
          <img src="${imageUrl}"
               alt="${model?.name || modelKey} ${this.t('compare.labels.generationResult')}"
               class="w-full h-full object-contain cursor-pointer hover:scale-105 transition-transform"
               data-action="view-image" data-urls='["${imageUrl}"]' data-index="0">
          <div class="absolute inset-0 bg-black/0 group-hover:bg-black/30
                      transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
            <button data-action="view-image" data-urls='["${imageUrl}"]' data-index="0"
                    class="bg-white/20 backdrop-blur-sm text-white px-4 py-2 rounded-lg
                           hover:bg-white/30 transition-all mr-2">
              <i class="fas fa-search-plus mr-2"></i>${this.t('compare.buttons.view')}
            </button>
            <button data-action="download-image" data-url="${imageUrl}"
                    class="bg-white/20 backdrop-blur-sm text-white px-4 py-2 rounded-lg
                           hover:bg-white/30 transition-all">
              <i class="fas fa-download mr-2"></i>${this.t('compare.buttons.download')}
            </button>
          </div>
        </div>
        <div id="${side}ModelInfo" class="text-xs text-white opacity-70">
          ${this.getModelStats(model)}
        </div>
      </div>
    `
  }

  private formatGenerationTime(time?: number): string {
    if (!time) return ''
    const seconds = Math.round(time / 1000)
    return `${seconds}${this.t('compare.labels.seconds')}`
  }

  private getModelStats(model: any): string {
    if (!model) return ''

    const priceMatch = model.displayName?.match(/\$([0-9.]+)\/张/)
    const price = priceMatch ? priceMatch[1] : '未知'

    const speedMatch = model.displayName?.match(/(\d+s)出图/)
    const speed = speedMatch ? speedMatch[1] : '未知'

    return `${this.t('compare.models.speed', { speed })} | ${this.t('compare.models.price', { price })}`
  }

  // ==================== 评价系统 ====================

  private showEvaluationButtons(): void {
    const evaluationArea = this.getElement('evaluationArea')
    if (!evaluationArea) return

    evaluationArea.classList.remove('hidden')

    document.querySelectorAll('.evaluation-btn').forEach((btn) => {
      btn.classList.remove('selected')
    })
  }

  private handleEvaluation(e: Event): void {
    const button = (e.target as HTMLElement).closest('.evaluation-btn') as HTMLElement | null
    if (!button) return

    const evaluation = button.dataset.evaluation
    if (!evaluation || !this.currentComparison) return

    document.querySelectorAll('.evaluation-btn').forEach((btn) => {
      btn.classList.remove('selected')
    })
    button.classList.add('selected')

    let winner: string | null = null
    let winnerModelName: string | null = null

    if (evaluation === 'left') {
      winner = this.currentComparison.leftModel
      winnerModelName = this.currentComparison.leftModelName
    } else if (evaluation === 'right') {
      winner = this.currentComparison.rightModel
      winnerModelName = this.currentComparison.rightModelName
    }

    this.updateHistoryWithEvaluation(evaluation, winner, winnerModelName)

    const messages: Record<string, string> = {
      left: this.t('compare.messages.evaluationLeft', { model: this.currentComparison.leftModelName }),
      right: this.t('compare.messages.evaluationRight', { model: this.currentComparison.rightModelName }),
      equal_good: this.t('compare.messages.evaluationEqualGood'),
      equal_bad: this.t('compare.messages.evaluationEqualBad')
    }

    this.showToast(messages[evaluation], 'success')
  }

  private saveComparisonToHistory(): void {
    if (!this.currentComparison) return

    const historyItem = {
      id: Date.now(),
      type: 'compare',
      prompt: this.currentComparison.prompt,
      ratio: this.currentComparison.ratio,
      timestamp: this.currentComparison.timestamp,
      urls: [this.currentComparison.leftUrl, this.currentComparison.rightUrl],
      comparison: {
        leftModel: this.currentComparison.leftModel,
        rightModel: this.currentComparison.rightModel,
        leftModelName: this.currentComparison.leftModelName,
        rightModelName: this.currentComparison.rightModelName,
        leftGenerationTime: this.currentComparison.leftGenerationTime,
        rightGenerationTime: this.currentComparison.rightGenerationTime,
        winner: null,
        evaluation: null
      },
      referenceImages: this.currentComparison.referenceImages || []
    }

    ;(this.app as any).addHistory?.(historyItem)
  }

  private updateHistoryWithEvaluation(evaluation: string, winner: string | null, winnerModelName: string | null): void {
    const history = (this.app as any).history
    if (!history || !this.currentComparison) return

    const latestComparison = history.find(
      (item: any) => item.type === 'compare' && item.timestamp === this.currentComparison!.timestamp
    )

    if (latestComparison?.comparison) {
      latestComparison.comparison.evaluation = evaluation
      latestComparison.comparison.winner = winner
      latestComparison.comparison.winnerModelName = winnerModelName
      ;(this.app as any).saveHistory?.()
    }
  }

  // ==================== UI 更新 ====================

  private updateCompareButton(isProcessing: boolean): void {
    const button = this.getElement<HTMLButtonElement>('compareBtn')
    if (!button) return

    if (isProcessing) {
      button.disabled = true
      button.innerHTML = `
        <i class="fas fa-spinner fa-spin mr-2"></i>
        <span>${this.t('compare.buttons.generating')}</span>
      `
    } else {
      button.disabled = false
      button.innerHTML = `
        <i class="fas fa-balance-scale mr-2"></i>
        <span>${this.t('compare.buttons.startCompare')}</span>
      `
    }
  }

  // ==================== Public getters ====================

  getLeftModel(): string | null {
    return this.leftModel
  }

  getRightModel(): string | null {
    return this.rightModel
  }

  getCurrentRatio(): string {
    return this.currentRatio
  }

  getReferenceImages(): CompareReferenceImage[] {
    return this.referenceImages
  }
}

// Factory functions
let comparePageInstance: ComparePage | null = null

export function createComparePage(app: AppInterface): ComparePage {
  comparePageInstance = new ComparePage(app)
  return comparePageInstance
}

export function getComparePage(): ComparePage | null {
  return comparePageInstance
}

export default ComparePage
