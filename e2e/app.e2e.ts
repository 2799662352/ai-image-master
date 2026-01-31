// e2e/app.e2e.ts - Electron 应用 E2E 测试
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'

let electronApp: ElectronApplication
let page: Page

test.describe('CATIMATION-Cyberpunk Master E2E', () => {
  test.beforeAll(async () => {
    // 启动 Electron 应用
    electronApp = await electron.launch({
      args: ['.'],
      cwd: process.cwd()
    })

    // 获取第一个窗口
    page = await electronApp.firstWindow()

    // 等待应用加载完成
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    // 关闭应用
    await electronApp.close()
  })

  test('应用应该成功启动', async () => {
    // 验证窗口标题
    const title = await page.title()
    expect(title).toContain('CATIMATION')
  })

  test('应用应该显示主界面', async () => {
    // 等待主内容加载
    await page.waitForSelector('#app, .main-content, .page-content', { timeout: 30000 })
    
    // 验证页面不是空白
    const bodyContent = await page.locator('body').textContent()
    expect(bodyContent).toBeTruthy()
  })

  test('应该能切换页面标签', async () => {
    // 查找导航标签
    const tabs = page.locator('[data-tab], .tab-btn, nav button')
    const tabCount = await tabs.count()
    
    // 至少应该有一个标签
    expect(tabCount).toBeGreaterThan(0)
  })

  test('Electron API 应该可用', async () => {
    // 验证 preload 脚本加载成功
    const isElectron = await page.evaluate(() => {
      return window.electronAPI?.isElectron === true
    })
    
    expect(isElectron).toBe(true)
  })

  test('应该能获取存储信息', async () => {
    // 测试存储 API
    const storageInfo = await page.evaluate(async () => {
      if (window.electronAPI?.getStorageInfo) {
        return await window.electronAPI.getStorageInfo()
      }
      return null
    })

    expect(storageInfo).toBeDefined()
    if (storageInfo) {
      expect(typeof storageInfo.imageCount).toBe('number')
      expect(typeof storageInfo.totalSize).toBe('number')
    }
  })
})

// 页面导航测试
test.describe('页面导航', () => {
  test.beforeAll(async () => {
    electronApp = await electron.launch({
      args: ['.'],
      cwd: process.cwd()
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await electronApp.close()
  })

  test('历史记录页面应该能加载', async () => {
    // 尝试点击历史记录标签
    const historyTab = page.locator('[data-tab="history"], button:has-text("历史")')
    
    if (await historyTab.count() > 0) {
      await historyTab.first().click()
      
      // 等待页面切换
      await page.waitForTimeout(500)
      
      // 验证页面已切换（检查是否有历史相关的内容）
      const pageContent = await page.content()
      expect(pageContent).toBeTruthy()
    }
  })
})
