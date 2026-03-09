// src/renderer/src/pages/UnderstandPage.ts
/**
 * 图像理解页面模块 - TypeScript 版本
 * @description 支持多图联合分析，使用 OpenAI 兼容 API
 */

import { BasePage, AppInterface, PageState } from './BasePage'
import type { PipelineProgress } from '../services/pipeline/types'

/**
 * 上传的图片
 */
export interface UploadedImage {
  id: number
  base64: string
  fileName: string
  fileSize: number
  mimeType: string
  compressed: boolean
}

/**
 * Vision 模型配置
 */
export interface VisionModel {
  id: string
  displayName: string
  shortName?: string
  name?: string
  icon?: string
  recommended?: boolean
  price?: string
  description?: string
  features?: string[]
  defaultModel?: string
}

/**
 * 模型配置数据
 */
export interface ModelConfig {
  models: VisionModel[]
  defaultModel: string
  customModelEnabled?: boolean
  customModelPlaceholder?: string
}

/**
 * 分析角色配置
 */
export interface AnalysisRole {
  id: string
  name: string
  shortName?: string
  icon: string
  prompt: string
  promptFile?: string
  default?: boolean
  defaultModel?: string
  contextPlaceholder?: string
}

/**
 * 角色配置数据
 */
export interface RoleConfig {
  roles: AnalysisRole[]
}

/**
 * 图像理解页面状态
 */
export interface UnderstandPageState extends PageState {
  currentModel: string | null
  currentRole: string | null
  isCustomPrompt: boolean
  uploadedImagesCount: number
  contextText?: string
}

/**
 * 图像理解页面类
 */
export class UnderstandPage extends BasePage {
  private uploadedImages: UploadedImage[] = []
  private currentModel: string | null = null
  private modelConfig: ModelConfig | null = null
  private isAnalyzing: boolean = false
  private customModelId: string = ''
  private modalRendered: boolean = false

  // 角色系统
  private roleConfig: RoleConfig | null = null
  private currentRole: string | null = null
  private isCustomPrompt: boolean = false

  // 结果存储
  private lastResult: string = ''

  // 分镜导入相关
  private _lastStoryboardResult: any = null
  private _lastAnalyzedImages: Array<{base64: string; mimeType: string}> = []
  private _lastFormattedText: string = ''
  private _lastJsonText: string = ''
  private _currentResultTab: 'formatted' | 'json' = 'formatted'

  // 调试标志
  private styleDebugLogged: boolean = false

  constructor(app: AppInterface) {
    super(app)
    this.init()
  }

  /**
   * 初始化页面
   */
  async init(): Promise<void> {
    console.log('初始化图像理解页面 (TypeScript)')

    // 加载配置
    await Promise.all([
      this.loadModelConfig(),
      this.loadRoleConfig()
    ])

    // 绑定事件
    this.bindEvents()

    // 设置语言监听
    this.setupLanguageListener()

    this.isInitialized = true
  }

  /**
   * 设置语言切换监听器
   */
  private setupLanguageListener(): void {
    const i18n = (window as any).i18n
    if (i18n?.onLanguageChange) {
      i18n.onLanguageChange((lang: string) => {
        console.log('UnderstandPage: 语言切换为', lang)
        this.renderRoleButtons()
        if (this.modalRendered) {
          this.renderModelSelectionModal()
        }
      })
    }
  }

  /**
   * 加载模型配置JSON
   */
  async loadModelConfig(): Promise<void> {
    try {
      const response = await fetch('data/vision-models.json?v=' + Date.now())
      this.modelConfig = await response.json()
      this.currentModel = this.modelConfig!.defaultModel
      console.log('✅ 模型配置加载成功:', this.modelConfig)

      this.updateCustomModelArea()
      this.updateCurrentModelDisplay()
    } catch (error) {
      console.error('❌ 模型配置加载失败:', error)
      // 使用默认配置
      this.modelConfig = {
        models: [
          {
            id: 'gpt-5.2',
            displayName: 'GPT-5.2',
            shortName: 'GPT-5.2',
            icon: '🚀',
            recommended: true
          }
        ],
        defaultModel: 'gemini-3-pro-preview'
      }
      this.currentModel = 'gemini-3-pro-preview'
      this.updateCurrentModelDisplay()
    }
  }

  /**
   * 加载角色配置JSON
   */
  async loadRoleConfig(): Promise<void> {
    try {
      const response = await fetch('data/understand-roles.json?v=' + Date.now())
      this.roleConfig = await response.json()

      const defaultRole = this.roleConfig!.roles.find(r => r.default)
      this.currentRole = defaultRole ? defaultRole.id : this.roleConfig!.roles[0].id

      console.log('✅ 角色配置加载成功:', this.roleConfig)

      this.renderRoleButtons()
      this.applyRolePrompt(this.currentRole)

      const defaultRoleObj = this.roleConfig!.roles.find(r => r.id === this.currentRole)
      if (defaultRoleObj?.defaultModel) {
        this.currentModel = defaultRoleObj.defaultModel
        this.updateCurrentModelDisplay()
      }
      this.updateContextPlaceholder(defaultRoleObj)
    } catch (error) {
      console.error('❌ 角色配置加载失败:', error)
      this.roleConfig = {
        roles: [
          {
            id: 'universal',
            name: '万物识别+百科',
            icon: '🔍',
            shortName: '万物识别',
            prompt: '请详细识别并分析图片中的内容。',
            default: true
          }
        ]
      }
      this.currentRole = 'universal'
      this.renderRoleButtons()
    }
  }

  /**
   * 绑定事件
   */
  bindEvents(): void {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.setupEventListeners())
    } else {
      this.setupEventListeners()
    }
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    // 分析按钮
    this.addEventListenerSafe('analyzeBtn', 'click', () => this.analyzeImages())

    // 模型选择按钮
    this.addEventListenerSafe('selectModelBtn', 'click', () => this.openModelSelectionModal())

    // 关闭模型选择弹窗
    this.addEventListenerSafe('closeVisionModelModal', 'click', () => this.closeModelSelectionModal())

    // 弹窗点击外部关闭
    const modal = this.getElement<HTMLElement>('visionModelModal')
    if (modal) {
      modal.addEventListener('click', (e: MouseEvent) => {
        if ((e.target as HTMLElement).id === 'visionModelModal') {
          this.closeModelSelectionModal()
        }
      })
    }

    // 图片上传区域
    this.setupImageUploadArea()

    // 粘贴图片支持
    this.setupPasteHandler()

    // 复制结果按钮
    this.addEventListenerSafe('copyResultBtn', 'click', () => this.copyResult())

    // 自定义模型折叠
    this.setupCustomModelToggle()

    // 自定义模型输入
    const customInput = this.getElement<HTMLInputElement>('customModelInput')
    if (customInput) {
      customInput.addEventListener('input', (e: Event) => {
        this.customModelId = (e.target as HTMLInputElement).value.trim()
      })
    }

    // 角色选择器
    this.setupRoleSelector()

    // 自定义提示词按钮
    this.addEventListenerSafe('customPromptBtn', 'click', () => this.enableCustomPrompt())

    // 附加上下文折叠/展开
    this.addEventListenerSafe('understandContextToggle', 'click', () => {
      const wrapper = document.getElementById('understandContextWrapper')
      const arrow = document.getElementById('understandContextArrow')
      if (wrapper && arrow) {
        const isHidden = wrapper.classList.contains('hidden')
        wrapper.classList.toggle('hidden')
        arrow.textContent = isHidden ? '▼' : '▶'
      }
    })
  }

  /**
   * 设置图片上传区域
   */
  private setupImageUploadArea(): void {
    const imageArea = this.getElement<HTMLElement>('understandImageArea')
    if (!imageArea) return

    imageArea.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('.delete-image-btn')) return
      if (target.closest('#addMoreUnderstandArea')) {
        this.triggerFileUpload()
        return
      }
      const uploadPrompt = this.getElement<HTMLElement>('understandUploadPrompt')
      if (uploadPrompt && !uploadPrompt.classList.contains('hidden')) {
        this.triggerFileUpload()
      }
    })

    imageArea.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      imageArea.classList.add('border-opacity-70', 'bg-white', 'bg-opacity-5')
    })

    imageArea.addEventListener('dragleave', (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      imageArea.classList.remove('border-opacity-70', 'bg-white', 'bg-opacity-5')
    })

    imageArea.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      imageArea.classList.remove('border-opacity-70', 'bg-white', 'bg-opacity-5')

      const files = Array.from(e.dataTransfer?.files || []).filter(file =>
        file.type.startsWith('image/')
      )

      if (files.length > 0) {
        this.handleMultipleImageUpload(files)
      }
    })
  }

  /**
   * 设置粘贴处理器
   */
  private setupPasteHandler(): void {
    document.addEventListener('paste', (e: ClipboardEvent) => {
      if (this.app.currentTab !== 'understand') return

      const items = e.clipboardData?.items
      if (!items) return

      const imageFiles: File[] = []
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile()
          if (file) imageFiles.push(file)
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault()
        this.handleMultipleImageUpload(imageFiles)
      }
    })
  }

  /**
   * 设置自定义模型折叠
   */
  private setupCustomModelToggle(): void {
    const toggleBtn = this.getElement<HTMLButtonElement>('toggleCustomModel')
    const customArea = this.getElement<HTMLElement>('customModelInputArea')

    if (toggleBtn && customArea) {
      toggleBtn.addEventListener('click', () => {
        const isHidden = customArea.classList.contains('hidden')
        if (isHidden) {
          customArea.classList.remove('hidden')
          toggleBtn.innerHTML = '<i class="fas fa-chevron-up mr-1"></i>收起'
        } else {
          customArea.classList.add('hidden')
          toggleBtn.innerHTML = '<i class="fas fa-chevron-down mr-1"></i>展开'
        }
      })
    }
  }

  /**
   * 设置角色选择器
   */
  private setupRoleSelector(): void {
    const roleSelector = this.getElement<HTMLElement>('understandRoleSelector')
    if (roleSelector) {
      roleSelector.addEventListener('click', (e: MouseEvent) => {
        const roleBtn = (e.target as HTMLElement).closest('.role-btn') as HTMLElement | null
        if (roleBtn) {
          const roleId = roleBtn.dataset.roleId
          if (roleId) {
            this.selectRole(roleId)
          }
        }
      })
    }
  }

  /**
   * 打开模型选择弹窗（懒加载）
   */
  openModelSelectionModal(): void {
    const modal = this.getElement<HTMLElement>('visionModelModal')
    if (!modal) return

    if (!this.modalRendered) {
      this.renderModelSelectionModal()
      this.modalRendered = true
    }

    modal.classList.remove('hidden')
  }

  /**
   * 关闭模型选择弹窗
   */
  closeModelSelectionModal(): void {
    const modal = this.getElement<HTMLElement>('visionModelModal')
    if (modal) {
      modal.classList.add('hidden')
    }
  }

  /**
   * 渲染模型选择弹窗内容
   */
  renderModelSelectionModal(): void {
    const listContainer = this.getElement<HTMLElement>('visionModelList')
    if (!listContainer || !this.modelConfig) return

    const i18n = (window as any).i18n

    listContainer.innerHTML = this.modelConfig.models.map(model => {
      const modelData = i18n?.tObject?.('understand.visionModelData', model.id) || {}
      const displayName = modelData.displayName || model.shortName || model.displayName || model.name || model.id
      const description = modelData.description || model.description || ''
      const features = modelData.features || model.features || []
      const recommendedText = i18n?.t('understand.visionModelData.recommended') || '推荐'
      const currentText = i18n?.t('understand.visionModelData.current') || '当前'

      const featuresHtml = features.length > 0
        ? `<div class="flex flex-wrap gap-2">${features.map((f: string) => `<span class="bg-gray-100 text-gray-700 text-xs px-2 py-1 rounded">${f}</span>`).join('')}</div>`
        : ''

      return `
        <div class="model-card cursor-pointer p-4 border-2 rounded-lg transition-all hover:shadow-lg
                    ${model.id === this.currentModel
          ? 'border-blue-500 bg-blue-50'
          : 'border-gray-200 hover:border-blue-300'}"
             data-model-id="${model.id}">
          <div class="flex items-start space-x-4">
            <div class="text-3xl">${model.icon || '🤖'}</div>
            <div class="flex-1">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center space-x-2">
                  <span class="text-gray-800 font-semibold text-lg">${displayName}</span>
                  ${model.recommended ? `<span class="bg-yellow-400 text-white text-xs px-2 py-1 rounded font-medium">${recommendedText}</span>` : ''}
                  ${model.id === this.currentModel ? `<span class="bg-blue-500 text-white text-xs px-2 py-1 rounded font-medium">${currentText}</span>` : ''}
                </div>
                ${model.price ? `<span class="text-gray-500 text-sm font-mono">${model.price}</span>` : ''}
              </div>
              <p class="text-gray-600 text-sm mb-3">${description}</p>
              ${featuresHtml}
            </div>
          </div>
        </div>
      `
    }).join('')

    // 绑定点击事件
    listContainer.querySelectorAll('.model-card').forEach(card => {
      card.addEventListener('click', () => {
        const modelId = (card as HTMLElement).dataset.modelId
        if (modelId) {
          this.selectModelAndClose(modelId)
        }
      })
    })
  }

  /**
   * 选择模型并关闭弹窗
   */
  selectModelAndClose(modelId: string): void {
    this.selectModel(modelId)
    this.closeModelSelectionModal()
    this.showToast(`已切换到 ${this.getModelDisplayName(modelId)}`, 'success')
  }

  /**
   * 选择模型
   */
  selectModel(modelId: string): void {
    this.currentModel = modelId
    this.updateCurrentModelDisplay()
    console.log('✅ 切换模型:', modelId)
  }

  /**
   * 更新当前模型显示
   */
  updateCurrentModelDisplay(): void {
    const iconEl = this.getElement<HTMLElement>('visionModelIcon')
    const nameEl = this.getElement<HTMLElement>('visionModelName')

    if (!this.modelConfig || !iconEl || !nameEl) return

    const model = this.modelConfig.models.find(m => m.id === this.currentModel)
    if (model) {
      iconEl.textContent = model.icon || '🤖'
      nameEl.textContent = model.shortName || model.displayName || model.name || model.id
    }
  }

  /**
   * 更新自定义模型区域显示
   */
  updateCustomModelArea(): void {
    if (!this.modelConfig) return

    const customModelSection = document.querySelector('[data-custom-model-section]') as HTMLElement ||
      this.getElement<HTMLElement>('customModelInputArea')?.parentElement
    const customInput = this.getElement<HTMLInputElement>('customModelInput')

    if (this.modelConfig.customModelEnabled === false) {
      if (customModelSection) {
        customModelSection.style.display = 'none'
      }
    } else {
      if (customModelSection) {
        customModelSection.style.display = ''
      }
    }

    if (customInput && this.modelConfig.customModelPlaceholder) {
      customInput.placeholder = this.modelConfig.customModelPlaceholder
    }
  }

  /**
   * 渲染角色按钮
   */
  renderRoleButtons(): void {
    const container = this.getElement<HTMLElement>('understandRoleSelector')
    if (!container || !this.roleConfig) return

    container.innerHTML = ''

    this.roleConfig.roles.forEach(role => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'role-btn px-3 py-1.5 rounded-full text-sm transition-all'
      button.dataset.roleId = role.id

      if (role.id === this.currentRole) {
        button.classList.add('bg-white', 'bg-opacity-20', 'text-white', 'font-medium')
      } else {
        button.classList.add('bg-white', 'bg-opacity-5', 'text-white', 'opacity-70', 'hover:opacity-100', 'hover:bg-opacity-10')
      }

      const i18n = (window as any).i18n
      const roleShortName = i18n
        ? (i18n.t(`understand.roleData.${role.id}.shortName`) || role.shortName || role.name)
        : (role.shortName || role.name)

      button.innerHTML = `
        <span class="mr-1">${role.icon}</span>
        <span>${roleShortName}</span>
      `

      container.appendChild(button)
    })
  }

  /**
   * 选择角色
   */
  selectRole(roleId: string): void {
    if (!this.roleConfig) return

    const role = this.roleConfig.roles.find(r => r.id === roleId)
    if (!role) return

    if (this.currentRole === roleId && !this.isCustomPrompt) return

    this.currentRole = roleId
    this.isCustomPrompt = false

    this.applyRolePrompt(roleId)

    if (role.defaultModel) {
      this.currentModel = role.defaultModel
      this.updateCurrentModelDisplay()
      console.log(`🔄 已切换到推荐模型: ${role.defaultModel}`)
    }

    this.updateRoleButtonsStyle()
    this.updateRoleDisplay()
    this.updateContextPlaceholder(role)

    console.log(`✅ 已切换到角色: ${role.name}`)
  }

  /**
   * 应用角色提示词
   */
  applyRolePrompt(roleId: string): void {
    const role = this.roleConfig?.roles.find(r => r.id === roleId)
    if (!role) return

    const textarea = this.getElement<HTMLTextAreaElement>('understandPrompt')
    if (!textarea) return

    if (role.promptFile) {
      textarea.value = '加载提示词中...'
      fetch(`${role.promptFile}?v=${Date.now()}`)
        .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text() })
        .then(text => {
          textarea.value = text
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
        })
        .catch(() => {
          textarea.value = role.prompt || ''
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
        })
    } else {
      textarea.value = role.prompt
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  /**
   * 启用自定义提示词模式
   */
  enableCustomPrompt(): void {
    this.isCustomPrompt = true

    const roleButtons = document.querySelectorAll('.role-btn')
    roleButtons.forEach(btn => {
      btn.classList.remove('bg-white', 'bg-opacity-20', 'font-medium')
      btn.classList.add('bg-white', 'bg-opacity-5', 'opacity-70', 'hover:opacity-100', 'hover:bg-opacity-10')
    })

    this.updateRoleDisplay()
    this.updateContextPlaceholder()

    const textarea = this.getElement<HTMLTextAreaElement>('understandPrompt')
    if (textarea) {
      textarea.focus()
    }

    console.log('✅ 已切换到自定义提示词模式')
  }

  /**
   * 更新角色按钮样式
   */
  private updateRoleButtonsStyle(): void {
    const roleButtons = document.querySelectorAll<HTMLElement>('.role-btn')
    roleButtons.forEach(btn => {
      const roleId = btn.dataset.roleId
      if (roleId === this.currentRole && !this.isCustomPrompt) {
        btn.classList.remove('bg-opacity-5', 'opacity-70', 'hover:opacity-100', 'hover:bg-opacity-10')
        btn.classList.add('bg-white', 'bg-opacity-20', 'font-medium')
      } else {
        btn.classList.remove('bg-white', 'bg-opacity-20', 'font-medium')
        btn.classList.add('bg-white', 'bg-opacity-5', 'opacity-70', 'hover:opacity-100', 'hover:bg-opacity-10')
      }
    })
  }

  /**
   * 更新角色名称显示
   */
  private updateRoleDisplay(): void {
    const nameEl = this.getElement<HTMLElement>('currentRoleName')
    const hintEl = this.getElement<HTMLElement>('roleHintText')

    if (!nameEl) return

    if (this.isCustomPrompt) {
      nameEl.textContent = '提问（自定义）'
      if (hintEl) hintEl.textContent = '您正在使用自定义提示词'
    } else {
      const role = this.roleConfig?.roles.find(r => r.id === this.currentRole)
      if (role) {
        nameEl.textContent = `提问（${role.shortName || role.name}）`
        if (hintEl) hintEl.textContent = '点击上方角色标签快速切换提示词'
      } else {
        nameEl.textContent = '提问（可选）'
        if (hintEl) hintEl.textContent = '点击上方角色标签快速应用专业提示词'
      }
    }
  }

  /**
   * 更新附加上下文 placeholder（根据当前角色）
   */
  private updateContextPlaceholder(role?: AnalysisRole): void {
    const contextEl = document.getElementById('understandContext') as HTMLTextAreaElement
    if (!contextEl) return

    if (role?.contextPlaceholder) {
      contextEl.placeholder = role.contextPlaceholder
      const wrapper = document.getElementById('understandContextWrapper')
      const arrow = document.getElementById('understandContextArrow')
      if (wrapper?.classList.contains('hidden')) {
        wrapper.classList.remove('hidden')
        if (arrow) arrow.textContent = '▼'
      }
    } else {
      contextEl.placeholder = this.t('understand.placeholders.context') || '补充说明、剧本大纲、特殊要求...'
    }
  }

  /**
   * 触发文件选择对话框
   */
  triggerFileUpload(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.onchange = (e: Event) => {
      const files = Array.from((e.target as HTMLInputElement).files || [])
      if (files.length > 0) {
        this.handleMultipleImageUpload(files)
      }
    }
    input.click()
  }

  /**
   * 处理多张图片上传
   */
  async handleMultipleImageUpload(files: File[]): Promise<void> {
    if (!files || files.length === 0) return

    this.showToast(`正在处理 ${files.length} 张图片...`, 'info')

    try {
      const processedImages: UploadedImage[] = []

      for (const file of files) {
        if (!file.type.startsWith('image/')) {
          console.warn(`跳过非图片文件: ${file.name}`)
          continue
        }

        if (file.size > 50 * 1024 * 1024) {
          this.showToast(`图片 ${file.name} 超过 50MB，已跳过`, 'warning')
          continue
        }

        const base64 = await this.fileToBase64(file)

        const needsCompression = file.size > 2 * 1024 * 1024
        const finalBase64 = needsCompression
          ? await this.compressImage(base64, file.type)
          : base64

        if (needsCompression) {
          console.log(`✅ 图片 ${file.name} 已压缩 (${(file.size / 1024 / 1024).toFixed(2)}MB → 优化后)`)
        }

        processedImages.push({
          base64: finalBase64,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          id: Date.now() + Math.random(),
          compressed: needsCompression
        })
      }

      this.uploadedImages.push(...processedImages)
      this.updateImagePreview()

      const compressedCount = processedImages.filter(img => img.compressed).length
      const message = compressedCount > 0
        ? `成功上传 ${processedImages.length} 张图片 (${compressedCount} 张已压缩优化)`
        : `成功上传 ${processedImages.length} 张图片`

      this.showToast(message, 'success')

    } catch (error: any) {
      console.error('图片上传失败:', error)
      this.showToast('图片上传失败: ' + error.message, 'error')
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
   * 压缩图片
   */
  private compressImage(base64: string, mimeType: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        let width = img.width
        let height = img.height

        const maxSize = 2048
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = (height / width) * maxSize
            width = maxSize
          } else {
            width = (width / height) * maxSize
            height = maxSize
          }
        }

        canvas.width = width
        canvas.height = height

        const ctx = canvas.getContext('2d')
        ctx?.drawImage(img, 0, 0, width, height)

        const compressedDataURL = canvas.toDataURL('image/jpeg', 0.85)
        const compressedBase64 = compressedDataURL.split(',')[1]

        resolve(compressedBase64)
      }
      img.onerror = reject
      img.src = `data:${mimeType};base64,${base64}`
    })
  }

  /**
   * 更新图片预览
   */
  updateImagePreview(): void {
    const uploadPrompt = this.getElement<HTMLElement>('understandUploadPrompt')
    const imagesPreview = this.getElement<HTMLElement>('understandImagesPreview')
    const imagesList = this.getElement<HTMLElement>('understandImagesList')
    const countText = this.getElement<HTMLElement>('understandCountText')

    if (!uploadPrompt || !imagesPreview || !imagesList) return

    if (this.uploadedImages.length === 0) {
      uploadPrompt.classList.remove('hidden')
      imagesPreview.classList.add('hidden')
    } else {
      uploadPrompt.classList.add('hidden')
      imagesPreview.classList.remove('hidden')

      imagesList.innerHTML = this.uploadedImages.map((img, index) => `
        <div class="relative group aspect-square">
          <img src="data:${img.mimeType};base64,${img.base64}"
               alt="${img.fileName}"
               class="w-full h-full object-cover rounded-lg shadow-md">
          ${img.compressed ? '<div class="absolute top-1 left-1 bg-green-500 text-white text-xs px-1.5 py-0.5 rounded opacity-90" title="已压缩优化"><i class="fas fa-check"></i></div>' : ''}
          <button class="delete-image-btn absolute top-1 right-1 bg-red-500 hover:bg-red-600 text-white rounded-full w-7 h-7 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  data-index="${index}">
            <i class="fas fa-times text-sm"></i>
          </button>
          <div class="absolute bottom-0 left-0 right-0 bg-black bg-opacity-70 text-white text-xs p-1.5 rounded-b-lg truncate">
            ${img.fileName}
          </div>
        </div>
      `).join('')

      // 绑定删除按钮事件
      imagesList.querySelectorAll('.delete-image-btn').forEach(btn => {
        btn.addEventListener('click', (e: Event) => {
          e.stopPropagation()
          const index = parseInt((btn as HTMLElement).dataset.index || '0', 10)
          this.removeImage(index)
        })
      })

      if (countText) {
        countText.textContent = `(${this.uploadedImages.length})`
      }
    }
  }

  /**
   * 删除单张图片
   */
  removeImage(index: number): void {
    this.uploadedImages.splice(index, 1)
    this.updateImagePreview()
    this.showToast('已删除图片', 'info')
  }

  /**
   * 清空所有图片
   */
  clearAllImages(): void {
    this.uploadedImages = []
    this.updateImagePreview()
    this.showToast('已清空所有图片', 'info')
  }

  /**
   * 分析图片
   */
  async analyzeImages(): Promise<void> {
    if (this.uploadedImages.length === 0) {
      this.showToast('请先上传图片', 'error')
      return
    }

    const api = this.getApi()
    if (!api || !api.visionApiKey) {
      this.showToast('请先在设置中配置图像理解 API Key', 'error')
      return
    }

    if (this.isAnalyzing) {
      this.showToast('正在分析中，请稍候...', 'warning')
      return
    }

    this.isAnalyzing = true
    this.styleDebugLogged = false

    const promptInput = this.getElement<HTMLTextAreaElement>('understandPrompt')
    const prompt = promptInput ? promptInput.value.trim() : ''
    let finalPrompt = prompt || '请详细分析这些图片的内容，包括场景、物体、人物、氛围等。'

    const contextEl = document.getElementById('understandContext') as HTMLTextAreaElement
    const contextText = contextEl?.value?.trim()
    if (contextText) {
      finalPrompt += `\n\n--- 用户附加要求 ---\n${contextText}`
    }

    const modelToUse = this.customModelId || this.currentModel || 'gpt-5.2'

    this.showAnalyzingStream(modelToUse)

    let fullResult = ''

    try {
      if (this.currentRole === 'sora-storyboard' || this.currentRole === 'sora-storyboard-pro') {
        if (this.currentRole === 'sora-storyboard-pro') {
          try {
            const { getStoryboardPipelineService } = await import('../services/ServiceBridge')
            const pipelineService = await getStoryboardPipelineService(modelToUse)
            if (pipelineService) {
              console.log('[UnderstandPage] Using storyboard pro pipeline...')
              const inputImages = this.uploadedImages.map(img => ({
                data: img.base64, mimeType: img.mimeType || 'image/jpeg'
              }))
              this.showPipelineProgress()

              const result = await pipelineService.execute(
                {
                  inputImages,
                  userContext: [prompt || '', contextText || ''].filter(Boolean).join('\n\n'),
                },
                (progress) => this.onPipelineProgress(progress)
              )

              const { formatStoryboardText } = await import('../services/StoryboardToDirectorAdapter')
              const formattedText = formatStoryboardText(result)
              const jsonOutput = JSON.stringify(result, null, 2)
              fullResult = jsonOutput

              this._lastStoryboardResult = result
              this._lastAnalyzedImages = inputImages.map(img => ({ base64: img.data, mimeType: img.mimeType }))
              this._lastFormattedText = formattedText
              this._lastJsonText = jsonOutput
              this.showStoryboardResult(formattedText, jsonOutput)
              this.onStreamComplete(jsonOutput, modelToUse)
              this.showToast('分镜分析完成！', 'success')

              this.isAnalyzing = false
              return
            }
          } catch (pipelineError: any) {
            console.warn('[UnderstandPage] Pipeline failed, falling back to single-pass:', pipelineError.message)
          }
        }

        try {
          const { getLangChainStoryboardService } = await import('../services/ServiceBridge')
          const storyboardService = await getLangChainStoryboardService(modelToUse)
          if (storyboardService) {
            console.log('[UnderstandPage] Using LangChain structured storyboard output...')
            const images = this.uploadedImages.map(img => ({
              base64: img.base64, mimeType: img.mimeType || 'image/jpeg'
            }))
            const rolePrompt = prompt || ''
            const context = contextText || undefined

            const result = await storyboardService.analyze({ images, rolePrompt, context })
            const jsonOutput = storyboardService.toJSON(result)

            fullResult = jsonOutput
            this.appendResultChunk(jsonOutput)
            this.onStreamComplete(jsonOutput, modelToUse)
            this.showToast('LangChain 结构化分析完成！', 'success')

            this._lastStoryboardResult = result
            this._lastAnalyzedImages = images
            this.showImportToDirectorButton()

            this.isAnalyzing = false
            return
          }
        } catch (lcError: any) {
          console.warn('[UnderstandPage] LangChain structured output failed, falling back to stream:', lcError.message)
        }
      }

      await api.analyzeImagesStream(
        this.uploadedImages,
        finalPrompt,
        modelToUse,
        null,
        (chunk: string) => {
          fullResult += chunk
          this.appendResultChunk(chunk)
        },
        () => {
          console.log(`✅ 流式分析完成 - 总长度: ${fullResult.length} 字符`)
          this.onStreamComplete(fullResult, modelToUse)
          this.showToast('分析完成！', 'success')
          this.isAnalyzing = false
        },
        (error: Error) => {
          console.error('图像分析失败:', error)
          this.showError(error.message || '分析失败，请重试')
          this.isAnalyzing = false
        }
      )
    } catch (error: any) {
      console.error('图像分析失败:', error)
      this.showError(error.message || '分析失败，请重试')
      this.isAnalyzing = false
    }
  }

  /**
   * 显示流式分析状态
   */
  private showAnalyzingStream(modelId: string): void {
    const resultContainer = this.getElement<HTMLElement>('understandResult')
    if (!resultContainer) return

    const modelName = this.getModelDisplayName(modelId)
    const compressedCount = this.uploadedImages.filter(img => img.compressed).length

    resultContainer.innerHTML = `
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-white text-lg font-semibold flex items-center">
          <i class="fas fa-brain text-blue-400 mr-2 animate-pulse"></i>
          AI 正在分析中...
        </h3>
        <span class="text-white opacity-50 text-sm">${modelName}</span>
      </div>
      <div id="streamingContent" class="text-white" style="min-height: 300px; line-height: 1.8; word-wrap: break-word; overflow-wrap: break-word; white-space: pre-wrap; width: 100%; display: block; overflow: visible;">
        <span class="typing-cursor"></span>
      </div>
      <div class="flex items-center justify-between text-white opacity-50 text-xs mt-3">
        <span>分析图片: ${this.uploadedImages.length} 张${compressedCount > 0 ? ` (${compressedCount} 张已优化)` : ''}</span>
        <span>正在接收数据...</span>
      </div>
    `

    const copyBtn = this.getElement<HTMLElement>('copyResultBtn')
    if (copyBtn) copyBtn.classList.add('hidden')
  }

  /**
   * 追加流式输出的文本片段
   */
  private appendResultChunk(chunk: string): void {
    const contentEl = this.getElement<HTMLElement>('streamingContent')
    if (!contentEl) return

    const cursor = contentEl.querySelector('.typing-cursor')
    if (cursor) cursor.remove()

    const textNode = document.createTextNode(chunk)
    contentEl.appendChild(textNode)

    const newCursor = document.createElement('span')
    newCursor.className = 'typing-cursor'
    contentEl.appendChild(newCursor)

    const resultContainer = this.getElement<HTMLElement>('understandResult')
    if (resultContainer) {
      resultContainer.scrollTop = resultContainer.scrollHeight
    }
  }

  /**
   * 流式输出完成后的处理
   */
  private onStreamComplete(fullResult: string, modelId: string): void {
    const contentEl = this.getElement<HTMLElement>('streamingContent')
    if (!contentEl) return

    this.lastResult = fullResult

    const cursor = contentEl.querySelector('.typing-cursor')
    if (cursor) cursor.remove()

    const resultContainer = this.getElement<HTMLElement>('understandResult')
    if (resultContainer) {
      const icon = resultContainer.querySelector('.fa-brain')
      if (icon) {
        icon.classList.remove('fa-brain', 'animate-pulse', 'text-blue-400')
        icon.classList.add('fa-check-circle', 'text-green-400')
      }
      const title = resultContainer.querySelector('h3')
      if (title && title.childNodes[1]) {
        title.childNodes[1].textContent = '分析结果'
      }

      const timeStamp = resultContainer.querySelector('.text-xs span:last-child')
      if (timeStamp) {
        timeStamp.textContent = new Date().toLocaleString('zh-CN')
      }
    }

    const copyBtn = this.getElement<HTMLElement>('copyResultBtn')
    if (copyBtn) copyBtn.classList.remove('hidden')

    console.log('✅ 流式输出完成，总字符数:', fullResult.length)
  }

  /**
   * 显示错误
   */
  private showError(errorMessage: string): void {
    const resultContainer = this.getElement<HTMLElement>('understandResult')
    if (!resultContainer) return

    resultContainer.innerHTML = `
      <div class="text-center py-12">
        <i class="fas fa-exclamation-triangle text-6xl text-red-400 opacity-70 mb-4"></i>
        <p class="text-white text-lg mb-2">分析失败</p>
        <p class="text-red-300 text-sm mb-4">${this.escapeHtml(errorMessage)}</p>
        <button id="retryAnalyzeBtn" type="button"
                class="bg-blue-500 hover:bg-blue-600 text-white px-6 py-2 rounded-lg transition-colors">
          <i class="fas fa-redo mr-2"></i>重试
        </button>
      </div>
    `

    this.addEventListenerSafe('retryAnalyzeBtn', 'click', () => this.analyzeImages())

    const copyBtn = this.getElement<HTMLElement>('copyResultBtn')
    if (copyBtn) copyBtn.classList.add('hidden')
  }

  /**
   * HTML 转义
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  /**
   * 获取模型显示名称
   */
  getModelDisplayName(modelId: string): string {
    if (!this.modelConfig) return modelId

    if (this.customModelId && modelId === this.customModelId) {
      return `自定义: ${modelId}`
    }

    const model = this.modelConfig.models.find(m => m.id === modelId)
    return model ? (model.displayName || model.id) : modelId
  }

  /**
   * 显示"导入到导演模式"按钮（兼容非 pipeline 路径）
   */
  private showImportToDirectorButton(): void {
    const resultArea = this.getElement<HTMLElement>('understandResult')
    if (!resultArea) return

    const existingBtn = document.getElementById('importToDirectorBtn')
    if (existingBtn) existingBtn.remove()

    const btn = document.createElement('button')
    btn.id = 'importToDirectorBtn'
    btn.className = 'mt-4 px-6 py-3 bg-[#FCE300] text-black font-bold rounded-lg hover:bg-yellow-400 transition-colors flex items-center gap-2 cursor-pointer'
    btn.innerHTML = '<i class="fas fa-film"></i> 导入到导演模式'
    btn.onclick = () => this.importToDirector()
    resultArea.appendChild(btn)
  }

  /**
   * Pipeline 完成后展示 Tab 切换结果（格式化文本 / JSON）+ 复制 + 导入按钮
   */
  private showStoryboardResult(formattedText: string, jsonText: string): void {
    const resultArea = document.getElementById('pipelineResultArea')
    if (!resultArea) return

    this._currentResultTab = 'formatted'

    const spinner = document.getElementById('pipelineSpinner')
    if (spinner) { spinner.classList.remove('animate-pulse'); spinner.className = 'fas fa-check-circle text-green-400 mr-2' }
    const title = document.getElementById('pipelineTitle')
    if (title) title.textContent = '分镜分析完成'

    resultArea.innerHTML = `
      <div class="bg-[#27272A] rounded-none p-4">
        <h3 class="text-white font-semibold flex items-center mb-3">
          <i class="fas fa-scroll text-green-400 mr-2"></i>
          分镜数据
        </h3>
        <div class="flex gap-1 bg-[#09090B] border border-[#3F3F46] rounded-none p-1 mb-3" id="storyboardTabs">
          <button id="tabFormatted" class="${UnderstandPage.TAB_ACTIVE}" aria-label="格式化文本视图">
            <i class="fas fa-align-left mr-1"></i> 格式化文本
          </button>
          <button id="tabJson" class="${UnderstandPage.TAB_INACTIVE}" aria-label="JSON数据视图">
            <i class="fas fa-code mr-1"></i> JSON
          </button>
        </div>
        <div id="storyboardContent" class="bg-[#09090B] border border-[#3F3F46] rounded-none p-4 font-mono text-sm text-white/90 overflow-auto whitespace-pre-wrap" style="max-height: 800px; line-height: 1.8;">${this.escapeHtml(formattedText)}</div>
        <div class="flex gap-2 mt-3">
          <button id="pipelineCopyBtn" class="px-4 py-2 bg-[#09090B] border border-[#3F3F46] hover:bg-[#3F3F46] text-white rounded-none transition-colors duration-200 cursor-pointer flex items-center gap-1" aria-label="复制当前内容到剪贴板">
            <i class="fas fa-copy"></i> <span>复制</span>
          </button>
          <button id="importToDirectorBtn" class="px-6 py-3 bg-[#FCE300] text-black font-bold rounded-none hover:bg-yellow-400 transition-colors duration-200 cursor-pointer flex items-center gap-2" aria-label="导入到导演模式">
            <i class="fas fa-film"></i> 导入导演模式
          </button>
        </div>
      </div>
    `

    document.getElementById('tabFormatted')?.addEventListener('click', () => {
      this._currentResultTab = 'formatted'
      this.updateStoryboardTab(formattedText, jsonText)
    })
    document.getElementById('tabJson')?.addEventListener('click', () => {
      this._currentResultTab = 'json'
      this.updateStoryboardTab(formattedText, jsonText)
    })
    document.getElementById('pipelineCopyBtn')?.addEventListener('click', () => {
      this.copyCurrentResult()
    })
    document.getElementById('importToDirectorBtn')?.addEventListener('click', () => {
      this.importToDirector()
    })
  }

  private static readonly TAB_BASE = 'px-4 py-2 rounded-none text-sm font-medium cursor-pointer transition-colors duration-200'
  private static readonly TAB_ACTIVE = `${UnderstandPage.TAB_BASE} bg-[#FCE300] text-black font-bold`
  private static readonly TAB_INACTIVE = `${UnderstandPage.TAB_BASE} text-white/60 hover:text-white/80 hover:bg-[#3F3F46]`

  private updateStoryboardTab(formattedText: string, jsonText: string): void {
    const content = document.getElementById('storyboardContent')
    const tabF = document.getElementById('tabFormatted')
    const tabJ = document.getElementById('tabJson')
    if (!content || !tabF || !tabJ) return

    const isFormatted = this._currentResultTab === 'formatted'
    content.textContent = isFormatted ? formattedText : jsonText
    tabF.className = isFormatted ? UnderstandPage.TAB_ACTIVE : UnderstandPage.TAB_INACTIVE
    tabJ.className = isFormatted ? UnderstandPage.TAB_INACTIVE : UnderstandPage.TAB_ACTIVE
  }

  private async copyCurrentResult(): Promise<void> {
    const text = this._currentResultTab === 'formatted'
      ? this._lastFormattedText
      : this._lastJsonText
    if (!text) return

    const showSuccess = () => {
      const btn = document.getElementById('pipelineCopyBtn')
      if (btn) {
        const span = btn.querySelector('span')
        const icon = btn.querySelector('i')
        if (span) span.textContent = '已复制'
        if (icon) { icon.className = 'fas fa-check'; icon.style.color = '#4ade80' }
        setTimeout(() => {
          if (span) span.textContent = '复制'
          if (icon) { icon.className = 'fas fa-copy'; icon.style.color = '' }
        }, 1500)
      }
    }

    try {
      await navigator.clipboard.writeText(text)
      showSuccess()
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      try {
        document.execCommand('copy')
        showSuccess()
      } catch {
        this.showToast('复制失败，请手动复制', 'error')
      }
      document.body.removeChild(textarea)
    }
  }

  /**
   * 将分镜数据导入导演模式
   */
  private async importToDirector(): Promise<void> {
    if (!this._lastStoryboardResult) return

    const { convertStoryboardToDirector } = await import('../services/StoryboardToDirectorAdapter')
    const importData = convertStoryboardToDirector(
      this._lastStoryboardResult,
      this._lastAnalyzedImages[0]?.base64,
      this._lastAnalyzedImages[0]?.mimeType
    )

    sessionStorage.setItem('director_import_data', JSON.stringify(importData))
    this.app.switchTab('director')
    this.showToast('已导入到导演模式', 'success')
  }

  /**
   * 显示 4-Pass 管线进度 UI
   */
  private showPipelineProgress(): void {
    const resultContainer = this.getElement<HTMLElement>('understandResult')
    if (!resultContainer) return

    const passes = [
      { icon: '📋', label: 'Pass 0: 导演规划' },
      { icon: '🔍', label: 'Pass 1: 场景+角色分析' },
      { icon: '🎥', label: 'Pass 2: 分镜生成' },
      { icon: '✅', label: 'Pass 3: 快速校验' },
    ]

    resultContainer.innerHTML = `
      <div class="space-y-4">
        <div class="bg-[#27272A] rounded-none p-4" id="pipelineProgressCard">
          <h3 class="text-white font-semibold flex items-center mb-3">
            <i class="fas fa-brain text-blue-400 mr-2 animate-pulse" id="pipelineSpinner"></i>
            <span id="pipelineTitle">分镜分析中...</span>
          </h3>
          <div class="space-y-2" id="pipelineProgressBars">
            ${passes.map((p, i) => `
              <div class="flex items-center gap-3 text-sm" id="pipelinePass${i}">
                <span class="text-xl">${p.icon}</span>
                <span class="text-white opacity-70">${p.label}</span>
                <span class="ml-auto text-white opacity-30">等待中</span>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="bg-[#27272A] rounded-none p-4 hidden" id="pipelinePassResults">
          <h3 class="text-white font-semibold flex items-center mb-3">
            <i class="fas fa-stream text-purple-400 mr-2"></i>
            分析过程
          </h3>
          <div id="pipelinePassData" class="space-y-2"></div>
        </div>
        <div id="pipelineResultArea"></div>
      </div>
    `

    const firstPass = document.getElementById('pipelinePass0')
    if (firstPass) {
      const status = firstPass.querySelector('span:last-child')
      if (status) {
        status.textContent = '⏳ 进行中...'
        status.classList.remove('opacity-30')
        status.classList.add('text-yellow-400', 'animate-pulse')
      }
    }
  }

  /**
   * 处理管线各 Pass 完成的进度回调
   */
  private onPipelineProgress(progress: PipelineProgress): void {
    if (progress.status === 'running') {
      const passEl = document.getElementById(`pipelinePass${progress.pass}`)
      if (passEl) {
        const statusEl = passEl.querySelector('span:last-child')
        if (statusEl && !statusEl.textContent?.includes('完成')) {
          statusEl.textContent = '⏳ 进行中...'
          statusEl.className = 'ml-auto text-yellow-400 animate-pulse'
        }
      }
      return
    }

    const passEl = document.getElementById(`pipelinePass${progress.pass}`)
    if (passEl) {
      const statusEl = passEl.querySelector('span:last-child')
      if (statusEl) {
        statusEl.textContent = '✓ 完成'
        statusEl.className = 'ml-auto text-green-400'
      }
    }

    const passResultsCard = document.getElementById('pipelinePassResults')
    const passDataArea = document.getElementById('pipelinePassData')
    if (passResultsCard && passDataArea && progress.passData) {
      passResultsCard.classList.remove('hidden')
      const summary = document.createElement('div')
      summary.className = 'p-3 bg-[#09090B] border border-[#3F3F46] rounded-none'
      const displayData = progress.passData.summary || progress.passData.raw
      const issuesList = progress.passData.raw?.report?.issues
      const issuesHtml = Array.isArray(issuesList) && issuesList.length > 0
        ? `<ul class="mt-2 text-xs text-amber-300/80 list-disc pl-4">${issuesList.map((issue: string) => `<li>${this.escapeHtml(typeof issue === 'string' ? issue : JSON.stringify(issue))}</li>`).join('')}</ul>`
        : ''
      summary.innerHTML = `
        <div class="text-sm text-blue-300 font-medium mb-1">${progress.label}</div>
        <pre class="text-xs text-white opacity-70 overflow-auto max-h-40">${typeof displayData === 'string' ? this.escapeHtml(displayData) : JSON.stringify(displayData, null, 2)}</pre>
        ${issuesHtml}
      `
      passDataArea.appendChild(summary)
    }

    const nextPassEl = document.getElementById(`pipelinePass${progress.pass + 1}`)
    if (nextPassEl) {
      const nextStatus = nextPassEl.querySelector('span:last-child')
      if (nextStatus && !nextStatus.textContent?.includes('完成')) {
        nextStatus.textContent = '⏳ 进行中...'
        nextStatus.className = 'ml-auto text-yellow-400 animate-pulse'
      }
    }
  }

  /**
   * 复制分析结果
   */
  async copyResult(): Promise<void> {
    if (!this.lastResult) {
      this.showToast('没有可复制的内容', 'warning')
      return
    }

    try {
      await navigator.clipboard.writeText(this.lastResult)
      this.showToast('已复制到剪贴板', 'success')
    } catch (error) {
      console.error('复制失败:', error)

      const textarea = document.createElement('textarea')
      textarea.value = this.lastResult
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()

      try {
        document.execCommand('copy')
        this.showToast('已复制到剪贴板', 'success')
      } catch (err) {
        this.showToast('复制失败，请手动复制', 'error')
      }

      document.body.removeChild(textarea)
    }
  }

  /**
   * 获取上传的图片数量
   */
  getUploadedImagesCount(): number {
    return this.uploadedImages.length
  }

  /**
   * 获取当前模型
   */
  getCurrentModel(): string | null {
    return this.currentModel
  }

  /**
   * 获取当前角色
   */
  getCurrentRole(): string | null {
    return this.currentRole
  }

  /**
   * 是否正在分析
   */
  getIsAnalyzing(): boolean {
    return this.isAnalyzing
  }

  /**
   * 保存页面状态
   */
  saveState(): void {
    const contextEl = document.getElementById('understandContext') as HTMLTextAreaElement
    const state: UnderstandPageState = {
      currentModel: this.currentModel,
      currentRole: this.currentRole,
      isCustomPrompt: this.isCustomPrompt,
      uploadedImagesCount: this.uploadedImages.length,
      contextText: contextEl?.value || ''
    }

    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager?.savePageState) {
      pageStateManager.savePageState('understand', state)
    }
  }

  /**
   * 恢复页面状态
   */
  async restoreState(): Promise<void> {
    if (this.stateRestored) return

    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager?.getPageState) {
      const state = pageStateManager.getPageState('understand') as UnderstandPageState | null
      if (state) {
        if (state.currentModel) this.currentModel = state.currentModel
        if (state.currentRole) this.currentRole = state.currentRole
        this.isCustomPrompt = state.isCustomPrompt || false
        if (state.contextText) {
          const contextEl = document.getElementById('understandContext') as HTMLTextAreaElement
          if (contextEl) contextEl.value = state.contextText
        }
        console.log('图像理解状态已恢复:', state)
      }
    }

    this.stateRestored = true
  }

  /**
   * 页面激活时调用
   */
  onActivate(): void {
    console.log('图像理解页面已激活')

    if (this.modelConfig) {
      this.updateCurrentModelDisplay()
    }

    if (this.uploadedImages.length === 0) {
      this.updateImagePreview()
    }
  }

  /**
   * 页面停用时调用
   */
  onDeactivate(): void {
    console.log('图像理解页面已停用')
    this.saveState()
  }

  /**
   * 语言切换时调用
   */
  onLanguageChange(): void {
    console.log('UnderstandPage 语言切换')
    this.renderRoleButtons()
    if (this.modalRendered) {
      this.renderModelSelectionModal()
    }
  }

  /**
   * 收集状态用于持久化
   */
  collectState(): UnderstandPageState {
    const contextEl = document.getElementById('understandContext') as HTMLTextAreaElement
    return {
      currentModel: this.currentModel,
      currentRole: this.currentRole,
      isCustomPrompt: this.isCustomPrompt,
      uploadedImagesCount: this.uploadedImages.length,
      contextText: contextEl?.value || ''
    }
  }

  /**
   * 应用恢复的状态
   */
  applyState(state: UnderstandPageState): void {
    if (state.currentModel) this.currentModel = state.currentModel
    if (state.currentRole) this.currentRole = state.currentRole
    this.isCustomPrompt = state.isCustomPrompt || false
    if (state.contextText) {
      const contextEl = document.getElementById('understandContext') as HTMLTextAreaElement
      if (contextEl) contextEl.value = state.contextText
    }
  }

  /**
   * 销毁页面
   */
  destroy(): void {
    this.saveState()
    this.uploadedImages = []
    super.destroy()
  }
}

// 工厂函数
let understandPageInstance: UnderstandPage | null = null

export function createUnderstandPage(app: AppInterface): UnderstandPage {
  understandPageInstance = new UnderstandPage(app)
  return understandPageInstance
}

export function getUnderstandPage(): UnderstandPage | null {
  return understandPageInstance
}

export default UnderstandPage
