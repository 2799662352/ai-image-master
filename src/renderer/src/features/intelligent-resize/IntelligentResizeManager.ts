// src/renderer/src/features/intelligent-resize/IntelligentResizeManager.ts
/**
 * 智能尺寸管理器
 * 处理 Gemini 智能尺寸模式的 UI 显示和尺寸计算
 */

export interface ImageData {
  fileName?: string
  width?: number
  height?: number
  base64?: string
}

export interface OutputSize {
  width: number
  height: number
}

export interface PageReference {
  referenceImages?: ImageData[]
  batchReferenceImages?: ImageData[]
}

export interface IntelligentResizeConfig {
  removeDisabledIndicator?: (element: Element) => void
}

export class IntelligentResizeManager {
  private config: IntelligentResizeConfig
  private pages: Record<string, PageReference> = {}

  constructor(config: IntelligentResizeConfig = {}) {
    this.config = config
  }

  /**
   * 设置页面引用
   */
  setPages(pages: Record<string, PageReference>): void {
    this.pages = pages
  }

  /**
   * 设置 Gemini 智能尺寸模式
   */
  setupIntelligentResizeMode(): void {
    // 首先恢复所有宽高比按钮的正常状态（不影响分辨率按钮）
    document.querySelectorAll('#ratioButtons .ratio-btn, .edit-ratio-btn').forEach(btn => {
      const element = btn as HTMLElement
      element.style.opacity = '1'
      element.style.pointerEvents = 'auto'
      element.style.backgroundColor = ''
      element.style.color = ''
      element.style.cursor = ''
      element.style.filter = ''
      element.title = ''
      element.removeAttribute('data-disabled-tooltip')
      this.config.removeDisabledIndicator?.(element)
    })

    // 创建或更新智能尺寸提示UI
    this.updateIntelligentResizeUI()
  }

  /**
   * 更新智能尺寸 UI 显示
   */
  updateIntelligentResizeUI(): void {
    console.log('开始更新智能尺寸UI')

    // 找到生成页面的尺寸选择区域
    const ratioBtn = document.querySelector('.ratio-btn')
    const ratioContainer = ratioBtn?.closest('div')?.parentElement
    if (!ratioContainer) {
      console.log('未找到尺寸选择容器')
      return
    }

    // 移除旧的智能尺寸提示
    const existingHint = ratioContainer.querySelector('.intelligent-resize-hint')
    if (existingHint) {
      existingHint.remove()
    }

    // 隐藏原来的尺寸选择按钮
    const ratioButtonsContainer = ratioBtn?.closest('div')
    if (ratioButtonsContainer) {
      ;(ratioButtonsContainer as HTMLElement).style.display = 'none'
      console.log('已隐藏尺寸选择按钮')
    }

    // 创建智能尺寸提示元素
    const hint = document.createElement('div')
    hint.className = 'intelligent-resize-hint mt-2 p-3 bg-orange-100/20 rounded-lg border border-orange-300/30'

    // 检查是否有参考图
    const generatePage = this.pages?.generate || (window as any).generatePage
    // referenceImages 是可选字段,页面还没建好时整条链都是 undefined。
    // `undefined > 0` 运行时本就是 false,补 ?? 0 只是把这层写进类型。
    const hasReferenceImages = (generatePage?.referenceImages?.length ?? 0) > 0

    console.log('检查参考图状态:', hasReferenceImages, generatePage?.referenceImages?.length, 'generatePage存在:', !!generatePage)

    if (hasReferenceImages) {
      // 有参考图：显示基于参考图的预期输出
      console.log('显示参考图尺寸提示')
      // 先显示加载状态
      hint.innerHTML = `
        <div class="text-orange-200 text-sm">
          <div class="flex items-center mb-2">
            <i class="fas fa-magic mr-2"></i>
            <span class="font-medium">智能遵循原图比例</span>
          </div>
          <div class="text-xs opacity-75">
            📷 正在分析参考图尺寸信息...
          </div>
        </div>
      `
      // 然后异步加载尺寸信息
      this.showReferenceImageSizeHint(hint)
    } else {
      // 无参考图：显示提示用户上传参考图
      console.log('显示上传提示')
      hint.innerHTML = `
        <div class="flex items-center text-orange-200 text-sm">
          <i class="fas fa-magic mr-2"></i>
          <div>
            <div class="font-medium">智能遵循原图比例</div>
            <div class="text-xs opacity-75 mt-1">📷 请上传参考图片，将根据原图比例智能调整尺寸（最大1024×1024px）</div>
          </div>
        </div>
      `
    }

    // 添加到DOM
    ratioContainer.appendChild(hint)
    console.log('智能尺寸UI更新完成')
  }

  /**
   * 显示基于参考图的尺寸提示
   */
  showReferenceImageSizeHint(hintElement: HTMLElement): void {
    try {
      const generatePage = this.pages?.generate || (window as any).generatePage
      if (!generatePage?.referenceImages?.length) {
        console.log('❌ 没有参考图数据，显示默认提示')
        return
      }

      console.log('🔍 开始处理参考图尺寸信息，参考图数量:', generatePage.referenceImages.length)

      // 获取第一张参考图的数据
      const firstImageData = generatePage.referenceImages[0] as ImageData
      console.log('📷 参考图数据:', {
        fileName: firstImageData?.fileName,
        width: firstImageData?.width,
        height: firstImageData?.height,
        hasSize: !!(firstImageData?.width && firstImageData?.height)
      })

      // 检查是否已有尺寸信息
      if (firstImageData.width && firstImageData.height) {
        const originalWidth = firstImageData.width
        const originalHeight = firstImageData.height
        const ratio = originalWidth / originalHeight

        console.log('✅ 直接使用已获取的图片尺寸:', originalWidth, 'x', originalHeight, '比例:', ratio.toFixed(2))

        // 计算预期输出尺寸
        const api = (window as any).aiImageAPI
        const outputSize = api?.calculateGeminiOutputSize?.(originalWidth, originalHeight) as OutputSize

        console.log('🎯 计算出预期输出尺寸:', outputSize)

        // 格式化比例显示
        const ratioText = this.formatRatio(ratio)

        hintElement.innerHTML = `
          <div class="text-orange-200 text-sm">
            <div class="flex items-center mb-2">
              <i class="fas fa-magic mr-2"></i>
              <span class="font-medium">智能遵循原图比例</span>
            </div>
            <div class="bg-orange-100/10 rounded p-2 text-xs">
              <div class="flex justify-between items-center">
                <span>原图尺寸:</span>
                <span class="font-mono">${originalWidth} × ${originalHeight}px ${ratioText}</span>
              </div>
              <div class="flex justify-between items-center mt-1">
                <span>预计输出:</span>
                <span class="font-mono text-green-300">${outputSize?.width || '?'} × ${outputSize?.height || '?'}px</span>
              </div>
            </div>
            <div class="text-xs opacity-75 mt-1">
              📏 自动保持比例，最大1024×1024px
            </div>
          </div>
        `

        console.log('🎉 参考图尺寸提示已更新完成!')
      } else {
        console.warn('⚠️ 参考图缺少尺寸信息，显示默认提示')
        hintElement.innerHTML = `
          <div class="text-orange-200 text-sm">
            <div class="flex items-center mb-2">
              <i class="fas fa-magic mr-2"></i>
              <span class="font-medium">智能遵循原图比例</span>
            </div>
            <div class="text-xs opacity-75 mt-1">
              📷 正在分析参考图尺寸信息...
            </div>
          </div>
        `
      }
    } catch (error) {
      console.error('💥 处理参考图尺寸时发生错误:', error)
    }
  }

  /**
   * 设置批量页面的 Gemini 智能尺寸模式
   */
  setupBatchIntelligentResizeMode(): void {
    console.log('设置批量页面智能尺寸模式')

    // 找到批量页面的尺寸选择器
    const batchRatioSelect = document.getElementById('batchRatio') as HTMLSelectElement | null
    const batchRatioContainer = batchRatioSelect?.closest('div')
    if (!batchRatioSelect || !batchRatioContainer) {
      console.log('未找到批量尺寸选择器或容器')
      return
    }

    // 移除旧的智能尺寸描述
    const existingDescription = batchRatioContainer.querySelector('.batch-intelligent-description')
    if (existingDescription) {
      existingDescription.remove()
    }

    // 设置选择器为智能模式
    batchRatioSelect.classList.add('intelligent-batch-display')
    batchRatioSelect.style.pointerEvents = 'none' // 禁用点击
    batchRatioSelect.style.cursor = 'default'

    // 移除下拉箭头和调整样式
    batchRatioSelect.style.appearance = 'none'
    ;(batchRatioSelect.style as any).webkitAppearance = 'none'
    ;(batchRatioSelect.style as any).mozAppearance = 'none'
    batchRatioSelect.style.backgroundImage = 'none'
    batchRatioSelect.style.fontWeight = 'normal'

    // 简洁的选择器显示
    batchRatioSelect.innerHTML = '<option>📏 智能遵循参考图</option>'

    // 创建独立的描述行
    const description = document.createElement('div')
    description.className = 'batch-intelligent-description mt-2 text-xs text-white opacity-75'

    const batchPage = this.pages?.batch
    const hasBatchReferenceImages = (batchPage?.batchReferenceImages?.length || 0) > 0

    console.log('检查批量参考图状态:', hasBatchReferenceImages, batchPage?.batchReferenceImages?.length)

    if (hasBatchReferenceImages && batchPage?.batchReferenceImages) {
      // 有参考图：显示具体尺寸信息
      const firstImageData = batchPage.batchReferenceImages[0]
      if (firstImageData.width && firstImageData.height) {
        const api = (window as any).aiImageAPI
        const outputSize = api?.calculateGeminiOutputSize?.(firstImageData.width, firstImageData.height) as OutputSize
        const ratioText = this.formatRatio(firstImageData.width / firstImageData.height)

        description.innerHTML = `
          <div class="flex items-center justify-between">
            <span>参考图尺寸: ${firstImageData.width} × ${firstImageData.height}px ${ratioText}</span>
            <span class="text-green-300">预计输出: ${outputSize?.width || '?'} × ${outputSize?.height || '?'}px</span>
          </div>
        `
      } else {
        description.innerHTML = '<div class="text-orange-300">正在分析参考图尺寸信息...</div>'
      }
    } else {
      // 无参考图：显示提示
      description.innerHTML = '<div>可选择上传参考图片，将根据参考图比例智能调整尺寸（最大1024×1024px）</div>'
    }

    // 添加到容器
    batchRatioContainer.appendChild(description)

    console.log('批量智能尺寸UI更新完成')
  }

  /**
   * 显示批量参考图的尺寸提示
   */
  showBatchReferenceImageSizeHint(hintElement: HTMLElement, batchReferenceImages: ImageData[]): void {
    try {
      if (!batchReferenceImages?.length) {
        console.log('❌ 没有批量参考图数据')
        return
      }

      console.log('🔍 开始处理批量参考图尺寸信息，参考图数量:', batchReferenceImages.length)

      // 获取第一张参考图的数据
      const firstImageData = batchReferenceImages[0]
      console.log('📷 批量参考图数据:', {
        fileName: firstImageData?.fileName,
        width: firstImageData?.width,
        height: firstImageData?.height,
        hasSize: !!(firstImageData?.width && firstImageData?.height)
      })

      // 检查是否已有尺寸信息
      if (firstImageData.width && firstImageData.height) {
        const originalWidth = firstImageData.width
        const originalHeight = firstImageData.height
        const ratio = originalWidth / originalHeight

        console.log('✅ 直接使用已获取的批量图片尺寸:', originalWidth, 'x', originalHeight, '比例:', ratio.toFixed(2))

        // 计算预期输出尺寸
        const api = (window as any).aiImageAPI
        const outputSize = api?.calculateGeminiOutputSize?.(originalWidth, originalHeight) as OutputSize

        console.log('🎯 计算出批量预期输出尺寸:', outputSize)

        // 格式化比例显示
        const ratioText = this.formatRatio(ratio)

        hintElement.innerHTML = `
          <div class="text-orange-200 text-sm">
            <div class="flex items-center mb-2">
              <i class="fas fa-magic mr-2"></i>
              <span class="font-medium">智能遵循参考图</span>
            </div>
            <div class="bg-orange-100/10 rounded p-2 text-xs">
              <div class="flex justify-between items-center">
                <span>参考图尺寸:</span>
                <span class="font-mono">${originalWidth} × ${originalHeight}px ${ratioText}</span>
              </div>
              <div class="flex justify-between items-center mt-1">
                <span>预计输出:</span>
                <span class="font-mono text-green-300">${outputSize?.width || '?'} × ${outputSize?.height || '?'}px</span>
              </div>
            </div>
            <div class="text-xs opacity-75 mt-1">
              📏 所有图片将遵循此比例，最大1024×1024px
            </div>
          </div>
        `

        console.log('🎉 批量参考图尺寸提示已更新完成!')
      } else {
        console.warn('⚠️ 批量参考图缺少尺寸信息，显示默认提示')
        hintElement.innerHTML = `
          <div class="text-orange-200 text-sm">
            <div class="flex items-center mb-2">
              <i class="fas fa-magic mr-2"></i>
              <span class="font-medium">智能遵循参考图</span>
            </div>
            <div class="text-xs opacity-75 mt-1">
              📷 正在分析参考图尺寸信息...
            </div>
          </div>
        `
      }
    } catch (error) {
      console.error('💥 处理批量参考图尺寸时发生错误:', error)
    }
  }

  /**
   * 格式化比例显示
   */
  formatRatio(ratio: number): string {
    if (Math.abs(ratio - 1) < 0.1) return '(约1:1)'
    if (Math.abs(ratio - 2 / 3) < 0.1) return '(约2:3)'
    if (Math.abs(ratio - 3 / 2) < 0.1) return '(约3:2)'
    if (ratio > 1) return `(约${ratio.toFixed(1)}:1)`
    return `(约1:${(1 / ratio).toFixed(1)})`
  }

  /**
   * 销毁实例
   */
  destroy(): void {
    // 移除智能尺寸提示
    const hints = document.querySelectorAll('.intelligent-resize-hint, .batch-intelligent-description')
    hints.forEach(hint => hint.remove())
  }
}

// 单例实例
let intelligentResizeInstance: IntelligentResizeManager | null = null

/**
 * 获取 IntelligentResizeManager 单例
 */
export function getIntelligentResizeManager(config?: IntelligentResizeConfig): IntelligentResizeManager {
  if (!intelligentResizeInstance) {
    intelligentResizeInstance = new IntelligentResizeManager(config)
  }
  return intelligentResizeInstance
}

/**
 * 创建新的 IntelligentResizeManager 实例
 */
export function createIntelligentResizeManager(config?: IntelligentResizeConfig): IntelligentResizeManager {
  return new IntelligentResizeManager(config)
}
