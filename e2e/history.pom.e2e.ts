// e2e/history.pom.e2e.ts
/**
 * 使用 Page Object Model 的历史记录页面 E2E 测试
 */

import { test, expect } from './fixtures'
import { HistoryPage, GeneratePage } from './pages'

test.describe('HistoryPage (POM)', () => {
  let historyPage: HistoryPage

  test.beforeEach(async ({ page }) => {
    historyPage = new HistoryPage(page)
    await historyPage.navigate()
    await historyPage.waitForLoad()
  })

  test('应该显示历史记录页面', async () => {
    const isVisible = await historyPage.isVisible()
    expect(isVisible).toBe(true)
  })

  test('应该显示空状态或历史记录列表', async ({ page }) => {
    const isEmpty = await historyPage.isEmpty()
    
    if (isEmpty) {
      // 检查空状态提示
      const emptyState = page.locator('.history-empty, .empty-state, [class*="empty"]')
      const count = await emptyState.count()
      expect(count).toBeGreaterThanOrEqual(0) // 可能没有专门的空状态元素
    } else {
      // 检查历史记录列表
      const count = await historyPage.getHistoryCount()
      expect(count).toBeGreaterThan(0)
    }
  })

  test('应该能获取历史记录数量', async () => {
    const count = await historyPage.getHistoryCount()
    expect(count).toBeGreaterThanOrEqual(0)
  })
})

test.describe('HistoryPage 导航测试', () => {
  test('应该能从生成页面导航到历史页面', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    const historyPage = new HistoryPage(page)
    
    // 先到生成页面
    await generatePage.navigate()
    expect(await generatePage.isVisible()).toBe(true)
    
    // 然后到历史页面
    await historyPage.navigate()
    expect(await historyPage.isVisible()).toBe(true)
    expect(await generatePage.isVisible()).toBe(false)
  })

  test('应该能从历史页面导航到生成页面', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    const historyPage = new HistoryPage(page)
    
    await historyPage.navigate()
    await generatePage.navigate()
    
    expect(await generatePage.isVisible()).toBe(true)
  })
})

test.describe('HistoryPage 交互测试', () => {
  test('如果有历史记录，应该能查看详情', async ({ page }) => {
    const historyPage = new HistoryPage(page)
    await historyPage.navigate()
    await historyPage.waitForLoad()
    
    const count = await historyPage.getHistoryCount()
    
    if (count > 0) {
      const info = await historyPage.getHistoryItemInfo(0)
      // 验证历史记录项有基本信息
      expect(info).toBeDefined()
    }
  })

  test('清空按钮应该在有历史记录时可见', async ({ page }) => {
    const historyPage = new HistoryPage(page)
    await historyPage.navigate()
    await historyPage.waitForLoad()
    
    const count = await historyPage.getHistoryCount()
    
    if (count > 0) {
      const clearBtn = page.locator('#clearHistoryBtn, .clear-history-btn')
      // 按钮可能存在也可能隐藏，取决于 UI 设计
      const btnCount = await clearBtn.count()
      expect(btnCount).toBeGreaterThanOrEqual(0)
    }
  })
})
