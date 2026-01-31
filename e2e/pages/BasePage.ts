// e2e/pages/BasePage.ts
/**
 * 页面对象模型基类
 * 提供所有页面共享的方法
 */

import { Page, Locator } from '@playwright/test'

export abstract class BasePage {
  protected page: Page
  protected tabName: string

  constructor(page: Page, tabName: string) {
    this.page = page
    this.tabName = tabName
  }

  /**
   * 导航到此页面
   */
  async navigate(): Promise<void> {
    await this.page.click(`[data-tab="${this.tabName}"]`)
    await this.waitForPanel()
  }

  /**
   * 等待面板显示
   */
  async waitForPanel(): Promise<void> {
    await this.page.waitForSelector(`#${this.tabName}Panel:not(.hidden)`, { timeout: 5000 })
  }

  /**
   * 检查面板是否可见
   */
  async isVisible(): Promise<boolean> {
    const panel = await this.page.$(`#${this.tabName}Panel`)
    if (!panel) return false
    return !(await panel.evaluate(el => el.classList.contains('hidden')))
  }

  /**
   * 获取面板元素
   */
  getPanel(): Locator {
    return this.page.locator(`#${this.tabName}Panel`)
  }

  /**
   * 等待加载完成
   */
  async waitForLoading(): Promise<void> {
    // 等待加载指示器消失
    const loader = this.page.locator('.loading, .spinner')
    if (await loader.count() > 0) {
      await loader.waitFor({ state: 'hidden', timeout: 30000 })
    }
  }

  /**
   * 截图
   */
  async screenshot(name: string): Promise<void> {
    await this.page.screenshot({ path: `e2e/screenshots/${name}.png` })
  }

  /**
   * 获取 Toast 消息
   */
  async getToastMessage(): Promise<string> {
    const toast = await this.page.waitForSelector('#toast:not(.hidden)', { timeout: 5000 })
    const message = await toast.$('#toastMessage')
    return message ? await message.textContent() || '' : ''
  }

  /**
   * 等待 Toast 消息
   */
  async waitForToast(expectedText?: string): Promise<void> {
    const toast = this.page.locator('#toast')
    await toast.waitFor({ state: 'visible', timeout: 5000 })
    
    if (expectedText) {
      await this.page.locator('#toastMessage', { hasText: expectedText }).waitFor({ timeout: 5000 })
    }
  }
}
