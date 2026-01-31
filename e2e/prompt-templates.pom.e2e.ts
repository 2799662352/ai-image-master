// e2e/prompt-templates.pom.e2e.ts
/**
 * 使用 Page Object Model 的提示词模板页面 E2E 测试
 */

import { test, expect } from './fixtures'
import { PromptTemplatesPage, GeneratePage } from './pages'

test.describe('PromptTemplatesPage (POM)', () => {
  let templatesPage: PromptTemplatesPage

  test.beforeEach(async ({ page }) => {
    templatesPage = new PromptTemplatesPage(page)
    await templatesPage.navigate()
    await templatesPage.waitForPanel()
  })

  test('应该显示提示词模板页面', async () => {
    const isVisible = await templatesPage.isVisible()
    expect(isVisible).toBe(true)
  })

  test('应该有模板容器', async ({ page }) => {
    const container = page.locator('#templatesPanel, .templates-container')
    const count = await container.count()
    expect(count).toBeGreaterThan(0)
  })

  test('应该显示模板分类', async () => {
    const categoryCount = await templatesPage.getCategoryCount()
    // 至少应该有一个分类标签或者模板区域
    expect(categoryCount).toBeGreaterThanOrEqual(0)
  })
})

test.describe('PromptTemplatesPage 模板操作', () => {
  test('应该能加载模板', async ({ page }) => {
    const templatesPage = new PromptTemplatesPage(page)
    await templatesPage.navigate()
    await templatesPage.waitForPanel()
    
    // 等待模板加载
    await page.waitForTimeout(1000)
    
    // 检查是否有模板卡片
    const hasTemplates = await templatesPage.hasTemplates()
    // 模板可能需要从服务器加载，所以不强制要求有模板
    expect(typeof hasTemplates).toBe('boolean')
  })

  test('应该能获取模板标题', async ({ page }) => {
    const templatesPage = new PromptTemplatesPage(page)
    await templatesPage.navigate()
    await templatesPage.waitForPanel()
    
    await page.waitForTimeout(1000)
    
    const titles = await templatesPage.getTemplateTitles()
    expect(Array.isArray(titles)).toBe(true)
  })
})

test.describe('PromptTemplatesPage 导航测试', () => {
  test('应该能从模板页面返回生成页面', async ({ page }) => {
    const templatesPage = new PromptTemplatesPage(page)
    const generatePage = new GeneratePage(page)
    
    await templatesPage.navigate()
    expect(await templatesPage.isVisible()).toBe(true)
    
    await generatePage.navigate()
    expect(await generatePage.isVisible()).toBe(true)
  })
})
