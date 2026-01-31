// e2e/pages/UnderstandPage.ts
/**
 * 图像理解页面对象模型
 */

import { Page, Locator } from '@playwright/test'
import { BasePage } from './BasePage'

export class UnderstandPage extends BasePage {
  // 定位器
  readonly imageUploadArea: Locator
  readonly uploadedImages: Locator
  readonly modelSelector: Locator
  readonly roleSelector: Locator
  readonly customPromptInput: Locator
  readonly analyzeButton: Locator
  readonly resultContainer: Locator
  readonly copyResultButton: Locator

  constructor(page: Page) {
    super(page, 'understand')

    this.imageUploadArea = page.locator('#understandImageArea, .understand-upload-area')
    this.uploadedImages = page.locator('.understand-image-preview, .uploaded-image')
    this.modelSelector = page.locator('#visionModelSelector, .vision-model-select')
    this.roleSelector = page.locator('#roleSelector, .role-select')
    this.customPromptInput = page.locator('#customPromptInput, textarea[name="customPrompt"]')
    this.analyzeButton = page.locator('#analyzeBtn, button:has-text("分析")')
    this.resultContainer = page.locator('#analysisResult, .analysis-result')
    this.copyResultButton = page.locator('#copyResultBtn, button:has-text("复制")')
  }

  /**
   * 获取已上传图片数量
   */
  async getUploadedImageCount(): Promise<number> {
    return await this.uploadedImages.count()
  }

  /**
   * 选择视觉模型
   */
  async selectModel(modelName: string): Promise<void> {
    await this.modelSelector.click()
    await this.page.click(`.model-option:has-text("${modelName}"), .choices__item:has-text("${modelName}")`)
  }

  /**
   * 选择分析角色
   */
  async selectRole(roleName: string): Promise<void> {
    await this.roleSelector.click()
    await this.page.click(`.role-option:has-text("${roleName}"), .choices__item:has-text("${roleName}")`)
  }

  /**
   * 设置自定义提示词
   */
  async setCustomPrompt(prompt: string): Promise<void> {
    await this.customPromptInput.fill(prompt)
  }

  /**
   * 点击分析按钮
   */
  async clickAnalyze(): Promise<void> {
    await this.analyzeButton.click()
  }

  /**
   * 等待分析完成
   */
  async waitForAnalysis(timeout = 60000): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const btn = document.querySelector('#analyzeBtn, button:has-text("分析")')
        return btn && !btn.textContent?.includes('分析中')
      },
      { timeout }
    )
  }

  /**
   * 获取分析结果
   */
  async getAnalysisResult(): Promise<string> {
    const result = await this.resultContainer.textContent()
    return result || ''
  }

  /**
   * 检查是否有分析结果
   */
  async hasResult(): Promise<boolean> {
    const result = await this.getAnalysisResult()
    return result.trim().length > 0
  }

  /**
   * 复制分析结果
   */
  async copyResult(): Promise<void> {
    if (await this.copyResultButton.count() > 0) {
      await this.copyResultButton.click()
    }
  }

  /**
   * 检查分析按钮是否可用
   */
  async isAnalyzeEnabled(): Promise<boolean> {
    return await this.analyzeButton.isEnabled()
  }

  /**
   * 检查是否正在分析
   */
  async isAnalyzing(): Promise<boolean> {
    const text = await this.analyzeButton.textContent()
    return text?.includes('分析中') || false
  }

  /**
   * 删除指定索引的上传图片
   */
  async removeImage(index: number): Promise<void> {
    const images = await this.uploadedImages.all()
    if (images[index]) {
      const removeBtn = images[index].locator('.remove-btn, button:has-text("删除")')
      if (await removeBtn.count() > 0) {
        await removeBtn.click()
      }
    }
  }
}
