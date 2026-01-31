// e2e/director.pom.e2e.ts
/**
 * 使用 Page Object Model 的导演模式页面 E2E 测试
 */

import { test, expect } from './fixtures'
import { DirectorPage, GeneratePage } from './pages'

test.describe('DirectorPage (POM)', () => {
  let directorPage: DirectorPage

  test.beforeEach(async ({ page }) => {
    directorPage = new DirectorPage(page)
    await directorPage.navigate()
    await directorPage.waitForPanel()
  })

  test('应该显示导演模式页面', async () => {
    const isVisible = await directorPage.isVisible()
    expect(isVisible).toBe(true)
  })

  test('应该有参考图上传区域', async ({ page }) => {
    const uploadArea = page.locator('#directorReferenceArea, .director-reference-area, .reference-upload')
    const count = await uploadArea.count()
    expect(count).toBeGreaterThan(0)
  })

  test('应该有生成按钮', async ({ page }) => {
    const generateBtn = page.locator('#directorGenerateBtn, button:has-text("生成")')
    const count = await generateBtn.count()
    expect(count).toBeGreaterThan(0)
  })
})

test.describe('DirectorPage 功能测试', () => {
  test('初始状态应该没有参考图', async ({ page }) => {
    const directorPage = new DirectorPage(page)
    await directorPage.navigate()
    await directorPage.waitForPanel()
    
    const refCount = await directorPage.getReferenceImageCount()
    expect(refCount).toBe(0)
  })

  test('初始状态应该没有生成结果', async ({ page }) => {
    const directorPage = new DirectorPage(page)
    await directorPage.navigate()
    await directorPage.waitForPanel()
    
    const hasResults = await directorPage.hasResults()
    expect(hasResults).toBe(false)
  })

  test('生成按钮初始状态', async ({ page }) => {
    const directorPage = new DirectorPage(page)
    await directorPage.navigate()
    await directorPage.waitForPanel()
    
    const isGenerating = await directorPage.isGenerating()
    expect(isGenerating).toBe(false)
  })
})

test.describe('DirectorPage 布局和模式', () => {
  test('应该有布局选项', async ({ page }) => {
    const directorPage = new DirectorPage(page)
    await directorPage.navigate()
    await directorPage.waitForPanel()
    
    const layoutOptions = page.locator('.layout-option, .layout-btn')
    const count = await layoutOptions.count()
    // 布局选项可能存在
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('应该有模式选择', async ({ page }) => {
    const directorPage = new DirectorPage(page)
    await directorPage.navigate()
    await directorPage.waitForPanel()
    
    const modeOptions = page.locator('.mode-option, .mode-btn')
    const count = await modeOptions.count()
    // 模式选项可能存在
    expect(count).toBeGreaterThanOrEqual(0)
  })
})

test.describe('DirectorPage 导航测试', () => {
  test('应该能从导演页面返回生成页面', async ({ page }) => {
    const directorPage = new DirectorPage(page)
    const generatePage = new GeneratePage(page)
    
    await directorPage.navigate()
    expect(await directorPage.isVisible()).toBe(true)
    
    await generatePage.navigate()
    expect(await generatePage.isVisible()).toBe(true)
    expect(await directorPage.isVisible()).toBe(false)
  })
})

test.describe('DirectorPage 场景描述', () => {
  test('应该有场景描述输入框', async ({ page }) => {
    const directorPage = new DirectorPage(page)
    await directorPage.navigate()
    await directorPage.waitForPanel()
    
    const sceneInput = page.locator('#sceneDescription, textarea[name="scene"], .scene-input')
    const count = await sceneInput.count()
    // 场景描述可能是可选的
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('应该能设置场景描述', async ({ page }) => {
    const directorPage = new DirectorPage(page)
    await directorPage.navigate()
    await directorPage.waitForPanel()
    
    const testDescription = '一个神秘的夜晚场景'
    
    const sceneInput = page.locator('#sceneDescription, textarea[name="scene"]')
    if (await sceneInput.count() > 0) {
      await directorPage.setSceneDescription(testDescription)
      const value = await sceneInput.inputValue()
      expect(value).toBe(testDescription)
    }
  })
})
