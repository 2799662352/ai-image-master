// src/renderer/src/features/settings/SiteManager.ts
/**
 * 站点管理器
 * 处理站点选择、自定义站点的 CRUD 操作和设置模态框
 */

declare const i18n: any

export interface SiteConfig {
  name: string
  baseURL: string
  pathPrefix?: string
  defaultApiKey?: string
  description?: string
  isCustom?: boolean
}

export interface SiteManagerConfig {
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void
  updateApiStatus?: (hasKey: boolean) => void
}

// 站点图标映射
const SITE_ICONS: Record<string, string> = {
  'apiyi': 'fa-bolt',
  'b-apiyi': 'fa-server',
  'local': 'fa-desktop',
  'antigravity': 'fa-rocket',
  'yunwu': 'fa-cloud',
  'bolatu': 'fa-layer-group',
  'default': 'fa-globe'
}

export class SiteManager {
  private config: SiteManagerConfig
  private contextMenuElement: HTMLElement | null = null
  private closeMenuHandler: ((e: MouseEvent) => void) | null = null

  constructor(config: SiteManagerConfig = {}) {
    this.config = config
  }

  /**
   * 渲染站点卡片
   */
  renderSiteCards(): void {
    const container = document.getElementById('siteCardsContainer')
    const api = (window as any).aiImageAPI
    if (!container || !api) return

    const sites = api.getAllSites() as Record<string, SiteConfig>
    const currentSite = api.currentSite as string

    container.innerHTML = ''

    Object.entries(sites).forEach(([key, site]) => {
      const isSelected = key === currentSite
      const isCustom = site.isCustom
      const icon = SITE_ICONS[key] || SITE_ICONS['default']

      const card = document.createElement('div')
      card.className = `site-card relative cursor-pointer rounded-lg p-3 border-2 transition-all ${
        isSelected
          ? 'border-blue-500 bg-blue-50'
          : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
      }`
      card.dataset.siteKey = key

      card.innerHTML = `
        <div class="text-center">
          <i class="fas ${icon} text-2xl ${isSelected ? 'text-blue-500' : 'text-gray-400'} mb-2"></i>
          <div class="text-sm font-medium ${isSelected ? 'text-blue-700' : 'text-gray-700'} truncate">${site.name}</div>
          ${isSelected ? '<div class="absolute -top-1 -right-1 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center"><i class="fas fa-check text-white text-xs"></i></div>' : ''}
          ${isCustom ? '<div class="absolute -top-1 -left-1 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center" title="自定义站点"><i class="fas fa-user text-white text-xs"></i></div>' : ''}
        </div>
      `

      // 点击选择站点
      card.addEventListener('click', () => this.selectSite(key))

      // 自定义站点可以右键编辑/删除
      if (isCustom) {
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          this.showContextMenu(e, key, site)
        })
      }

      container.appendChild(card)
    })

    // 更新当前站点提示
    this.updateCurrentSiteHint()
  }

  /**
   * 选择站点
   */
  selectSite(siteKey: string): void {
    const api = (window as any).aiImageAPI
    if (!api) return

    api.saveSite(siteKey)
    this.renderSiteCards()

    // 加载该站点的图片生成 API Key 到输入框
    const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement | null
    const storedKey = api.getStoredApiKey(siteKey)
    const sites = api.getAllSites() as Record<string, SiteConfig>
    const site = sites[siteKey]

    if (apiKeyInput) {
      apiKeyInput.value = storedKey || site?.defaultApiKey || ''
    }

    // 加载该站点的图像理解 API Key 到输入框
    const visionApiKeyInput = document.getElementById('visionApiKeyInput') as HTMLInputElement | null
    const storedVisionKey = api.getStoredVisionApiKey(siteKey)

    if (visionApiKeyInput) {
      visionApiKeyInput.value = storedVisionKey || ''
    }

    this.updateCurrentSiteHint()
  }

  /**
   * 更新当前站点提示
   */
  updateCurrentSiteHint(): void {
    const hintEl = document.getElementById('currentSiteHint')
    const api = (window as any).aiImageAPI
    if (!hintEl || !api) return

    const site = api.getCurrentSite() as SiteConfig
    const span = hintEl.querySelector('span')

    if (!span) return

    if (site.defaultApiKey) {
      span.textContent = `${site.name} 已配置默认 Key，可直接使用。也可输入自己的 Key。`
      hintEl.classList.remove('hidden')
    } else {
      span.textContent = `请输入 ${site.name} 的 API Key`
      hintEl.classList.remove('hidden')
    }
  }

  /**
   * 显示站点右键菜单
   */
  private showContextMenu(event: MouseEvent, siteKey: string, site: SiteConfig): void {
    // 移除已存在的菜单
    this.removeContextMenu()

    const menu = document.createElement('div')
    menu.id = 'siteContextMenu'
    menu.className = 'fixed bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-[50002]'
    menu.style.left = `${event.clientX}px`
    menu.style.top = `${event.clientY}px`

    menu.innerHTML = `
      <button class="w-full px-4 py-2 text-left hover:bg-gray-100 flex items-center" data-action="edit">
        <i class="fas fa-edit mr-2 text-blue-500"></i>编辑
      </button>
      <button class="w-full px-4 py-2 text-left hover:bg-gray-100 flex items-center text-red-600" data-action="delete">
        <i class="fas fa-trash mr-2"></i>删除
      </button>
    `

    document.body.appendChild(menu)
    this.contextMenuElement = menu

    // 点击其他地方关闭菜单
    this.closeMenuHandler = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        this.removeContextMenu()
      }
    }
    setTimeout(() => document.addEventListener('click', this.closeMenuHandler!), 0)

    // 菜单项点击
    menu.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = (btn as HTMLElement).dataset.action
        this.removeContextMenu()

        if (action === 'edit') {
          this.openEditModal(siteKey, site)
        } else if (action === 'delete') {
          if (confirm(`确定要删除站点 "${site.name}" 吗？`)) {
            const api = (window as any).aiImageAPI
            api?.removeCustomSite?.(siteKey)
            this.renderSiteCards()
          }
        }
      })
    })
  }

  /**
   * 移除右键菜单
   */
  private removeContextMenu(): void {
    if (this.contextMenuElement) {
      this.contextMenuElement.remove()
      this.contextMenuElement = null
    }
    if (this.closeMenuHandler) {
      document.removeEventListener('click', this.closeMenuHandler)
      this.closeMenuHandler = null
    }
  }

  /**
   * 打开添加自定义站点模态框
   */
  openAddModal(): void {
    const modal = document.getElementById('customSiteModal')
    const title = document.getElementById('customSiteModalTitle')
    const editingKey = document.getElementById('editingSiteKey') as HTMLInputElement | null

    // 清空表单
    this.clearFormInputs()
    if (editingKey) editingKey.value = ''

    // 使用 i18n 翻译标题
    const titleText = this.getI18nText('settingsModal.customSite.addTitle', '添加自定义站点')
    if (title) {
      title.innerHTML = `<i class="fas fa-plus-circle text-green-500 mr-2"></i><span>${titleText}</span>`
    }

    if (modal) {
      modal.classList.remove('hidden')
      this.updateModalI18n()
    }
  }

  /**
   * 打开编辑自定义站点模态框
   */
  openEditModal(siteKey: string, site: SiteConfig): void {
    const modal = document.getElementById('customSiteModal')
    const title = document.getElementById('customSiteModalTitle')
    const editingKey = document.getElementById('editingSiteKey') as HTMLInputElement | null

    // 填充表单
    this.setInputValue('customSiteName', site.name || '')
    this.setInputValue('customSiteBaseURL', site.baseURL || '')
    this.setInputValue('customSitePathPrefix', site.pathPrefix || '')
    this.setInputValue('customSiteApiKey', site.defaultApiKey || '')
    this.setInputValue('customSiteDescription', site.description || '')
    if (editingKey) editingKey.value = siteKey

    // 使用 i18n 翻译标题
    const titleText = this.getI18nText('settingsModal.customSite.editTitle', '编辑自定义站点')
    if (title) {
      title.innerHTML = `<i class="fas fa-edit text-blue-500 mr-2"></i><span>${titleText}</span>`
    }

    if (modal) {
      modal.classList.remove('hidden')
      this.updateModalI18n()
    }
  }

  /**
   * 关闭自定义站点模态框
   */
  closeModal(): void {
    const modal = document.getElementById('customSiteModal')
    if (modal) modal.classList.add('hidden')
  }

  /**
   * 保存自定义站点
   */
  saveFromModal(): boolean {
    const name = this.getInputValue('customSiteName')
    const baseURL = this.getInputValue('customSiteBaseURL')
    const pathPrefix = this.getInputValue('customSitePathPrefix')
    const apiKey = this.getInputValue('customSiteApiKey')
    const description = this.getInputValue('customSiteDescription')
    const editingKey = this.getInputValue('editingSiteKey')

    // 验证必填项
    if (!name) {
      alert('请输入站点名称')
      return false
    }
    if (!baseURL) {
      alert('请输入 Base URL')
      return false
    }

    // 验证 URL 格式
    try {
      new URL(baseURL)
    } catch {
      alert('Base URL 格式不正确，请输入完整的 URL（如 https://api.example.com）')
      return false
    }

    const config: SiteConfig = {
      name,
      baseURL,
      pathPrefix,
      defaultApiKey: apiKey,
      description: description || '用户自定义站点'
    }

    const api = (window as any).aiImageAPI
    let success: boolean

    if (editingKey) {
      // 编辑模式
      success = api?.updateCustomSite?.(editingKey, config) ?? false
    } else {
      // 添加模式 - 生成唯一 key
      const key = 'custom-' + Date.now()
      success = api?.addCustomSite?.(key, config) ?? false
    }

    if (success) {
      this.closeModal()
      this.renderSiteCards()
      return true
    } else {
      alert('保存失败，请重试')
      return false
    }
  }

  /**
   * 打开设置模态框
   */
  openSettingsModal(): void {
    const modal = document.getElementById('settingsModal')
    if (!modal) return

    modal.classList.remove('hidden')
    this.renderSiteCards()

    // 加载当前站点的 API Key
    const api = (window as any).aiImageAPI
    if (api) {
      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement | null
      const storedKey = api.getStoredApiKey(api.currentSite)
      const site = api.getCurrentSite()
      if (apiKeyInput) {
        apiKeyInput.value = storedKey || site?.defaultApiKey || ''
      }

      // 加载图像理解 API Key
      const visionApiKeyInput = document.getElementById('visionApiKeyInput') as HTMLInputElement | null
      const visionKey = api.getStoredVisionApiKey()
      if (visionApiKeyInput) {
        visionApiKeyInput.value = visionKey || ''
      }
    }

    // 更新模态框内的翻译
    this.updateModalI18n()
  }

  /**
   * 关闭设置模态框
   */
  closeSettingsModal(): void {
    const modal = document.getElementById('settingsModal')
    if (modal) modal.classList.add('hidden')
  }

  /**
   * 保存 API Key（公共方法）
   */
  async saveApiKeyPublic(): Promise<boolean> {
    const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement | null
    const visionApiKeyInput = document.getElementById('visionApiKeyInput') as HTMLInputElement | null
    const api = (window as any).aiImageAPI

    const apiKey = apiKeyInput?.value.trim()
    const visionApiKey = visionApiKeyInput?.value.trim()

    // 验证必填
    if (!apiKey) {
      this.config.showToast?.('请输入图片生成 API Key', 'error')
      return false
    }

    let success = true
    const messages: string[] = []

    // 保存图片生成 API Key
    if (api?.saveApiKey?.(apiKey)) {
      messages.push('图片生成 API Key 保存成功')
    } else {
      success = false
      messages.push('图片生成 API Key 保存失败')
    }

    // 保存图像理解 API Key
    if (api?.saveVisionApiKey?.(visionApiKey || '')) {
      if (visionApiKey) {
        messages.push('图像理解 API Key 保存成功')
      } else {
        messages.push('图像理解 API Key 已清除')
      }
    } else {
      messages.push('图像理解 API Key 保存失败')
    }

    // 显示结果
    if (success) {
      this.config.showToast?.(messages.join('\n'), 'success')
      this.config.updateApiStatus?.(true)
      this.closeSettingsModal()
    } else {
      this.config.showToast?.(messages.join('\n'), 'error')
    }

    return success
  }

  /**
   * 更新 API 状态显示
   */
  updateApiStatusDisplay(isConnected = false): void {
    const api = (window as any).aiImageAPI
    const hasApiKey = api?.apiKey
    const isActive = isConnected || !!hasApiKey

    // 获取状态文本
    let statusText: string
    try {
      if (typeof i18n !== 'undefined' && typeof i18n.t === 'function') {
        statusText = isActive
          ? i18n.t('nav.settingsButton.configured')
          : i18n.t('nav.settingsButton.notConfigured')
      } else {
        statusText = isActive ? '已设置' : '未设置'
      }
    } catch {
      statusText = isActive ? '已设置' : '未设置'
    }

    // 更新桌面端设置按钮
    this.updateSettingsButton('settingsBtn', isActive, statusText)
    // 更新移动端设置按钮
    this.updateSettingsButton('settingsBtnMobile', isActive, statusText)
  }

  /**
   * 更新设置按钮样式
   */
  private updateSettingsButton(id: string, isActive: boolean, statusText: string): void {
    const btn = document.getElementById(id)
    if (!btn) return

    const icon = btn.querySelector('i')
    const span = btn.querySelector('span')
    let badge = btn.querySelector('.status-badge')

    if (isActive) {
      btn.classList.remove('border-gray-200', 'text-gray-600')
      btn.classList.add('border-green-400', 'text-green-700', 'bg-green-50')
      if (icon) icon.classList.add('text-green-500')
      if (span) span.textContent = statusText

      if (!badge) {
        badge = document.createElement('span')
        badge.className = 'status-badge absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full'
        btn.style.position = 'relative'
        btn.appendChild(badge)
      }
    } else {
      btn.classList.remove('border-green-400', 'text-green-700', 'bg-green-50')
      btn.classList.add('border-gray-200', 'text-gray-600')
      if (icon) icon.classList.remove('text-green-500')
      if (span) span.textContent = statusText
      if (badge) badge.remove()
    }
  }

  /**
   * 初始化设置模态框事件监听
   */
  initSettingsModalEvents(): void {
    // 添加自定义站点按钮
    const addCustomSiteBtn = document.getElementById('addCustomSiteBtn')
    if (addCustomSiteBtn) {
      addCustomSiteBtn.addEventListener('click', () => this.openAddModal())
    }

    // 关闭设置模态框
    const closeSettingsX = document.getElementById('closeSettingsX')
    const closeSettings = document.getElementById('closeSettings')
    const settingsModal = document.getElementById('settingsModal')

    const closeSettingsModal = () => {
      if (settingsModal) settingsModal.classList.add('hidden')
    }

    if (closeSettingsX) closeSettingsX.addEventListener('click', closeSettingsModal)
    if (closeSettings) closeSettings.addEventListener('click', closeSettingsModal)

    // 点击模态框外部关闭
    if (settingsModal) {
      settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) closeSettingsModal()
      })
    }

    // 自定义站点模态框事件
    const cancelCustomSite = document.getElementById('cancelCustomSite')
    const saveCustomSite = document.getElementById('saveCustomSite')
    const customSiteModal = document.getElementById('customSiteModal')

    if (cancelCustomSite) cancelCustomSite.addEventListener('click', () => this.closeModal())
    if (saveCustomSite) saveCustomSite.addEventListener('click', () => this.saveFromModal())

    // 点击模态框外部关闭
    if (customSiteModal) {
      customSiteModal.addEventListener('click', (e) => {
        if (e.target === customSiteModal) this.closeModal()
      })
    }

    // 保存 API 配置按钮
    const saveApiConfig = document.getElementById('saveApiConfig')
    if (saveApiConfig) {
      saveApiConfig.addEventListener('click', () => this.saveApiConfig(closeSettingsModal))
    }

    // 测试连接按钮
    const testConnection = document.getElementById('testConnection')
    if (testConnection) {
      testConnection.addEventListener('click', () => this.testConnection(testConnection as HTMLButtonElement))
    }

    // API Key 显示/隐藏切换
    this.initApiKeyVisibilityToggle()

    // "如何获取 API Key" 折叠展开
    this.initHowToGetToggle()
  }

  /**
   * 保存 API 配置
   */
  private saveApiConfig(closeCallback: () => void): void {
    const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement | null
    const visionApiKeyInput = document.getElementById('visionApiKeyInput') as HTMLInputElement | null
    const api = (window as any).aiImageAPI

    if (apiKeyInput && api) {
      const apiKey = apiKeyInput.value.trim()
      const visionApiKey = visionApiKeyInput?.value.trim()

      // 保存图片生成 API Key
      api.saveApiKey(apiKey)

      // 保存图像理解 API Key（包括清空操作）
      if (visionApiKey !== undefined) {
        api.saveVisionApiKey(visionApiKey)
      }

      // 显示保存成功提示
      if (this.config.showToast) {
        this.config.showToast('配置已保存', 'success')
      } else {
        alert('配置已保存')
      }

      closeCallback()

      // 更新设置按钮状态
      this.config.updateApiStatus?.(!!apiKey)
    }
  }

  /**
   * 测试连接
   */
  private async testConnection(button: HTMLButtonElement): Promise<void> {
    const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement | null
    const apiKey = apiKeyInput?.value.trim()
    const api = (window as any).aiImageAPI

    if (!apiKey) {
      alert('请先输入 API Key')
      return
    }

    button.disabled = true
    button.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>测试中...'

    try {
      const currentSite = api?.getCurrentSite() as SiteConfig
      const testUrl = currentSite.baseURL + '/v1/models'

      const response = await fetch(testUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      })

      if (response.ok) {
        alert('✅ 连接成功！')
      } else {
        alert(`❌ 连接失败：${response.status} ${response.statusText}`)
      }
    } catch (error) {
      alert(`❌ 连接失败：${(error as Error).message}`)
    } finally {
      button.disabled = false
      button.innerHTML = '<i class="fas fa-plug mr-2"></i>测试连接'
    }
  }

  /**
   * 初始化 API Key 可见性切换
   */
  private initApiKeyVisibilityToggle(): void {
    const toggleBtn = document.getElementById('toggleApiKeyVisibility')
    const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement | null

    if (toggleBtn && apiKeyInput) {
      toggleBtn.addEventListener('click', () => {
        const icon = toggleBtn.querySelector('i')
        if (apiKeyInput.type === 'password') {
          apiKeyInput.type = 'text'
          icon?.classList.replace('fa-eye', 'fa-eye-slash')
        } else {
          apiKeyInput.type = 'password'
          icon?.classList.replace('fa-eye-slash', 'fa-eye')
        }
      })
    }
  }

  /**
   * 初始化 "如何获取 API Key" 折叠
   */
  private initHowToGetToggle(): void {
    const toggleBtn = document.getElementById('toggleHowToGet')
    const content = document.getElementById('howToGetContent')
    const icon = document.getElementById('howToGetIcon')

    if (toggleBtn && content && icon) {
      toggleBtn.addEventListener('click', () => {
        content.classList.toggle('hidden')
        icon.classList.toggle('rotate-180')
      })
    }
  }

  /**
   * 辅助方法：获取输入值
   */
  private getInputValue(id: string): string {
    const input = document.getElementById(id) as HTMLInputElement | null
    return input?.value.trim() || ''
  }

  /**
   * 辅助方法：设置输入值
   */
  private setInputValue(id: string, value: string): void {
    const input = document.getElementById(id) as HTMLInputElement | null
    if (input) input.value = value
  }

  /**
   * 辅助方法：清空表单输入
   */
  private clearFormInputs(): void {
    const ids = [
      'customSiteName',
      'customSiteBaseURL',
      'customSitePathPrefix',
      'customSiteApiKey',
      'customSiteDescription'
    ]
    ids.forEach(id => this.setInputValue(id, ''))
  }

  /**
   * 辅助方法：获取 i18n 文本
   */
  private getI18nText(key: string, defaultText: string): string {
    try {
      if (typeof i18n !== 'undefined' && typeof i18n.t === 'function') {
        return i18n.t(key) || defaultText
      }
    } catch {
      // 忽略错误
    }
    return defaultText
  }

  /**
   * 辅助方法：更新模态框 i18n
   */
  private updateModalI18n(): void {
    try {
      if (typeof i18n !== 'undefined' && typeof i18n.updateDOM === 'function') {
        i18n.updateDOM()
      }
    } catch {
      // 忽略错误
    }
  }

  /**
   * 销毁实例
   */
  destroy(): void {
    this.removeContextMenu()
  }
}

// 单例实例
let siteManagerInstance: SiteManager | null = null

/**
 * 获取 SiteManager 单例
 */
export function getSiteManager(config?: SiteManagerConfig): SiteManager {
  if (!siteManagerInstance) {
    siteManagerInstance = new SiteManager(config)
  }
  return siteManagerInstance
}

/**
 * 创建新的 SiteManager 实例
 */
export function createSiteManager(config?: SiteManagerConfig): SiteManager {
  return new SiteManager(config)
}
