// e2e/settings.pom.e2e.ts
/**
 * 使用 Page Object Model 的设置页面 E2E 测试
 */

import { test, expect } from './fixtures'
import { SettingsPage, GeneratePage } from './pages'

test.describe('SettingsPage (POM)', () => {
  let settingsPage: SettingsPage

  test.beforeEach(async ({ page }) => {
    settingsPage = new SettingsPage(page)
    await settingsPage.navigate()
    await settingsPage.waitForPanel()
  })

  test('应该显示设置页面', async () => {
    const isVisible = await settingsPage.isVisible()
    expect(isVisible).toBe(true)
  })

  test('应该有 API Key 输入框', async ({ page }) => {
    const apiInput = page.locator('#apiKeyInput, input[name="apiKey"], input[type="password"]')
    const count = await apiInput.count()
    expect(count).toBeGreaterThan(0)
  })
})

test.describe('SettingsPage 配置测试', () => {
  test('应该能输入 API Key', async ({ page }) => {
    const settingsPage = new SettingsPage(page)
    await settingsPage.navigate()
    
    const testKey = 'test-api-key-12345'
    await settingsPage.setApiKey(testKey)
    
    const value = await settingsPage.getApiKey()
    expect(value).toBe(testKey)
  })

  test('保存按钮应该可见', async ({ page }) => {
    const settingsPage = new SettingsPage(page)
    await settingsPage.navigate()
    
    const saveBtn = page.locator('#saveSettingsBtn, .save-settings-btn, button:has-text("保存")')
    const count = await saveBtn.count()
    expect(count).toBeGreaterThan(0)
  })
})

test.describe('SettingsPage 导航测试', () => {
  test('应该能从设置页面返回生成页面', async ({ page }) => {
    const settingsPage = new SettingsPage(page)
    const generatePage = new GeneratePage(page)
    
    await settingsPage.navigate()
    expect(await settingsPage.isVisible()).toBe(true)
    
    await generatePage.navigate()
    expect(await generatePage.isVisible()).toBe(true)
    expect(await settingsPage.isVisible()).toBe(false)
  })
})
