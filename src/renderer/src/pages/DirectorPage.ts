// src/renderer/src/pages/DirectorPage.ts
/**
 * 导演模式页面模块 - TypeScript 版本
 * @description 支持漫画分镜布局和批量场景生成
 */

import { BasePage, AppInterface, PageState } from './BasePage'

// ==================== 类型定义 ====================

/**
 * 布局类型
 */
export type LayoutType = '6grid' | '4grid' | '2closeup' | '9grid'

/**
 * 生成模式
 */
export type GenerationMode = 'single' | 'multi'

/**
 * 风格模板类型
 */
export type StyleTemplateKey = 'anime' | 'manga' | 'movie' | 'webtoon' | 'comic' | 'illustration'

/**
 * 风格模板
 */
export interface StyleTemplate {
  name: string
  prefix: string
  suffix: string
  negative: string
}

/**
 * 风格模板集合
 */
export interface StyleTemplates {
  [key: string]: StyleTemplate
}

/**
 * 布局配置
 */
export interface LayoutConfig {
  rows: number
  cols: number
  name: string
  description: string
  ratio: string
}

/**
 * 布局配置集合
 */
export interface LayoutConfigs {
  [key: string]: LayoutConfig
}

/**
 * 参考图片
 */
export interface DirectorReferenceImage {
  id?: number
  base64: string
  fileName: string
  fileSize: number
  mimeType: string
  originalFile?: File
}

/**
 * 生成结果
 */
export interface DirectorResult {
  success: boolean
  imageData?: string
  error?: string
  prompt: string
  index: number
}

/**
 * 自定义图库图片
 */
export interface CustomGalleryImage {
  id: string
  name: string
  base64?: string
  url?: string
  filename?: string
  createdAt: string
}

/**
 * 导演页面状态
 */
export interface DirectorPageState extends PageState {
  mode: GenerationMode
  layout: LayoutType
  ratio: string
  resolution: string
  template: string | null
  imageCount: string
  sceneDescription: string
  multiScenePrompts: string
  referenceImages: Array<{
    base64: string
    fileName: string
    fileSize: number
    mimeType: string
  }>
}

/**
 * 导演模式页面类
 */
export class DirectorPage extends BasePage {
  // 参考图片
  private referenceImages: DirectorReferenceImage[] = []
  private maxReferenceImages: number = 8

  // 生成状态
  private isGenerating: boolean = false
  private isProcessingFiles: boolean = false

  // 布局和模式
  private currentLayout: LayoutType = '6grid'
  private imageCount: number = 1
  private currentRatio: string = '3:2'
  private currentResolution: string = '2K'
  private currentTemplate: string | null = null
  private currentMode: GenerationMode = 'single'

  // 生成结果
  private generatedResult: string | null = null
  private generatedResults: DirectorResult[] = []
  private currentResultIndex: number = 0

  // 分析资产
  private lastAnalysisResult: string | null = null
  private lastComicPrompt: string | null = null

  // 图库
  private gallerySelectedImages: string[] = []
  private customGalleryImages: CustomGalleryImage[] = []
  private galleryEditMode: boolean = false
  private galleryDeleteSelection: string[] = []
  private exampleGalleryCount: number = 38
  private exampleGalleryPath: string = './assets/templates/'

  // 模板管理
  private customTemplates: StyleTemplates = {}
  private templateOverrides: StyleTemplates = {}
  private editingTemplateKey: string | null = null
  private editingTemplateIsBuiltin: boolean = false

  // 风格模板库
  private styleTemplates: StyleTemplates = {
    anime: {
      name: '动画截图风格',
      prefix: 'anime screencap, TV anime, storyboard panel, sequential storytelling, narrative composition, ',
      suffix: ', masterpiece, best quality, absurdres, very aesthetic, full color, anime cel shading, TV anime coloring',
      negative: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks'
    },
    manga: {
      name: '漫画分镜风格',
      prefix: 'manga panel, comic storyboard, sequential art, black and white manga, screentone, ',
      suffix: ', masterpiece, best quality, manga style, high contrast, dynamic lines, speech bubbles layout',
      negative: 'blurry, lowres, bad anatomy, worst quality, color, photorealistic, 3d render'
    },
    movie: {
      name: '电影分镜风格',
      prefix: 'cinematic storyboard, film still, movie scene, cinematography, ',
      suffix: ', masterpiece, best quality, cinematic lighting, depth of field, widescreen, film grain, color grading',
      negative: 'anime, cartoon, illustration, bad anatomy, worst quality, low quality'
    },
    webtoon: {
      name: '韩漫/条漫风格',
      prefix: 'webtoon style, korean manhwa, full color comic, vertical scroll format, ',
      suffix: ', masterpiece, best quality, soft shading, clean lineart, vibrant colors, romantic atmosphere',
      negative: 'blurry, lowres, bad anatomy, worst quality, black and white, monochrome'
    },
    comic: {
      name: '美漫风格',
      prefix: 'american comic style, superhero comic, comic book panel, bold lineart, ',
      suffix: ', masterpiece, best quality, dynamic pose, strong contrast, halftone dots, action scene',
      negative: 'blurry, lowres, bad anatomy, worst quality, anime style, soft shading'
    },
    illustration: {
      name: '插画风格',
      prefix: 'illustration, detailed artwork, artistic composition, ',
      suffix: ', masterpiece, best quality, highly detailed, beautiful lighting, artistic, professional illustration',
      negative: 'blurry, lowres, bad anatomy, worst quality, bad quality, simple background'
    }
  }

  private defaultStyleTemplates: StyleTemplates

  // 布局配置
  private layouts: LayoutConfigs = {
    '6grid': {
      rows: 2,
      cols: 3,
      name: '6格标准',
      description: '2行×3列，适合完整故事',
      ratio: '3:2'
    },
    '4grid': {
      rows: 2,
      cols: 2,
      name: '4格方正',
      description: '2行×2列，适合转折场景',
      ratio: '1:1'
    },
    '2closeup': {
      rows: 1,
      cols: 2,
      name: '2格特写',
      description: '1行×2列，适合表情特写',
      ratio: '16:9'
    },
    '9grid': {
      rows: 3,
      cols: 3,
      name: '9格全景',
      description: '3行×3列，适合动作场景',
      ratio: '1:1'
    }
  }

  constructor(app: AppInterface) {
    super(app)
    this.defaultStyleTemplates = JSON.parse(JSON.stringify(this.styleTemplates))
    this.init()
  }

  /**
   * 初始化页面
   */
  init(): void {
    console.log('初始化导演模式页面 (TypeScript)')
    this.bindEvents()
    this.bindStateAutoSave()
    this.loadUserTemplates()
    this.loadCustomGalleryImages()
    this.isInitialized = true
  }

  /**
   * 绑定事件
   */
  bindEvents(): void {
    // 上传区域
    this.setupUploadArea()

    // 清除参考图按钮
    this.addEventListenerSafe('directorClearImage', 'click', () => this.clearReferenceImage())

    // 模式切换
    this.setupModeSwitch()

    // 多提示词输入计数
    this.addEventListenerSafe('directorMultiSceneInput', 'input', () => this.updatePromptCount())

    // 布局选择
    this.setupLayoutSelection()

    // 生成按钮
    this.addEventListenerSafe('directorGenerateBtn', 'click', () => this.startGeneration())

    // 下载按钮
    this.addEventListenerSafe('directorDownloadBtn', 'click', () => this.downloadResult())
    this.addEventListenerSafe('directorDownloadAllBtn', 'click', () => this.downloadAllResults())

    // 重新生成按钮
    this.addEventListenerSafe('directorRegenerateBtn', 'click', () => this.startGeneration())

    // 出图数量滑块
    this.addEventListenerSafe('directorImageCount', 'input', () => this.updateImageCountDisplay())

    // 风格模板
    this.setupTemplateEvents()

    // 图片尺寸选择
    const ratioSelect = this.getElement<HTMLSelectElement>('directorRatio')
    if (ratioSelect) {
      ratioSelect.addEventListener('change', (e: Event) => {
        this.currentRatio = (e.target as HTMLSelectElement).value
      })
    }

    // 分辨率选择
    const resolutionSelect = this.getElement<HTMLSelectElement>('directorResolution')
    if (resolutionSelect) {
      resolutionSelect.addEventListener('change', (e: Event) => {
        this.currentResolution = (e.target as HTMLSelectElement).value
      })
    }

    // 示例图库
    this.setupGalleryEvents()
  }

  /**
   * 设置上传区域
   */
  private setupUploadArea(): void {
    const uploadArea = this.getElement<HTMLElement>('directorUploadArea')
    if (!uploadArea) return

    uploadArea.addEventListener('click', () => this.triggerFileSelection())
    uploadArea.addEventListener('dragover', (e) => this.handleDragOver(e))
    uploadArea.addEventListener('dragleave', (e) => this.handleDragLeave(e))
    uploadArea.addEventListener('drop', (e) => this.handleDrop(e))
  }

  /**
   * 设置模式切换
   */
  private setupModeSwitch(): void {
    const modeRadios = document.querySelectorAll<HTMLInputElement>('input[name="directorMode"]')
    modeRadios.forEach(radio => {
      radio.addEventListener('change', (e: Event) => {
        this.switchMode((e.target as HTMLInputElement).value as GenerationMode)
      })
    })
  }

  /**
   * 设置布局选择
   */
  private setupLayoutSelection(): void {
    const layoutContainer = this.getElement<HTMLElement>('directorLayoutOptions')
    if (layoutContainer) {
      layoutContainer.addEventListener('click', (e: MouseEvent) => {
        const card = (e.target as HTMLElement).closest('.layout-card') as HTMLElement | null
        if (card?.dataset.layout) {
          this.selectLayout(card.dataset.layout as LayoutType)
        }
      })
    }
  }

  /**
   * 设置模板事件
   */
  private setupTemplateEvents(): void {
    this.addEventListenerSafe('directorTemplateBtn', 'click', () => this.showTemplateModal())
    this.addEventListenerSafe('closeTemplateModalX', 'click', () => this.hideTemplateModal())
    this.addEventListenerSafe('closeTemplateModal', 'click', () => this.hideTemplateModal())
    this.addEventListenerSafe('directorClearTemplate', 'click', () => this.clearTemplate())

    const templateList = this.getElement<HTMLElement>('directorTemplateList')
    if (templateList) {
      templateList.addEventListener('click', (e: MouseEvent) => {
        const card = (e.target as HTMLElement).closest('.template-card') as HTMLElement | null
        if (card?.dataset.template) {
          this.selectTemplate(card.dataset.template)
        }
      })
    }
  }

  /**
   * 设置图库事件
   */
  private setupGalleryEvents(): void {
    this.addEventListenerSafe('directorExampleGalleryBtn', 'click', () => this.showGalleryModal())
    this.addEventListenerSafe('closeGalleryModalX', 'click', () => this.hideGalleryModal())
    this.addEventListenerSafe('closeGalleryModal', 'click', () => this.hideGalleryModal())
    this.addEventListenerSafe('confirmGallerySelection', 'click', () => this.confirmGallerySelection())
  }

  /**
   * 绑定状态自动保存
   */
  private bindStateAutoSave(): void {
    const elements = [
      { id: 'directorSceneInput', event: 'input' },
      { id: 'directorMultiSceneInput', event: 'input' },
      { id: 'directorImageCount', event: 'input' },
      { id: 'directorRatio', event: 'change' },
      { id: 'directorResolution', event: 'change' }
    ]

    elements.forEach(({ id, event }) => {
      const element = this.getElement<HTMLElement>(id)
      if (element) {
        element.addEventListener(event, () => this.saveCurrentState())
      }
    })
  }

  // ==================== 图库管理 ====================

  /**
   * 显示图库模态框
   */
  showGalleryModal(): void {
    const modal = this.getElement<HTMLElement>('directorGalleryModal')
    if (modal) {
      modal.classList.remove('hidden')
      this.galleryEditMode = false
      this.galleryDeleteSelection = []
      this.updateGalleryEditModeUI()
      this.loadGalleryImages()
      ;(window as any).i18n?.updateDOM()
    }
  }

  /**
   * 隐藏图库模态框
   */
  hideGalleryModal(): void {
    const modal = this.getElement<HTMLElement>('directorGalleryModal')
    if (modal) {
      modal.classList.add('hidden')
    }
    this.gallerySelectedImages = []
    this.galleryDeleteSelection = []
    this.galleryEditMode = false
    this.updateGallerySelectedCount()
  }

  /**
   * 加载自定义图库
   */
  async loadCustomGalleryImages(): Promise<void> {
    try {
      let images: CustomGalleryImage[] = []
      const electronAPI = (window as any).electronAPI

      if (electronAPI?.isElectron) {
        images = await electronAPI.loadCustomGallery() || []
      } else {
        const data = localStorage.getItem('director_custom_gallery')
        images = data ? JSON.parse(data) : []
      }

      this.customGalleryImages = images
      console.log('[DirectorPage] 已加载自定义图库:', this.customGalleryImages.length, '张')
    } catch (error) {
      console.error('[DirectorPage] 加载自定义图库失败:', error)
      this.customGalleryImages = []
    }
  }

  /**
   * 加载图库图片
   */
  loadGalleryImages(): void {
    this.loadCustomGalleryGrid()
    this.loadBuiltinGalleryGrid()
    if (!this.galleryEditMode) {
      this.gallerySelectedImages = []
    }
    this.updateGallerySelectedCount()
  }

  /**
   * 加载自定义图库网格
   */
  private loadCustomGalleryGrid(): void {
    const grid = this.getElement<HTMLElement>('customGalleryGrid')
    const countSpan = this.getElement<HTMLElement>('customImageCount')

    if (!grid) return

    if (countSpan) {
      countSpan.textContent = `(${this.customGalleryImages.length})`
    }

    grid.innerHTML = ''

    if (this.customGalleryImages.length === 0) {
      grid.innerHTML = `
        <div class="col-span-full text-center py-10 relative overflow-hidden"
             style="border: 2px dashed #3F3F46; background: linear-gradient(135deg, #18181B 0%, #09090B 100%);">
          <div class="relative z-10">
            <i class="fas fa-folder-open text-4xl mb-3" style="color: #06B6D4;"></i>
            <p class="text-[#FAFAFA] text-sm uppercase tracking-widest font-bold mb-1">NO_DATA_FOUND</p>
            <p class="text-[#71717A] text-xs uppercase tracking-wide">点击上方按钮添加您的图片</p>
          </div>
        </div>
      `
      return
    }

    this.customGalleryImages.forEach(img => {
      const card = this.createGalleryCard(img, true)
      grid.appendChild(card)
    })
  }

  /**
   * 加载内置图库网格
   */
  private loadBuiltinGalleryGrid(): void {
    const grid = this.getElement<HTMLElement>('builtinGalleryGrid')
    if (!grid) return

    grid.innerHTML = ''

    for (let i = 1; i <= this.exampleGalleryCount; i++) {
      const imagePath = `${this.exampleGalleryPath}anime-example-${String(i).padStart(2, '0')}.png`
      const card = this.createBuiltinGalleryCard(imagePath, i)
      grid.appendChild(card)
    }
  }

  /**
   * 创建图库卡片
   */
  private createGalleryCard(img: CustomGalleryImage, isCustom: boolean): HTMLElement {
    const card = document.createElement('div')
    const imageUrl = img.url || img.base64 || ''
    const isSelected = this.galleryEditMode
      ? this.galleryDeleteSelection.includes(img.id)
      : this.gallerySelectedImages.includes(imageUrl)

    card.className = 'gallery-card group relative cursor-pointer overflow-hidden transition-all duration-300'
    card.dataset.imgId = img.id
    card.dataset.isCustom = String(isCustom)

    card.innerHTML = `
      <img src="${imageUrl}" alt="${img.name}" 
           class="w-full h-32 object-cover transition-transform duration-300 group-hover:scale-105" loading="lazy">
      <div class="gallery-check ${isSelected ? '' : 'hidden'} absolute top-2 right-2 w-6 h-6 z-30 flex items-center justify-center"
           style="background: ${this.galleryEditMode ? '#EF4444' : '#EC4899'};">
        <i class="fas ${this.galleryEditMode ? 'fa-trash' : 'fa-check'} text-white text-xs"></i>
      </div>
      <div class="absolute bottom-0 left-0 right-0 z-20" 
           style="background: linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 100%);">
        <div class="p-2">
          <p class="text-[#FAFAFA] text-xs truncate uppercase tracking-wider font-medium">${img.name}</p>
        </div>
      </div>
    `

    card.addEventListener('click', () => this.handleGalleryCardClick(img, imageUrl))

    return card
  }

  /**
   * 创建内置图库卡片
   */
  private createBuiltinGalleryCard(imagePath: string, index: number): HTMLElement {
    const card = document.createElement('div')
    const isSelected = this.gallerySelectedImages.includes(imagePath)

    card.className = 'gallery-card group relative cursor-pointer overflow-hidden transition-all duration-300'
    card.dataset.imagePath = imagePath

    card.innerHTML = `
      <img src="${imagePath}" alt="示例图片 ${index}" 
           class="w-full h-32 object-cover transition-transform duration-300 group-hover:scale-105" loading="lazy">
      <div class="gallery-check ${isSelected ? '' : 'hidden'} absolute top-2 right-2 w-6 h-6 z-30 flex items-center justify-center bg-pink-500">
        <i class="fas fa-check text-white text-xs"></i>
      </div>
    `

    card.addEventListener('click', () => this.toggleGallerySelection(imagePath, card))

    return card
  }

  /**
   * 处理图库卡片点击
   */
  private handleGalleryCardClick(img: CustomGalleryImage, imageUrl: string): void {
    if (this.galleryEditMode) {
      const idx = this.galleryDeleteSelection.indexOf(img.id)
      if (idx > -1) {
        this.galleryDeleteSelection.splice(idx, 1)
      } else {
        this.galleryDeleteSelection.push(img.id)
      }
      this.loadGalleryImages()
    } else {
      this.toggleGallerySelection(imageUrl)
    }
  }

  /**
   * 切换图库选择
   */
  private toggleGallerySelection(imagePath: string, card?: HTMLElement): void {
    const idx = this.gallerySelectedImages.indexOf(imagePath)
    if (idx > -1) {
      this.gallerySelectedImages.splice(idx, 1)
    } else {
      if (this.gallerySelectedImages.length >= this.maxReferenceImages) {
        this.showToast(`最多选择 ${this.maxReferenceImages} 张图片`, 'warning')
        return
      }
      this.gallerySelectedImages.push(imagePath)
    }

    if (card) {
      const checkEl = card.querySelector('.gallery-check')
      if (checkEl) {
        checkEl.classList.toggle('hidden')
      }
    }

    this.updateGallerySelectedCount()
  }

  /**
   * 更新图库选中数量
   */
  private updateGallerySelectedCount(): void {
    const countEl = this.getElement<HTMLElement>('gallerySelectedCount')
    if (countEl) {
      countEl.textContent = `${this.gallerySelectedImages.length}`
    }
  }

  /**
   * 更新编辑模式 UI
   */
  private updateGalleryEditModeUI(): void {
    const editBtn = this.getElement<HTMLElement>('galleryEditModeBtn')
    const editActions = this.getElement<HTMLElement>('galleryEditActions')
    const selectActions = this.getElement<HTMLElement>('confirmGallerySelection')

    if (this.galleryEditMode) {
      editBtn?.classList.add('bg-[#FCE300]', 'text-black')
      editActions?.classList.remove('hidden')
      selectActions?.classList.add('hidden')
    } else {
      editBtn?.classList.remove('bg-[#FCE300]', 'text-black')
      editActions?.classList.add('hidden')
      selectActions?.classList.remove('hidden')
    }
  }

  /**
   * 确认图库选择
   */
  async confirmGallerySelection(): Promise<void> {
    if (this.gallerySelectedImages.length === 0) {
      this.showToast('请选择至少一张图片', 'warning')
      return
    }

    this.showToast(`正在加载 ${this.gallerySelectedImages.length} 张图片...`, 'info')

    for (const imagePath of this.gallerySelectedImages) {
      try {
        const response = await fetch(imagePath)
        const blob = await response.blob()
        const file = new File([blob], imagePath.split('/').pop() || 'image.png', { type: blob.type })
        await this.handleSingleImageUpload(file)
      } catch (error) {
        console.error('加载图片失败:', imagePath, error)
      }
    }

    this.hideGalleryModal()
    this.showToast(`已添加 ${this.gallerySelectedImages.length} 张参考图`, 'success')
  }

  // ==================== 模板管理 ====================

  /**
   * 加载用户模板
   */
  async loadUserTemplates(): Promise<void> {
    try {
      const electronAPI = (window as any).electronAPI

      if (electronAPI?.isElectron) {
        const templates = await electronAPI.loadTemplates()
        if (templates) {
          this.customTemplates = templates.templates || {}
          this.templateOverrides = templates.overrides || {}
        }
      } else {
        const customData = localStorage.getItem('director_custom_templates')
        const overrideData = localStorage.getItem('director_template_overrides')
        this.customTemplates = customData ? JSON.parse(customData) : {}
        this.templateOverrides = overrideData ? JSON.parse(overrideData) : {}
      }

      // 应用覆盖
      for (const key in this.templateOverrides) {
        if (this.styleTemplates[key]) {
          this.styleTemplates[key] = { ...this.styleTemplates[key], ...this.templateOverrides[key] }
        }
      }

      console.log('[DirectorPage] 已加载用户模板:', Object.keys(this.customTemplates).length)
    } catch (error) {
      console.error('[DirectorPage] 加载用户模板失败:', error)
    }
  }

  /**
   * 显示模板模态框
   */
  showTemplateModal(): void {
    const modal = this.getElement<HTMLElement>('directorTemplateModal')
    if (modal) {
      modal.classList.remove('hidden')
      this.renderTemplateList()
    }
  }

  /**
   * 隐藏模板模态框
   */
  hideTemplateModal(): void {
    const modal = this.getElement<HTMLElement>('directorTemplateModal')
    if (modal) {
      modal.classList.add('hidden')
    }
  }

  /**
   * 渲染模板列表
   */
  private renderTemplateList(): void {
    const list = this.getElement<HTMLElement>('directorTemplateList')
    if (!list) return

    list.innerHTML = ''

    // 渲染内置模板
    Object.entries(this.styleTemplates).forEach(([key, template]) => {
      const card = this.createTemplateCard(key, template, true)
      list.appendChild(card)
    })

    // 渲染自定义模板
    Object.entries(this.customTemplates).forEach(([key, template]) => {
      const card = this.createTemplateCard(key, template, false)
      list.appendChild(card)
    })
  }

  /**
   * 创建模板卡片
   */
  private createTemplateCard(key: string, template: StyleTemplate, isBuiltin: boolean): HTMLElement {
    const card = document.createElement('div')
    const isSelected = this.currentTemplate === key

    card.className = `template-card cursor-pointer p-4 rounded-lg border-2 transition-all ${
      isSelected ? 'border-pink-500 bg-pink-500 bg-opacity-10' : 'border-gray-600 hover:border-gray-400'
    }`
    card.dataset.template = key

    card.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <h4 class="text-white font-medium">${template.name}</h4>
        ${isBuiltin ? '<span class="text-xs text-gray-400">内置</span>' : '<span class="text-xs text-pink-400">自定义</span>'}
      </div>
      <p class="text-gray-400 text-xs line-clamp-2">${template.prefix.substring(0, 100)}...</p>
    `

    return card
  }

  /**
   * 选择模板
   */
  selectTemplate(templateKey: string): void {
    const template = this.styleTemplates[templateKey] || this.customTemplates[templateKey]
    if (!template) return

    this.currentTemplate = templateKey

    const nameSpan = this.getElement<HTMLElement>('directorTemplateName')
    const clearBtn = this.getElement<HTMLElement>('directorClearTemplate')

    if (nameSpan) {
      nameSpan.textContent = template.name
      nameSpan.classList.add('text-pink-400')
    }
    if (clearBtn) {
      clearBtn.classList.remove('hidden')
    }

    this.hideTemplateModal()
    this.showToast(`已选择「${template.name}」模板`, 'success')
    this.saveCurrentState()
  }

  /**
   * 清除模板
   */
  clearTemplate(): void {
    this.currentTemplate = null

    const nameSpan = this.getElement<HTMLElement>('directorTemplateName')
    const clearBtn = this.getElement<HTMLElement>('directorClearTemplate')

    if (nameSpan) {
      nameSpan.textContent = '默认（无模板）'
      nameSpan.classList.remove('text-pink-400')
    }
    if (clearBtn) {
      clearBtn.classList.add('hidden')
    }

    this.saveCurrentState()
  }

  // ==================== 参考图管理 ====================

  /**
   * 触发文件选择
   */
  triggerFileSelection(): void {
    if (this.isGenerating || this.isProcessingFiles) return

    if (this.referenceImages.length >= this.maxReferenceImages) {
      this.showToast(`最多上传 ${this.maxReferenceImages} 张参考图`, 'warning')
      return
    }

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.style.display = 'none'

    input.addEventListener('change', async (e: Event) => {
      const files = Array.from((e.target as HTMLInputElement).files || [])
      if (files.length > 0) {
        await this.handleMultipleReferenceImageUpload(files)
      }
      input.remove()
    })

    document.body.appendChild(input)
    input.click()
  }

  /**
   * 处理拖拽悬停
   */
  private handleDragOver(e: DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const uploadArea = this.getElement<HTMLElement>('directorUploadArea')
    if (uploadArea) {
      uploadArea.classList.add('drag-over')
    }
  }

  /**
   * 处理拖拽离开
   */
  private handleDragLeave(e: DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const uploadArea = this.getElement<HTMLElement>('directorUploadArea')
    if (uploadArea) {
      uploadArea.classList.remove('drag-over')
    }
  }

  /**
   * 处理拖拽放置
   */
  private handleDrop(e: DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const uploadArea = this.getElement<HTMLElement>('directorUploadArea')
    if (uploadArea) {
      uploadArea.classList.remove('drag-over')
    }

    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'))
    if (files.length > 0) {
      this.handleMultipleReferenceImageUpload(files)
    }
  }

  /**
   * 处理多张参考图上传
   */
  async handleMultipleReferenceImageUpload(files: File[]): Promise<void> {
    if (this.isProcessingFiles) return

    this.isProcessingFiles = true
    let successCount = 0

    try {
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue
        if (this.referenceImages.length >= this.maxReferenceImages) {
          this.showToast(`最多上传 ${this.maxReferenceImages} 张参考图`, 'warning')
          break
        }

        try {
          await this.handleSingleImageUpload(file)
          successCount++
        } catch (error) {
          console.error(`处理文件 ${file.name} 失败:`, error)
        }
      }

      this.updateReferenceImagesPreview()
      this.updateGenerateButtonState()

      if (successCount > 0) {
        this.showToast(`已上传 ${successCount} 张图片`, 'success')
      }
    } finally {
      this.isProcessingFiles = false
    }
  }

  /**
   * 处理单张图片上传
   */
  private async handleSingleImageUpload(file: File): Promise<void> {
    const base64 = await this.fileToBase64(file)

    this.referenceImages.push({
      base64,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'image/jpeg',
      originalFile: file
    })
  }

  /**
   * 文件转 Base64
   */
  private fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1]
        resolve(base64)
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  /**
   * 更新参考图预览
   */
  updateReferenceImagesPreview(): void {
    const uploadArea = this.getElement<HTMLElement>('directorUploadArea')
    const preview = this.getElement<HTMLElement>('directorImagePreview')

    if (!preview) return

    if (this.referenceImages.length === 0) {
      if (uploadArea) uploadArea.classList.remove('hidden')
      preview.classList.add('hidden')
      preview.innerHTML = ''
      return
    }

    if (uploadArea) uploadArea.classList.add('hidden')
    preview.classList.remove('hidden')

    preview.innerHTML = `
      <div class="grid grid-cols-4 gap-2 mb-3">
        ${this.referenceImages.map((img, index) => `
          <div class="relative group aspect-square">
            <img src="data:${img.mimeType};base64,${img.base64}" 
                 class="w-full h-full object-cover rounded-lg" alt="${img.fileName}">
            <button class="delete-ref-img absolute top-1 right-1 w-5 h-5 bg-red-500 hover:bg-red-600 rounded-full 
                          flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    data-index="${index}">
              <i class="fas fa-times text-white text-xs"></i>
            </button>
          </div>
        `).join('')}
        ${this.referenceImages.length < this.maxReferenceImages ? `
          <div class="aspect-square border-2 border-dashed border-gray-500 rounded-lg flex items-center justify-center cursor-pointer hover:border-pink-500 transition-colors add-more-ref">
            <i class="fas fa-plus text-gray-400"></i>
          </div>
        ` : ''}
      </div>
      <p class="text-sm text-gray-400 text-center">${this.referenceImages.length}/${this.maxReferenceImages} 张参考图</p>
    `

    // 绑定删除按钮
    preview.querySelectorAll('.delete-ref-img').forEach(btn => {
      btn.addEventListener('click', (e: Event) => {
        e.stopPropagation()
        const index = parseInt((btn as HTMLElement).dataset.index || '0', 10)
        this.removeReferenceImage(index)
      })
    })

    // 绑定添加更多
    const addMoreBtn = preview.querySelector('.add-more-ref')
    if (addMoreBtn) {
      addMoreBtn.addEventListener('click', () => this.triggerFileSelection())
    }
  }

  /**
   * 删除参考图
   */
  removeReferenceImage(index: number): void {
    this.referenceImages.splice(index, 1)
    this.updateReferenceImagesPreview()
    this.updateGenerateButtonState()
    this.saveCurrentState()
  }

  /**
   * 清除所有参考图
   */
  clearReferenceImage(): void {
    this.referenceImages = []
    this.updateReferenceImagesPreview()
    this.updateGenerateButtonState()
    this.saveCurrentState()
    this.showToast('已清除所有参考图', 'info')
  }

  // ==================== 模式和布局 ====================

  /**
   * 切换模式
   */
  switchMode(mode: GenerationMode): void {
    this.currentMode = mode

    const singleUI = this.getElement<HTMLElement>('directorSingleModeUI')
    const multiUI = this.getElement<HTMLElement>('directorMultiModeUI')
    const singleLabel = this.getElement<HTMLElement>('directorSingleModeLabel')
    const multiLabel = this.getElement<HTMLElement>('directorMultiModeLabel')
    const generateBtn = this.getElement<HTMLElement>('directorGenerateBtn')

    if (mode === 'single') {
      singleUI?.classList.remove('hidden')
      multiUI?.classList.add('hidden')

      if (singleLabel) {
        singleLabel.className = 'flex-1 flex items-center justify-center cursor-pointer px-4 py-3 bg-gradient-to-r from-blue-500 to-purple-500 rounded-lg text-white font-medium shadow-md transition-all'
      }
      if (multiLabel) {
        multiLabel.className = 'flex-1 flex items-center justify-center cursor-pointer px-4 py-3 bg-white bg-opacity-10 hover:bg-opacity-20 rounded-lg text-white transition-all'
      }

      const btnSpan = generateBtn?.querySelector('span')
      if (btnSpan) btnSpan.textContent = '一键生成漫画分镜'
    } else {
      singleUI?.classList.add('hidden')
      multiUI?.classList.remove('hidden')

      if (singleLabel) {
        singleLabel.className = 'flex-1 flex items-center justify-center cursor-pointer px-4 py-3 bg-white bg-opacity-10 hover:bg-opacity-20 rounded-lg text-white transition-all'
      }
      if (multiLabel) {
        multiLabel.className = 'flex-1 flex items-center justify-center cursor-pointer px-4 py-3 bg-gradient-to-r from-orange-500 to-pink-500 rounded-lg text-white font-medium shadow-md transition-all'
      }

      const btnSpan = generateBtn?.querySelector('span')
      if (btnSpan) btnSpan.textContent = '批量生成漫画分镜'

      this.updatePromptCount()
    }

    this.updateGenerateButtonState()
    this.saveCurrentState()
  }

  /**
   * 选择布局
   */
  selectLayout(layoutKey: LayoutType): void {
    this.currentLayout = layoutKey
    this.updateLayoutSelection()
    this.saveCurrentState()
  }

  /**
   * 更新布局选择UI
   */
  updateLayoutSelection(): void {
    const cards = document.querySelectorAll<HTMLElement>('.layout-card')
    cards.forEach(card => {
      const isSelected = card.dataset.layout === this.currentLayout
      if (isSelected) {
        card.classList.add('border-pink-500', 'bg-pink-500', 'bg-opacity-10')
        card.classList.remove('border-gray-600')
      } else {
        card.classList.remove('border-pink-500', 'bg-pink-500', 'bg-opacity-10')
        card.classList.add('border-gray-600')
      }
    })
  }

  /**
   * 更新提示词计数
   */
  updatePromptCount(): void {
    const multiSceneInput = this.getElement<HTMLTextAreaElement>('directorMultiSceneInput')
    const countSpan = this.getElement<HTMLElement>('directorPromptCount')

    if (multiSceneInput && countSpan) {
      const prompts = this.parseMultiPrompts(multiSceneInput.value)
      countSpan.textContent = `${prompts.length} 个场景`
    }
  }

  /**
   * 解析多提示词
   */
  private parseMultiPrompts(text: string): string[] {
    if (!text?.trim()) return []
    return text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0)
  }

  /**
   * 更新出图数量显示
   */
  updateImageCountDisplay(): void {
    const slider = this.getElement<HTMLInputElement>('directorImageCount')
    const display = this.getElement<HTMLElement>('directorCountDisplay')
    if (slider && display) {
      this.imageCount = parseInt(slider.value)
      display.textContent = `${this.imageCount}张`
    }
  }

  /**
   * 更新生成按钮状态
   */
  updateGenerateButtonState(): void {
    const btn = this.getElement<HTMLButtonElement>('directorGenerateBtn')
    if (btn) {
      btn.disabled = this.isGenerating || this.referenceImages.length === 0
    }
  }

  // ==================== 生成逻辑 ====================

  /**
   * 开始生成
   */
  async startGeneration(): Promise<void> {
    if (this.referenceImages.length === 0) {
      this.showToast('请先上传参考图', 'warning')
      return
    }

    const api = this.getApi()
    if (!api?.apiKey) {
      this.showToast('请先在设置中配置 API Key', 'error')
      return
    }

    if (this.isGenerating) return

    if (this.currentMode === 'multi') {
      await this.startMultiGeneration()
    } else {
      await this.startSingleGeneration()
    }
  }

  /**
   * 单模式生成
   */
  private async startSingleGeneration(): Promise<void> {
    this.isGenerating = true
    this.updateGenerateButtonState()
    this.generatedResults = []

    const sceneDescription = this.getElement<HTMLTextAreaElement>('directorSceneInput')?.value.trim() || ''
    const imageCount = this.imageCount
    const layout = this.layouts[this.currentLayout]
    const panelCount = layout.rows * layout.cols

    this.clearResultsGrid()
    this.showProgress('正在分析参考图...')

    let successCount = 0

    try {
      // 分析参考图
      const imageAnalysis = await this.analyzeReferenceImage()
      this.lastAnalysisResult = imageAnalysis

      for (let i = 0; i < imageCount; i++) {
        this.updateProgress(i + 1, imageCount, `生成第 ${i + 1}/${imageCount} 张...`)

        try {
          const comicPrompt = await this.generateComicPrompt(imageAnalysis, sceneDescription, panelCount, layout)
          this.lastComicPrompt = comicPrompt

          const result = await this.generateComicPage(comicPrompt, layout)
          successCount++

          this.generatedResults.push({
            success: true,
            imageData: result,
            prompt: sceneDescription || '自动分析',
            index: i
          })
          this.addResultCard(this.generatedResults[this.generatedResults.length - 1], i)
        } catch (error: any) {
          this.generatedResults.push({
            success: false,
            error: error.message,
            prompt: sceneDescription || '自动分析',
            index: i
          })
          this.addResultCard(this.generatedResults[this.generatedResults.length - 1], i)
        }
      }

      this.hideProgress()
      this.updateResultsHeader(successCount, imageCount)

      if (successCount > 0) {
        this.showToast(`成功生成 ${successCount}/${imageCount} 张漫画页面！`, 'success')
        this.saveToHistory(sceneDescription, successCount)
      } else {
        this.showToast('所有图片生成失败，请重试', 'error')
      }
    } catch (error: any) {
      console.error('生成失败:', error)
      this.showToast('生成失败: ' + error.message, 'error')
      this.hideProgress()
    } finally {
      this.isGenerating = false
      this.updateGenerateButtonState()
    }
  }

  /**
   * 多提示词模式批量生成
   */
  private async startMultiGeneration(): Promise<void> {
    const multiSceneInput = this.getElement<HTMLTextAreaElement>('directorMultiSceneInput')
    const prompts = this.parseMultiPrompts(multiSceneInput?.value || '')

    if (prompts.length === 0) {
      this.showToast('请输入至少一个场景描述', 'warning')
      return
    }

    this.isGenerating = true
    this.updateGenerateButtonState()
    this.generatedResults = []

    const layout = this.layouts[this.currentLayout]
    const panelCount = layout.rows * layout.cols
    let successCount = 0

    this.clearResultsGrid()
    this.showProgress('正在分析参考图...')

    try {
      const imageAnalysis = await this.analyzeReferenceImage()
      this.lastAnalysisResult = imageAnalysis

      for (let i = 0; i < prompts.length; i++) {
        const sceneDescription = prompts[i]
        this.updateProgress(i + 1, prompts.length, `生成第 ${i + 1}/${prompts.length} 张...`)

        try {
          const comicPrompt = await this.generateComicPrompt(imageAnalysis, sceneDescription, panelCount, layout)
          const result = await this.generateComicPage(comicPrompt, layout)
          successCount++

          this.generatedResults.push({
            success: true,
            imageData: result,
            prompt: sceneDescription,
            index: i
          })
          this.addResultCard(this.generatedResults[this.generatedResults.length - 1], i)
        } catch (error: any) {
          this.generatedResults.push({
            success: false,
            error: error.message,
            prompt: sceneDescription,
            index: i
          })
          this.addResultCard(this.generatedResults[this.generatedResults.length - 1], i)
        }
      }

      this.hideProgress()
      this.updateResultsHeader(successCount, prompts.length)

      if (successCount > 0) {
        this.showToast(`批量生成完成！成功 ${successCount}/${prompts.length} 张`, 'success')
      }
    } catch (error: any) {
      console.error('批量生成失败:', error)
      this.showToast('批量生成失败: ' + error.message, 'error')
      this.hideProgress()
    } finally {
      this.isGenerating = false
      this.updateGenerateButtonState()
    }
  }

  /**
   * 分析参考图
   */
  private async analyzeReferenceImage(): Promise<string> {
    const api = this.getApi()
    if (!api?.visionApiKey) {
      const sceneInput = this.getElement<HTMLTextAreaElement>('directorSceneInput')?.value.trim()
      return sceneInput || '请详细描述图片中的场景、人物、环境和氛围。'
    }

    const images = this.referenceImages.map(img => ({
      base64: img.base64,
      mimeType: img.mimeType || 'image/jpeg'
    }))

    const analysisPrompt = images.length > 1
      ? `请详细分析这${images.length}张参考图片，包括人物特征、场景环境、画面构图、色调和风格。请用简洁的英文描述。`
      : '请详细分析这张图片，包括人物特征、场景环境、画面构图、色调和风格。请用简洁的英文描述。'

    return new Promise((resolve, reject) => {
      let result = ''

      api.analyzeImagesStream(
        images,
        analysisPrompt,
        'gemini-2.0-flash',
        null,
        (chunk: string) => { result += chunk },
        () => { resolve(result) },
        (error: Error) => {
          const sceneInput = this.getElement<HTMLTextAreaElement>('directorSceneInput')?.value.trim()
          if (sceneInput) {
            resolve(sceneInput)
          } else {
            reject(error)
          }
        }
      )
    })
  }

  /**
   * 生成分镜提示词
   */
  private async generateComicPrompt(
    imageAnalysis: string,
    sceneDescription: string,
    panelCount: number,
    layout: LayoutConfig
  ): Promise<string> {
    const userDescription = sceneDescription || imageAnalysis
    const viewAngles = this.generateViewAngles(panelCount)

    let templatePrefix = ''
    let templateSuffix = ''
    let templateNegative = ''

    const currentTemplateData = this.currentTemplate
      ? (this.styleTemplates[this.currentTemplate] || this.customTemplates[this.currentTemplate])
      : null

    if (currentTemplateData) {
      templatePrefix = currentTemplateData.prefix || ''
      templateSuffix = currentTemplateData.suffix || ''
      templateNegative = currentTemplateData.negative || ''
    }

    const panelPrompts = []
    for (let i = 0; i < panelCount; i++) {
      panelPrompts.push(`Panel ${i + 1}: ${viewAngles[i]}, ${userDescription}`)
    }

    let comicPrompt = `${templatePrefix}Create a single comic page image with ${panelCount} panels arranged in a ${layout.rows}x${layout.cols} grid layout.

Art Style: Maintain consistent art style throughout all panels. Professional manga/comic quality.

Panel Descriptions:
${panelPrompts.join('\n')}

Important Instructions:
- Each panel should have '分镜X' label in the top-left corner
- No speech bubbles, no dialogue text
- No timecode, no subtitles
- Consistent character appearance across all panels
- Clear panel borders with slight gaps between panels
- Cinematic lighting and composition
- High detail and quality rendering

Reference Image Analysis:
${imageAnalysis}

User Scene Description:
${sceneDescription || 'Based on reference image'}${templateSuffix}`

    if (templateNegative) {
      comicPrompt += `\n\nNegative prompt (avoid these): ${templateNegative}`
    }

    return comicPrompt
  }

  /**
   * 生成视角分配
   */
  private generateViewAngles(panelCount: number): string[] {
    const viewTypes = [
      'Over-the-Shoulder (OTS) shot',
      'Back View shot',
      'Point of View (POV) shot',
      'Extreme Close-up (ECU) on face/eyes',
      'Cowboy Shot (thigh-up)',
      'Full Body Shot',
      'Low Angle (heroic) shot',
      'High Angle (vulnerable) shot',
      'Dutch Angle (tilted) shot',
      'Upper Body Shot (chest-up)'
    ]

    const angles: string[] = []
    const requiredAngles = [
      'Over-the-Shoulder (OTS) shot',
      'Back View shot',
      'Point of View (POV) shot'
    ]

    for (let i = 0; i < Math.min(requiredAngles.length, panelCount); i++) {
      angles.push(requiredAngles[i])
    }

    while (angles.length < panelCount) {
      const randomIndex = Math.floor(Math.random() * viewTypes.length)
      angles.push(viewTypes[randomIndex])
    }

    // 打乱顺序
    for (let i = angles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[angles[i], angles[j]] = [angles[j], angles[i]]
    }

    return angles
  }

  /**
   * 生成漫画页面
   */
  private async generateComicPage(prompt: string, layout: LayoutConfig): Promise<string> {
    const preparedImages = this.referenceImages.map(img => ({
      base64: img.base64,
      mimeType: img.mimeType || 'image/jpeg'
    }))

    const ratio = this.currentRatio === 'auto' ? layout.ratio : this.currentRatio
    const api = this.getApi()

    const result = await api.generateImageWithReference(
      prompt,
      preparedImages,
      ratio,
      1,
      this.currentResolution
    )

    if (result.success && result.urls && result.urls.length > 0) {
      return result.urls[0]
    }

    throw new Error(result.error || '生成失败')
  }

  // ==================== 结果显示 ====================

  /**
   * 清空结果网格
   */
  private clearResultsGrid(): void {
    const emptyState = this.getElement<HTMLElement>('directorEmptyState')
    const grid = this.getElement<HTMLElement>('directorResultsGrid')

    if (emptyState) emptyState.classList.add('hidden')
    if (grid) {
      grid.classList.remove('hidden')
      grid.innerHTML = ''
    }
  }

  /**
   * 显示进度
   */
  private showProgress(message: string): void {
    const progressArea = this.getElement<HTMLElement>('directorProgressArea')
    const progressText = this.getElement<HTMLElement>('directorProgressText')

    if (progressArea) progressArea.classList.remove('hidden')
    if (progressText) progressText.textContent = message
  }

  /**
   * 更新进度
   */
  private updateProgress(current: number, total: number, message: string): void {
    const progressText = this.getElement<HTMLElement>('directorProgressText')
    const progressBar = this.getElement<HTMLElement>('directorProgressBar')

    if (progressText) progressText.textContent = message
    if (progressBar) {
      progressBar.style.width = `${(current / total) * 100}%`
    }
  }

  /**
   * 隐藏进度
   */
  private hideProgress(): void {
    const progressArea = this.getElement<HTMLElement>('directorProgressArea')
    if (progressArea) progressArea.classList.add('hidden')
  }

  /**
   * 添加结果卡片
   */
  private addResultCard(result: DirectorResult, index: number): void {
    const grid = this.getElement<HTMLElement>('directorResultsGrid')
    if (!grid) return

    const resultArea = this.getElement<HTMLElement>('directorResultArea')
    if (resultArea) resultArea.classList.remove('hidden')
    grid.classList.remove('hidden')

    const emptyState = this.getElement<HTMLElement>('directorEmptyState')
    if (emptyState) emptyState.classList.add('hidden')

    const card = document.createElement('div')
    card.className = 'bg-white bg-opacity-5 rounded-lg p-4 animate-fade-in'
    card.dataset.index = String(index)

    if (result.success && result.imageData) {
      const imageSrc = this.getImageSrc(result.imageData)
      card.innerHTML = `
        <div class="relative group">
          <img src="${imageSrc}" alt="漫画分镜 ${index + 1}" class="w-full h-48 object-cover rounded-lg mb-2" loading="lazy">
          <div class="absolute inset-0 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center space-x-2">
            <button class="download-single bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" data-index="${index}" title="下载图片">
              <i class="fas fa-download"></i>
            </button>
            <button class="preview-result bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" data-index="${index}" title="查看大图">
              <i class="fas fa-expand"></i>
            </button>
          </div>
        </div>
        <p class="text-white text-xs truncate">${result.prompt}</p>
        <div class="flex items-center justify-between mt-2">
          <span class="text-green-400 text-xs"><i class="fas fa-check-circle mr-1"></i>生成成功</span>
          <span class="text-gray-400 text-xs">#${index + 1}</span>
        </div>
      `

      // 绑定按钮事件
      const downloadBtn = card.querySelector('.download-single')
      if (downloadBtn) {
        downloadBtn.addEventListener('click', () => this.downloadSingleResult(index))
      }
      const previewBtn = card.querySelector('.preview-result')
      if (previewBtn) {
        previewBtn.addEventListener('click', () => this.previewResult(index))
      }
    } else {
      card.innerHTML = `
        <div class="h-48 bg-red-500 bg-opacity-20 rounded-lg flex items-center justify-center mb-2 relative">
          <i class="fas fa-exclamation-triangle text-red-400 text-2xl"></i>
          <div class="absolute top-1 right-1 text-gray-400 text-xs">#${index + 1}</div>
        </div>
        <p class="text-white text-xs truncate mb-2">${result.prompt}</p>
        <div class="bg-red-600 bg-opacity-20 rounded p-2">
          <p class="text-red-300 text-xs">${result.error || '生成失败'}</p>
        </div>
      `
    }

    grid.appendChild(card)
  }

  /**
   * 更新结果标题
   */
  private updateResultsHeader(successCount: number, totalCount: number): void {
    const countSpan = this.getElement<HTMLElement>('directorResultCount')
    const downloadAllBtn = this.getElement<HTMLElement>('directorDownloadAllBtn')

    if (countSpan) {
      countSpan.textContent = `成功 ${successCount}/${totalCount} 张`
    }
    if (downloadAllBtn) {
      if (successCount > 1) {
        downloadAllBtn.classList.remove('hidden')
      } else {
        downloadAllBtn.classList.add('hidden')
      }
    }
  }

  /**
   * 获取图片源
   */
  private getImageSrc(imageData: string): string {
    if (imageData.startsWith('data:') || imageData.startsWith('http')) {
      return imageData
    }
    return `data:image/png;base64,${imageData}`
  }

  // ==================== 下载功能 ====================

  /**
   * 下载结果
   */
  downloadResult(): void {
    if (this.generatedResults.length > 0) {
      this.downloadSingleResult(0)
    }
  }

  /**
   * 下载单张结果
   */
  downloadSingleResult(index: number): void {
    const result = this.generatedResults[index]
    if (!result?.success || !result.imageData) return

    const imageSrc = this.getImageSrc(result.imageData)
    const filename = `comic-panel-${index + 1}-${Date.now()}.png`
    this.downloadImage(imageSrc, filename)
  }

  /**
   * 下载图片
   */
  private downloadImage(src: string, filename: string): void {
    const a = document.createElement('a')
    a.href = src
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  /**
   * 预览结果
   */
  previewResult(index: number): void {
    const result = this.generatedResults[index]
    if (!result?.success || !result.imageData) return

    const imageSrc = this.getImageSrc(result.imageData)
    const viewImage = (this.app as any).viewImage
    if (viewImage) {
      viewImage([imageSrc], 0)
    } else {
      window.open(imageSrc, '_blank')
    }
  }

  /**
   * 下载全部结果
   */
  downloadAllResults(): void {
    const successResults = this.generatedResults.filter(r => r.success)
    if (successResults.length === 0) {
      this.showToast('没有可下载的图片', 'warning')
      return
    }

    this.showToast(`开始下载 ${successResults.length} 张图片...`, 'info')

    successResults.forEach((result, i) => {
      setTimeout(() => {
        if (result.imageData) {
          const imageSrc = this.getImageSrc(result.imageData)
          const filename = `comic-panel-${result.index + 1}-${Date.now()}.png`
          this.downloadImage(imageSrc, filename)
        }
      }, i * 500)
    })
  }

  /**
   * 保存到历史记录
   */
  private saveToHistory(description: string, successCount: number): void {
    try {
      const successUrls = this.generatedResults
        .filter(r => r.success && r.imageData)
        .map(r => r.imageData!)

      this.app.addToHistory(
        'director',
        description || '导演模式 - 自动分析',
        successUrls,
        this.currentRatio
      )
      console.log('✅ 导演模式结果已保存到历史记录')
    } catch (error) {
      console.error('保存历史记录失败:', error)
    }
  }

  // ==================== 状态管理 ====================

  /**
   * 收集状态
   */
  collectState(): DirectorPageState {
    const sceneInput = this.getElement<HTMLTextAreaElement>('directorSceneInput')
    const multiSceneInput = this.getElement<HTMLTextAreaElement>('directorMultiSceneInput')
    const imageCountSlider = this.getElement<HTMLInputElement>('directorImageCount')

    return {
      mode: this.currentMode,
      layout: this.currentLayout,
      ratio: this.currentRatio,
      resolution: this.currentResolution,
      template: this.currentTemplate,
      imageCount: imageCountSlider?.value || '1',
      sceneDescription: sceneInput?.value || '',
      multiScenePrompts: multiSceneInput?.value || '',
      referenceImages: this.referenceImages.map(img => ({
        base64: img.base64,
        fileName: img.fileName,
        fileSize: img.fileSize,
        mimeType: img.mimeType
      }))
    }
  }

  /**
   * 应用状态
   */
  applyState(state: DirectorPageState): void {
    if (state.mode) {
      this.currentMode = state.mode
      this.switchMode(state.mode)
    }

    if (state.layout) {
      this.currentLayout = state.layout
      this.selectLayout(state.layout)
    }

    if (state.ratio) this.currentRatio = state.ratio
    if (state.resolution) this.currentResolution = state.resolution
    if (state.template) this.selectTemplate(state.template)

    if (state.imageCount) {
      const slider = this.getElement<HTMLInputElement>('directorImageCount')
      if (slider) {
        slider.value = state.imageCount
        this.imageCount = parseInt(state.imageCount)
        this.updateImageCountDisplay()
      }
    }

    if (state.sceneDescription) {
      const input = this.getElement<HTMLTextAreaElement>('directorSceneInput')
      if (input) input.value = state.sceneDescription
    }

    if (state.multiScenePrompts) {
      const input = this.getElement<HTMLTextAreaElement>('directorMultiSceneInput')
      if (input) {
        input.value = state.multiScenePrompts
        this.updatePromptCount()
      }
    }

    if (state.referenceImages?.length) {
      this.referenceImages = state.referenceImages.filter(img => img?.base64) as DirectorReferenceImage[]
      this.updateReferenceImagesPreview()
    }

    this.stateRestored = true
  }

  /**
   * 保存页面状态
   */
  saveState(): void {
    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager?.savePageState) {
      pageStateManager.savePageState('director', this.collectState())
    }
  }

  /**
   * 恢复页面状态
   */
  async restoreState(): Promise<void> {
    if (this.stateRestored) return

    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager?.getPageState) {
      const state = pageStateManager.getPageState('director') as DirectorPageState | null
      if (state) {
        this.applyState(state)
        console.log('📥 恢复 DirectorPage 状态:', state)
      }
    }

    this.stateRestored = true
  }

  /**
   * 保存当前状态
   */
  saveCurrentState(): void {
    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager?.saveState) {
      pageStateManager.saveState('director', this.collectState())
    }
  }

  // ==================== 页面生命周期 ====================

  /**
   * 页面激活
   */
  onActivate(): void {
    console.log('导演模式页面已激活')

    this.updateLayoutSelection()
    this.updateGenerateButtonState()

    this.requestIdleCallback(() => {
      if (!this.stateRestored) {
        this.restoreState()
      }
      this.switchMode(this.currentMode)
      this.restoreResultsDisplay()
    }, { timeout: 1000 })
  }

  /**
   * 恢复结果显示
   */
  private restoreResultsDisplay(): void {
    const grid = this.getElement<HTMLElement>('directorResultsGrid')
    const emptyState = this.getElement<HTMLElement>('directorEmptyState')

    if (this.generatedResults?.length > 0) {
      if (grid) {
        grid.innerHTML = ''
        grid.classList.remove('hidden')
      }
      if (emptyState) emptyState.classList.add('hidden')

      this.generatedResults.forEach((result, index) => {
        this.addResultCard(result, index)
      })

      const successCount = this.generatedResults.filter(r => r.success).length
      this.updateResultsHeader(successCount, this.generatedResults.length)
    } else {
      this.showEmptyState()
    }
  }

  /**
   * 显示空状态
   */
  private showEmptyState(): void {
    const emptyState = this.getElement<HTMLElement>('directorEmptyState')
    const grid = this.getElement<HTMLElement>('directorResultsGrid')

    if (emptyState) emptyState.classList.remove('hidden')
    if (grid) grid.classList.add('hidden')
  }

  /**
   * 页面停用
   */
  onDeactivate(): void {
    this.saveCurrentState()
    console.log('导演模式页面已停用')
  }

  /**
   * 语言切换
   */
  onLanguageChange(): void {
    this.updateLayoutSelection()
  }

  /**
   * 销毁页面
   */
  destroy(): void {
    this.saveCurrentState()
    this.referenceImages = []
    this.generatedResults = []
    super.destroy()
  }

  // ==================== Getter 方法 ====================

  getReferenceImagesCount(): number {
    return this.referenceImages.length
  }

  getCurrentLayout(): LayoutType {
    return this.currentLayout
  }

  getCurrentMode(): GenerationMode {
    return this.currentMode
  }

  getIsGenerating(): boolean {
    return this.isGenerating
  }

  getGeneratedResultsCount(): number {
    return this.generatedResults.length
  }
}

// 工厂函数
let directorPageInstance: DirectorPage | null = null

export function createDirectorPage(app: AppInterface): DirectorPage {
  directorPageInstance = new DirectorPage(app)
  return directorPageInstance
}

export function getDirectorPage(): DirectorPage | null {
  return directorPageInstance
}

export default DirectorPage
