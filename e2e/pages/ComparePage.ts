// e2e/pages/ComparePage.ts
/**
 * 模型对比页面对象模型
 */

import { Page, Locator } from '@playwright/test'
import { BasePage } from './BasePage'

export class ComparePage extends BasePage {
  // 元素定位器
  private promptInput: Locator
  private leftModelSelector: Locator
  private rightModelSelector: Locator
  private compareBtn: Locator
  private leftResult: Locator
  private rightResult: Locator
  private winnerSelector: Locator
  private saveComparisonBtn: Locator

  constructor(page: Page) {
    super(page, 'compare')
    
    this.promptInput = page.locator('#comparePrompt')
    this.leftModelSelector = page.locator('#leftModelSelector')
    this.rightModelSelector = page.locator('#rightModelSelector')
    this.compareBtn = page.locator('#compareBtn')
    this.leftResult = page.locator('#leftCompareResult')
    this.rightResult = page.locator('#rightCompareResult')
    this.winnerSelector = page.locator('.winner-selector')
    this.saveComparisonBtn = page.locator('#saveComparisonBtn')
  }

  /**
   * 输入提示词
   */
  async enterPrompt(prompt: string): Promise<void> {
    await this.promptInput.fill(prompt)
  }

  /**
   * 获取当前提示词
   */
  async getPrompt(): Promise<string> {
    return await this.promptInput.inputValue()
  }

  /**
   * 选择左侧模型
   */
  async selectLeftModel(modelId: string): Promise<void> {
    await this.leftModelSelector.selectOption(modelId)
  }

  /**
   * 选择右侧模型
   */
  async selectRightModel(modelId: string): Promise<void> {
    await this.rightModelSelector.selectOption(modelId)
  }

  /**
   * 获取选中的左侧模型
   */
  async getLeftModel(): Promise<string> {
    return await this.leftModelSelector.inputValue()
  }

  /**
   * 获取选中的右侧模型
   */
  async getRightModel(): Promise<string> {
    return await this.rightModelSelector.inputValue()
  }

  /**
   * 点击对比按钮
   */
  async clickCompare(): Promise<void> {
    await this.compareBtn.click()
  }

  /**
   * 检查对比按钮是否禁用
   */
  async isCompareButtonDisabled(): Promise<boolean> {
    return await this.compareBtn.isDisabled()
  }

  /**
   * 检查左侧结果是否有图片
   */
  async hasLeftResult(): Promise<boolean> {
    const img = await this.leftResult.locator('img').count()
    return img > 0
  }

  /**
   * 检查右侧结果是否有图片
   */
  async hasRightResult(): Promise<boolean> {
    const img = await this.rightResult.locator('img').count()
    return img > 0
  }

  /**
   * 等待对比完成
   */
  async waitForCompareComplete(timeout: number = 60000): Promise<void> {
    await Promise.all([
      this.leftResult.locator('img').waitFor({ timeout }),
      this.rightResult.locator('img').waitFor({ timeout })
    ])
  }

  /**
   * 选择获胜者
   */
  async selectWinner(side: 'left' | 'right' | 'tie'): Promise<void> {
    await this.winnerSelector.locator(`[data-winner="${side}"]`).click()
  }

  /**
   * 保存对比结果
   */
  async saveComparison(): Promise<void> {
    await this.saveComparisonBtn.click()
  }

  /**
   * 检查是否正在生成
   */
  async isGenerating(): Promise<boolean> {
    const leftLoading = await this.leftResult.locator('.loading, .spinner').count() > 0
    const rightLoading = await this.rightResult.locator('.loading, .spinner').count() > 0
    return leftLoading || rightLoading
  }

  /**
   * 获取左侧图片URL
   */
  async getLeftImageUrl(): Promise<string | null> {
    const img = this.leftResult.locator('img')
    if (await img.count() > 0) {
      return await img.getAttribute('src')
    }
    return null
  }

  /**
   * 获取右侧图片URL
   */
  async getRightImageUrl(): Promise<string | null> {
    const img = this.rightResult.locator('img')
    if (await img.count() > 0) {
      return await img.getAttribute('src')
    }
    return null
  }
}
