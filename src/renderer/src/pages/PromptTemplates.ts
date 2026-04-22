// src/renderer/src/pages/PromptTemplates.ts
/**
 * 提示词模板模块 - TypeScript 版本
 * @description 管理和应用预设提示词模板
 */

import { BasePage, AppInterface, PageState } from './BasePage'

/**
 * 单个模板项
 */
export interface PromptTemplate {
  id: number
  title: string
  prompt: string
  preview: string
  tags: string[]
}

/**
 * 模板分类数据结构
 */
export interface TemplateCategories {
  [category: string]: PromptTemplate[]
}

/**
 * 提示词模板页面状态
 */
export interface PromptTemplatesState extends PageState {
  currentCategory: string
  isTemplatesLoaded: boolean
}

/**
 * 提示词模板管理类
 */
export class PromptTemplates extends BasePage {
  private templates: TemplateCategories = {}
  private currentCategory: string = '热门'
  private modal: HTMLElement | null = null
  private targetInput: HTMLInputElement | HTMLTextAreaElement | null = null
  private isBatchMode: boolean = false
  private isTemplatesLoaded: boolean = false

  constructor(app: AppInterface) {
    super(app)
    this.init()
  }

  /**
   * 初始化模块
   */
  init(): void {
    console.log('初始化提示词模板模块 (TypeScript)')
    this.modal = this.getElement<HTMLElement>('promptTemplateModal')
    this.bindEvents()
    this.isInitialized = true
  }

  /**
   * 绑定事件
   */
  bindEvents(): void {
    // 单图生成模板按钮
    this.addEventListenerSafe('promptTemplateBtn', 'click', () => {
      this.targetInput = this.getElement<HTMLInputElement>('promptInput')
      this.isBatchMode = false
      this.showTemplateModal()
    })

    // 批量生成模板按钮
    this.addEventListenerSafe('batchPromptTemplateBtn', 'click', () => {
      this.targetInput = this.getElement<HTMLTextAreaElement>('batchPrompts')
      this.isBatchMode = true
      this.showTemplateModal()
    })

    // 模态框事件
    if (this.modal) {
      // 关闭按钮
      const closeBtn = this.getElement<HTMLButtonElement>('closeTemplateModal')
      if (closeBtn) {
        closeBtn.addEventListener('click', () => this.hideTemplateModal())
      }

      // 点击背景关闭
      this.modal.addEventListener('click', (e: MouseEvent) => {
        if (e.target === this.modal) {
          this.hideTemplateModal()
        }
      })

      // ESC键关闭
      document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Escape' && this.modal && !this.modal.classList.contains('hidden')) {
          this.hideTemplateModal()
        }
      })

      // 分类切换按钮
      this.bindCategoryButtons()
    }
  }

  /**
   * 绑定分类按钮事件
   */
  private bindCategoryButtons(): void {
    if (!this.modal) return

    const categoryBtns = this.modal.querySelectorAll<HTMLButtonElement>('.template-category-btn')
    categoryBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const category = btn.dataset.category
        if (category) {
          this.switchCategory(category)
        }
      })
    })
  }

  /**
   * 加载模板数据
   */
  async loadTemplates(): Promise<void> {
    try {
      console.log('开始加载提示词模板数据')
      const response = await fetch('data/prompt-templates.json')
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      this.templates = await response.json()
      console.log('提示词模板数据加载成功:', Object.keys(this.templates))
    } catch (error) {
      console.error('加载提示词模板数据失败:', error)
      // 使用默认模板数据
      this.templates = this.getDefaultTemplates()
    }
  }

  /**
   * 获取默认模板数据（备用）
   */
  private getDefaultTemplates(): TemplateCategories {
    return {
      '热门': [
        {
          id: 1,
          title: '古装美女',
          prompt: '一位身穿古装的美丽女子，古典气质，细腻五官，柔和光线，传统服饰，高清摄影，细节丰富',
          preview: 'images/templates/ancient_beauty.jpg',
          tags: ['人物', '古装', '美女', '传统']
        },
        {
          id: 2,
          title: '科幻城市',
          prompt: '未来科幻城市，高楼大厦，霓虹灯光，赛博朋克风格，夜景，超高清，细节丰富',
          preview: 'images/templates/cyberpunk_city.jpg',
          tags: ['科幻', '城市', '赛博朋克', '夜景']
        }
      ],
      '电商': [
        {
          id: 101,
          title: '女装模特',
          prompt: '年轻女性模特，身穿时尚服装，白色背景，专业摄影，高清，电商产品展示',
          preview: 'images/templates/female_model.jpg',
          tags: ['模特', '女装', '电商', '产品']
        }
      ]
    }
  }

  /**
   * 显示模板弹窗
   */
  async showTemplateModal(): Promise<void> {
    if (!this.modal) return

    console.log('显示提示词模板弹窗')
    this.modal.classList.remove('hidden')

    // 懒加载：首次打开时才加载模板数据
    if (!this.isTemplatesLoaded) {
      console.log('首次打开模板弹窗，开始加载模板数据')
      await this.loadTemplates()
      this.isTemplatesLoaded = true
    }

    // 重置到默认分类
    this.currentCategory = '热门'
    this.updateCategoryButtons()
    this.renderTemplates()

    // 防止页面滚动
    document.body.style.overflow = 'hidden'
  }

  /**
   * 隐藏模板弹窗
   */
  hideTemplateModal(): void {
    if (!this.modal) return

    console.log('隐藏提示词模板弹窗')
    this.modal.classList.add('hidden')

    // 恢复页面滚动
    document.body.style.overflow = ''
  }

  /**
   * 切换分类
   */
  switchCategory(category: string): void {
    console.log('切换模板分类:', category)
    this.currentCategory = category
    this.updateCategoryButtons()
    this.renderTemplates()
  }

  /**
   * 更新分类按钮状态
   */
  private updateCategoryButtons(): void {
    if (!this.modal) return

    const categoryBtns = this.modal.querySelectorAll<HTMLButtonElement>('.template-category-btn')
    categoryBtns.forEach(btn => {
      const category = btn.dataset.category
      if (category === this.currentCategory) {
        btn.classList.add('active')
        btn.classList.remove('bg-gray-100', 'hover:bg-gray-200', 'text-gray-700')
        btn.classList.add('bg-blue-500', 'text-white')
      } else {
        btn.classList.remove('active')
        btn.classList.remove('bg-blue-500', 'text-white')
        btn.classList.add('bg-gray-100', 'hover:bg-gray-200', 'text-gray-700')
      }
    })
  }

  /**
   * 渲染模板列表
   */
  renderTemplates(): void {
    const templateGrid = this.getElement<HTMLElement>('templateGrid')
    const loadingDiv = this.getElement<HTMLElement>('templateLoading')
    const emptyDiv = this.getElement<HTMLElement>('templateEmpty')

    if (!templateGrid) return

    // 显示加载状态
    if (loadingDiv) loadingDiv.classList.remove('hidden')
    if (emptyDiv) emptyDiv.classList.add('hidden')
    templateGrid.innerHTML = ''

    // 模拟加载延迟
    setTimeout(() => {
      const categoryTemplates = this.templates[this.currentCategory] || []

      if (loadingDiv) loadingDiv.classList.add('hidden')

      if (categoryTemplates.length === 0) {
        if (emptyDiv) emptyDiv.classList.remove('hidden')
        return
      }

      // 渲染模板卡片
      categoryTemplates.forEach(template => {
        const templateCard = this.createTemplateCard(template)
        templateGrid.appendChild(templateCard)
      })

      console.log(`渲染了 ${categoryTemplates.length} 个模板`)
    }, 300)
  }

  /**
   * 创建模板卡片
   */
  private createTemplateCard(template: PromptTemplate): HTMLElement {
    const card = document.createElement('div')
    card.className = 'bg-gray-50 rounded-lg overflow-hidden hover:shadow-lg transition-all cursor-pointer group border border-gray-200'

    const tagsHtml = template.tags
      .map(tag => `<span class="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded">${tag}</span>`)
      .join('')

    const fallbackImage = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgdmlld0JveD0iMCAwIDIwMCAyMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIiBmaWxsPSIjRjNGNEY2Ii8+CjxwYXRoIGQ9Ik05MCA5MEw5MCA1NEwxMTAgMTAwTDkwIDkwWiIgZmlsbD0iIzlCOUJBMCIvPgo8cGF0aCBkPSJNMTA1IDkwTDEyNSA5MEwxMjUgMTEwTDEwNSAxMTBMMTA1IDkwWiIgZmlsbD0iIzlCOUJBMCIvPgo8Y2lyY2xlIGN4PSI5OCIgY3k9IjEwMCIgcj0iMyIgZmlsbD0iIzlCOUJBMCIvPgo8dGV4dCB4PSIxMDAiIHk9IjE0MCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE0IiBmaWxsPSIjOUI5QkEwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj7lm77niYfpooTop4g8L3RleHQ+Cjwvc3ZnPgo='

    card.innerHTML = `
      <div class="aspect-square bg-gray-200 relative overflow-hidden">
        <img src="${template.preview}" 
             alt="${template.title}"
             class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
             onerror="this.src='${fallbackImage}'">
        <div class="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-center justify-center">
          <div class="bg-white/90 px-3 py-1 rounded-lg opacity-0 group-hover:opacity-100 transition-all transform translate-y-2 group-hover:translate-y-0">
            <span class="text-sm font-medium text-gray-800">${this.t('promptTemplates.clickToUse') || '点击使用'}</span>
          </div>
        </div>
      </div>
      <div class="p-3">
        <h3 class="font-medium text-gray-800 mb-2">${template.title}</h3>
        <p class="text-sm text-gray-600 mb-2 line-clamp-2">${template.prompt}</p>
        <div class="flex flex-wrap gap-1">
          ${tagsHtml}
        </div>
      </div>
    `

    // 绑定点击事件
    card.addEventListener('click', () => {
      this.applyTemplate(template)
    })

    return card
  }

  /**
   * 应用模板到输入框
   */
  applyTemplate(template: PromptTemplate): void {
    if (!this.targetInput) {
      console.error('未找到目标输入框')
      return
    }

    console.log('应用模板:', template.title)

    if (this.isBatchMode) {
      // 批量模式：在新行添加提示词
      const currentValue = this.targetInput.value.trim()
      const newValue = currentValue ? `${currentValue}\n${template.prompt}` : template.prompt
      this.targetInput.value = newValue
    } else {
      // 单图模式：替换内容
      this.targetInput.value = template.prompt
    }

    // 触发输入事件
    this.targetInput.dispatchEvent(new Event('input', { bubbles: true }))

    // 关闭弹窗
    this.hideTemplateModal()

    // 显示成功提示
    const message = this.t('promptTemplates.applied', { title: template.title }) ||
      `已应用模板"${template.title}"`
    this.showToast(message, 'success')
  }

  /**
   * 获取所有分类
   */
  getCategories(): string[] {
    return Object.keys(this.templates)
  }

  /**
   * 获取指定分类的模板数量
   */
  getTemplateCount(category?: string): number {
    if (category) {
      return this.templates[category]?.length || 0
    }
    // 返回所有模板总数
    return Object.values(this.templates).reduce((sum, templates) => sum + templates.length, 0)
  }

  /**
   * 当前分类
   */
  getCurrentCategory(): string {
    return this.currentCategory
  }

  /**
   * 是否已加载模板
   */
  isLoaded(): boolean {
    return this.isTemplatesLoaded
  }

  /**
   * 保存页面状态
   */
  saveState(): void {
    const state: PromptTemplatesState = {
      currentCategory: this.currentCategory,
      isTemplatesLoaded: this.isTemplatesLoaded
    }

    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager?.savePageState) {
      pageStateManager.savePageState('promptTemplates', state)
    }
  }

  /**
   * 恢复页面状态
   */
  async restoreState(): Promise<void> {
    if (this.stateRestored) return

    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager?.getPageState) {
      const state = pageStateManager.getPageState('promptTemplates') as PromptTemplatesState | null
      if (state) {
        this.currentCategory = state.currentCategory || '热门'
        console.log('提示词模板状态已恢复:', state)
      }
    }

    this.stateRestored = true
  }

  /**
   * 页面激活时调用
   */
  onActivate(): void {
    console.log('PromptTemplates 页面激活')
    this.restoreState()
  }

  /**
   * 页面停用时调用
   */
  onDeactivate(): void {
    console.log('PromptTemplates 页面停用')
    this.saveState()
  }

  /**
   * 语言切换时调用
   */
  onLanguageChange(): void {
    console.log('PromptTemplates 语言切换')
    // 如果模态框可见，重新渲染模板
    if (this.modal && !this.modal.classList.contains('hidden')) {
      this.renderTemplates()
    }
  }

  /**
   * 收集状态用于持久化
   */
  collectState(): PromptTemplatesState {
    return {
      currentCategory: this.currentCategory,
      isTemplatesLoaded: this.isTemplatesLoaded
    }
  }

  /**
   * 应用恢复的状态
   */
  applyState(state: PromptTemplatesState): void {
    if (state.currentCategory) {
      this.currentCategory = state.currentCategory
    }
  }

  /**
   * 销毁模块
   */
  destroy(): void {
    this.saveState()
    this.templates = {}
    this.isTemplatesLoaded = false
    super.destroy()
  }
}

// 工厂函数
let promptTemplatesInstance: PromptTemplates | null = null

export function createPromptTemplates(app: AppInterface): PromptTemplates {
  promptTemplatesInstance = new PromptTemplates(app)
  return promptTemplatesInstance
}

export function getPromptTemplates(): PromptTemplates | null {
  return promptTemplatesInstance
}

export default PromptTemplates
