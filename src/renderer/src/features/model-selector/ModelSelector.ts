// src/renderer/src/features/model-selector/ModelSelector.ts
/**
 * 模型选择器模块
 * 处理桌面端和移动端的模型选择器初始化和交互
 */

import type { AIModel, ModelCapabilities } from '@/types'

declare const Choices: any

export interface ModelInfo {
  name: string
  displayName: string
  time?: string
  isNew?: boolean
  capabilities?: ModelCapabilities
}

export interface ModelSelectorOptions {
  onModelChange?: (modelKey: string) => void
  getModelDisplayName?: (modelKey: string) => string
}

export class ModelSelector {
  private desktopChoice: any = null
  private mobileChoice: any = null
  private options: ModelSelectorOptions
  private initialized = false

  constructor(options: ModelSelectorOptions = {}) {
    this.options = options
  }

  /**
   * 初始化模型选择器
   */
  init(retryCount = 0): void {
    const MAX_RETRIES = 30

    console.log('🚀 初始化模型选择器（Choices.js）')

    // 等待 Choices.js 加载完成
    if (typeof Choices === 'undefined') {
      if (retryCount >= MAX_RETRIES) {
        console.error('❌ Choices.js 加载超时，放弃初始化模型选择器')
        return
      }
      console.warn(`⏳ Choices.js 未加载，延迟初始化... (${retryCount + 1}/${MAX_RETRIES})`)
      setTimeout(() => this.init(retryCount + 1), 100)
      return
    }

    const desktopSelector = document.getElementById('modelSelector') as HTMLSelectElement
    const mobileSelector = document.getElementById('modelSelectorMobile') as HTMLSelectElement

    if (!desktopSelector || !mobileSelector) {
      console.warn('⏳ DOM 元素未就绪，延迟初始化...')
      setTimeout(() => this.init(), 100)
      return
    }

    try {
      const api = (window as any).aiImageAPI
      const models = api?.getAllModels?.() || {}
      const currentModelKey = api?.model || ''

      console.log('📊 当前模型:', currentModelKey, '所有模型数:', Object.keys(models).length)

      this.initDesktop(desktopSelector, models, currentModelKey)
      this.initMobile(mobileSelector, models, currentModelKey)

      this.initialized = true
      console.log('✅ 模型选择器初始化完成')
    } catch (error) {
      console.error('❌ 模型选择器初始化失败:', error)
    }
  }

  /**
   * 初始化桌面端模型选择器
   */
  private initDesktop(
    selectElement: HTMLSelectElement,
    models: Record<string, ModelInfo>,
    currentModelKey: string
  ): void {
    console.log('🖥️ 初始化桌面端模型选择器')

    // 销毁旧实例
    if (this.desktopChoice) {
      this.desktopChoice.destroy()
      this.desktopChoice = null
    }

    // 填充选项
    this.populateOptions(selectElement, models, currentModelKey)

    // 初始化 Choices.js
    this.desktopChoice = new Choices(selectElement, {
      searchEnabled: false,
      itemSelectText: '',
      shouldSort: false,
      position: 'bottom',
      renderChoiceLimit: -1,
      allowHTML: true,
      removeItemButton: false,
      callbackOnCreateTemplates: this.createTemplates.bind(this)
    })

    // 绑定事件
    this.bindEvents(selectElement)

    console.log('✅ 桌面端模型选择器初始化完成')
  }

  /**
   * 初始化移动端模型选择器
   */
  private initMobile(
    selectElement: HTMLSelectElement,
    models: Record<string, ModelInfo>,
    currentModelKey: string
  ): void {
    console.log('📱 初始化移动端模型选择器')

    // 销毁旧实例
    if (this.mobileChoice) {
      this.mobileChoice.destroy()
      this.mobileChoice = null
    }

    // 填充选项
    this.populateOptions(selectElement, models, currentModelKey)

    // 初始化 Choices.js
    this.mobileChoice = new Choices(selectElement, {
      searchEnabled: false,
      itemSelectText: '',
      shouldSort: false,
      position: 'bottom',
      renderChoiceLimit: -1,
      allowHTML: true,
      removeItemButton: false,
      callbackOnCreateTemplates: this.createTemplates.bind(this)
    })

    // 绑定事件
    this.bindEvents(selectElement)

    console.log('✅ 移动端模型选择器初始化完成')
  }

  /**
   * 填充选择器选项
   */
  private populateOptions(
    selectElement: HTMLSelectElement,
    models: Record<string, ModelInfo>,
    currentModelKey: string
  ): void {
    selectElement.innerHTML = ''

    Object.keys(models).forEach(modelKey => {
      const model = models[modelKey]
      const option = document.createElement('option')
      option.value = modelKey

      const displayName = this.options.getModelDisplayName
        ? this.options.getModelDisplayName(modelKey)
        : model.displayName

      option.textContent = `${model.name} - ${displayName}`

      if (modelKey === currentModelKey) {
        option.selected = true
      }

      selectElement.appendChild(option)
    })
  }

  /**
   * 创建 Choices.js 模板
   */
  private createTemplates(template: any) {
    return {
      item: ({ classNames }: any, data: any) => {
        const modelName = data.label.split(' - ')[0]
        return template(`
          <div class="${classNames.item}" style="display: flex; align-items: center; gap: 0.5rem;">
            <i class="fas fa-robot" style="font-size: 17px;"></i>
            <span style="font-size: 16px; font-weight: 500;">${modelName}</span>
          </div>
        `)
      },
      choice: ({ classNames }: any, data: any) => {
        const parts = data.label.split(' - ')
        const name = parts[0] || ''
        const desc = parts[1] || ''

        const api = (window as any).aiImageAPI
        const modelInfo = api?.models?.[data.value]

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
   * 绑定事件监听器
   */
  private bindEvents(selectElement: HTMLSelectElement): void {
    const handleChoice = (event: CustomEvent) => {
      if (event.detail?.choice?.value) {
        const selectedModel = event.detail.choice.value
        console.log('模型已切换:', selectedModel)
        this.options.onModelChange?.(selectedModel)
      }
    }

    const handleChange = (event: Event) => {
      const target = event.target as HTMLSelectElement
      if (target.value) {
        console.log('通过 change 事件切换模型:', target.value)
        this.options.onModelChange?.(target.value)
      }
    }

    selectElement.addEventListener('choice', handleChoice as EventListener)
    selectElement.addEventListener('change', handleChange)
  }

  /**
   * 设置当前选中的模型
   */
  setCurrentModel(modelKey: string): void {
    if (this.desktopChoice) {
      this.desktopChoice.setChoiceByValue(modelKey)
    }
    if (this.mobileChoice) {
      this.mobileChoice.setChoiceByValue(modelKey)
    }
  }

  /**
   * 刷新模型列表
   */
  refresh(): void {
    const api = (window as any).aiImageAPI
    const models = api?.getAllModels?.() || {}
    const currentModelKey = api?.model || ''

    const desktopSelector = document.getElementById('modelSelector') as HTMLSelectElement
    const mobileSelector = document.getElementById('modelSelectorMobile') as HTMLSelectElement

    if (desktopSelector) {
      this.initDesktop(desktopSelector, models, currentModelKey)
    }
    if (mobileSelector) {
      this.initMobile(mobileSelector, models, currentModelKey)
    }
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

// 导出默认实例工厂
export function createModelSelector(options?: ModelSelectorOptions): ModelSelector {
  return new ModelSelector(options)
}
