// e2e/pages/GeneratePage.ts
/**
 * 生成页面对象模型
 */

import { Page, Locator } from '@playwright/test'
import { BasePage } from './BasePage'

export class GeneratePage extends BasePage {
  // 定位器
  readonly promptInput: Locator
  readonly generateButton: Locator
  readonly modelSelector: Locator
  readonly ratioButtons: Locator
  readonly resolutionButtons: Locator
  readonly referenceImageUpload: Locator
  readonly generatedImagesContainer: Locator

  constructor(page: Page) {
    super(page, 'generate')

    this.promptInput = page.locator('#promptInput')
    this.generateButton = page.locator('#generateBtn')
    this.modelSelector = page.locator('#modelSelector')
    this.ratioButtons = page.locator('.ratio-btn')
    this.resolutionButtons = page.locator('.resolution-btn')
    this.referenceImageUpload = page.locator('#referenceImageUpload')
    this.generatedImagesContainer = page.locator('#generatedImages')
  }

  /**
   * 设置提示词
   */
  async setPrompt(text: string): Promise<void> {
    await this.promptInput.fill(text)
  }

  /**
   * 获取提示词
   */
  async getPrompt(): Promise<string> {
    return await this.promptInput.inputValue()
  }

  /**
   * 清空提示词
   */
  async clearPrompt(): Promise<void> {
    await this.promptInput.clear()
  }

  /**
   * 选择比例
   */
  async selectRatio(ratio: string): Promise<void> {
    await this.page.click(`.ratio-btn[data-ratio="${ratio}"]`)
  }

  /**
   * 选择分辨率
   */
  async selectResolution(resolution: string): Promise<void> {
    await this.page.click(`.resolution-btn[data-resolution="${resolution}"]`)
  }

  /**
   * 选择模型
   */
  async selectModel(modelName: string): Promise<void> {
    await this.modelSelector.click()
    await this.page.click(`.choices__item[data-value="${modelName}"]`)
  }

  /**
   * 点击生成按钮
   */
  async clickGenerate(): Promise<void> {
    await this.generateButton.click()
  }

  /**
   * 执行完整的生成流程
   */
  async generate(options: {
    prompt: string
    ratio?: string
    resolution?: string
    model?: string
  }): Promise<void> {
    await this.setPrompt(options.prompt)
    
    if (options.ratio) {
      await this.selectRatio(options.ratio)
    }
    
    if (options.resolution) {
      await this.selectResolution(options.resolution)
    }
    
    if (options.model) {
      await this.selectModel(options.model)
    }
    
    await this.clickGenerate()
  }

  /**
   * 等待生成完成
   */
  async waitForGeneration(timeout = 120000): Promise<void> {
    // 等待按钮恢复正常状态（不再是"生成中..."）
    await this.page.waitForFunction(
      () => {
        const btn = document.getElementById('generateBtn')
        return btn && !btn.textContent?.includes('生成中')
      },
      { timeout }
    )
  }

  /**
   * 获取生成的图片数量
   */
  async getGeneratedImageCount(): Promise<number> {
    const images = await this.generatedImagesContainer.locator('img').count()
    return images
  }

  /**
   * 获取生成的图片 URL
   */
  async getGeneratedImageUrls(): Promise<string[]> {
    const images = await this.generatedImagesContainer.locator('img').all()
    const urls: string[] = []
    for (const img of images) {
      const src = await img.getAttribute('src')
      if (src) urls.push(src)
    }
    return urls
  }

  /**
   * 检查生成按钮是否可用
   */
  async isGenerateEnabled(): Promise<boolean> {
    return await this.generateButton.isEnabled()
  }

  /**
   * 检查是否正在生成
   */
  async isGenerating(): Promise<boolean> {
    const text = await this.generateButton.textContent()
    return text?.includes('生成中') || false
  }

  /**
   * 上传参考图片（通过 base64）
   */
  async uploadReferenceImage(base64Data: string): Promise<void> {
    await this.page.evaluate((data) => {
      const event = new CustomEvent('referenceImageAdded', { detail: { data } })
      document.dispatchEvent(event)
    }, base64Data)
  }

  /**
   * 获取当前选中的比例
   */
  async getSelectedRatio(): Promise<string | null> {
    const activeBtn = await this.page.$('.ratio-btn.active')
    return activeBtn ? await activeBtn.getAttribute('data-ratio') : null
  }

  /**
   * 获取当前选中的分辨率
   */
  async getSelectedResolution(): Promise<string | null> {
    const activeBtn = await this.page.$('.resolution-btn.active')
    return activeBtn ? await activeBtn.getAttribute('data-resolution') : null
  }
}
