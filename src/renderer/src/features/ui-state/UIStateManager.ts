// src/renderer/src/features/ui-state/UIStateManager.ts
/**
 * UI 状态管理器
 * 处理数量选择器、尺寸选择器状态切换和禁用指示器
 */

export interface SelectorConfig {
  id: string
  tooltip: string
}

export interface UIStateManagerConfig {
  setupIntelligentResizeMode?: () => void
  setupBatchIntelligentResizeMode?: () => void
  renderBatchRatioOptions?: (modelConfig: any) => void
}

type IconType = 'ban' | 'lock' | 'slash'

export class UIStateManager {
  private config: UIStateManagerConfig

  private readonly countSelectors: SelectorConfig[] = [
    { id: '#generateCount', tooltip: '当前模型仅支持生成1张图片' },
    { id: '#editCount', tooltip: '当前模型仅支持生成1张图片' },
    { id: '#batchCount', tooltip: '当前模型仅支持生成1张图片' }
  ]

  constructor(config: UIStateManagerConfig = {}) {
    this.config = config
  }

  /**
   * 切换数量选择器状态
   */
  toggleCountSelectors(disabled: boolean): void {
    this.countSelectors.forEach(({ id, tooltip }) => {
      const element = document.querySelector(id) as HTMLSelectElement | null
      if (!element) return

      const api = (window as any).aiImageAPI
      const model = api?.getCurrentModel?.()
      const isSeedream = model?.name?.toLowerCase().includes('seedream')

      const shouldDisable = disabled || (isSeedream && (id === '#batchCount' || id === '#generateCount'))
      element.disabled = shouldDisable

      if (shouldDisable) {
        element.value = '1'
        element.style.opacity = '0.4'
        element.style.backgroundColor = '#f3f4f6'
        element.style.color = '#9ca3af'
        element.style.cursor = 'not-allowed'

        const finalTooltip = isSeedream && id === '#batchCount'
          ? 'Seedream 模型一次最多生成 15 张，每张按单价计费'
          : isSeedream && id === '#generateCount'
            ? 'Seedream 模型按张计费，建议一次生成 1 张'
            : tooltip

        element.title = finalTooltip
        element.setAttribute('data-disabled-tooltip', finalTooltip)
        this.addDisabledIndicator(element, 'lock')
      } else {
        element.style.opacity = '1'
        element.style.backgroundColor = ''
        element.style.color = ''
        element.style.cursor = ''
        element.title = ''
        element.removeAttribute('data-disabled-tooltip')
        this.removeDisabledIndicator(element)
      }
    })
  }

  /**
   * 切换尺寸选择器状态
   */
  toggleSizeSelectors(disabled: boolean, intelligentResize = false): void {
    console.log('切换尺寸选择器状态:', { disabled, intelligentResize })

    if (intelligentResize) {
      // Gemini智能尺寸模式：显示智能尺寸信息
      this.config.setupIntelligentResizeMode?.()
      // 注意：不要 return，还需要处理批量页面
    }

    // 确保显示原来的尺寸选择按钮容器（非智能模式时）
    if (!intelligentResize) {
      const ratioBtn = document.querySelector('.ratio-btn')
      const ratioButtonsContainer = ratioBtn?.closest('div')
      if (ratioButtonsContainer) {
        ;(ratioButtonsContainer as HTMLElement).style.display = ''
      }

      // 移除智能尺寸提示（非智能模式时）
      const intelligentHint = document.querySelector('.intelligent-resize-hint')
      if (intelligentHint) {
        intelligentHint.remove()
      }
    }

    const tooltip = '当前模型不支持自定义尺寸'

    // 生成页面的比例按钮（非智能模式时才处理）- 只影响宽高比按钮
    if (!intelligentResize) {
      this.processRatioButtons('#ratioButtons .ratio-btn', disabled, tooltip)
    }

    // 编辑页面的比例按钮（非智能模式时才处理）
    if (!intelligentResize) {
      this.processRatioButtons('.edit-ratio-btn', disabled, tooltip)
    }

    // 批量页面的尺寸选择器
    this.processBatchRatioSelector(disabled, intelligentResize, tooltip)

    // 对于非智能模式，恢复批量选择器正常状态
    if (!intelligentResize) {
      this.restoreBatchRatioSelector()
    }
  }

  /**
   * 处理比例按钮状态
   */
  private processRatioButtons(selector: string, disabled: boolean, tooltip: string): void {
    document.querySelectorAll(selector).forEach(btn => {
      const element = btn as HTMLElement

      if (disabled) {
        element.style.opacity = '0.3'
        element.style.pointerEvents = 'none'
        element.style.backgroundColor = '#f3f4f6'
        element.style.color = '#9ca3af'
        element.style.cursor = 'not-allowed'
        element.style.filter = 'grayscale(1)'
        element.title = tooltip
        element.setAttribute('data-disabled-tooltip', tooltip)

        // 确保选中1:1比例
        if ((element as any).dataset.ratio === '1:1') {
          element.classList.add('active')
        } else {
          element.classList.remove('active')
        }

        // 添加禁用图标指示器
        this.addDisabledIndicator(element, 'ban')
      } else {
        element.style.opacity = '1'
        element.style.pointerEvents = 'auto'
        element.style.backgroundColor = ''
        element.style.color = ''
        element.style.cursor = ''
        element.style.filter = ''
        element.title = ''
        element.removeAttribute('data-disabled-tooltip')

        // 移除禁用图标指示器
        this.removeDisabledIndicator(element)
      }
    })
  }

  /**
   * 处理批量比例选择器
   */
  private processBatchRatioSelector(disabled: boolean, intelligentResize: boolean, tooltip: string): void {
    const batchRatioSelect = document.getElementById('batchRatio') as HTMLSelectElement | null
    if (!batchRatioSelect) return

    if (intelligentResize) {
      // Gemini智能尺寸模式：显示智能尺寸信息
      console.log('🔧 批量页面 - 准备调用智能尺寸设置')
      this.config.setupBatchIntelligentResizeMode?.()
    } else if (disabled) {
      batchRatioSelect.style.opacity = '0.3'
      batchRatioSelect.style.pointerEvents = 'none'
      batchRatioSelect.style.backgroundColor = '#f3f4f6'
      batchRatioSelect.style.color = '#9ca3af'
      batchRatioSelect.style.cursor = 'not-allowed'
      batchRatioSelect.title = tooltip
      batchRatioSelect.setAttribute('data-disabled-tooltip', tooltip)

      // 设置为1:1
      batchRatioSelect.value = '1:1'

      // 添加禁用图标指示器
      this.addDisabledIndicator(batchRatioSelect, 'ban')
    } else {
      batchRatioSelect.style.opacity = '1'
      batchRatioSelect.style.pointerEvents = 'auto'
      batchRatioSelect.style.backgroundColor = ''
      batchRatioSelect.style.color = ''
      batchRatioSelect.style.cursor = ''
      batchRatioSelect.title = ''
      batchRatioSelect.removeAttribute('data-disabled-tooltip')

      // 移除禁用图标指示器
      this.removeDisabledIndicator(batchRatioSelect)
    }
  }

  /**
   * 恢复批量比例选择器正常状态
   */
  private restoreBatchRatioSelector(): void {
    const batchRatioSelect = document.getElementById('batchRatio') as HTMLSelectElement | null
    if (batchRatioSelect && batchRatioSelect.classList.contains('intelligent-batch-display')) {
      // 恢复正常的选择器
      batchRatioSelect.classList.remove('intelligent-batch-display')
      batchRatioSelect.style.pointerEvents = ''
      batchRatioSelect.style.cursor = ''
      batchRatioSelect.style.display = ''

      // 恢复原来的样式
      batchRatioSelect.style.appearance = ''
      ;(batchRatioSelect.style as any).webkitAppearance = ''
      ;(batchRatioSelect.style as any).mozAppearance = ''
      batchRatioSelect.style.backgroundImage = ''
      batchRatioSelect.style.fontWeight = ''

      // 恢复原来的选项
      const api = (window as any).aiImageAPI
      const currentModel = api?.getCurrentModel?.()
      if (currentModel) {
        this.config.renderBatchRatioOptions?.(currentModel)
      }

      // 移除智能尺寸描述
      const batchRatioContainer = batchRatioSelect.closest('div')
      const intelligentDescription = batchRatioContainer?.querySelector('.batch-intelligent-description')
      if (intelligentDescription) {
        intelligentDescription.remove()
      }
    }

    // 移除旧的智能尺寸提示（兼容之前的版本）
    const batchIntelligentHint = document.querySelector('.batch-intelligent-resize-hint')
    if (batchIntelligentHint) {
      batchIntelligentHint.remove()
    }
  }

  /**
   * 添加禁用图标指示器
   */
  addDisabledIndicator(element: HTMLElement, iconType: IconType = 'ban'): void {
    // 避免重复添加
    if (element.querySelector('.disabled-indicator')) {
      return
    }

    const icons: Record<IconType, string> = {
      'ban': 'fas fa-ban',
      'lock': 'fas fa-lock',
      'slash': 'fas fa-slash'
    }

    const indicator = document.createElement('div')
    indicator.className = 'disabled-indicator'
    indicator.innerHTML = `<i class="${icons[iconType] || icons.ban}"></i>`
    indicator.style.cssText = `
      position: absolute;
      top: 50%;
      right: 8px;
      transform: translateY(-50%);
      color: #ef4444;
      font-size: 12px;
      z-index: 10;
      pointer-events: none;
      opacity: 0.8;
      text-shadow: 0 0 2px rgba(239, 68, 68, 0.5);
    `

    // 设置父元素为相对定位
    if (element.style.position !== 'absolute' && element.style.position !== 'fixed') {
      element.style.position = 'relative'
    }

    element.appendChild(indicator)
  }

  /**
   * 移除禁用图标指示器
   */
  removeDisabledIndicator(element: HTMLElement | Element): void {
    const indicator = element.querySelector('.disabled-indicator')
    if (indicator) {
      indicator.remove()
    }
  }

  /**
   * 创建增强的悬浮提示
   */
  createEnhancedTooltip(element: HTMLElement, message: string): HTMLElement {
    const tooltip = document.createElement('div')
    tooltip.className = 'enhanced-tooltip'
    tooltip.textContent = message
    tooltip.style.cssText = `
      position: absolute;
      bottom: 120%;
      left: 50%;
      transform: translateX(-50%);
      background: #1f2937;
      color: white;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      white-space: nowrap;
      z-index: 1000;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    `

    // 添加小箭头
    const arrow = document.createElement('div')
    arrow.style.cssText = `
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      border: 4px solid transparent;
      border-top-color: #1f2937;
    `
    tooltip.appendChild(arrow)

    return tooltip
  }

  /**
   * 显示增强提示
   */
  showEnhancedTooltip(tooltip: HTMLElement): void {
    tooltip.style.opacity = '1'
  }

  /**
   * 隐藏增强提示
   */
  hideEnhancedTooltip(tooltip: HTMLElement): void {
    tooltip.style.opacity = '0'
  }

  /**
   * 设置 Seedream 模型的数量提示
   * 当切换到 Seedream 模型时显示特殊提示
   */
  setupSeedreamCountHint(modelConfig: any): void {
    const isSeedream = modelConfig?.name?.toLowerCase().includes('seedream')
    const batchCountLabel = document.getElementById('batchCountLabel')
    let hint = document.getElementById('batchCountHint')

    if (!batchCountLabel) return

    if (isSeedream) {
      const message = 'Seedream 模型支持一次生成多张，每张按单价计费（最多 15 张）。如需批量多图，请分批提交任务。'

      if (!hint) {
        hint = document.createElement('button')
        hint.id = 'batchCountHint'
        hint.type = 'button'
        hint.className = 'ml-2 w-4 h-4 flex items-center justify-center text-orange-200 hover:text-orange-100 transition-colors'
        hint.innerHTML = `<i class="fas fa-question-circle"></i>`
        hint.title = message
        hint.setAttribute('aria-label', message)
        hint.addEventListener('click', () => {
          // 使用 ToastManager 显示提示
          const toast = (window as any).toastManagerTS
          toast?.show(message, 'info')
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
   * 绑定增强悬浮提示（事件委托）
   */
  bindEnhancedTooltips(): void {
    // 使用事件委托处理动态添加的禁用元素
    document.addEventListener('mouseenter', (e) => {
      const element = e.target as HTMLElement
      if (!element || element.nodeType !== 1) return
      if (!element.hasAttribute?.('data-disabled-tooltip')) return
      if (!(element as HTMLButtonElement).disabled) return

      const tooltipText = element.getAttribute('data-disabled-tooltip')
      if (!tooltipText) return

      const tooltipElement = this.createEnhancedTooltip(element, tooltipText)

      // 设置父元素为相对定位
      if (element.style.position !== 'absolute' && element.style.position !== 'fixed') {
        element.style.position = 'relative'
      }

      element.appendChild(tooltipElement)

      // 显示动画
      setTimeout(() => {
        this.showEnhancedTooltip(tooltipElement)
      }, 50)
    }, true)

    document.addEventListener('mouseleave', (e) => {
      const element = e.target as HTMLElement
      if (!element || element.nodeType !== 1) return
      if (!element.hasAttribute?.('data-disabled-tooltip')) return

      const tooltipElement = element.querySelector('.enhanced-tooltip') as HTMLElement
      if (tooltipElement) {
        this.hideEnhancedTooltip(tooltipElement)
        setTimeout(() => {
          if (tooltipElement.parentNode) {
            tooltipElement.remove()
          }
        }, 300)
      }
    }, true)

    console.log('[UIStateManager] 增强悬浮提示已绑定')
  }

  /**
   * 销毁实例
   */
  destroy(): void {
    // 移除所有禁用指示器
    document.querySelectorAll('.disabled-indicator').forEach(el => el.remove())
    // 移除所有增强提示
    document.querySelectorAll('.enhanced-tooltip').forEach(el => el.remove())
  }
}

// 单例实例
let uiStateManagerInstance: UIStateManager | null = null

/**
 * 获取 UIStateManager 单例
 */
export function getUIStateManager(config?: UIStateManagerConfig): UIStateManager {
  if (!uiStateManagerInstance) {
    uiStateManagerInstance = new UIStateManager(config)
  }
  return uiStateManagerInstance
}

/**
 * 创建新的 UIStateManager 实例
 */
export function createUIStateManager(config?: UIStateManagerConfig): UIStateManager {
  return new UIStateManager(config)
}
