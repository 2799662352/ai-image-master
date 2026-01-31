// e2e/pages/HistoryPage.ts
/**
 * 历史记录页面对象模型
 */

import { Page, Locator } from '@playwright/test'
import { BasePage } from './BasePage'

export class HistoryPage extends BasePage {
  // 定位器
  readonly historyList: Locator
  readonly emptyState: Locator
  readonly clearButton: Locator
  readonly historyItems: Locator

  constructor(page: Page) {
    super(page, 'history')

    this.historyList = page.locator('#historyList, .history-list')
    this.emptyState = page.locator('.history-empty, .empty-state')
    this.clearButton = page.locator('#clearHistoryBtn, .clear-history-btn')
    this.historyItems = page.locator('.history-item')
  }

  /**
   * 获取历史记录数量
   */
  async getHistoryCount(): Promise<number> {
    return await this.historyItems.count()
  }

  /**
   * 检查是否为空
   */
  async isEmpty(): Promise<boolean> {
    const count = await this.getHistoryCount()
    return count === 0
  }

  /**
   * 获取指定索引的历史记录
   */
  getHistoryItem(index: number): Locator {
    return this.historyItems.nth(index)
  }

  /**
   * 获取历史记录的提示词
   */
  async getHistoryPrompts(): Promise<string[]> {
    const items = await this.historyItems.all()
    const prompts: string[] = []
    
    for (const item of items) {
      const promptEl = await item.$('.history-prompt, .prompt-text')
      if (promptEl) {
        const text = await promptEl.textContent()
        if (text) prompts.push(text.trim())
      }
    }
    
    return prompts
  }

  /**
   * 点击清空按钮
   */
  async clickClear(): Promise<void> {
    await this.clearButton.click()
  }

  /**
   * 确认清空对话框
   */
  async confirmClear(): Promise<void> {
    await this.page.click('text=确认')
  }

  /**
   * 取消清空对话框
   */
  async cancelClear(): Promise<void> {
    await this.page.click('text=取消')
  }

  /**
   * 清空所有历史记录
   */
  async clearAll(): Promise<void> {
    if (await this.isEmpty()) return
    
    await this.clickClear()
    await this.confirmClear()
  }

  /**
   * 点击历史记录项
   */
  async clickHistoryItem(index: number): Promise<void> {
    await this.getHistoryItem(index).click()
  }

  /**
   * 查看历史记录图片
   */
  async viewImage(index: number): Promise<void> {
    const item = this.getHistoryItem(index)
    const viewBtn = item.locator('.view-btn, [data-action="view"]')
    await viewBtn.click()
  }

  /**
   * 删除历史记录项
   */
  async deleteHistoryItem(index: number): Promise<void> {
    const item = this.getHistoryItem(index)
    const deleteBtn = item.locator('.delete-btn, [data-action="delete"]')
    await deleteBtn.click()
  }

  /**
   * 下载历史记录图片
   */
  async downloadImage(index: number): Promise<void> {
    const item = this.getHistoryItem(index)
    const downloadBtn = item.locator('.download-btn, [data-action="download"]')
    await downloadBtn.click()
  }

  /**
   * 重新生成
   */
  async regenerate(index: number): Promise<void> {
    const item = this.getHistoryItem(index)
    const regenerateBtn = item.locator('.regenerate-btn, [data-action="regenerate"]')
    await regenerateBtn.click()
  }

  /**
   * 获取历史记录项的详细信息
   */
  async getHistoryItemInfo(index: number): Promise<{
    prompt?: string
    model?: string
    timestamp?: string
  }> {
    const item = this.getHistoryItem(index)
    
    const prompt = await item.locator('.history-prompt, .prompt-text').textContent()
    const model = await item.locator('.history-model, .model-name').textContent()
    const timestamp = await item.locator('.history-time, .timestamp').textContent()
    
    return {
      prompt: prompt?.trim(),
      model: model?.trim(),
      timestamp: timestamp?.trim()
    }
  }

  /**
   * 等待历史记录加载
   */
  async waitForLoad(): Promise<void> {
    await this.waitForPanel()
    // 等待历史记录列表或空状态显示
    await Promise.race([
      this.historyItems.first().waitFor({ timeout: 5000 }).catch(() => {}),
      this.emptyState.waitFor({ timeout: 5000 }).catch(() => {})
    ])
  }
}
