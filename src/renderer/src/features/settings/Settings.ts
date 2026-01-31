// src/renderer/src/features/settings/Settings.ts
/**
 * 设置面板模块
 * 处理应用设置、API Key 配置等功能
 */

export interface SettingsOptions {
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void
  onApiKeyChange?: (apiKey: string) => void
  getI18nText?: (key: string) => string
}

export class Settings {
  private options: SettingsOptions
  private modalId = 'settingsModal'

  constructor(options: SettingsOptions = {}) {
    this.options = options
  }

  /**
   * 打开设置模态框
   */
  open(): void {
    const modal = document.getElementById(this.modalId)
    if (modal) {
      modal.classList.remove('hidden')
      
      // 渲染站点卡片
      const renderSiteCards = (window as any).renderSiteCards
      if (typeof renderSiteCards === 'function') {
        renderSiteCards()
      }
      
      // 加载并显示已保存的 API Keys
      this.loadStoredApiKey()
      
      // 更新模态框内的翻译
      const i18n = (window as any).i18n
      if (i18n?.updateDOM) {
        i18n.updateDOM()
      }
    }
  }

  /**
   * 关闭设置模态框
   */
  close(): void {
    const modal = document.getElementById(this.modalId)
    if (modal) {
      modal.classList.add('hidden')
    }
  }

  /**
   * 加载已存储的 API Key
   */
  private loadStoredApiKey(): void {
    const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
    const api = (window as any).aiImageAPI
    
    if (apiKeyInput && api) {
      const storedKey = api.getStoredApiKey?.(api.currentSite)
      const site = api.getCurrentSite?.()
      apiKeyInput.value = storedKey || site?.defaultApiKey || ''
    }
  }

  /**
   * 保存 API Key
   */
  async saveApiKey(): Promise<boolean> {
    const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
    const visionApiKeyInput = document.getElementById('visionApiKeyInput') as HTMLInputElement
    
    const apiKey = apiKeyInput?.value.trim() || ''
    const visionApiKey = visionApiKeyInput?.value.trim() || ''
    const api = (window as any).aiImageAPI

    if (!apiKey) {
      this.options.showToast?.('请输入图片生成 API Key', 'error')
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
    if (api?.saveVisionApiKey?.(visionApiKey)) {
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
      this.options.showToast?.(messages.join('\n'), 'success')
      this.options.onApiKeyChange?.(apiKey)
      this.close()
    } else {
      this.options.showToast?.(messages.join('\n'), 'error')
    }

    return success
  }

  /**
   * 更新 API 状态显示
   */
  updateApiStatus(isConnected = false): void {
    const settingsBtn = document.getElementById('settingsBtn')
    const settingsBtnMobile = document.getElementById('settingsBtnMobile')
    const api = (window as any).aiImageAPI

    const hasApiKey = api?.apiKey
    const isActive = isConnected || hasApiKey

    const statusText = this.options.getI18nText
      ? (isActive 
          ? this.options.getI18nText('nav.settingsButton.configured')
          : this.options.getI18nText('nav.settingsButton.notConfigured'))
      : (isActive ? '已设置' : '未设置')

    // 更新桌面端设置按钮
    if (settingsBtn) {
      this.updateSettingsButton(settingsBtn, isActive, statusText)
    }

    // 更新移动端设置按钮
    if (settingsBtnMobile) {
      this.updateSettingsButton(settingsBtnMobile, isActive, statusText)
    }
  }

  /**
   * 更新设置按钮样式
   */
  private updateSettingsButton(btn: HTMLElement, isActive: boolean, statusText: string): void {
    const icon = btn.querySelector('i')
    const span = btn.querySelector('span')
    let badge = btn.querySelector('.status-badge') as HTMLDivElement

    if (isActive) {
      // 已配置状态 - 绿色样式
      if (icon) icon.className = 'fas fa-cog text-green-300'
      if (span) {
        span.textContent = statusText
        span.className = 'hidden lg:inline text-green-100'
      }
      // 添加绿色徽章点
      if (!badge) {
        badge = document.createElement('div')
        badge.className = 'status-badge absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full'
        btn.appendChild(badge)
      } else {
        badge.className = 'status-badge absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full'
      }
    } else {
      // 未配置状态 - 红色样式
      if (icon) icon.className = 'fas fa-cog text-red-300'
      if (span) {
        span.textContent = statusText
        span.className = 'hidden lg:inline text-red-100'
      }
      // 添加红色徽章点
      if (!badge) {
        badge = document.createElement('div')
        badge.className = 'status-badge absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full animate-pulse'
        btn.appendChild(badge)
      } else {
        badge.className = 'status-badge absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full animate-pulse'
      }
    }
  }

  /**
   * 绑定设置按钮事件
   */
  bindEvents(): void {
    const settingsBtn = document.getElementById('settingsBtn')
    const settingsBtnMobile = document.getElementById('settingsBtnMobile')
    const closeBtn = document.getElementById('closeSettingsX')
    const saveBtn = document.getElementById('saveApiConfig')

    settingsBtn?.addEventListener('click', () => this.open())
    settingsBtnMobile?.addEventListener('click', () => this.open())
    closeBtn?.addEventListener('click', () => this.close())
    saveBtn?.addEventListener('click', () => this.saveApiKey())

    // 点击模态框外部关闭
    const modal = document.getElementById(this.modalId)
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.close()
      }
    })
  }
}

export function createSettings(options?: SettingsOptions): Settings {
  return new Settings(options)
}
