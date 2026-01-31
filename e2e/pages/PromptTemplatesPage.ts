// e2e/pages/PromptTemplatesPage.ts
/**
 * 提示词模板页面对象模型
 */

import { Page, Locator } from '@playwright/test'
import { BasePage } from './BasePage'

export class PromptTemplatesPage extends BasePage {
  // 定位器
  readonly templatesContainer: Locator
  readonly categoryTabs: Locator
  readonly templateCards: Locator
  readonly searchInput: Locator
  readonly applyButton: Locator

  constructor(page: Page) {
    super(page, 'templates')

    this.templatesContainer = page.locator('#templatesPanel, .templates-container')
    this.categoryTabs = page.locator('.template-category-tab, .category-btn')
    this.templateCards = page.locator('.template-card, .prompt-template')
    this.searchInput = page.locator('#templateSearch, input[placeholder*="搜索"]')
    this.applyButton = page.locator('.apply-template-btn, button:has-text("应用")')
  }

  /**
   * 获取模板分类数量
   */
  async getCategoryCount(): Promise<number> {
    return await this.categoryTabs.count()
  }

  /**
   * 选择分类
   */
  async selectCategory(categoryName: string): Promise<void> {
    await this.page.click(`.template-category-tab:has-text("${categoryName}"), .category-btn:has-text("${categoryName}")`)
  }

  /**
   * 获取当前分类下的模板数量
   */
  async getTemplateCount(): Promise<number> {
    return await this.templateCards.count()
  }

  /**
   * 搜索模板
   */
  async searchTemplates(query: string): Promise<void> {
    if (await this.searchInput.count() > 0) {
      await this.searchInput.fill(query)
    }
  }

  /**
   * 点击模板卡片
   */
  async clickTemplate(index: number): Promise<void> {
    const cards = await this.templateCards.all()
    if (cards[index]) {
      await cards[index].click()
    }
  }

  /**
   * 应用选中的模板
   */
  async applySelectedTemplate(): Promise<void> {
    if (await this.applyButton.count() > 0) {
      await this.applyButton.click()
    }
  }

  /**
   * 获取模板标题列表
   */
  async getTemplateTitles(): Promise<string[]> {
    const cards = await this.templateCards.all()
    const titles: string[] = []
    for (const card of cards) {
      const title = await card.locator('.template-title, h3, h4').textContent()
      if (title) titles.push(title.trim())
    }
    return titles
  }

  /**
   * 检查是否有模板加载
   */
  async hasTemplates(): Promise<boolean> {
    return await this.getTemplateCount() > 0
  }
}
