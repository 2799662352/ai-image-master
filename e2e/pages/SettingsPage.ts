// e2e/pages/SettingsPage.ts
/**
 * 设置页面对象模型
 */

import { Page, Locator } from '@playwright/test'
import { BasePage } from './BasePage'

export class SettingsPage extends BasePage {
  // 定位器
  readonly apiKeyInput: Locator
  readonly saveButton: Locator
  readonly siteSelector: Locator
  readonly languageSelector: Locator
  readonly themeToggle: Locator

  constructor(page: Page) {
    super(page, 'settings')

    this.apiKeyInput = page.locator('#apiKeyInput, input[name="apiKey"]')
    this.saveButton = page.locator('#saveSettingsBtn, .save-settings-btn')
    this.siteSelector = page.locator('#siteSelector, .site-selector')
    this.languageSelector = page.locator('#languageSelector, .language-selector')
    this.themeToggle = page.locator('#themeToggle, .theme-toggle')
  }

  /**
   * 设置 API Key
   */
  async setApiKey(key: string): Promise<void> {
    await this.apiKeyInput.fill(key)
  }

  /**
   * 获取 API Key
   */
  async getApiKey(): Promise<string> {
    return await this.apiKeyInput.inputValue()
  }

  /**
   * 保存设置
   */
  async save(): Promise<void> {
    await this.saveButton.click()
  }

  /**
   * 选择站点
   */
  async selectSite(siteKey: string): Promise<void> {
    await this.siteSelector.click()
    await this.page.click(`[data-site="${siteKey}"]`)
  }

  /**
   * 选择语言
   */
  async selectLanguage(langCode: string): Promise<void> {
    await this.languageSelector.click()
    await this.page.click(`[data-lang="${langCode}"]`)
  }

  /**
   * 切换主题
   */
  async toggleTheme(): Promise<void> {
    await this.themeToggle.click()
  }

  /**
   * 检查 API 状态
   */
  async getApiStatus(): Promise<'connected' | 'not-configured' | 'error'> {
    const statusEl = await this.page.$('.api-status')
    if (!statusEl) return 'not-configured'
    
    const classes = await statusEl.getAttribute('class') || ''
    
    if (classes.includes('connected')) return 'connected'
    if (classes.includes('error')) return 'error'
    return 'not-configured'
  }

  /**
   * 配置并保存 API Key
   */
  async configureApiKey(key: string): Promise<void> {
    await this.setApiKey(key)
    await this.save()
    await this.waitForToast()
  }
}
