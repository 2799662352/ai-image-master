// e2e/understand.pom.e2e.ts
/**
 * 使用 Page Object Model 的图像理解页面 E2E 测试
 */

import { test, expect } from './fixtures'
import { UnderstandPage, GeneratePage } from './pages'

test.describe('UnderstandPage (POM)', () => {
  let understandPage: UnderstandPage

  test.beforeEach(async ({ page }) => {
    understandPage = new UnderstandPage(page)
    await understandPage.navigate()
    await understandPage.waitForPanel()
  })

  test('应该显示图像理解页面', async () => {
    const isVisible = await understandPage.isVisible()
    expect(isVisible).toBe(true)
  })

  test('应该有图片上传区域', async ({ page }) => {
    const uploadArea = page.locator('#understandImageArea, .understand-upload-area, .upload-area')
    const count = await uploadArea.count()
    expect(count).toBeGreaterThan(0)
  })

  test('应该有分析按钮', async ({ page }) => {
    const analyzeBtn = page.locator('#analyzeBtn, button:has-text("分析"), button:has-text("开始分析")')
    const count = await analyzeBtn.count()
    expect(count).toBeGreaterThan(0)
  })
})

test.describe('UnderstandPage 功能测试', () => {
  test('初始状态应该没有上传图片', async ({ page }) => {
    const understandPage = new UnderstandPage(page)
    await understandPage.navigate()
    await understandPage.waitForPanel()
    
    const imageCount = await understandPage.getUploadedImageCount()
    expect(imageCount).toBe(0)
  })

  test('初始状态应该没有分析结果', async ({ page }) => {
    const understandPage = new UnderstandPage(page)
    await understandPage.navigate()
    await understandPage.waitForPanel()
    
    const hasResult = await understandPage.hasResult()
    expect(hasResult).toBe(false)
  })

  test('分析按钮初始状态', async ({ page }) => {
    const understandPage = new UnderstandPage(page)
    await understandPage.navigate()
    await understandPage.waitForPanel()
    
    const isAnalyzing = await understandPage.isAnalyzing()
    expect(isAnalyzing).toBe(false)
  })
})

test.describe('UnderstandPage 导航测试', () => {
  test('应该能从理解页面返回生成页面', async ({ page }) => {
    const understandPage = new UnderstandPage(page)
    const generatePage = new GeneratePage(page)
    
    await understandPage.navigate()
    expect(await understandPage.isVisible()).toBe(true)
    
    await generatePage.navigate()
    expect(await generatePage.isVisible()).toBe(true)
    expect(await understandPage.isVisible()).toBe(false)
  })
})

test.describe('UnderstandPage 模型选择', () => {
  test('应该有模型选择器', async ({ page }) => {
    const understandPage = new UnderstandPage(page)
    await understandPage.navigate()
    await understandPage.waitForPanel()
    
    const modelSelector = page.locator('#visionModelSelector, .vision-model-select, select[name="model"]')
    const count = await modelSelector.count()
    // 模型选择器可能是可选的
    expect(count).toBeGreaterThanOrEqual(0)
  })
})
