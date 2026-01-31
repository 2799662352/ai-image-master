// e2e/pages/DirectorPage.ts
/**
 * 导演/分镜页面对象模型
 */

import { Page, Locator } from '@playwright/test'
import { BasePage } from './BasePage'

export class DirectorPage extends BasePage {
  // 定位器
  readonly referenceImageArea: Locator
  readonly uploadedReferences: Locator
  readonly layoutSelector: Locator
  readonly modeSelector: Locator
  readonly templateSelector: Locator
  readonly galleryButton: Locator
  readonly sceneDescription: Locator
  readonly multiScenePrompts: Locator
  readonly generateButton: Locator
  readonly resultsContainer: Locator
  readonly downloadAllButton: Locator

  constructor(page: Page) {
    super(page, 'director')

    this.referenceImageArea = page.locator('#directorReferenceArea, .director-reference-area')
    this.uploadedReferences = page.locator('.director-reference-image, .reference-preview')
    this.layoutSelector = page.locator('#layoutSelector, .layout-select')
    this.modeSelector = page.locator('#modeSelector, .mode-select, .mode-btn')
    this.templateSelector = page.locator('#templateSelector, .template-select')
    this.galleryButton = page.locator('#galleryBtn, button:has-text("画廊")')
    this.sceneDescription = page.locator('#sceneDescription, textarea[name="scene"]')
    this.multiScenePrompts = page.locator('#multiScenePrompts, textarea[name="multiScene"]')
    this.generateButton = page.locator('#directorGenerateBtn, button:has-text("生成")')
    this.resultsContainer = page.locator('#directorResults, .director-results')
    this.downloadAllButton = page.locator('#downloadAllBtn, button:has-text("下载全部")')
  }

  /**
   * 获取已上传参考图数量
   */
  async getReferenceImageCount(): Promise<number> {
    return await this.uploadedReferences.count()
  }

  /**
   * 选择布局
   */
  async selectLayout(layout: string): Promise<void> {
    await this.page.click(`.layout-option[data-layout="${layout}"], .layout-btn[data-layout="${layout}"]`)
  }

  /**
   * 选择模式（单场景/多场景）
   */
  async selectMode(mode: 'single' | 'multi'): Promise<void> {
    await this.page.click(`.mode-btn[data-mode="${mode}"], .mode-option[data-mode="${mode}"]`)
  }

  /**
   * 选择风格模板
   */
  async selectTemplate(templateName: string): Promise<void> {
    await this.templateSelector.click()
    await this.page.click(`.template-option:has-text("${templateName}")`)
  }

  /**
   * 打开画廊
   */
  async openGallery(): Promise<void> {
    await this.galleryButton.click()
  }

  /**
   * 设置场景描述
   */
  async setSceneDescription(description: string): Promise<void> {
    await this.sceneDescription.fill(description)
  }

  /**
   * 设置多场景提示词
   */
  async setMultiScenePrompts(prompts: string): Promise<void> {
    await this.multiScenePrompts.fill(prompts)
  }

  /**
   * 点击生成按钮
   */
  async clickGenerate(): Promise<void> {
    await this.generateButton.click()
  }

  /**
   * 等待生成完成
   */
  async waitForGeneration(timeout = 180000): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const btn = document.querySelector('#directorGenerateBtn, button:has-text("生成")')
        return btn && !btn.textContent?.includes('生成中')
      },
      { timeout }
    )
  }

  /**
   * 获取生成结果数量
   */
  async getResultCount(): Promise<number> {
    const results = await this.resultsContainer.locator('img, .result-image').count()
    return results
  }

  /**
   * 检查是否有生成结果
   */
  async hasResults(): Promise<boolean> {
    return await this.getResultCount() > 0
  }

  /**
   * 下载全部结果
   */
  async downloadAll(): Promise<void> {
    if (await this.downloadAllButton.count() > 0) {
      await this.downloadAllButton.click()
    }
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
   * 删除参考图
   */
  async removeReferenceImage(index: number): Promise<void> {
    const images = await this.uploadedReferences.all()
    if (images[index]) {
      const removeBtn = images[index].locator('.remove-btn, .delete-btn')
      if (await removeBtn.count() > 0) {
        await removeBtn.click()
      }
    }
  }

  /**
   * 获取当前布局
   */
  async getCurrentLayout(): Promise<string | null> {
    const activeLayout = await this.page.$('.layout-btn.active, .layout-option.selected')
    return activeLayout ? await activeLayout.getAttribute('data-layout') : null
  }

  /**
   * 获取当前模式
   */
  async getCurrentMode(): Promise<string | null> {
    const activeMode = await this.page.$('.mode-btn.active, .mode-option.selected')
    return activeMode ? await activeMode.getAttribute('data-mode') : null
  }
}
