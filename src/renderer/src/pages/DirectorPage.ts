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
  private currentModalType: 'analysis' | 'prompt' | null = null
  private modalEscHandler: ((e: KeyboardEvent) => void) | null = null

  // 图库
  private gallerySelectedImages: string[] = []
  private customGalleryImages: CustomGalleryImage[] = []
  private galleryEditMode: boolean = false
  private galleryDeleteSelection: string[] = []
  private exampleGalleryCount: number = 38
  private exampleGalleryPath: string = 'assets/templates/'

  // 模板管理
  private customTemplates: StyleTemplates = {}
  private templateOverrides: StyleTemplates = {}
  private editingTemplateKey: string | null = null
  private editingTemplateIsBuiltin: boolean = false

  // 风格模板库 - 名称将在 getTemplateDisplayName() 中国际化
  private styleTemplates: StyleTemplates = {
    anime: {
      name: 'anime', // i18n key: director.templates.styles.anime
      prefix: 'anime screencap, TV anime, storyboard panel, sequential storytelling, narrative composition, ',
      suffix: ', masterpiece, best quality, absurdres, very aesthetic, full color, anime cel shading, TV anime coloring',
      negative: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks'
    },
    manga: {
      name: 'manga', // i18n key: director.templates.styles.manga
      prefix: 'manga panel, comic storyboard, sequential art, black and white manga, screentone, ',
      suffix: ', masterpiece, best quality, manga style, high contrast, dynamic lines, speech bubbles layout',
      negative: 'blurry, lowres, bad anatomy, worst quality, color, photorealistic, 3d render'
    },
    movie: {
      name: 'movie', // i18n key: director.templates.styles.movie
      prefix: 'cinematic storyboard, film still, movie scene, cinematography, ',
      suffix: ', masterpiece, best quality, cinematic lighting, depth of field, widescreen, film grain, color grading',
      negative: 'anime, cartoon, illustration, bad anatomy, worst quality, low quality'
    },
    webtoon: {
      name: 'webtoon', // i18n key: director.templates.styles.webtoon
      prefix: 'webtoon style, korean manhwa, full color comic, vertical scroll format, ',
      suffix: ', masterpiece, best quality, soft shading, clean lineart, vibrant colors, romantic atmosphere',
      negative: 'blurry, lowres, bad anatomy, worst quality, black and white, monochrome'
    },
    comic: {
      name: 'comic', // i18n key: director.templates.styles.comic
      prefix: 'american comic style, superhero comic, comic book panel, bold lineart, ',
      suffix: ', masterpiece, best quality, dynamic pose, strong contrast, halftone dots, action scene',
      negative: 'blurry, lowres, bad anatomy, worst quality, anime style, soft shading'
    },
    illustration: {
      name: 'illustration', // i18n key: director.templates.styles.illustration
      prefix: 'illustration, detailed artwork, artistic composition, ',
      suffix: ', masterpiece, best quality, highly detailed, beautiful lighting, artistic, professional illustration',
      negative: 'blurry, lowres, bad anatomy, worst quality, bad quality, simple background'
    }
  }

  private defaultStyleTemplates: StyleTemplates

  // 布局配置 - 名称和描述将在 getLayoutDisplayName/Description() 中国际化
  private layouts: LayoutConfigs = {
    '6grid': {
      rows: 2,
      cols: 3,
      name: '6grid', // i18n key: director.layouts.6grid.name
      description: '6grid', // i18n key: director.layouts.6grid.description
      ratio: '3:2'
    },
    '4grid': {
      rows: 2,
      cols: 2,
      name: '4grid', // i18n key: director.layouts.4grid.name
      description: '4grid', // i18n key: director.layouts.4grid.description
      ratio: '1:1'
    },
    '2closeup': {
      rows: 1,
      cols: 2,
      name: '2closeup', // i18n key: director.layouts.2closeup.name
      description: '2closeup', // i18n key: director.layouts.2closeup.description
      ratio: '16:9'
    },
    '9grid': {
      rows: 3,
      cols: 3,
      name: '9grid', // i18n key: director.layouts.9grid.name
      description: '9grid', // i18n key: director.layouts.9grid.description
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
    
    // 初始化 UI 状态
    this.updateLayoutSelection()
    this.updateGenerateButtonState()
    
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
    console.log('[DirectorPage] 设置布局选择, 容器存在:', !!layoutContainer)
    
    if (layoutContainer) {
      layoutContainer.addEventListener('click', (e: MouseEvent) => {
        const card = (e.target as HTMLElement).closest('.layout-card') as HTMLElement | null
        console.log('[DirectorPage] 布局点击, 卡片:', card?.dataset.layout)
        if (card?.dataset.layout) {
          this.selectLayout(card.dataset.layout as LayoutType)
        }
      })
    }
    
    // 备用方案：直接绑定到每个布局卡片
    const cards = document.querySelectorAll<HTMLElement>('.layout-card[data-layout]')
    console.log('[DirectorPage] 找到布局卡片数量:', cards.length)
    cards.forEach(card => {
      card.addEventListener('click', () => {
        const layout = card.dataset.layout as LayoutType
        console.log('[DirectorPage] 直接点击布局:', layout)
        if (layout) {
          this.selectLayout(layout)
        }
      })
    })
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
            <p class="text-[#71717A] text-xs uppercase tracking-wide">${this.t('director.gallery.clickToAddImages') || '点击上方按钮添加您的图片'}</p>
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
    // HTML 中使用 directorGalleryGrid 而不是 builtinGalleryGrid
    const grid = this.getElement<HTMLElement>('directorGalleryGrid')
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
      <img src="${imagePath}" alt="${this.t('director.gallery.exampleImage', { index }) || `示例图片 ${index}`}" 
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
        this.showToast(this.t('director.messages.maxSelectImages', { max: this.maxReferenceImages }) || `最多选择 ${this.maxReferenceImages} 张图片`, 'warning')
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
      this.showToast(this.t('director.messages.selectAtLeastOne') || '请选择至少一张图片', 'warning')
      return
    }

    this.showToast(this.t('director.messages.loadingImages', { count: this.gallerySelectedImages.length }) || `正在加载 ${this.gallerySelectedImages.length} 张图片...`, 'info')

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
    this.showToast(this.t('director.messages.addedReferenceImages', { count: this.gallerySelectedImages.length }) || `已添加 ${this.gallerySelectedImages.length} 张参考图`, 'success')
  }

  // ==================== 模板管理 ====================

  /**
   * 加载用户模板
   */
  async loadUserTemplates(): Promise<void> {
    try {
      const electronAPI = (window as any).electronAPI

      if (electronAPI?.isElectron) {
        // 使用正确的 API 名称
        const customTemplates = await electronAPI.loadCustomTemplates?.()
        const templateOverrides = await electronAPI.loadTemplateOverrides?.()
        this.customTemplates = customTemplates || {}
        this.templateOverrides = templateOverrides || {}
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
  renderTemplateList(): void {
    const loading = document.getElementById('templateListLoading')
    const list = this.getElement<HTMLElement>('directorTemplateList')
    if (!list) return

    // 隐藏加载状态
    if (loading) loading.classList.add('hidden')

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

    if (list.children.length === 0) {
      list.innerHTML = `
        <div class="col-span-2 text-center py-8 text-[#A1A1AA]">
          <i class="fas fa-folder-open text-4xl mb-4"></i>
          <p>${this.t('director.templates.noTemplates') || '暂无模板'}</p>
        </div>
      `
    }
  }

  /**
   * 创建模板卡片
   */
  private createTemplateCard(key: string, template: StyleTemplate, isBuiltin: boolean): HTMLElement {
    const card = document.createElement('div')
    const isSelected = this.currentTemplate === key
    const isModified = this.templateOverrides[key] !== undefined

    card.className = `template-card cursor-pointer border-2 ${
      isSelected ? 'border-[#FCE300] bg-[#FCE300] bg-opacity-10' : 'border-[#3F3F46] hover:border-[#FCE300]'
    } bg-[#27272A] rounded-none p-4 transition-all relative group`
    card.dataset.template = key

    const modifiedText = this.t('director.templates.modified') || '已修改'
    const builtinText = this.t('director.templates.builtin') || '内置'
    const customText = this.t('director.templates.custom') || '自定义'
    const badgeHtml = isBuiltin 
      ? (isModified ? `<span class="ml-2 text-xs bg-[#FCE300] text-black px-1 font-bold uppercase">${modifiedText}</span>` : `<span class="text-xs text-[#A1A1AA]">${builtinText}</span>`)
      : `<span class="ml-2 text-xs bg-[#8B5CF6] text-white px-1 font-bold uppercase">${customText}</span>`

    const displayName = this.getTemplateDisplayName(key, template)
    card.innerHTML = `
      <div class="flex items-start justify-between">
        <div class="flex-1 min-w-0">
          <h4 class="font-bold text-[#FAFAFA] flex items-center uppercase tracking-tight">
            ${this.escapeHtmlText(displayName)}
            ${badgeHtml}
          </h4>
          <p class="text-[#A1A1AA] text-sm mt-1 line-clamp-2">${this.escapeHtmlText(template.prefix.substring(0, 80))}...</p>
        </div>
        <button class="edit-template-btn w-8 h-8 bg-[#3F3F46] hover:bg-[#FCE300] text-[#A1A1AA] hover:text-black rounded-none flex items-center justify-center transition-all cursor-pointer ml-2 flex-shrink-0"
                title="${this.t('director.buttons.edit') || '编辑'}">
          <i class="fas fa-edit text-sm"></i>
        </button>
      </div>
    `

    // 点击卡片选择模板
    card.addEventListener('click', (e) => {
      // 如果点击的是编辑按钮，不选择模板
      if ((e.target as HTMLElement).closest('.edit-template-btn')) {
        return
      }
      this.selectTemplate(key)
    })

    // 编辑按钮点击事件
    const editBtn = card.querySelector('.edit-template-btn')
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.openTemplateEditor(template, key, isBuiltin)
      })
    }

    return card
  }

  /**
   * HTML 文本转义
   */
  private escapeHtmlText(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  /**
   * 获取模板的国际化显示名称
   */
  private getTemplateDisplayName(key: string, template: StyleTemplate): string {
    // 内置模板使用 i18n key
    const builtinTemplateNames: Record<string, string> = {
      anime: this.t('director.templates.styles.anime') || '动画截图风格',
      manga: this.t('director.templates.styles.manga') || '漫画分镜风格',
      movie: this.t('director.templates.styles.movie') || '电影分镜风格',
      webtoon: this.t('director.templates.styles.webtoon') || '韩漫/条漫风格',
      comic: this.t('director.templates.styles.comic') || '美漫风格',
      illustration: this.t('director.templates.styles.illustration') || '插画风格'
    }
    
    // 如果是内置模板，返回国际化名称；否则返回自定义模板的原名
    if (builtinTemplateNames[key]) {
      return builtinTemplateNames[key]
    }
    return template.name
  }

  /**
   * 获取布局的国际化显示名称
   */
  private getLayoutDisplayName(layoutKey: string): string {
    const layoutNames: Record<string, string> = {
      '6grid': this.t('director.layouts.6grid.name') || '6格标准',
      '4grid': this.t('director.layouts.4grid.name') || '4格方正',
      '2closeup': this.t('director.layouts.2closeup.name') || '2格特写',
      '9grid': this.t('director.layouts.9grid.name') || '9格全景'
    }
    return layoutNames[layoutKey] || layoutKey
  }

  /**
   * 获取布局的国际化描述
   */
  private getLayoutDisplayDescription(layoutKey: string): string {
    const layoutDescriptions: Record<string, string> = {
      '6grid': this.t('director.layouts.6grid.description') || '2行×3列，适合完整故事',
      '4grid': this.t('director.layouts.4grid.description') || '2行×2列，适合转折场景',
      '2closeup': this.t('director.layouts.2closeup.description') || '1行×2列，适合表情特写',
      '9grid': this.t('director.layouts.9grid.description') || '3行×3列，适合动作场景'
    }
    return layoutDescriptions[layoutKey] || ''
  }

  /**
   * 选择模板
   */
  selectTemplate(templateKey: string): void {
    const template = this.styleTemplates[templateKey] || this.customTemplates[templateKey]
    if (!template) return

    this.currentTemplate = templateKey
    const displayName = this.getTemplateDisplayName(templateKey, template)

    const nameSpan = this.getElement<HTMLElement>('directorTemplateName')
    const clearBtn = this.getElement<HTMLElement>('directorClearTemplate')

    if (nameSpan) {
      nameSpan.textContent = displayName
      nameSpan.classList.add('text-pink-400')
    }
    if (clearBtn) {
      clearBtn.classList.remove('hidden')
    }

    this.hideTemplateModal()
    this.showToast(this.t('director.messages.templateSelected', { name: displayName }) || `已选择「${displayName}」模板`, 'success')
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
      nameSpan.textContent = this.t('director.templates.default') || '默认（无模板）'
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
      this.showToast(this.t('director.messages.maxUploadImages', { max: this.maxReferenceImages }) || `最多上传 ${this.maxReferenceImages} 张参考图`, 'warning')
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
          this.showToast(this.t('director.messages.maxUploadImages', { max: this.maxReferenceImages }) || `最多上传 ${this.maxReferenceImages} 张参考图`, 'warning')
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
        this.showToast(this.t('director.messages.uploadedImages', { count: successCount }) || `已上传 ${successCount} 张图片`, 'success')
      }
    } finally {
      this.isProcessingFiles = false
    }
  }

  /**
   * 处理单张图片上传
   */
  private async handleSingleImageUpload(file: File): Promise<void> {
    // 先压缩图片
    const compressedFile = await this.compressImage(file)
    
    // 转换为 base64
    const base64 = await this.fileToBase64(compressedFile)

    this.referenceImages.push({
      base64,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'image/jpeg',
      originalFile: compressedFile
    })
  }

  /**
   * 压缩图片
   * @param file 原始图片文件
   * @param maxSizeMB 最大文件大小（MB）
   * @param maxWidthOrHeight 最大宽度或高度（像素）
   * @returns 压缩后的文件，如果压缩失败则返回原文件
   */
  private async compressImage(
    file: File,
    maxSizeMB: number = 2,
    maxWidthOrHeight: number = 2048
  ): Promise<File> {
    // 检查 imageCompression 库是否存在
    const imageCompression = (window as any).imageCompression
    if (typeof imageCompression === 'undefined') {
      console.warn('[DirectorPage] 图片压缩库未加载，使用原图')
      return file
    }

    const options = {
      maxSizeMB,
      maxWidthOrHeight,
      useWebWorker: true,
      fileType: file.type
    }

    try {
      console.log(
        `[DirectorPage] 压缩图片: ${file.name}, 原始大小: ${(file.size / 1024 / 1024).toFixed(2)}MB`
      )
      const compressedFile = await imageCompression(file, options)
      console.log(
        `[DirectorPage] 压缩完成: ${(compressedFile.size / 1024 / 1024).toFixed(2)}MB`
      )
      return compressedFile
    } catch (error) {
      console.warn('[DirectorPage] 图片压缩失败，使用原图:', error)
      return file
    }
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

    // 当有多张参考图时显示"清空全部"按钮
    const clearAllText = this.t('director.buttons.clearAll') || '清空全部'
    const referenceImagesText = this.t('director.labels.referenceImages') || '参考图'
    const clearAllButton = this.referenceImages.length > 1 ? `
      <button onclick="window.directorPage?.clearAllReferenceImages()" 
              class="text-red-400 hover:text-red-300 text-xs transition-colors">
        <i class="fas fa-trash-alt mr-1"></i>${clearAllText}
      </button>
    ` : ''

    preview.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <span class="text-white text-sm opacity-70">
          <i class="fas fa-images mr-1"></i>
          ${referenceImagesText} (${this.referenceImages.length}/${this.maxReferenceImages})
        </span>
        ${clearAllButton}
      </div>
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
   * 清除所有参考图（旧方法名，保留兼容）
   */
  clearReferenceImage(): void {
    this.clearAllReferenceImages()
  }

  /**
   * 清空所有参考图
   * @public 供 onclick 调用
   */
  clearAllReferenceImages(): void {
    this.referenceImages = []
    this.updateReferenceImagesPreview()
    this.updateGenerateButtonState()
    this.saveCurrentState()
    this.showToast(this.t('director.messages.clearedAllReferenceImages') || '已清空所有参考图', 'info')
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
      if (btnSpan) btnSpan.textContent = this.t('director.buttons.generateSingle') || '一键生成漫画分镜'
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
      if (btnSpan) btnSpan.textContent = this.t('director.buttons.generateBatch') || '批量生成漫画分镜'

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
        // 选中状态：蓝色高亮
        card.classList.add('bg-blue-500', 'bg-opacity-30', 'ring-2', 'ring-blue-400')
        card.classList.remove('bg-[#09090B]', 'border', 'border-[#3F3F46]')
      } else {
        // 未选中状态：深色背景
        card.classList.remove('bg-blue-500', 'bg-opacity-30', 'ring-2', 'ring-blue-400')
        card.classList.add('bg-[#09090B]', 'border', 'border-[#3F3F46]')
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
      countSpan.textContent = this.t('director.labels.sceneCount', { count: prompts.length }) || `${prompts.length} 个场景`
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
      display.textContent = this.t('director.labels.imageCountDisplay', { count: this.imageCount }) || `${this.imageCount}张`
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
      this.showToast(this.t('director.messages.uploadReferenceFirst') || '请先上传参考图', 'warning')
      return
    }

    const api = this.getApi()
    if (!api?.apiKey) {
      this.showToast(this.t('director.messages.configureApiKey') || '请先在设置中配置 API Key', 'error')
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
    this.showProgress(this.t('director.progress.analyzingWithCount', { count: imageCount }) || `正在分析参考图... (将生成 ${imageCount} 张)`)

    // 总步骤：分析1 + 生成提示词1 + 生成图片N
    const totalSteps = 2 + imageCount
    let currentStep = 0
    let successCount = 0

    try {
      // Step 1: 分析参考图
      currentStep++
      this.updateProgress(currentStep, totalSteps, this.t('director.progress.analyzingReference') || '正在分析参考图...')
      const imageAnalysis = await this.analyzeReferenceImage()
      this.showAnalysisResult(imageAnalysis)

      // Step 2: 生成分镜提示词
      currentStep++
      this.updateProgress(currentStep, totalSteps, this.t('director.progress.generatingPrompt') || '正在生成分镜提示词...')
      const comicPrompt = await this.generateComicPrompt(imageAnalysis, sceneDescription, panelCount, layout)
      this.showPromptResult(comicPrompt)

      // Step 3-N: 生成多张漫画页面
      for (let i = 0; i < imageCount; i++) {
        currentStep++
        this.updateProgress(currentStep, totalSteps, this.t('director.progress.generatingComic', { current: i + 1, total: imageCount }) || `正在生成第 ${i + 1}/${imageCount} 张漫画...`)

        try {
          const result = await this.generateComicPage(comicPrompt, layout)
          successCount++

          this.generatedResults.push({
            success: true,
            imageData: result,
            prompt: sceneDescription || (this.t('director.labels.autoAnalysis') || '自动分析'),
            index: i
          })
          this.addResultCard(this.generatedResults[this.generatedResults.length - 1], i)
        } catch (error: any) {
          console.error(`第 ${i + 1} 张生成失败:`, error)
          this.generatedResults.push({
            success: false,
            error: error.message,
            prompt: sceneDescription || (this.t('director.labels.autoAnalysis') || '自动分析'),
            index: i
          })
          this.addResultCard(this.generatedResults[this.generatedResults.length - 1], i)
        }
      }

      this.hideProgress()
      this.updateResultsHeader(successCount, imageCount)

      if (successCount > 0) {
        this.showToast(this.t('director.messages.generateSuccess', { success: successCount, total: imageCount }) || `成功生成 ${successCount}/${imageCount} 张漫画页面！`, 'success')
        this.saveToHistory(sceneDescription, successCount)
      } else {
        this.showToast(this.t('director.messages.allGenerationFailed') || '所有图片生成失败，请重试', 'error')
      }
    } catch (error: any) {
      console.error('生成失败:', error)
      this.showToast((this.t('director.messages.generateFailed') || '生成失败: ') + error.message, 'error')
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
      this.showToast(this.t('director.messages.enterAtLeastOneScene') || '请输入至少一个场景描述', 'warning')
      return
    }

    this.isGenerating = true
    this.updateGenerateButtonState()
    this.generatedResults = []

    const layout = this.layouts[this.currentLayout]
    const panelCount = layout.rows * layout.cols
    
    // 总步骤：分析1次 + 每个场景2步（提示词+生成）
    const totalSteps = prompts.length * 2 + 1
    let currentStep = 0
    let successCount = 0

    this.clearResultsGrid()
    this.showProgress(this.t('director.progress.analyzingReference') || '正在分析参考图...')

    try {
      // Step 1: 分析参考图（只需一次）
      currentStep++
      this.updateProgress(currentStep, totalSteps, this.t('director.progress.analyzingReference') || '正在分析参考图...')
      const imageAnalysis = await this.analyzeReferenceImage()
      this.showAnalysisResult(imageAnalysis)

      // 为每个提示词生成漫画页面
      for (let i = 0; i < prompts.length; i++) {
        const sceneDescription = prompts[i]
        
        // 生成分镜提示词
        currentStep++
        this.updateProgress(currentStep, totalSteps, this.t('director.progress.buildingPrompt', { current: i + 1, total: prompts.length }) || `生成第 ${i + 1}/${prompts.length} 张：构建提示词...`)
        const comicPrompt = await this.generateComicPrompt(imageAnalysis, sceneDescription, panelCount, layout)
        this.showPromptResult(comicPrompt)

        // 生成漫画页面
        currentStep++
        this.updateProgress(currentStep, totalSteps, this.t('director.progress.generatingImage', { current: i + 1, total: prompts.length }) || `生成第 ${i + 1}/${prompts.length} 张：生成图片...`)
        
        try {
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
          console.error(`第 ${i + 1} 张生成失败:`, error)
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
        this.showToast(this.t('director.messages.batchGenerateSuccess', { success: successCount, total: prompts.length }) || `批量生成完成！成功 ${successCount}/${prompts.length} 张`, 'success')
      }
    } catch (error: any) {
      console.error('批量生成失败:', error)
      this.showToast((this.t('director.messages.batchGenerateFailed') || '批量生成失败: ') + error.message, 'error')
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
      const defaultDescription = this.t('director.prompts.defaultSceneDescription') || '请详细描述图片中的场景、人物、环境和氛围。'
      return sceneInput || defaultDescription
    }

    const images = this.referenceImages.map(img => ({
      base64: img.base64,
      mimeType: img.mimeType || 'image/jpeg'
    }))

    // Analysis prompts for vision API - these are intentionally detailed
    const multiImagePrompt = this.t('director.prompts.analyzeMultipleImages', { count: images.length }) || 
      `请详细分析这${images.length}张参考图片，包括：
1. 人物特征（面部特征、发型、衣着、姿态）
2. 场景环境（地点、光线、氛围）
3. 画面构图和视角
4. 色调和风格
5. 各图片之间的关联性和风格一致性

请用简洁的英文描述，以便后续生成分镜使用。`
    
    const singleImagePrompt = this.t('director.prompts.analyzeSingleImage') ||
      `请详细分析这张图片，包括：
1. 人物特征（面部特征、发型、衣着、姿态）
2. 场景环境（地点、光线、氛围）
3. 画面构图和视角
4. 色调和风格

请用简洁的英文描述，以便后续生成分镜使用。`

    const analysisPrompt = images.length > 1 ? multiImagePrompt : singleImagePrompt

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

    const panelPrompts: string[] = []
    for (let i = 0; i < panelCount; i++) {
      panelPrompts.push(`Panel ${i + 1}: ${viewAngles[i]}, ${userDescription}`)
    }

    let comicPrompt = `${templatePrefix}Create a single comic page image with ${panelCount} panels arranged in a ${layout.rows}x${layout.cols} grid layout.

Art Style: Maintain consistent art style throughout all panels. Professional manga/comic quality.

Panel Descriptions:
${panelPrompts.join('\n')}

Important Instructions:
- Each panel should have 'Panel X' label in the top-left corner
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

    throw new Error(result.error || (this.t('director.messages.generateFailedShort') || '生成失败'))
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
   * 显示进度 - 创建完整的进度 UI
   */
  private showProgress(message: string): void {
    const progressArea = this.getElement<HTMLElement>('directorProgressArea')
    const resultArea = this.getElement<HTMLElement>('directorResultArea')
    
    const analysisTitle = this.t('director.progress.analysisTitle') || '参考图分析结果'
    const promptTitle = this.t('director.progress.promptTitle') || '生成的提示词'
    const clickToView = this.t('director.assets.clickToView') || '点击查看'
    
    if (progressArea) {
      progressArea.classList.remove('hidden')
      progressArea.innerHTML = `
        <div class="text-center py-8">
          <div class="relative inline-block mb-4">
            <i class="fas fa-film text-6xl text-white opacity-30 animate-pulse"></i>
          </div>
          <p class="text-white text-lg mb-2" id="directorProgressText">${message}</p>
          <div class="w-64 h-2 bg-white bg-opacity-20 rounded-full mx-auto overflow-hidden">
            <div id="directorProgressBar" class="h-full bg-gradient-to-r from-blue-400 to-purple-500 rounded-full transition-all duration-500" style="width: 0%"></div>
          </div>
          <p class="text-white opacity-50 text-sm mt-2" id="directorProgressStep">${this.t('director.progress.step', { current: 1, total: 4 }) || '步骤 1/4'}</p>
          
          <!-- 资产面板容器（点击打开弹窗） -->
          <div class="mt-6 max-w-lg mx-auto space-y-3">
            <!-- 分析结果面板 -->
            <div id="directorAnalysisPanel" class="hidden bg-white bg-opacity-5 border border-white border-opacity-10 rounded-lg overflow-hidden cursor-pointer hover:bg-white hover:bg-opacity-10 transition-all duration-200"
                 onclick="window.directorPage?.showAssetModal('analysis')">
              <div class="flex justify-between items-center p-3">
                <span class="text-white text-sm font-medium flex items-center">
                  <i class="fas fa-search-plus mr-2 text-blue-400"></i>
                  ${analysisTitle}
                </span>
                <div class="flex items-center space-x-2">
                  <span class="text-white text-opacity-50 text-xs">${clickToView}</span>
                  <i class="fas fa-external-link-alt text-white text-opacity-50 text-xs"></i>
                </div>
              </div>
            </div>
            
            <!-- 提示词面板 -->
            <div id="directorPromptPanel" class="hidden bg-white bg-opacity-5 border border-white border-opacity-10 rounded-lg overflow-hidden cursor-pointer hover:bg-white hover:bg-opacity-10 transition-all duration-200"
                 onclick="window.directorPage?.showAssetModal('prompt')">
              <div class="flex justify-between items-center p-3">
                <span class="text-white text-sm font-medium flex items-center">
                  <i class="fas fa-magic mr-2 text-purple-400"></i>
                  ${promptTitle}
                </span>
                <div class="flex items-center space-x-2">
                  <span class="text-white text-opacity-50 text-xs">${clickToView}</span>
                  <i class="fas fa-external-link-alt text-white text-opacity-50 text-xs"></i>
                </div>
              </div>
            </div>
          </div>
        </div>
      `
    }

    if (resultArea) {
      resultArea.classList.add('hidden')
    }
  }

  /**
   * 更新进度
   */
  private updateProgress(current: number, total: number, message: string): void {
    const progressText = this.getElement<HTMLElement>('directorProgressText')
    const progressBar = this.getElement<HTMLElement>('directorProgressBar')
    const progressStep = this.getElement<HTMLElement>('directorProgressStep')

    if (progressText) progressText.textContent = message
    if (progressBar) {
      progressBar.style.width = `${(current / total) * 100}%`
    }
    if (progressStep) {
      progressStep.textContent = this.t('director.progress.step', { current, total }) || `步骤 ${current}/${total}`
    }
  }

  /**
   * 隐藏进度
   */
  private hideProgress(): void {
    const progressArea = this.getElement<HTMLElement>('directorProgressArea')
    const resultArea = this.getElement<HTMLElement>('directorResultArea')
    
    if (progressArea) {
      progressArea.classList.add('hidden')
    }
    
    // 恢复结果区域可见性
    if (resultArea) {
      resultArea.classList.remove('hidden')
    }
    
    // 渲染资产区域（分析结果和提示词卡片）
    this.renderAssetsSection()
  }

  /**
   * 显示分析结果（在进度区域显示面板）
   */
  private showAnalysisResult(analysis: string): void {
    this.lastAnalysisResult = analysis
    const panel = document.getElementById('directorAnalysisPanel')
    if (panel) {
      panel.classList.remove('hidden')
    }
  }

  /**
   * 显示提示词结果（在进度区域显示面板）
   */
  private showPromptResult(prompt: string): void {
    this.lastComicPrompt = prompt
    const panel = document.getElementById('directorPromptPanel')
    if (panel) {
      panel.classList.remove('hidden')
    }
  }

  /**
   * 渲染资产卡片区（在结果区域显示分析结果和提示词）
   */
  private renderAssetsSection(): void {
    const assetsSection = this.getElement<HTMLElement>('directorAssetsSection')
    if (!assetsSection) {
      console.warn('[DirectorPage] 资产区域元素不存在')
      return
    }
    
    // 如果没有任何资产数据，隐藏区域
    if (!this.lastAnalysisResult && !this.lastComicPrompt) {
      assetsSection.classList.add('hidden')
      return
    }
    
    const analysisTitle = this.t('director.assets.analysisCard') || '图像分析'
    const promptTitle = this.t('director.assets.promptCard') || '生成提示词'
    const clickToView = this.t('director.assets.clickToView') || '点击查看'
    
    let html = ''
    
    // 分析结果卡片（点击打开弹窗）
    if (this.lastAnalysisResult) {
      html += `
        <div class="bg-[#27272A] border border-white border-opacity-10 rounded-lg overflow-hidden cursor-pointer hover:bg-white hover:bg-opacity-5 transition-all duration-200"
             onclick="window.directorPage?.showAssetModal('analysis')">
          <div class="flex justify-between items-center p-3">
            <span class="text-white text-sm font-medium flex items-center">
              <i class="fas fa-search-plus mr-2 text-blue-400"></i>
              ${analysisTitle}
            </span>
            <div class="flex items-center space-x-2">
              <span class="text-white text-opacity-50 text-xs">${clickToView}</span>
              <i class="fas fa-external-link-alt text-white text-opacity-50 text-xs"></i>
            </div>
          </div>
        </div>
      `
    }
    
    // 提示词卡片（点击打开弹窗）
    if (this.lastComicPrompt) {
      html += `
        <div class="bg-[#27272A] border border-white border-opacity-10 rounded-lg overflow-hidden cursor-pointer hover:bg-white hover:bg-opacity-5 transition-all duration-200"
             onclick="window.directorPage?.showAssetModal('prompt')">
          <div class="flex justify-between items-center p-3">
            <span class="text-white text-sm font-medium flex items-center">
              <i class="fas fa-magic mr-2 text-purple-400"></i>
              ${promptTitle}
            </span>
            <div class="flex items-center space-x-2">
              <span class="text-white text-opacity-50 text-xs">${clickToView}</span>
              <i class="fas fa-external-link-alt text-white text-opacity-50 text-xs"></i>
            </div>
          </div>
        </div>
      `
    }
    
    assetsSection.innerHTML = html
    assetsSection.classList.remove('hidden')
    
    console.log('[DirectorPage] 资产区域已渲染:', {
      hasAnalysis: !!this.lastAnalysisResult,
      hasPrompt: !!this.lastComicPrompt
    })
  }

  /**
   * 显示资产弹窗
   */
  showAssetModal(type: 'analysis' | 'prompt'): void {
    const modal = document.getElementById('directorAssetModal')
    const titleIcon = document.getElementById('assetModalIcon')
    const titleText = document.getElementById('assetModalTitleText')
    const content = document.getElementById('assetModalContent')
    
    if (!modal || !content) {
      console.warn('[DirectorPage] 资产弹窗元素不存在')
      return
    }
    
    // 设置当前显示的资产类型
    this.currentModalType = type
    
    if (type === 'analysis') {
      if (titleIcon) titleIcon.className = 'fas fa-search-plus mr-2 text-blue-400'
      if (titleText) titleText.textContent = this.t('director.assets.analysisCard') || '图像分析'
      content.textContent = this.lastAnalysisResult || (this.t('director.progress.noAnalysis') || '未进行图像分析')
    } else if (type === 'prompt') {
      if (titleIcon) titleIcon.className = 'fas fa-magic mr-2 text-purple-400'
      if (titleText) titleText.textContent = this.t('director.assets.promptCard') || '生成提示词'
      content.textContent = this.lastComicPrompt || ''
    }
    
    // 显示弹窗
    modal.classList.remove('hidden')
    
    // 添加 ESC 键关闭
    this.modalEscHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeAssetModal()
      }
    }
    document.addEventListener('keydown', this.modalEscHandler)
    
    // 点击背景关闭
    modal.onclick = (e) => {
      if (e.target === modal) {
        this.closeAssetModal()
      }
    }
    
    console.log('[DirectorPage] 打开资产弹窗:', type)
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
      const comicPanelAlt = this.t('director.labels.comicPanel', { index: index + 1 }) || `漫画分镜 ${index + 1}`
      const downloadTitle = this.t('director.buttons.downloadImage') || '下载图片'
      const viewTitle = this.t('director.buttons.viewLarge') || '查看大图'
      const successText = this.t('director.labels.generateSuccess') || '生成成功'
      card.innerHTML = `
        <div class="relative group">
          <img src="${imageSrc}" alt="${comicPanelAlt}" class="w-full h-48 object-cover rounded-lg mb-2" loading="lazy">
          <div class="absolute inset-0 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center space-x-2">
            <button class="download-single bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" data-index="${index}" title="${downloadTitle}">
              <i class="fas fa-download"></i>
            </button>
            <button class="preview-result bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" data-index="${index}" title="${viewTitle}">
              <i class="fas fa-expand"></i>
            </button>
          </div>
        </div>
        <p class="text-white text-xs truncate">${result.prompt}</p>
        <div class="flex items-center justify-between mt-2">
          <span class="text-green-400 text-xs"><i class="fas fa-check-circle mr-1"></i>${successText}</span>
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
      const failedText = this.t('director.labels.generateFailed') || '生成失败'
      card.innerHTML = `
        <div class="h-48 bg-red-500 bg-opacity-20 rounded-lg flex items-center justify-center mb-2 relative">
          <i class="fas fa-exclamation-triangle text-red-400 text-2xl"></i>
          <div class="absolute top-1 right-1 text-gray-400 text-xs">#${index + 1}</div>
        </div>
        <p class="text-white text-xs truncate mb-2">${result.prompt}</p>
        <div class="bg-red-600 bg-opacity-20 rounded p-2">
          <p class="text-red-300 text-xs">${result.error || failedText}</p>
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
      countSpan.textContent = this.t('director.labels.successCount', { success: successCount, total: totalCount }) || `成功 ${successCount}/${totalCount} 张`
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
      this.showToast(this.t('director.messages.noDownloadableImages') || '没有可下载的图片', 'warning')
      return
    }

    this.showToast(this.t('director.messages.startDownloading', { count: successResults.length }) || `开始下载 ${successResults.length} 张图片...`, 'info')

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

  // ==================== 结果导航方法 ====================

  /**
   * 显示单图结果
   */
  showResult(imageData: string): void {
    const progressArea = this.getElement<HTMLElement>('directorProgressArea')
    const resultArea = this.getElement<HTMLElement>('directorResultArea')

    if (progressArea) progressArea.classList.add('hidden')

    if (resultArea) {
      resultArea.classList.remove('hidden')
      
      const imageSrc = this.getImageSrc(imageData)

      resultArea.innerHTML = `
        <div class="space-y-4">
          <div class="relative group">
            <img src="${imageSrc}" 
                 alt="${this.t('director.labels.generatedComicPage') || '生成的漫画页面'}" 
                 class="w-full rounded-lg shadow-lg cursor-pointer"
                 onclick="window.directorPage?.previewCurrentResult()">
            <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all rounded-lg flex items-center justify-center">
              <i class="fas fa-search-plus text-white text-3xl opacity-0 group-hover:opacity-100 transition-opacity"></i>
            </div>
          </div>
          <div class="flex justify-center space-x-4">
            <button id="directorDownloadBtn" 
                    class="px-6 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors">
              <i class="fas fa-download mr-2"></i>${this.t('director.buttons.downloadImage') || '下载图片'}
            </button>
            <button id="directorRegenerateBtn" 
                    class="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors">
              <i class="fas fa-redo mr-2"></i>${this.t('director.buttons.regenerate') || '重新生成'}
            </button>
          </div>
        </div>
      `

      // 重新绑定按钮事件
      document.getElementById('directorDownloadBtn')?.addEventListener('click', () => this.downloadCurrentResult())
      document.getElementById('directorRegenerateBtn')?.addEventListener('click', () => this.startGeneration())
    }
  }

  /**
   * 显示多图结果（主图+缩略图导航+左右箭头）
   */
  showMultiResults(): void {
    const progressArea = this.getElement<HTMLElement>('directorProgressArea')
    const resultArea = this.getElement<HTMLElement>('directorResultArea')

    if (progressArea) progressArea.classList.add('hidden')

    if (!resultArea) return

    const successResults = this.generatedResults.filter(r => r.success)
    const totalCount = this.generatedResults.length
    const successCount = successResults.length

    if (successCount === 0) {
      resultArea.classList.add('hidden')
      return
    }

    resultArea.classList.remove('hidden')
    
    // 找到第一个成功的结果
    while (this.currentResultIndex < this.generatedResults.length && !this.generatedResults[this.currentResultIndex].success) {
      this.currentResultIndex++
    }
    if (this.currentResultIndex >= this.generatedResults.length) {
      this.currentResultIndex = this.generatedResults.findIndex(r => r.success)
    }

    const currentResult = this.generatedResults[this.currentResultIndex]
    const imageSrc = currentResult?.imageData ? this.getImageSrc(currentResult.imageData) : ''

    // 生成缩略图
    let thumbnailsHtml = ''
    this.generatedResults.forEach((result, index) => {
      if (result.success && result.imageData) {
        const thumbSrc = this.getImageSrc(result.imageData)
        const isActive = index === this.currentResultIndex
        const thumbAlt = this.t('director.labels.imageNumber', { index: index + 1 }) || `第${index + 1}张`
        thumbnailsHtml += `
          <div class="cursor-pointer rounded-lg overflow-hidden border-2 transition-all ${isActive ? 'border-blue-400 ring-2 ring-blue-400' : 'border-transparent opacity-60 hover:opacity-100'}"
               onclick="window.directorPage?.switchToResult(${index})">
            <img src="${thumbSrc}" alt="${thumbAlt}" class="w-16 h-16 object-cover">
          </div>
        `
      } else {
        thumbnailsHtml += `
          <div class="rounded-lg overflow-hidden border-2 border-red-400 opacity-50 cursor-not-allowed">
            <div class="w-16 h-16 bg-red-500 bg-opacity-20 flex items-center justify-center">
              <i class="fas fa-times text-red-400"></i>
            </div>
          </div>
        `
      }
    })

    const successCountText = this.t('director.labels.successCount', { success: successCount, total: totalCount }) || `成功 ${successCount}/${totalCount} 张`
    const currentCountText = this.t('director.labels.currentImage', { current: this.currentResultIndex + 1, total: totalCount }) || `第 ${this.currentResultIndex + 1}/${totalCount} 张`
    const downloadCurrentText = this.t('director.buttons.downloadCurrent') || '下载当前'
    const downloadAllText = this.t('director.buttons.downloadAll') || '下载全部'
    const regenerateText = this.t('director.buttons.regenerate') || '重新生成'
    
    resultArea.innerHTML = `
      <div class="space-y-4">
        <!-- 统计信息 -->
        <div class="flex items-center justify-between text-white">
          <span class="opacity-70">
            <i class="fas fa-images mr-2"></i>
            ${successCountText}
          </span>
          <span class="text-sm opacity-50" id="directorResultCounter">
            ${currentCountText}
          </span>
        </div>

        <!-- 主图显示 -->
        <div class="relative group">
          <img id="directorMainImage" 
               src="${imageSrc}" 
               alt="${this.t('director.labels.generatedComicPage') || '生成的漫画页面'}" 
               class="w-full rounded-lg shadow-lg cursor-pointer"
               onclick="window.directorPage?.previewCurrentResult()">
          <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all rounded-lg flex items-center justify-center">
            <i class="fas fa-search-plus text-white text-3xl opacity-0 group-hover:opacity-100 transition-opacity"></i>
          </div>
          
          <!-- 左右切换按钮 -->
          <button class="absolute left-2 top-1/2 -translate-y-1/2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white rounded-full w-10 h-10 flex items-center justify-center transition-all"
                  onclick="window.directorPage?.navigateResult(-1)">
            <i class="fas fa-chevron-left"></i>
          </button>
          <button class="absolute right-2 top-1/2 -translate-y-1/2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white rounded-full w-10 h-10 flex items-center justify-center transition-all"
                  onclick="window.directorPage?.navigateResult(1)">
            <i class="fas fa-chevron-right"></i>
          </button>
        </div>

        <!-- 场景描述 -->
        <div class="bg-white bg-opacity-10 rounded-lg p-3">
          <p class="text-white text-sm opacity-70" id="directorCurrentPrompt">${this.escapeHtmlText(currentResult?.prompt || '')}</p>
        </div>

        <!-- 缩略图列表 -->
        <div class="flex space-x-2 overflow-x-auto pb-2" id="directorThumbnails">
          ${thumbnailsHtml}
        </div>

        <!-- 操作按钮 -->
        <div class="flex justify-center space-x-4 flex-wrap gap-2">
          <button id="directorDownloadCurrentBtn" 
                  class="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors text-sm">
            <i class="fas fa-download mr-2"></i>${downloadCurrentText}
          </button>
          <button id="directorDownloadAllBtn" 
                  class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors text-sm">
            <i class="fas fa-file-archive mr-2"></i>${downloadAllText} (${successCount})
          </button>
          <button id="directorRegenerateBtn" 
                  class="px-4 py-2 bg-purple-500 hover:bg-purple-600 text-white rounded-lg transition-colors text-sm">
            <i class="fas fa-redo mr-2"></i>${regenerateText}
          </button>
        </div>
      </div>
    `

    // 绑定按钮事件
    document.getElementById('directorDownloadCurrentBtn')?.addEventListener('click', () => this.downloadCurrentResult())
    document.getElementById('directorDownloadAllBtn')?.addEventListener('click', () => this.downloadAllResults())
    document.getElementById('directorRegenerateBtn')?.addEventListener('click', () => this.startGeneration())
  }

  /**
   * 切换到指定结果
   * @public 供 onclick 调用
   */
  switchToResult(index: number): void {
    if (index >= 0 && index < this.generatedResults.length && this.generatedResults[index].success) {
      this.currentResultIndex = index
      this.updateCurrentResultDisplay()
    }
  }

  /**
   * 导航结果（上一张/下一张，循环）
   * @public 供 onclick 调用
   */
  navigateResult(direction: number): void {
    let newIndex = this.currentResultIndex + direction
    
    // 循环查找下一个成功的结果
    const maxAttempts = this.generatedResults.length
    let attempts = 0
    
    while (attempts < maxAttempts) {
      if (newIndex < 0) newIndex = this.generatedResults.length - 1
      if (newIndex >= this.generatedResults.length) newIndex = 0
      
      if (this.generatedResults[newIndex].success) {
        this.currentResultIndex = newIndex
        this.updateCurrentResultDisplay()
        return
      }
      
      newIndex += direction
      attempts++
    }
  }

  /**
   * 更新当前结果显示（主图和缩略图高亮）
   */
  updateCurrentResultDisplay(): void {
    const currentResult = this.generatedResults[this.currentResultIndex]
    if (!currentResult || !currentResult.success || !currentResult.imageData) return

    // 更新主图
    const mainImage = document.getElementById('directorMainImage') as HTMLImageElement | null
    if (mainImage) {
      mainImage.src = this.getImageSrc(currentResult.imageData)
    }

    // 更新场景描述
    const promptEl = document.getElementById('directorCurrentPrompt')
    if (promptEl) {
      promptEl.textContent = currentResult.prompt || ''
    }

    // 更新缩略图高亮
    const thumbnails = document.querySelectorAll('#directorThumbnails > div')
    thumbnails.forEach((thumb, index) => {
      if (this.generatedResults[index]?.success) {
        if (index === this.currentResultIndex) {
          thumb.className = 'cursor-pointer rounded-lg overflow-hidden border-2 transition-all border-blue-400 ring-2 ring-blue-400'
        } else {
          thumb.className = 'cursor-pointer rounded-lg overflow-hidden border-2 transition-all border-transparent opacity-60 hover:opacity-100'
        }
      }
    })

    // 更新计数
    const counterEl = document.getElementById('directorResultCounter')
    if (counterEl) {
      counterEl.textContent = this.t('director.labels.currentImage', { current: this.currentResultIndex + 1, total: this.generatedResults.length }) || `第 ${this.currentResultIndex + 1}/${this.generatedResults.length} 张`
    }
  }

  /**
   * 下载当前显示的结果
   * @public 供 onclick 调用
   */
  downloadCurrentResult(): void {
    const currentResult = this.generatedResults[this.currentResultIndex]
    if (!currentResult || !currentResult.success || !currentResult.imageData) {
      this.showToast(this.t('director.messages.cannotDownloadCurrent') || '当前图片无法下载', 'warning')
      return
    }

    const imageSrc = this.getImageSrc(currentResult.imageData)
    const filename = `comic_page_${this.currentLayout}_${this.currentResultIndex + 1}_${Date.now()}.png`
    this.downloadImage(imageSrc, filename)
  }

  /**
   * 预览当前结果
   * @public 供 onclick 调用
   */
  previewCurrentResult(): void {
    const currentResult = this.generatedResults[this.currentResultIndex]
    if (!currentResult?.success || !currentResult.imageData) return

    const imageSrc = this.getImageSrc(currentResult.imageData)
    this.previewImage(imageSrc)
  }

  /**
   * 全屏预览图片
   * @public 供外部调用
   * @param imageSrc 图片源（URL 或 base64）
   */
  public previewImage(imageSrc: string): void {
    // 创建遮罩层
    const overlay = document.createElement('div')
    overlay.className = 'fixed inset-0 flex items-center justify-center cursor-pointer'
    overlay.style.cssText = `
      z-index: 70000;
      background-color: rgba(0, 0, 0, 0.9);
      opacity: 0;
      transition: opacity 0.3s ease-in-out;
    `

    // 创建图片元素
    const img = document.createElement('img')
    img.src = imageSrc
    img.className = 'object-contain'
    img.style.cssText = `
      max-width: 90vw;
      max-height: 90vh;
      opacity: 0;
      transform: scale(0.9);
      transition: opacity 0.3s ease-in-out, transform 0.3s ease-in-out;
    `
    // 阻止点击图片关闭
    img.onclick = (e: MouseEvent) => e.stopPropagation()

    // 创建关闭按钮
    const closeBtn = document.createElement('button')
    closeBtn.className = 'absolute top-4 right-4 text-white text-3xl hover:text-gray-300 transition-colors'
    closeBtn.style.cssText = `
      background: none;
      border: none;
      cursor: pointer;
      padding: 8px;
      line-height: 1;
    `
    closeBtn.innerHTML = '<i class="fas fa-times"></i>'
    closeBtn.onclick = (e: MouseEvent) => {
      e.stopPropagation()
      closeOverlay()
    }

    // 关闭函数（带动画）
    const closeOverlay = (): void => {
      // 移除 ESC 事件监听
      document.removeEventListener('keydown', escHandler)
      
      // 渐出动画
      overlay.style.opacity = '0'
      img.style.opacity = '0'
      img.style.transform = 'scale(0.9)'
      
      // 动画结束后移除元素
      setTimeout(() => {
        if (overlay.parentNode) {
          overlay.remove()
        }
      }, 300)
    }

    // ESC 键关闭
    const escHandler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        closeOverlay()
      }
    }
    document.addEventListener('keydown', escHandler)

    // 点击遮罩层关闭
    overlay.onclick = () => closeOverlay()

    // 组装并添加到 DOM
    overlay.appendChild(img)
    overlay.appendChild(closeBtn)
    document.body.appendChild(overlay)

    // 触发渐入动画（需要在下一帧执行）
    requestAnimationFrame(() => {
      overlay.style.opacity = '1'
      img.style.opacity = '1'
      img.style.transform = 'scale(1)'
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
        description || (this.t('director.labels.directorModeAutoAnalysis') || '导演模式 - 自动分析'),
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

  /**
   * 立即保存状态（无防抖，用于页面失活时）
   */
  private saveCurrentStateImmediate(): void {
    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager?.savePageState) {
      pageStateManager.savePageState('director', this.collectState())
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
    console.log('导演模式页面已失活')
    this.saveCurrentStateImmediate()
  }

  /**
   * 语言切换
   */
  onLanguageChange(): void {
    this.updateLayoutSelection()
  }

  // ==================== 资产弹窗方法 ====================

  /**
   * 关闭资产弹窗
   */
  closeAssetModal(): void {
    const modal = document.getElementById('directorAssetModal')
    if (modal) {
      modal.classList.add('hidden')
    }
    console.log('[DirectorPage] 关闭资产弹窗')
  }

  /**
   * 复制弹窗内容
   */
  async copyModalContent(): Promise<void> {
    const content = this.lastAnalysisResult || this.lastComicPrompt
    
    if (!content) {
      this.app.showToast?.(this.t('director.messages.noCopyContent') || '没有可复制的内容', 'warning')
      return
    }
    
    try {
      await navigator.clipboard.writeText(content)
      this.app.showToast?.(this.t('common.copySuccess') || '已复制到剪贴板', 'success')
    } catch (error) {
      console.error('[DirectorPage] 复制失败:', error)
      this.app.showToast?.(this.t('common.copyFailed') || '复制失败', 'error')
    }
  }

  // ==================== 图库编辑模式方法 ====================

  /**
   * 切换图库编辑模式
   */
  toggleGalleryEditMode(): void {
    this.galleryEditMode = !this.galleryEditMode
    
    const editBtn = document.getElementById('galleryEditModeBtn')
    const editActions = document.getElementById('galleryEditActions')
    const confirmBtn = document.querySelector('#galleryModal button[data-action="confirm"]') as HTMLElement
    const cancelBtn = document.querySelector('#galleryModal button[data-action="cancel"]') as HTMLElement
    
    if (this.galleryEditMode) {
      editBtn?.classList.add('text-[#FCE300]', 'border-[#FCE300]')
      editActions?.classList.remove('hidden')
      if (confirmBtn) confirmBtn.classList.add('hidden')
      this.galleryDeleteSelection = []
      this.updateDeleteButtonState()
    } else {
      editBtn?.classList.remove('text-[#FCE300]', 'border-[#FCE300]')
      editActions?.classList.add('hidden')
      if (confirmBtn) confirmBtn.classList.remove('hidden')
      this.galleryDeleteSelection = []
    }
    
    // 重新渲染图库以显示/隐藏选择框
    this.loadGalleryImages()
  }

  /**
   * 更新删除按钮状态
   */
  private updateDeleteButtonState(): void {
    const deleteBtn = document.getElementById('deleteSelectedBtn') as HTMLButtonElement
    if (deleteBtn) {
      deleteBtn.disabled = this.galleryDeleteSelection.length === 0
    }
  }

  /**
   * 添加自定义图库图片
   */
  addCustomGalleryImage(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files
      if (!files || files.length === 0) return
      
      try {
        for (const file of Array.from(files)) {
          const base64 = await this.fileToBase64ForGallery(file)
          const imageData: CustomGalleryImage = {
            id: `custom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: file.name,
            base64: base64,
            filename: file.name,
            createdAt: new Date().toISOString()
          }
          this.customGalleryImages.push(imageData)
        }
        
        this.saveCustomGalleryToStorage()
        this.loadGalleryImages()
        this.app.showToast?.(this.t('director.messages.addedImages', { count: files.length }) || `已添加 ${files.length} 张图片`, 'success')
      } catch (error) {
        console.error('[DirectorPage] 添加图片失败:', error)
        this.app.showToast?.(this.t('director.messages.addImagesFailed') || '添加图片失败', 'error')
      }
    }
    
    input.click()
  }

  /**
   * 文件转 Base64（用于图库）
   */
  private fileToBase64ForGallery(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  /**
   * 保存自定义图库到存储
   */
  private saveCustomGalleryToStorage(): void {
    try {
      localStorage.setItem('director_custom_gallery', JSON.stringify(this.customGalleryImages))
    } catch (error) {
      console.error('[DirectorPage] 保存自定义图库失败:', error)
    }
  }

  /**
   * 从存储加载自定义图库
   */
  private loadCustomGalleryFromStorage(): void {
    try {
      const data = localStorage.getItem('director_custom_gallery')
      this.customGalleryImages = data ? JSON.parse(data) : []
    } catch {
      this.customGalleryImages = []
    }
  }

  /**
   * 删除选中的自定义图片
   */
  deleteSelectedCustomImages(): void {
    if (this.galleryDeleteSelection.length === 0) return
    
    const confirmMsg = this.t('director.messages.confirmDeleteImages', { count: this.galleryDeleteSelection.length }) || `确定要删除选中的 ${this.galleryDeleteSelection.length} 张图片吗？`
    if (!confirm(confirmMsg)) {
      return
    }
    
    try {
      this.customGalleryImages = this.customGalleryImages.filter(
        img => !this.galleryDeleteSelection.includes(img.id)
      )
      
      this.saveCustomGalleryToStorage()
      this.galleryDeleteSelection = []
      this.updateDeleteButtonState()
      this.loadGalleryImages()
      
      this.app.showToast?.(this.t('director.messages.deletedSelectedImages') || '已删除选中的图片', 'success')
    } catch (error) {
      console.error('[DirectorPage] 删除图片失败:', error)
      this.app.showToast?.(this.t('director.messages.deleteImagesFailed') || '删除图片失败', 'error')
    }
  }

  /**
   * 切换自定义图片的删除选择
   */
  toggleCustomImageDeleteSelection(imageId: string): void {
    const index = this.galleryDeleteSelection.indexOf(imageId)
    if (index >= 0) {
      this.galleryDeleteSelection.splice(index, 1)
    } else {
      this.galleryDeleteSelection.push(imageId)
    }
    this.updateDeleteButtonState()
    this.loadGalleryImages()
  }

  // ==================== 模板编辑器方法 ====================

  /**
   * 打开模板编辑器
   */
  openTemplateEditor(template: StyleTemplate | null, templateKey: string | null, isBuiltin: boolean): void {
    const editor = document.getElementById('directorTemplateEditorModal')
    if (!editor) {
      console.error('[DirectorPage] 模板编辑器不存在: directorTemplateEditorModal')
      return
    }
    
    this.editingTemplateKey = templateKey
    this.editingTemplateIsBuiltin = isBuiltin
    
    // 填充表单
    const nameInput = document.getElementById('templateEditorName') as HTMLInputElement
    const prefixInput = document.getElementById('templateEditorPrefix') as HTMLTextAreaElement
    const suffixInput = document.getElementById('templateEditorSuffix') as HTMLTextAreaElement
    const negativeInput = document.getElementById('templateEditorNegative') as HTMLTextAreaElement
    const titleEl = document.getElementById('templateEditorTitle')
    const deleteBtn = document.getElementById('templateEditorDeleteBtn')
    const resetBtn = document.getElementById('templateEditorResetBtn')
    
    if (template) {
      if (nameInput) nameInput.value = template.name || ''
      if (prefixInput) prefixInput.value = template.prefix || ''
      if (suffixInput) suffixInput.value = template.suffix || ''
      if (negativeInput) negativeInput.value = template.negative || ''
      if (titleEl) titleEl.textContent = this.t('director.templates.editTemplate') || '编辑模板'
      
      // 内置模板显示重置按钮，自定义模板显示删除按钮
      if (isBuiltin) {
        deleteBtn?.classList.add('hidden')
        resetBtn?.classList.remove('hidden')
      } else {
        deleteBtn?.classList.remove('hidden')
        resetBtn?.classList.add('hidden')
      }
    } else {
      if (nameInput) nameInput.value = ''
      if (prefixInput) prefixInput.value = ''
      if (suffixInput) suffixInput.value = ''
      if (negativeInput) negativeInput.value = ''
      if (titleEl) titleEl.textContent = this.t('director.templates.newTemplate') || '新建模板'
      deleteBtn?.classList.add('hidden')
      resetBtn?.classList.add('hidden')
    }
    
    editor.classList.remove('hidden')
  }

  /**
   * 关闭模板编辑器
   */
  closeTemplateEditor(): void {
    const editor = document.getElementById('directorTemplateEditorModal')
    if (editor) {
      editor.classList.add('hidden')
    }
    this.editingTemplateKey = null
    this.editingTemplateIsBuiltin = false
  }

  /**
   * 创建新模板
   */
  createNewTemplate(): void {
    this.openTemplateEditor(null, null, false)
  }

  /**
   * 保存模板
   */
  saveTemplateFromEditor(): void {
    const nameInput = document.getElementById('templateEditorName') as HTMLInputElement
    const prefixInput = document.getElementById('templateEditorPrefix') as HTMLTextAreaElement
    const suffixInput = document.getElementById('templateEditorSuffix') as HTMLTextAreaElement
    const negativeInput = document.getElementById('templateEditorNegative') as HTMLTextAreaElement
    
    const name = nameInput?.value?.trim()
    const prefix = prefixInput?.value?.trim() || ''
    const suffix = suffixInput?.value?.trim() || ''
    const negative = negativeInput?.value?.trim() || ''
    
    if (!name) {
      this.app.showToast?.(this.t('director.messages.enterTemplateName') || '请填写模板名称', 'warning')
      return
    }
    
    try {
      const template: StyleTemplate = { name, prefix, suffix, negative }
      
      if (this.editingTemplateKey) {
        if (this.editingTemplateIsBuiltin) {
          // 覆盖内置模板
          this.templateOverrides[this.editingTemplateKey] = template
          this.styleTemplates[this.editingTemplateKey] = template
        } else {
          // 编辑自定义模板
          this.customTemplates[this.editingTemplateKey] = template
        }
      } else {
        // 新建自定义模板
        const newKey = `custom_${Date.now()}`
        this.customTemplates[newKey] = template
      }
      
      this.saveTemplatesToStorage()
      this.closeTemplateEditor()
      this.renderTemplateList()
      
      this.app.showToast?.(this.t('director.messages.templateSaved') || '模板已保存', 'success')
    } catch (error) {
      console.error('[DirectorPage] 保存模板失败:', error)
      this.app.showToast?.(this.t('director.messages.templateSaveFailed') || '保存模板失败', 'error')
    }
  }

  /**
   * 删除当前模板
   */
  deleteCurrentTemplate(): void {
    if (!this.editingTemplateKey || this.editingTemplateIsBuiltin) return
    
    const confirmMsg = this.t('director.messages.confirmDeleteTemplate') || '确定要删除这个模板吗？'
    if (!confirm(confirmMsg)) return
    
    try {
      delete this.customTemplates[this.editingTemplateKey]
      this.saveTemplatesToStorage()
      
      this.closeTemplateEditor()
      this.renderTemplateList()
      
      this.app.showToast?.(this.t('director.messages.templateDeleted') || '模板已删除', 'success')
    } catch (error) {
      console.error('[DirectorPage] 删除模板失败:', error)
      this.app.showToast?.(this.t('director.messages.templateDeleteFailed') || '删除模板失败', 'error')
    }
  }

  /**
   * 重置当前模板（恢复内置模板默认值）
   */
  resetCurrentTemplate(): void {
    if (!this.editingTemplateKey || !this.editingTemplateIsBuiltin) return
    
    const confirmMsg = this.t('director.messages.confirmResetTemplate') || '确定要恢复此模板的默认值吗？'
    if (!confirm(confirmMsg)) return
    
    try {
      const original = this.defaultStyleTemplates[this.editingTemplateKey]
      
      if (original) {
        // 移除覆盖
        delete this.templateOverrides[this.editingTemplateKey]
        // 恢复默认值
        this.styleTemplates[this.editingTemplateKey] = JSON.parse(JSON.stringify(original))
        
        this.saveTemplatesToStorage()
        
        // 更新编辑器中的值
        const nameInput = document.getElementById('templateEditorName') as HTMLInputElement
        const prefixInput = document.getElementById('templateEditorPrefix') as HTMLTextAreaElement
        const suffixInput = document.getElementById('templateEditorSuffix') as HTMLTextAreaElement
        const negativeInput = document.getElementById('templateEditorNegative') as HTMLTextAreaElement
        
        if (nameInput) nameInput.value = original.name
        if (prefixInput) prefixInput.value = original.prefix
        if (suffixInput) suffixInput.value = original.suffix
        if (negativeInput) negativeInput.value = original.negative
        
        this.app.showToast?.(this.t('director.messages.restoredDefaults') || '已恢复默认值', 'success')
      }
    } catch (error) {
      console.error('[DirectorPage] 重置模板失败:', error)
      this.app.showToast?.(this.t('director.messages.resetFailed') || '重置失败', 'error')
    }
  }

  /**
   * 保存模板到存储
   */
  private saveTemplatesToStorage(): void {
    try {
      localStorage.setItem('director_custom_templates', JSON.stringify(this.customTemplates))
      localStorage.setItem('director_template_overrides', JSON.stringify(this.templateOverrides))
    } catch (error) {
      console.error('[DirectorPage] 保存模板失败:', error)
    }
  }

  /**
   * 从存储加载模板
   */
  private loadTemplatesFromStorage(): void {
    try {
      const customData = localStorage.getItem('director_custom_templates')
      this.customTemplates = customData ? JSON.parse(customData) : {}
      
      const overridesData = localStorage.getItem('director_template_overrides')
      this.templateOverrides = overridesData ? JSON.parse(overridesData) : {}
      
      // 应用覆盖
      for (const key of Object.keys(this.templateOverrides)) {
        if (this.styleTemplates[key]) {
          this.styleTemplates[key] = this.templateOverrides[key]
        }
      }
    } catch {
      this.customTemplates = {}
      this.templateOverrides = {}
    }
  }

  // ==================== 模板导入导出方法 ====================

  /**
   * 导入模板
   */
  async importTemplates(): Promise<void> {
    try {
      const electronAPI = (window as any).electronAPI
      
      if (electronAPI?.isElectron && electronAPI.importTemplates) {
        const result = await electronAPI.importTemplates()
        if (result?.canceled) return
        
        if (result?.success) {
          this.loadTemplatesFromStorage()
          this.renderTemplateList()
          this.app.showToast?.(this.t('director.messages.templatesImported') || '已导入模板', 'success')
        } else {
          this.app.showToast?.((this.t('director.messages.importFailed') || '导入失败: ') + (result?.error || (this.t('common.unknownError') || '未知错误')), 'error')
        }
      } else {
        // 浏览器环境：使用文件选择
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json'
        
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0]
          if (!file) return
          
          try {
            const text = await file.text()
            const imported = JSON.parse(text)
            
            let count = 0
            for (const [key, template] of Object.entries(imported)) {
              if ((template as any).name && ((template as any).prefix !== undefined || (template as any).prompt !== undefined)) {
                const newKey = `imported_${Date.now()}_${count}`
                this.customTemplates[newKey] = template as StyleTemplate
                count++
              }
            }
            
            this.saveTemplatesToStorage()
            this.renderTemplateList()
            
            this.app.showToast?.(this.t('director.messages.importedTemplatesCount', { count }) || `已导入 ${count} 个模板`, 'success')
          } catch (error) {
            console.error('[DirectorPage] 导入失败:', error)
            this.app.showToast?.(this.t('director.messages.importFailedInvalidFormat') || '导入失败: 无效的文件格式', 'error')
          }
        }
        
        input.click()
      }
    } catch (error) {
      console.error('[DirectorPage] 导入模板失败:', error)
      this.app.showToast?.(this.t('director.messages.importFailed') || '导入失败', 'error')
    }
  }

  /**
   * 导出模板
   */
  async exportTemplates(): Promise<void> {
    try {
      const allTemplates = { ...this.customTemplates }
      
      if (Object.keys(allTemplates).length === 0) {
        this.app.showToast?.(this.t('director.messages.noTemplatesToExport') || '没有可导出的自定义模板', 'warning')
        return
      }
      
      const electronAPI = (window as any).electronAPI
      
      if (electronAPI?.isElectron && electronAPI.exportTemplates) {
        const result = await electronAPI.exportTemplates()
        if (result?.canceled) return
        
        if (result?.success) {
          this.app.showToast?.((this.t('director.messages.templatesExportedTo') || '模板已导出到: ') + result.path, 'success')
        } else {
          this.app.showToast?.((this.t('director.messages.exportFailed') || '导出失败: ') + (result?.error || (this.t('common.unknownError') || '未知错误')), 'error')
        }
      } else {
        // 浏览器环境：下载 JSON 文件
        const dataStr = JSON.stringify(allTemplates, null, 2)
        const blob = new Blob([dataStr], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        
        const a = document.createElement('a')
        a.href = url
        a.download = `director-templates-${new Date().toISOString().split('T')[0]}.json`
        a.click()
        
        URL.revokeObjectURL(url)
        this.app.showToast?.(this.t('director.messages.templatesExported') || '模板已导出', 'success')
      }
    } catch (error) {
      console.error('[DirectorPage] 导出模板失败:', error)
      this.app.showToast?.(this.t('director.messages.exportFailed') || '导出失败', 'error')
    }
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
