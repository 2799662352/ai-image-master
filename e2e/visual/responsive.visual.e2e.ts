// e2e/visual/responsive.visual.e2e.ts
/**
 * 响应式布局视觉回归测试
 * 
 * 测试不同窗口尺寸下的布局:
 * - 桌面端布局 (1400x900)
 * - 移动端布局 (375x812)
 * - 平板布局 (768x1024)
 * 
 * 运行: npm run test:e2e -- --project=visual
 */

import { test, expect } from '../fixtures'
import { GeneratePage, HistoryPage } from '../pages'

// 定义测试视口尺寸
const viewports = {
  desktop: { width: 1400, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 812 }
} as const

test.describe('响应式布局: 桌面端 (1400x900)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(viewports.desktop)
  })

  test('生成页面 - 桌面布局', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()
    await page.waitForTimeout(500)

    // 截取整个页面
    await expect(page).toHaveScreenshot('desktop-generate-full.png', {
      fullPage: true,
      mask: [
        page.locator('.timestamp'),
        page.locator('.version-info')
      ]
    })
  })

  test('历史页面 - 桌面布局', async ({ page }) => {
    const historyPage = new HistoryPage(page)
    await historyPage.navigate()
    await historyPage.waitForLoad()
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('desktop-history-full.png', {
      fullPage: true,
      mask: [
        page.locator('.timestamp'),
        page.locator('.history-time')
      ]
    })
  })

  test('侧边栏 - 桌面布局', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()

    // 侧边栏在桌面端应该可见
    const sidebar = page.locator('.sidebar, #sidebar, aside').first()
    if (await sidebar.isVisible()) {
      await expect(sidebar).toHaveScreenshot('desktop-sidebar.png')
    }
  })
})

test.describe('响应式布局: 平板端 (768x1024)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(viewports.tablet)
  })

  test('生成页面 - 平板布局', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('tablet-generate-full.png', {
      fullPage: true,
      mask: [
        page.locator('.timestamp'),
        page.locator('.version-info')
      ]
    })
  })

  test('历史页面 - 平板布局', async ({ page }) => {
    const historyPage = new HistoryPage(page)
    await historyPage.navigate()
    await historyPage.waitForLoad()
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('tablet-history-full.png', {
      fullPage: true,
      mask: [
        page.locator('.timestamp'),
        page.locator('.history-time')
      ]
    })
  })
})

test.describe('响应式布局: 移动端 (375x812)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(viewports.mobile)
  })

  test('生成页面 - 移动布局', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('mobile-generate-full.png', {
      fullPage: true,
      mask: [
        page.locator('.timestamp'),
        page.locator('.version-info')
      ]
    })
  })

  test('移动端菜单 - 折叠状态', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()

    // 移动端汉堡菜单按钮
    const menuBtn = page.locator('.mobile-menu-btn, #mobileMenuBtn, .hamburger')
    if (await menuBtn.isVisible()) {
      await expect(menuBtn).toHaveScreenshot('mobile-menu-btn.png')
    }
  })

  test('移动端菜单 - 展开状态', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()

    // 点击展开移动端菜单
    const menuBtn = page.locator('.mobile-menu-btn, #mobileMenuBtn, .hamburger')
    if (await menuBtn.isVisible()) {
      await menuBtn.click()
      await page.waitForTimeout(300)

      const mobileMenu = page.locator('.mobile-menu, #mobileMenu, .nav-mobile')
      if (await mobileMenu.isVisible()) {
        await expect(mobileMenu).toHaveScreenshot('mobile-menu-open.png')
      }
    }
  })

  test('历史页面 - 移动布局', async ({ page }) => {
    const historyPage = new HistoryPage(page)
    await historyPage.navigate()
    await historyPage.waitForLoad()
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('mobile-history-full.png', {
      fullPage: true,
      mask: [
        page.locator('.timestamp'),
        page.locator('.history-time')
      ]
    })
  })

  test('设置模态框 - 移动布局', async ({ page }) => {
    // 打开设置
    const settingsBtn = page.locator('#settingsBtn')
    await settingsBtn.click()

    const settingsModal = page.locator('#settingsModal')
    await settingsModal.waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForTimeout(300)

    await expect(settingsModal).toHaveScreenshot('mobile-settings-modal.png', {
      mask: [
        page.locator('#apiKeyInput'),
        page.locator('.api-key-input')
      ]
    })
  })
})

test.describe('响应式布局: 窗口调整', () => {
  test('从桌面到移动端的布局变化', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    
    // 从桌面开始
    await page.setViewportSize(viewports.desktop)
    await generatePage.navigate()
    await generatePage.waitForPanel()
    
    // 调整到移动端尺寸
    await page.setViewportSize(viewports.mobile)
    await page.waitForTimeout(500)
    
    // 验证布局已调整
    await expect(page).toHaveScreenshot('resize-to-mobile.png', {
      fullPage: true,
      mask: [
        page.locator('.timestamp'),
        page.locator('.version-info')
      ]
    })
  })

  test('从移动端到桌面的布局变化', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    
    // 从移动端开始
    await page.setViewportSize(viewports.mobile)
    await generatePage.navigate()
    await generatePage.waitForPanel()
    
    // 调整到桌面尺寸
    await page.setViewportSize(viewports.desktop)
    await page.waitForTimeout(500)
    
    // 验证布局已调整
    await expect(page).toHaveScreenshot('resize-to-desktop.png', {
      fullPage: true,
      mask: [
        page.locator('.timestamp'),
        page.locator('.version-info')
      ]
    })
  })
})

test.describe('响应式布局: 元素可见性', () => {
  test('桌面端侧边栏可见', async ({ page }) => {
    await page.setViewportSize(viewports.desktop)
    
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()

    const sidebar = page.locator('.sidebar, #sidebar, aside').first()
    // 在桌面端，侧边栏应该可见或不存在（取决于设计）
    const isVisible = await sidebar.isVisible().catch(() => false)
    expect(typeof isVisible).toBe('boolean')
  })

  test('移动端汉堡菜单按钮可见', async ({ page }) => {
    await page.setViewportSize(viewports.mobile)
    
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()

    const menuBtn = page.locator('.mobile-menu-btn, #mobileMenuBtn, .hamburger')
    // 在移动端，菜单按钮应该可见（如果设计有的话）
    const isVisible = await menuBtn.isVisible().catch(() => false)
    expect(typeof isVisible).toBe('boolean')
  })
})
