/**
 * RatioResolutionManager - 比例和分辨率管理器
 * 
 * 负责渲染和管理比例/分辨率选择按钮。
 * 从 app.js 和 ModelSelectorManager 中提取的专门模块。
 */

declare const i18n: {
  translations?: Record<string, {
    aspectRatios?: Record<string, { label: string; description?: string }>
    resolutions?: Record<string, { label: string; description?: string }>
  }>
  currentLang?: string
}

export interface RatioOption {
  key: string
  label?: string
  description?: string
}

export interface ResolutionOption {
  key: string
  label?: string
  description?: string
}

export interface ModelCapabilities {
  resolutionControl?: boolean
  [key: string]: unknown
}

export interface ModelConfig {
  name: string
  displayName: string
  capabilities?: ModelCapabilities
  ratios?: RatioOption[]
  resolutions?: ResolutionOption[]
  defaultResolution?: string
}

export interface PageReference {
  currentRatio?: string
  currentResolution?: string
  selectRatio?: (ratio: string) => void
  selectResolution?: (resolution: string) => void
  updateFinalResolutionDisplay?: () => void
}

export interface RatioResolutionConfig {
  /** 默认比例选项 */
  defaultRatios?: RatioOption[]
  /** 比例按钮容器 ID */
  ratioContainerId?: string
  /** 分辨率容器 ID */
  resolutionContainerId?: string
  /** 分辨率按钮容器 ID */
  resolutionButtonsId?: string
  /** 批量比例选择器 ID */
  batchRatioSelectId?: string
  /** 分辨率存储 key */
  resolutionStorageKey?: string
  /** 显示 toast 回调 */
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void
}

type RatioChangeCallback = (ratioKey: string) => void
type ResolutionChangeCallback = (resolutionKey: string) => void

const DEFAULT_CONFIG: Required<RatioResolutionConfig> = {
  defaultRatios: [
    { key: '1:1', label: '正方形', description: '1:1' },
    { key: '16:9', label: '横版', description: '16:9' },
    { key: '9:16', label: '竖版', description: '9:16' }
  ],
  ratioContainerId: 'ratioButtons',
  resolutionContainerId: 'resolutionContainer',
  resolutionButtonsId: 'resolutionButtons',
  batchRatioSelectId: 'batchRatio',
  resolutionStorageKey: 'gemini_resolution',
  showToast: () => {}
}

/**
 * RatioResolutionManager 类
 */
export class RatioResolutionManager {
  private config: Required<RatioResolutionConfig>
  private currentRatio: string = ''
  private currentResolution: string = ''
  private ratioChangeCallbacks: RatioChangeCallback[] = []
  private resolutionChangeCallbacks: ResolutionChangeCallback[] = []
  
  constructor(config: RatioResolutionConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }
  
  /**
   * 注册比例变化回调
   */
  onRatioChange(callback: RatioChangeCallback): () => void {
    this.ratioChangeCallbacks.push(callback)
    return () => {
      const index = this.ratioChangeCallbacks.indexOf(callback)
      if (index > -1) {
        this.ratioChangeCallbacks.splice(index, 1)
      }
    }
  }
  
  /**
   * 注册分辨率变化回调
   */
  onResolutionChange(callback: ResolutionChangeCallback): () => void {
    this.resolutionChangeCallbacks.push(callback)
    return () => {
      const index = this.resolutionChangeCallbacks.indexOf(callback)
      if (index > -1) {
        this.resolutionChangeCallbacks.splice(index, 1)
      }
    }
  }
  
  /**
   * 获取当前比例
   */
  getCurrentRatio(): string {
    return this.currentRatio
  }
  
  /**
   * 获取当前分辨率
   */
  getCurrentResolution(): string {
    return this.currentResolution
  }
  
  /**
   * 渲染比例选项按钮
   */
  renderRatioOptions(modelConfig: ModelConfig, page?: PageReference): void {
    const container = document.getElementById(this.config.ratioContainerId)
    if (!container) {
      return
    }
    
    const ratios = this.getRatiosFromModel(modelConfig)
    let currentRatio = page?.currentRatio || this.currentRatio || ratios[0].key
    
    // 确保当前比例在可用列表中
    if (!ratios.some(r => r.key === currentRatio)) {
      currentRatio = ratios[0].key
    }
    
    this.currentRatio = currentRatio
    if (page) {
      page.currentRatio = currentRatio
    }
    
    // 设置容器样式
    container.className = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2'
    container.innerHTML = ''
    
    // 创建按钮
    ratios.forEach(ratio => {
      const button = this.createRatioButton(ratio, ratio.key === currentRatio)
      button.addEventListener('click', () => this.selectRatio(ratio.key, page))
      container.appendChild(button)
    })
    
    // 触发初始选择
    page?.selectRatio?.(currentRatio)
  }
  
  /**
   * 创建比例按钮
   */
  private createRatioButton(ratio: RatioOption, isActive: boolean): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.ratio = ratio.key
    button.className = `ratio-btn text-white py-2 px-2 md:px-4 rounded-md transition-all text-xs md:text-sm ${
      isActive ? 'active' : ''
    }`
    
    const { label, subtitle } = this.getRatioLabel(ratio)
    
    button.title = subtitle && subtitle !== ratio.key
      ? `${label} · ${subtitle}`
      : label
    
    button.innerHTML = `
      <div class="flex flex-col md:flex-row items-center justify-center space-y-0.5 md:space-y-0 md:space-x-1">
        <span>${label}</span>
        <span class="text-[11px] opacity-70 md:text-xs">${subtitle}</span>
      </div>
    `
    
    return button
  }
  
  /**
   * 选择比例
   */
  selectRatio(ratioKey: string, page?: PageReference): void {
    this.currentRatio = ratioKey
    
    // 更新按钮状态
    const container = document.getElementById(this.config.ratioContainerId)
    if (container) {
      container.querySelectorAll('.ratio-btn').forEach(btn => {
        const btnElement = btn as HTMLElement
        if (btnElement.dataset.ratio === ratioKey) {
          btnElement.classList.add('active')
        } else {
          btnElement.classList.remove('active')
        }
      })
    }
    
    // 更新页面引用
    if (page) {
      page.currentRatio = ratioKey
      page.selectRatio?.(ratioKey)
    }
    
    // 触发回调
    for (const callback of this.ratioChangeCallbacks) {
      try {
        callback(ratioKey)
      } catch (error) {
        console.warn('[RatioResolutionManager] 比例变化回调失败:', error)
      }
    }
  }
  
  /**
   * 渲染分辨率选项
   */
  renderResolutionOptions(modelConfig: ModelConfig, page?: PageReference): void {
    const container = document.getElementById(this.config.resolutionContainerId)
    const buttonsContainer = document.getElementById(this.config.resolutionButtonsId)
    
    if (!container || !buttonsContainer) {
      return
    }
    
    // 检查模型是否支持分辨率控制
    if (!modelConfig.capabilities?.resolutionControl || !modelConfig.resolutions) {
      container.classList.add('hidden')
      return
    }
    
    container.classList.remove('hidden')
    
    const resolutions = modelConfig.resolutions
    
    // 读取保存的分辨率
    let currentResolution = this.loadSavedResolution()
    
    // 如果没有保存或不在可用列表中，使用默认值
    if (!currentResolution || !resolutions.some(r => r.key === currentResolution)) {
      currentResolution = modelConfig.defaultResolution || resolutions[0].key
    }
    
    this.currentResolution = currentResolution
    if (page) {
      page.currentResolution = currentResolution
    }
    
    buttonsContainer.innerHTML = ''
    
    // 创建按钮
    resolutions.forEach(resolution => {
      const button = this.createResolutionButton(resolution, resolution.key === currentResolution)
      button.addEventListener('click', () => this.selectResolution(resolution.key, page))
      buttonsContainer.appendChild(button)
    })
    
    // 触发初始选择
    page?.selectResolution?.(currentResolution)
    page?.updateFinalResolutionDisplay?.()
  }
  
  /**
   * 创建分辨率按钮
   */
  private createResolutionButton(resolution: ResolutionOption, isActive: boolean): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.resolution = resolution.key
    button.className = `ratio-btn text-white py-2 px-2 md:px-4 rounded-md transition-all text-xs md:text-sm ${
      isActive ? 'active' : ''
    }`
    
    const { label, subtitle } = this.getResolutionLabel(resolution)
    
    button.title = subtitle ? `${label} · ${subtitle}` : label
    
    button.innerHTML = `
      <div class="flex flex-col md:flex-row items-center justify-center space-y-0.5 md:space-y-0 md:space-x-1">
        <span>${label}</span>
        ${subtitle ? `<span class="text-[11px] opacity-70 md:text-xs">${subtitle}</span>` : ''}
      </div>
    `
    
    return button
  }
  
  /**
   * 选择分辨率
   */
  selectResolution(resolutionKey: string, page?: PageReference): void {
    this.currentResolution = resolutionKey
    
    // 保存到 localStorage
    this.saveResolution(resolutionKey)
    
    // 更新按钮状态
    const container = document.getElementById(this.config.resolutionButtonsId)
    if (container) {
      container.querySelectorAll('.ratio-btn').forEach(btn => {
        const btnElement = btn as HTMLElement
        if (btnElement.dataset.resolution === resolutionKey) {
          btnElement.classList.add('active')
        } else {
          btnElement.classList.remove('active')
        }
      })
    }
    
    // 更新页面引用
    if (page) {
      page.currentResolution = resolutionKey
      page.selectResolution?.(resolutionKey)
      page.updateFinalResolutionDisplay?.()
    }
    
    // 触发回调
    for (const callback of this.resolutionChangeCallbacks) {
      try {
        callback(resolutionKey)
      } catch (error) {
        console.warn('[RatioResolutionManager] 分辨率变化回调失败:', error)
      }
    }
  }
  
  /**
   * 渲染批量比例选项
   */
  renderBatchRatioOptions(modelConfig: ModelConfig, page?: PageReference): void {
    const selectElement = document.getElementById(this.config.batchRatioSelectId) as HTMLSelectElement | null
    if (!selectElement || selectElement.classList.contains('intelligent-batch-display')) {
      return
    }
    
    const ratios = this.getRatiosFromModel(modelConfig)
    const previousValue = selectElement.value
    const preferredRatio = page?.currentRatio || this.currentRatio
    
    selectElement.innerHTML = ''
    
    ratios.forEach(ratio => {
      const option = document.createElement('option')
      option.value = ratio.key
      const label = ratio.label || ratio.key
      const fullLabel = ratio.description ? `${label} ${ratio.description}` : label
      option.textContent = fullLabel
      option.label = label
      option.dataset.shortLabel = label
      option.dataset.fullLabel = fullLabel
      selectElement.appendChild(option)
    })
    
    // 确定目标值
    let targetValue = ratios[0].key
    if (previousValue && ratios.some(r => r.key === previousValue)) {
      targetValue = previousValue
    } else if (preferredRatio && ratios.some(r => r.key === preferredRatio)) {
      targetValue = preferredRatio
    }
    
    selectElement.value = targetValue
    this.updateBatchRatioTitle(selectElement)
    
    // 绑定事件
    if (!selectElement.dataset.shortLabelListenerAttached) {
      selectElement.addEventListener('change', () => {
        this.updateBatchRatioTitle(selectElement)
      })
      selectElement.dataset.shortLabelListenerAttached = 'true'
    }
  }
  
  /**
   * 更新批量比例选择器标题
   */
  private updateBatchRatioTitle(selectElement: HTMLSelectElement): void {
    const option = selectElement.selectedOptions[0]
    if (!option) return
    selectElement.title = option.dataset.fullLabel || option.textContent || ''
  }
  
  /**
   * 从模型配置获取比例列表
   */
  private getRatiosFromModel(modelConfig: ModelConfig): RatioOption[] {
    return Array.isArray(modelConfig.ratios) && modelConfig.ratios.length > 0
      ? modelConfig.ratios
      : this.config.defaultRatios
  }
  
  /**
   * 获取比例标签 (支持 i18n)
   */
  private getRatioLabel(ratio: RatioOption): { label: string; subtitle: string } {
    try {
      // 使用 TypeScript 版本的 I18nService
      const i18nService = (window as any).i18n
      if (i18nService && typeof i18nService.t === 'function') {
        const labelKey = `aspectRatios.${ratio.key}.label`
        const descKey = `aspectRatios.${ratio.key}.description`
        const translatedLabel = i18nService.t(labelKey)
        const translatedDesc = i18nService.t(descKey)
        
        // 如果翻译成功（返回值不等于 key 本身）
        if (translatedLabel !== labelKey) {
          return {
            label: `${translatedLabel} ${ratio.key}`,
            subtitle: translatedDesc !== descKey ? translatedDesc : ratio.key
          }
        }
      }
    } catch {
      // 忽略 i18n 错误
    }
    
    return {
      label: ratio.label || `比例 ${ratio.key}`,
      subtitle: ratio.description || ratio.key
    }
  }
  
  /**
   * 获取分辨率标签 (支持 i18n)
   */
  private getResolutionLabel(resolution: ResolutionOption): { label: string; subtitle: string } {
    try {
      // 使用 TypeScript 版本的 I18nService
      const i18nService = (window as any).i18n
      if (i18nService && typeof i18nService.t === 'function') {
        const labelKey = `resolutions.${resolution.key}.label`
        const descKey = `resolutions.${resolution.key}.description`
        const translatedLabel = i18nService.t(labelKey)
        const translatedDesc = i18nService.t(descKey)
        
        // 如果翻译成功（返回值不等于 key 本身）
        if (translatedLabel !== labelKey) {
          return {
            label: translatedLabel,
            subtitle: translatedDesc !== descKey ? translatedDesc : ''
          }
        }
      }
    } catch {
      // 忽略 i18n 错误
    }
    
    return {
      label: resolution.label || resolution.key,
      subtitle: resolution.description || ''
    }
  }
  
  /**
   * 保存分辨率到 localStorage
   */
  private saveResolution(resolutionKey: string): void {
    try {
      localStorage.setItem(this.config.resolutionStorageKey, resolutionKey)
    } catch (error) {
      console.warn('[RatioResolutionManager] 保存分辨率失败:', error)
    }
  }
  
  /**
   * 从 localStorage 读取分辨率
   */
  private loadSavedResolution(): string | null {
    try {
      return localStorage.getItem(this.config.resolutionStorageKey)
    } catch {
      return null
    }
  }
}

// 单例实例
let ratioResolutionManagerInstance: RatioResolutionManager | null = null

/**
 * 获取 RatioResolutionManager 单例
 */
export function getRatioResolutionManager(config?: RatioResolutionConfig): RatioResolutionManager {
  if (!ratioResolutionManagerInstance) {
    ratioResolutionManagerInstance = new RatioResolutionManager(config)
  }
  return ratioResolutionManagerInstance
}

/**
 * 创建新的 RatioResolutionManager 实例 (仅用于测试)
 */
export function createRatioResolutionManager(config?: RatioResolutionConfig): RatioResolutionManager {
  ratioResolutionManagerInstance = new RatioResolutionManager(config)
  return ratioResolutionManagerInstance
}
