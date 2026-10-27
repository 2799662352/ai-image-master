// src/renderer/src/features/model-selector/ModelSelectorManager.ts
/**
 * 模型选择器管理器
 * 处理模型选择、比例选项、分辨率选项的完整管理
 */

import type { ModelCapabilities } from '@/types'
import { MODEL_VENDORS, groupModelsByVendor } from '../../services/api/modelVendors'
import { VendorModelPanel } from './VendorModelPanel'

declare const Choices: any
declare const i18n: any

/** Choices.js 模板是字符串拼接，模型名 / 厂商名进 HTML 前先转义。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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

export interface ModelConfig {
  name: string
  displayName: string
  time?: string
  isNew?: boolean
  sizeStrategy?: string
  capabilities?: ModelCapabilities
  ratios?: RatioOption[]
  resolutions?: ResolutionOption[]
  defaultResolution?: string
}

export interface ModelSelectorManagerConfig {
  onModelChange?: (modelKey: string, model: ModelConfig) => void
  onRatioChange?: (ratioKey: string) => void
  onResolutionChange?: (resolutionKey: string) => void
  getModelDisplayName?: (modelKey: string) => string
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void
  defaultRatios?: RatioOption[]
}

export interface PageReference {
  currentRatio?: string
  currentResolution?: string
  selectRatio?: (ratio: string) => void
  selectResolution?: (resolution: string) => void
  updateFinalResolutionDisplay?: () => void
  updateReferenceImageLimitDisplay?: () => void
  updateReferenceImagesPreview?: () => void
  onModelChanged?: () => void
}

export class ModelSelectorManager {
  private desktopChoice: any = null
  private mobileChoice: any = null
  private config: ModelSelectorManagerConfig
  private initialized = false
  private currentModelKey = ''
  private switching = false

  private readonly DEFAULT_RATIOS: RatioOption[] = [
    { key: '1:1', label: '正方形', description: '1:1' },
    { key: '16:9', label: '横版', description: '16:9' },
    { key: '9:16', label: '竖版', description: '9:16' }
  ]

  constructor(config: ModelSelectorManagerConfig = {}) {
    this.config = {
      ...config,
      defaultRatios: config.defaultRatios || this.DEFAULT_RATIOS
    }
  }

  /**
   * 初始化模型选择器
   */
  init(retryCount = 0): void {
    const MAX_RETRIES = 30

    console.log('🚀 初始化模型选择器（Choices.js）')

    if (typeof Choices === 'undefined') {
      if (retryCount >= MAX_RETRIES) {
        console.error('❌ Choices.js 加载超时，放弃初始化模型选择器')
        return
      }
      console.warn(`⏳ Choices.js 未加载，延迟初始化... (${retryCount + 1}/${MAX_RETRIES})`)
      setTimeout(() => this.init(retryCount + 1), 100)
      return
    }

    const desktopSelector = document.getElementById('modelSelector') as HTMLSelectElement | null
    const mobileSelector = document.getElementById('modelSelectorMobile') as HTMLSelectElement | null

    if (!desktopSelector || !mobileSelector) {
      console.warn('⏳ DOM 元素未就绪，延迟初始化...')
      setTimeout(() => this.init(), 100)
      return
    }

    try {
      const api = (window as any).aiImageAPI
      const models = api?.getAllModels?.() || {}
      this.currentModelKey = api?.model || ''

      if (this.currentModelKey && !models[this.currentModelKey]) {
        const foundKey = Object.keys(models).find(k => models[k].name === this.currentModelKey)
        if (foundKey) {
          console.warn('⚠️ api.model returned name instead of key, auto-correcting:', this.currentModelKey, '→', foundKey)
          this.currentModelKey = foundKey
        }
      }

      this.initDesktopSelector(desktopSelector, models, this.currentModelKey)
      this.initMobileSelector(mobileSelector, models, this.currentModelKey)

      this.initialized = true
      console.log('✅ 模型选择器初始化完成')
      
      this.updateUIForModel()
    } catch (error) {
      console.error('❌ 模型选择器初始化失败:', error)
    }
  }

  /**
   * 初始化桌面端模型选择器
   */
  private initDesktopSelector(
    selectElement: HTMLSelectElement,
    models: Record<string, ModelConfig>,
    currentModelKey: string
  ): void {
    console.log('🖥️ 初始化桌面端模型选择器')

    if (this.desktopChoice) {
      console.log('🗑️ 销毁旧的桌面端 Choices 实例')
      this.desktopChoice.destroy()
      this.desktopChoice = null
    }

    this.populateSelectOptions(selectElement, models, currentModelKey)

    // 桌面端不再用 Choices.js:改成「厂商 → 模型」两级面板(设计稿 D6,照 apiyi 生图页)。
    // <select> 仍是选项 / 当前值的真源,面板点选会写回它并派发 change,下面
    // bindSelectorEvents 的监听照旧生效。对象表面兼容 Choices(setChoiceByValue 等)。
    this.desktopChoice = new VendorModelPanel({
      select: selectElement,
      getModels: () => ((window as any).aiImageAPI?.getAllModels?.() as Record<string, ModelConfig>) || {},
      getDisplayName: this.config.getModelDisplayName,
      onSelect: (modelKey) => this.handleModelSwitch(modelKey),
    })

    this.bindSelectorEvents(selectElement, '🖥️')

    console.log('✅ 桌面端模型选择器初始化完成')
  }

  /**
   * 初始化移动端模型选择器
   */
  private initMobileSelector(
    selectElement: HTMLSelectElement,
    models: Record<string, ModelConfig>,
    currentModelKey: string
  ): void {
    console.log('📱 初始化移动端模型选择器')

    if (this.mobileChoice) {
      console.log('🗑️ 销毁旧的移动端 Choices 实例')
      this.mobileChoice.destroy()
      this.mobileChoice = null
    }

    this.populateSelectOptions(selectElement, models, currentModelKey)

    this.mobileChoice = new Choices(selectElement, {
      searchEnabled: false,
      itemSelectText: '',
      shouldSort: false,
      position: 'bottom',
      renderChoiceLimit: -1,
      allowHTML: true,
      removeItemButton: false,
      callbackOnCreateTemplates: (template: any) => this.createChoicesTemplates(template)
    })

    this.bindSelectorEvents(selectElement, '📱')

    console.log('✅ 移动端模型选择器初始化完成')
  }

  /**
   * 填充选择器选项 —— 按厂商聚合(腾讯 / OpenAI / Google …各占一档)。
   *
   * 分组用原生 `<optgroup>`:Choices.js 读 `<optgroup>` 生成分组抬头(`choiceGroup` 模板),
   * 与 apiyi 生图页(imagen.apiyi.com)顶栏「厂商 → 模型」的两级结构一致。组序 / 组内顺序
   * 由 {@link groupModelsByVendor} 决定(组内保留 getAllModels() 的展示序)。
   * 只有一家厂商(或全都没标 vendor)时退回平铺:一组一个抬头只是噪音。
   */
  private populateSelectOptions(
    selectElement: HTMLSelectElement,
    models: Record<string, ModelConfig>,
    currentModelKey: string
  ): void {
    selectElement.innerHTML = ''

    const groups = groupModelsByVendor(models)
    const grouped = groups.length > 1

    for (const group of groups) {
      let parent: HTMLElement = selectElement
      if (grouped) {
        const optgroup = document.createElement('optgroup')
        optgroup.label = group.meta.name
        optgroup.dataset.vendor = group.vendorKey
        selectElement.appendChild(optgroup)
        parent = optgroup
      }

      for (const { key: modelKey, model } of group.models) {
        const option = document.createElement('option')
        option.value = modelKey

        const displayName = this.config.getModelDisplayName
          ? this.config.getModelDisplayName(modelKey)
          : model.displayName

        option.textContent = `${model.name} - ${displayName}`

        if (modelKey === currentModelKey) {
          option.selected = true
        }

        parent.appendChild(option)
      }
    }
  }

  /**
   * 创建 Choices.js 自定义模板
   */
  private createChoicesTemplates(template: any) {
    const api = (window as any).aiImageAPI
    // 模型表通过公开的 getAllModels() 取(与 init() 同一条路);`api.models` 是 ApiService
    // 的私有字段,在真机上不可靠,只留作兜底。每次渲染都重新取,自定义站点改了模型表也能跟上。
    const lookupModel = (key: string): any =>
      api?.getAllModels?.()?.[key] ?? api?.models?.[key] ?? undefined

    return {
      /**
       * 厂商分组抬头:「OpenAI · 5」。Choices.js 把 `<optgroup>` 的 label 与其下 choices
       * 一起交过来,抬头是 choices 的兄弟节点(不是父级),所以 CSS 里可以直接 sticky。
       */
      choiceGroup: ({ classNames }: any, group: any) => {
        const label = String(group.label ?? '')
        const count = Array.isArray(group.choices) ? group.choices.length : 0
        return template(`
          <div class="${classNames.group}" role="group" data-group data-id="${group.id}" data-value="${label}">
            <div class="${classNames.groupHeading} model-group-heading">
              <span class="model-group-name">${label}</span>
              ${count > 0 ? `<span class="model-group-count">${count}</span>` : ''}
            </div>
          </div>
        `)
      },
      /**
       * 选中态（顶栏里那一格）。设计稿 D6：36px 单行 =「厂商小标签 + 模型名 + ▾」。
       * 厂商读模型表的 `vendor`（与下拉分组同一张 {@link MODEL_VENDORS}）；模型名若已以厂商名
       * 开头（「腾讯 Image 2」）就去掉前缀，免得小标签和正文重复说一遍「腾讯」。
       */
      item: ({ classNames }: any, data: any) => {
        const modelName = String(data.label ?? '').split(' - ')[0]
        const vendorRaw = lookupModel(data.value)?.vendor
        const vendorName =
          typeof vendorRaw === 'string' && vendorRaw in MODEL_VENDORS
            ? MODEL_VENDORS[vendorRaw as keyof typeof MODEL_VENDORS].name
            : ''
        const shownName =
          vendorName && modelName.startsWith(vendorName)
            ? modelName.slice(vendorName.length).trim() || modelName
            : modelName
        return template(`
          <div class="${classNames.item} model-selected" title="${escapeHtml(modelName)}">
            ${vendorName ? `<span class="model-vendor-chip">${escapeHtml(vendorName)}</span>` : ''}
            <span class="model-selected-name">${escapeHtml(shownName)}</span>
            <svg class="model-selected-caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
        `)
      },
      choice: ({ classNames }: any, data: any) => {
        const parts = data.label.split(' - ')
        const name = parts[0] || ''
        const desc = parts[1] || ''

        const modelInfo = lookupModel(data.value)

        let badges = ''
        if (modelInfo) {
          if (modelInfo.time) {
            badges += `<span class="model-badge model-badge-time">⏱ ${modelInfo.time}</span>`
          }
          if (modelInfo.isNew) {
            badges += `<span class="model-badge model-badge-new">New</span>`
          }
        }

        return template(`
          <div class="${classNames.item} ${classNames.itemChoice} ${
            data.disabled ? classNames.itemDisabled : classNames.itemSelectable
          }" data-select-text="" data-choice ${
            data.disabled ? 'data-choice-disabled aria-disabled="true"' : 'data-choice-selectable'
          } data-id="${data.id}" data-value="${data.value}" role="option">
            <div class="model-header">
              <div class="model-name">${name}</div>
              ${badges ? `<div class="model-badges">${badges}</div>` : ''}
            </div>
            ${desc ? `<div class="model-desc">${desc}</div>` : ''}
          </div>
        `)
      }
    }
  }

  /**
   * 绑定选择器事件
   */
  private bindSelectorEvents(selectElement: HTMLSelectElement, prefix: string): void {
    const handleChoice = (event: CustomEvent) => {
      const value = event.detail?.value ?? event.detail?.choice?.value
      if (value) {
        console.log(`${prefix} 模型已切换:`, value)
        this.handleModelSwitch(value)
      }
    }

    const handleChange = (event: Event) => {
      const target = event.target as HTMLSelectElement
      if (target.value && target.value !== this.currentModelKey) {
        this.handleModelSwitch(target.value)
      }
    }

    selectElement.addEventListener('choice', handleChoice as EventListener)
    selectElement.addEventListener('change', handleChange)
    console.log(`✅ ${prefix} 事件监听器已绑定`)
  }

  /**
   * 处理模型切换
   */
  private handleModelSwitch(modelKey: string): void {
    if (this.switching || modelKey === this.currentModelKey) return
    this.switching = true

    try {
      console.log('🔄 切换模型到:', modelKey)

      const api = (window as any).aiImageAPI
      const saved = api?.setModel?.(modelKey) ?? api?.saveModel?.(modelKey)
      if (saved) {
        this.currentModelKey = modelKey

        if (this.desktopChoice) {
          this.desktopChoice.setChoiceByValue(modelKey)
        }
        if (this.mobileChoice) {
          this.mobileChoice.setChoiceByValue(modelKey)
        }

        const currentModel = api.getCurrentModel?.() as ModelConfig
        this.config.onModelChange?.(modelKey, currentModel)

        const w = window as any
        const generatePage = w.generatePage as PageReference | undefined
        this.updateUIForModel(generatePage)

        const batchPage = w.batchPage as { onModelChanged?: () => void } | undefined
        batchPage?.onModelChanged?.()

        const showToast = this.config.showToast ?? w.toastManagerTS?.show?.bind(w.toastManagerTS)
        showToast?.(`已切换到模型: ${currentModel?.name || modelKey}`, 'success')

        console.log('✅ 模型切换完成')
      } else {
        const showToast = this.config.showToast ?? (window as any).toastManagerTS?.show?.bind((window as any).toastManagerTS)
        showToast?.('模型切换失败', 'error')
      }
    } finally {
      this.switching = false
    }
  }

  /**
   * 渲染单图生成比例按钮
   */
  renderRatioOptions(modelConfig: ModelConfig, page?: PageReference): void {
    const ratioContainer = document.getElementById('ratioButtons')
    if (!ratioContainer) return

    // sizeStrategy === 'prompt' 时隐藏比例选择器
    const wrapper = ratioContainer.parentElement
    if (modelConfig.sizeStrategy === 'prompt') {
      if (wrapper) wrapper.classList.add('hidden')
      return
    }
    if (wrapper) wrapper.classList.remove('hidden')

    const ratios = Array.isArray(modelConfig.ratios) && modelConfig.ratios.length > 0
      ? modelConfig.ratios
      : this.config.defaultRatios!

    let currentRatio = page?.currentRatio || ratios[0].key

    if (!ratios.some(ratio => ratio.key === currentRatio)) {
      currentRatio = ratios[0].key
      if (page) {
        page.currentRatio = currentRatio
      }
    }

    ratioContainer.className = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2'
    ratioContainer.innerHTML = ''

    ratios.forEach(ratio => {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.ratio = ratio.key
      button.className = `ratio-btn text-white py-2 px-2 md:px-4 rounded-md transition-all text-xs md:text-sm ${
        ratio.key === currentRatio ? 'active' : ''
      }`

      const { label, subtitle } = this.getRatioLabel(ratio)

      if (subtitle && subtitle !== ratio.key) {
        button.title = `${label} · ${subtitle}`
      } else {
        button.title = label
      }

      button.innerHTML = `
        <div class="flex flex-col md:flex-row items-center justify-center space-y-0.5 md:space-y-0 md:space-x-1">
          <span>${label}</span>
          <span class="text-[11px] opacity-70 md:text-xs">${subtitle}</span>
        </div>
      `
      ratioContainer.appendChild(button)
    })

    page?.selectRatio?.(currentRatio)
  }

  /**
   * 获取比例标签（支持 i18n）
   */
  private getRatioLabel(ratio: RatioOption): { label: string; subtitle: string } {
    try {
      if (typeof i18n !== 'undefined') {
        const translated = i18n.translations?.[i18n.currentLang]?.aspectRatios?.[ratio.key]
        if (translated) {
          return {
            label: `${translated.label} ${ratio.key}`,
            subtitle: translated.description || ratio.key
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
   * 渲染分辨率选项
   */
  renderResolutionOptions(modelConfig: ModelConfig, page?: PageReference): void {
    const resolutionContainer = document.getElementById('resolutionContainer')
    const resolutionButtons = document.getElementById('resolutionButtons')

    if (!resolutionContainer || !resolutionButtons) {
      return
    }

    if (!modelConfig.capabilities?.resolutionControl || !modelConfig.resolutions) {
      resolutionContainer.classList.add('hidden')
      return
    }

    resolutionContainer.classList.remove('hidden')

    const resolutions = modelConfig.resolutions
    const isQualityMode = resolutions.some(r => ['low', 'medium', 'high'].includes(r.key))

    const label = resolutionContainer.querySelector('label')
    if (label) {
      label.textContent = isQualityMode ? '图片质量' : '图片分辨率'
    }

    const finalDisplay = document.getElementById('finalResolutionDisplay')
    if (finalDisplay) {
      finalDisplay.classList.toggle('hidden', isQualityMode)
    }

    let currentResolution: string | null = null
    try {
      currentResolution = localStorage.getItem('gemini_resolution')
    } catch {
      console.error('读取分辨率设置失败')
    }

    if (!currentResolution || !resolutions.some(res => res.key === currentResolution)) {
      currentResolution = modelConfig.defaultResolution || resolutions[0].key
    }

    if (page) {
      page.currentResolution = currentResolution
    }

    resolutionButtons.innerHTML = ''

    resolutions.forEach(resolution => {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.resolution = resolution.key
      button.className = `ratio-btn text-white py-2 px-2 md:px-4 rounded-md transition-all text-xs md:text-sm ${
        resolution.key === currentResolution ? 'active' : ''
      }`

      const { label: lbl, subtitle } = this.getResolutionLabel(resolution)

      if (subtitle) {
        button.title = `${lbl} · ${subtitle}`
      } else {
        button.title = lbl
      }

      button.innerHTML = `
        <div class="flex flex-col md:flex-row items-center justify-center space-y-0.5 md:space-y-0 md:space-x-1">
          <span>${lbl}</span>
          ${subtitle ? `<span class="text-[11px] opacity-70 md:text-xs">${subtitle}</span>` : ''}
        </div>
      `
      resolutionButtons.appendChild(button)
    })

    page?.selectResolution?.(currentResolution)
    page?.updateFinalResolutionDisplay?.()
  }

  /**
   * 获取分辨率标签（支持 i18n）
   */
  private getResolutionLabel(resolution: ResolutionOption): { label: string; subtitle: string } {
    try {
      if (typeof i18n !== 'undefined') {
        const translated = i18n.translations?.[i18n.currentLang]?.resolutions?.[resolution.key]
        if (translated) {
          return {
            label: translated.label,
            subtitle: translated.description || ''
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
   * 渲染批量生成比例选项
   */
  renderBatchRatioOptions(modelConfig: ModelConfig, page?: PageReference): void {
    const batchRatioSelect = document.getElementById('batchRatio') as HTMLSelectElement | null
    if (!batchRatioSelect || batchRatioSelect.classList.contains('intelligent-batch-display')) {
      return
    }

    const ratios = Array.isArray(modelConfig.ratios) && modelConfig.ratios.length > 0
      ? modelConfig.ratios
      : this.config.defaultRatios!

    const previousValue = batchRatioSelect.value
    const preferredRatio = page?.currentRatio
    batchRatioSelect.innerHTML = ''

    ratios.forEach(ratio => {
      const option = document.createElement('option')
      option.value = ratio.key
      const label = ratio.label || ratio.key
      const fullLabel = ratio.description ? `${label} ${ratio.description}` : label
      option.textContent = fullLabel
      option.label = label
      option.dataset.shortLabel = label
      option.dataset.fullLabel = fullLabel
      batchRatioSelect.appendChild(option)
    })

    let targetValue = ratios[0].key
    if (previousValue && ratios.some(ratio => ratio.key === previousValue)) {
      targetValue = previousValue
    } else if (preferredRatio && ratios.some(ratio => ratio.key === preferredRatio)) {
      targetValue = preferredRatio
    }
    batchRatioSelect.value = targetValue

    this.updateBatchRatioTitle(batchRatioSelect)

    if (!batchRatioSelect.dataset.shortLabelListenerAttached) {
      batchRatioSelect.addEventListener('change', () => {
        this.updateBatchRatioTitle(batchRatioSelect)
      })
      batchRatioSelect.dataset.shortLabelListenerAttached = 'true'
    }
  }

  /**
   * 更新批量比例选择器标题
   */
  private updateBatchRatioTitle(selectElement: HTMLSelectElement): void {
    const option = selectElement.selectedOptions[0]
    if (!option) return
    const fullLabel = option.dataset.fullLabel || option.textContent
    selectElement.title = fullLabel || ''
  }

  /**
   * 设置 Seedream 数量提示
   */
  setupSeedreamCountHint(modelConfig: ModelConfig): void {
    const isSeedream = modelConfig?.name?.toLowerCase().includes('seedream')
    const batchCountLabel = document.getElementById('batchCountLabel')
    let hint = document.getElementById('batchCountHint')

    if (!batchCountLabel) {
      return
    }

    if (isSeedream) {
      const message = 'Seedream 模型支持一次生成多张，每张按单价计费（最多 15 张）。如需批量多图，请分批提交任务。'

      if (!hint) {
        const btn = document.createElement('button')
        btn.id = 'batchCountHint'
        btn.type = 'button'
        hint = btn
        hint.className = 'ml-2 w-4 h-4 flex items-center justify-center text-orange-200 hover:text-orange-100 transition-colors'
        hint.innerHTML = `<i class="fas fa-question-circle"></i>`
        hint.title = message
        hint.setAttribute('aria-label', message)
        hint.addEventListener('click', () => {
          this.config.showToast?.(message, 'info')
        })
        batchCountLabel.appendChild(hint)
      } else {
        hint.title = message
        hint.setAttribute('aria-label', message)
      }
    } else if (hint) {
      hint.remove()
    }
  }

  /**
   * sizeStrategy === 'prompt' 时显示尺寸提示
   */
  setupPromptSizeHint(modelConfig: ModelConfig): void {
    const isPromptSize = modelConfig?.sizeStrategy === 'prompt'
    let hint = document.getElementById('promptSizeHint')

    if (isPromptSize) {
      if (!hint) {
        hint = document.createElement('div')
        hint.id = 'promptSizeHint'
        hint.className = 'mt-3 p-3 rounded-lg bg-emerald-500 bg-opacity-15 border border-emerald-300 border-opacity-40 text-emerald-50 text-xs md:text-sm flex items-start gap-2'
        hint.innerHTML = `
          <i class="fas fa-info-circle mt-0.5 flex-shrink-0"></i>
          <span>该模型尺寸自适应，无需单独选择。如需指定具体尺寸，请在提示词里描述，例如："横版 16:9 电影画幅"、"竖版 9:16 手机海报"、"1024×1024 方图"。</span>
        `
        const ratioContainer = document.getElementById('ratioButtons')?.parentElement
        if (ratioContainer) {
          ratioContainer.after(hint)
        }
      }
      hint.classList.remove('hidden')
    } else if (hint) {
      hint.classList.add('hidden')
    }
  }

  /**
   * 设置当前选中的模型
   */
  setCurrentModel(modelKey: string): void {
    this.currentModelKey = modelKey
    if (this.desktopChoice) {
      this.desktopChoice.setChoiceByValue(modelKey)
    }
    if (this.mobileChoice) {
      this.mobileChoice.setChoiceByValue(modelKey)
    }
  }

  /**
   * 切换模型（完整流程）
   * V16.4: 替代 app.switchModel()
   * @param modelKey 模型标识符
   * @param pages 页面引用（用于更新 UI）
   */
  switchModel(modelKey: string, pages?: { generate?: PageReference; batch?: PageReference }): boolean {
    console.log('🔄 切换模型到:', modelKey)

    const api = (window as any).aiImageAPI
    if (!api) {
      console.error('[ModelSelectorManager] API 未初始化')
      return false
    }

    if (api.setModel?.(modelKey) ?? api.saveModel?.(modelKey)) {
      // 同步选择器
      this.setCurrentModel(modelKey)

      // 更新 UI
      this.updateUIForModel(pages?.generate)

      const currentModel = api.getCurrentModel()
      this.config.showToast?.(`已切换到模型: ${currentModel.name}`, 'success')

      // 如果提供了页面引用，更新相关页面
      if (pages?.generate) {
        pages.generate.updateReferenceImageLimitDisplay?.()
        pages.generate.updateReferenceImagesPreview?.()
      }

      if (pages?.batch) {
        pages.batch.onModelChanged?.()
      }

      console.log('✅ 模型切换完成')
      return true
    } else {
      this.config.showToast?.('模型切换失败', 'error')
      return false
    }
  }

  /**
   * 获取当前模型 key
   */
  getCurrentModelKey(): string {
    return this.currentModelKey
  }

  /**
   * 刷新模型列表
   */
  refresh(): void {
    const api = (window as any).aiImageAPI
    const models = api?.getAllModels?.() || {}
    this.currentModelKey = api?.model || ''

    if (this.currentModelKey && !models[this.currentModelKey]) {
      const foundKey = Object.keys(models).find(k => models[k].name === this.currentModelKey)
      if (foundKey) {
        console.warn('⚠️ refresh: api.model returned name instead of key, auto-correcting:', this.currentModelKey, '→', foundKey)
        this.currentModelKey = foundKey
      }
    }

    const desktopSelector = document.getElementById('modelSelector') as HTMLSelectElement | null
    const mobileSelector = document.getElementById('modelSelectorMobile') as HTMLSelectElement | null

    if (desktopSelector) {
      this.initDesktopSelector(desktopSelector, models, this.currentModelKey)
    }
    if (mobileSelector) {
      this.initMobileSelector(mobileSelector, models, this.currentModelKey)
    }
  }

  /**
   * 更新模型选择器的显示名称 (用于语言切换后刷新)
   */
  updateDisplayNames(): void {
    const api = (window as any).aiImageAPI
    if (!api) return

    const models = api.getAllModels?.() || {}
    const currentValue = this.currentModelKey

    // 更新导航栏模型选择器 (Choices.js 实例)
    this.updateChoicesInstance(
      document.getElementById('modelSelector') as HTMLSelectElement,
      this.desktopChoice,
      models,
      currentValue
    )

    this.updateChoicesInstance(
      document.getElementById('modelSelectorMobile') as HTMLSelectElement,
      this.mobileChoice,
      models,
      currentValue
    )

    // 更新页面内的普通选择器
    this.updateSimpleSelector(document.getElementById('modelSelect') as HTMLSelectElement, models)
    this.updateSimpleSelector(document.getElementById('batchModelSelect') as HTMLSelectElement, models)
  }

  /**
   * 更新 Choices.js 实例的选项显示
   */
  private updateChoicesInstance(
    selectElement: HTMLSelectElement | null,
    choicesInstance: any,
    models: Record<string, ModelConfig>,
    currentValue: string
  ): void {
    if (!selectElement) return

    // 更新原生 select 选项文本
    Array.from(selectElement.options).forEach(option => {
      const modelKey = option.value
      const model = models[modelKey]
      if (model) {
        const displayName = this.config.getModelDisplayName
          ? this.config.getModelDisplayName(modelKey)
          : model.displayName
        option.textContent = `${model.name} - ${displayName}`
      }
    })

    // 如果存在 Choices 实例，重新设置选项
    if (choicesInstance && typeof choicesInstance.setChoices === 'function') {
      const choices = Array.from(selectElement.options).map(option => ({
        value: option.value,
        label: option.textContent || '',
        selected: option.value === currentValue
      }))

      choicesInstance.clearStore()
      choicesInstance.setChoices(choices, 'value', 'label', true)
    }
  }

  /**
   * 更新普通选择器的选项显示
   */
  private updateSimpleSelector(
    selectElement: HTMLSelectElement | null,
    models: Record<string, ModelConfig>
  ): void {
    if (!selectElement) return

    Array.from(selectElement.options).forEach(option => {
      const modelKey = option.value
      const model = models[modelKey]
      if (model) {
        const displayName = this.config.getModelDisplayName
          ? this.config.getModelDisplayName(modelKey)
          : model.displayName
        option.textContent = `${model.name} - ${displayName}`
      }
    })
  }

  /**
   * 更新 UI 以反映当前模型配置
   */
  updateUIForModel(page?: PageReference): void {
    const api = (window as any).aiImageAPI
    const modelKey = api?.getModelKey?.() || api?.model || 'unknown'
    const currentModel = api?.getCurrentModel?.() as ModelConfig

    if (!currentModel) {
      console.warn('[ModelSelectorManager] 无法获取当前模型配置')
      return
    }

    this.renderRatioOptions(currentModel, page)
    this.renderResolutionOptions(currentModel, page)
    this.setupSeedreamCountHint(currentModel)
    this.setupPromptSizeHint(currentModel)
    this.renderBatchRatioOptions(currentModel, page)

    page?.updateFinalResolutionDisplay?.()
    page?.updateReferenceImageLimitDisplay?.()
    page?.updateReferenceImagesPreview?.()
    page?.onModelChanged?.()

    console.log('[ModelSelectorManager] UI 已更新为模型:', currentModel.name)
  }

  /**
   * 获取桌面端选择器实例(现在是 {@link VendorModelPanel},表面兼容 Choices)
   */
  getDesktopChoice(): any {
    return this.desktopChoice
  }

  /**
   * 获取移动端 Choices 实例
   */
  getMobileChoice(): any {
    return this.mobileChoice
  }

  /**
   * 销毁实例
   */
  destroy(): void {
    if (this.desktopChoice) {
      this.desktopChoice.destroy()
      this.desktopChoice = null
    }
    if (this.mobileChoice) {
      this.mobileChoice.destroy()
      this.mobileChoice = null
    }
    this.initialized = false
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized
  }
}

// 单例实例
let modelSelectorManagerInstance: ModelSelectorManager | null = null

/**
 * 获取 ModelSelectorManager 单例
 */
export function getModelSelectorManager(config?: ModelSelectorManagerConfig): ModelSelectorManager {
  if (!modelSelectorManagerInstance) {
    modelSelectorManagerInstance = new ModelSelectorManager(config)
  }
  return modelSelectorManagerInstance
}

/**
 * 创建新的 ModelSelectorManager 实例
 */
export function createModelSelectorManager(config?: ModelSelectorManagerConfig): ModelSelectorManager {
  return new ModelSelectorManager(config)
}
