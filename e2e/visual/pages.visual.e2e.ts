// e2e/visual/pages.visual.e2e.ts
/**
 * 关键页面视觉回归测试
 * 
 * 使用截图比对检测 UI 变化:
 * - 生成页面各状态
 * - 历史页面
 * - 设置模态框
 * - 批量页面
 * 
 * 运行: npm run test:e2e -- --project=visual
 */

import { test, expect } from '../fixtures'
import { GeneratePage, HistoryPage, BatchPage } from '../pages'

test.describe('Visual: 生成页面', () => {
  test('生成页面 - 默认状态', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()
    
    // 等待所有动画完成
    await page.waitForTimeout(500)
    
    // 截取生成面板
    const panel = page.locator('#generatePanel')
    await expect(panel).toHaveScreenshot('generate-default.png', {
      mask: [
        // 遮盖动态内容
        page.locator('.timestamp'),
        page.locator('.version-info')
      ]
    })
  })

  test('生成页面 - 输入提示词后', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()
    
    // 输入提示词
    await generatePage.setPrompt('A beautiful cyberpunk cityscape at night')
    await page.waitForTimeout(300)
    
    // 截取提示词输入区域
    const promptArea = page.locator('.prompt-container, #promptInput').first()
    await expect(promptArea).toHaveScreenshot('generate-with-prompt.png')
  })

  test('生成页面 - 模型选择器', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()
    
    // 点击模型选择器展开
    const modelSelector = page.locator('#modelSelector')
    if (await modelSelector.isVisible()) {
      await modelSelector.click()
      await page.waitForTimeout(300)
      
      // 截取展开的选择器
      const dropdown = page.locator('.choices__list--dropdown, .model-dropdown').first()
      if (await dropdown.isVisible()) {
        await expect(dropdown).toHaveScreenshot('model-selector-open.png')
      }
    }
  })

  test('生成页面 - 比例选择器', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()
    
    // 截取比例选择区域
    const ratioSection = page.locator('.ratio-selector, .ratio-options').first()
    if (await ratioSection.isVisible()) {
      await expect(ratioSection).toHaveScreenshot('ratio-selector.png')
    }
  })
})

test.describe('Visual: 历史页面', () => {
  test('历史页面 - 空状态', async ({ page }) => {
    const historyPage = new HistoryPage(page)
    await historyPage.navigate()
    await historyPage.waitForLoad()
    
    // 如果是空状态，截取空状态 UI
    const isEmpty = await historyPage.isEmpty()
    if (isEmpty) {
      const emptyState = page.locator('.history-empty, .empty-state').first()
      if (await emptyState.isVisible()) {
        await expect(emptyState).toHaveScreenshot('history-empty.png')
      }
    }
  })

  test('历史页面 - 列表视图', async ({ page }) => {
    const historyPage = new HistoryPage(page)
    await historyPage.navigate()
    await historyPage.waitForLoad()
    
    // 截取历史列表区域
    const historyPanel = page.locator('#historyPanel')
    await expect(historyPanel).toHaveScreenshot('history-list.png', {
      mask: [
        // 遮盖时间戳等动态内容
        page.locator('.timestamp'),
        page.locator('.history-time'),
        page.locator('.relative-time')
      ]
    })
  })
})

test.describe('Visual: 批量页面', () => {
  test('批量页面 - 默认状态', async ({ page }) => {
    const batchPage = new BatchPage(page)
    await batchPage.navigate()
    await batchPage.waitForPanel()
    
    await page.waitForTimeout(300)
    
    // 截取批量面板
    const batchPanel = page.locator('#batchPanel')
    await expect(batchPanel).toHaveScreenshot('batch-default.png')
  })

  test('批量页面 - 输入多个提示词', async ({ page }) => {
    const batchPage = new BatchPage(page)
    await batchPage.navigate()
    await batchPage.waitForPanel()
    
    // 输入多个提示词
    await batchPage.enterPrompts([
      'A sunset over the ocean',
      'A mountain landscape in autumn',
      'A futuristic city skyline'
    ])
    await page.waitForTimeout(300)
    
    // 截取提示词输入区
    const promptsArea = page.locator('#batchPrompts')
    await expect(promptsArea).toHaveScreenshot('batch-with-prompts.png')
  })
})

test.describe('Visual: 设置模态框', () => {
  test('设置模态框 - 默认状态', async ({ page }) => {
    // 打开设置
    const settingsBtn = page.locator('#settingsBtn')
    await settingsBtn.click()
    
    const settingsModal = page.locator('#settingsModal')
    await settingsModal.waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForTimeout(300)
    
    // 截取设置模态框
    await expect(settingsModal).toHaveScreenshot('settings-modal.png', {
      mask: [
        // 遮盖 API Key（敏感信息）
        page.locator('#apiKeyInput'),
        page.locator('.api-key-input')
      ]
    })
  })
})

test.describe('Visual: 关于模态框', () => {
  test('关于模态框 - 内容显示', async ({ page }) => {
    // 打开关于模态框
    const aboutBtn = page.locator('#aboutBtn, [data-action="about"]')
    if (await aboutBtn.isVisible()) {
      await aboutBtn.click()
      
      const aboutModal = page.locator('#aboutModal')
      await aboutModal.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
      
      if (await aboutModal.isVisible()) {
        await page.waitForTimeout(300)
        await expect(aboutModal).toHaveScreenshot('about-modal.png', {
          mask: [
            page.locator('.version-number'),
            page.locator('.build-date')
          ]
        })
      }
    }
  })
})

test.describe('Visual: 错误状态', () => {
  test('Toast 错误提示样式', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()
    
    // 触发错误（空提示词生成）
    await generatePage.clearPrompt()
    await generatePage.clickGenerate()
    
    // 等待 Toast 显示
    await page.waitForTimeout(1000)
    
    const toast = page.locator('#toast:not(.hidden)')
    if (await toast.isVisible()) {
      await expect(toast).toHaveScreenshot('toast-error.png')
    }
  })
})

test.describe('Visual: 导航标签栏', () => {
  test('标签栏 - 默认状态', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()
    
    // 截取标签栏
    const tabBar = page.locator('.tabs, .tab-bar, nav').first()
    if (await tabBar.isVisible()) {
      await expect(tabBar).toHaveScreenshot('tab-bar.png')
    }
  })

  test('标签栏 - 激活状态', async ({ page }) => {
    const historyPage = new HistoryPage(page)
    await historyPage.navigate()
    await historyPage.waitForPanel()
    
    // 截取激活的历史标签
    const activeTab = page.locator('.tab.active, [data-tab="history"].active')
    if (await activeTab.isVisible()) {
      await expect(activeTab).toHaveScreenshot('tab-active.png')
    }
  })
})
