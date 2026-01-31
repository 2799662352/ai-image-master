// e2e/pages/BatchPage.ts
/**
 * 批量生成页面对象模型
 */

import { Page, Locator } from '@playwright/test'
import { BasePage } from './BasePage'

export class BatchPage extends BasePage {
  // 元素定位器
  private promptsTextarea: Locator
  private batchGenerateBtn: Locator
  private clearAllBtn: Locator
  private ratioSelector: Locator
  private referenceImageArea: Locator
  private resultsContainer: Locator
  private progressIndicator: Locator

  constructor(page: Page) {
    super(page, 'batch')
    
    this.promptsTextarea = page.locator('#batchPrompts')
    this.batchGenerateBtn = page.locator('#batchGenerateBtn')
    this.clearAllBtn = page.locator('#clearBatchBtn')
    this.ratioSelector = page.locator('#batchRatioSelector')
    this.referenceImageArea = page.locator('#batchReferenceImageArea')
    this.resultsContainer = page.locator('#batchResults')
    this.progressIndicator = page.locator('#batchProgress')
  }

  /**
   * 输入多个提示词（每行一个）
   */
  async enterPrompts(prompts: string[]): Promise<void> {
    await this.promptsTextarea.fill(prompts.join('\n'))
  }

  /**
   * 获取当前输入的提示词
   */
  async getPrompts(): Promise<string[]> {
    const text = await this.promptsTextarea.inputValue()
    return text.split('\n').filter(p => p.trim())
  }

  /**
   * 获取提示词数量
   */
  async getPromptCount(): Promise<number> {
    const prompts = await this.getPrompts()
    return prompts.length
  }

  /**
   * 点击批量生成按钮
   */
  async clickGenerate(): Promise<void> {
    await this.batchGenerateBtn.click()
  }

  /**
   * 点击清空按钮
   */
  async clickClear(): Promise<void> {
    await this.clearAllBtn.click()
  }

  /**
   * 选择比例
   */
  async selectRatio(ratio: string): Promise<void> {
    await this.ratioSelector.selectOption(ratio)
  }

  /**
   * 检查生成按钮是否禁用
   */
  async isGenerateButtonDisabled(): Promise<boolean> {
    return await this.batchGenerateBtn.isDisabled()
  }

  /**
   * 检查是否正在生成
   */
  async isGenerating(): Promise<boolean> {
    const progress = await this.progressIndicator.isVisible()
    return progress
  }

  /**
   * 等待批量生成完成
   */
  async waitForBatchComplete(timeout: number = 120000): Promise<void> {
    await this.progressIndicator.waitFor({ state: 'hidden', timeout })
  }

  /**
   * 获取结果数量
   */
  async getResultCount(): Promise<number> {
    const results = await this.resultsContainer.locator('.batch-result-item').count()
    return results
  }

  /**
   * 检查是否有参考图
   */
  async hasReferenceImages(): Promise<boolean> {
    const images = await this.referenceImageArea.locator('img').count()
    return images > 0
  }

  /**
   * 获取面板内的错误消息
   */
  async getErrorMessage(): Promise<string | null> {
    const errorElement = this.page.locator('.batch-error-message')
    if (await errorElement.count() > 0) {
      return await errorElement.textContent()
    }
    return null
  }
}
