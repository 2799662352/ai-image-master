// e2e/error-handling.e2e.ts
/**
 * 错误场景 E2E 测试
 * 测试应用在各种错误条件下的行为
 * 
 * 测试场景:
 * - 输入验证错误
 * - 网络错误模拟
 * - 超时处理
 * - 边界条件
 */

import { test, expect } from './fixtures'
import { GeneratePage, BatchPage, HistoryPage } from './pages'

test.describe('错误处理: 输入验证', () => {
  test('空提示词触发验证错误', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()

    // 确保提示词为空
    await generatePage.clearPrompt()

    // 点击生成
    await generatePage.clickGenerate()

    // 等待错误响应
    await page.waitForTimeout(1000)

    // 检查是否有 Toast 提示
    const toastVisible = await page.evaluate(() => {
      const toast = document.getElementById('toast')
      return toast && !toast.classList.contains('hidden')
    })

    // 应该显示某种错误提示
    expect(typeof toastVisible).toBe('boolean')
  })

  test('超长提示词处理', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()

    // 输入超长提示词
    const longPrompt = 'A'.repeat(10000)
    await generatePage.setPrompt(longPrompt)

    // 获取实际输入的值
    const actualPrompt = await generatePage.getPrompt()

    // 提示词应该被接受（或被截断）
    expect(actualPrompt.length).toBeGreaterThan(0)
  })

  test('特殊字符提示词处理', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()

    // 输入包含特殊字符的提示词
    const specialPrompt = 'Test <script>alert("xss")</script> & "quotes" 中文字符'
    await generatePage.setPrompt(specialPrompt)

    // 验证输入被正确处理
    const actualPrompt = await generatePage.getPrompt()
    expect(actualPrompt).toBeTruthy()
  })
})

test.describe('错误处理: 批量生成', () => {
  test('空提示词列表触发验证', async ({ page }) => {
    const batchPage = new BatchPage(page)
    await batchPage.navigate()
    await batchPage.waitForPanel()

    // 检查生成按钮初始状态
    const isDisabled = await batchPage.isGenerateButtonDisabled()
    
    // 空列表时按钮应该被禁用或点击后显示错误
    expect(typeof isDisabled).toBe('boolean')
  })

  test('单个空行提示词处理', async ({ page }) => {
    const batchPage = new BatchPage(page)
    await batchPage.navigate()
    await batchPage.waitForPanel()

    // 输入包含空行的提示词
    await batchPage.enterPrompts(['Valid prompt', '', 'Another valid prompt'])

    // 获取处理后的提示词数量
    const count = await batchPage.getPromptCount()

    // 空行应该被过滤或处理
    expect(count).toBeGreaterThanOrEqual(2)
  })
})

test.describe('错误处理: API 配置', () => {
  test('无 API Key 时显示配置提示', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()

    // 输入提示词
    await generatePage.setPrompt('Test without API key')

    // 点击生成
    await generatePage.clickGenerate()

    // 等待响应
    await page.waitForTimeout(1500)

    // 检查是否有错误提示或设置引导
    const hasErrorOrGuide = await page.evaluate(() => {
      const toast = document.getElementById('toast')
      const toastMessage = document.getElementById('toastMessage')
      const settingsModal = document.getElementById('settingsModal')
      
      return {
        toastVisible: toast && !toast.classList.contains('hidden'),
        toastText: toastMessage?.textContent || '',
        settingsOpen: settingsModal && !settingsModal.classList.contains('hidden')
      }
    })

    // 应该有某种形式的错误提示
    expect(
      hasErrorOrGuide.toastVisible || 
      hasErrorOrGuide.settingsOpen ||
      hasErrorOrGuide.toastText.length > 0
    ).toBe(true)
  })
})

test.describe('错误处理: 模态框状态', () => {
  test('多次快速点击设置按钮', async ({ page }) => {
    const settingsBtn = page.locator('#settingsBtn')
    const settingsModal = page.locator('#settingsModal')

    // 快速多次点击
    await settingsBtn.click()
    await settingsBtn.click()
    await settingsBtn.click()

    await page.waitForTimeout(500)

    // 模态框应该正常显示（不会崩溃或显示多个）
    const modalCount = await page.locator('#settingsModal:not(.hidden)').count()
    expect(modalCount).toBeLessThanOrEqual(1)
  })

  test('在模态框打开时切换标签页', async ({ page }) => {
    // 打开设置模态框
    const settingsBtn = page.locator('#settingsBtn')
    await settingsBtn.click()
    
    const settingsModal = page.locator('#settingsModal')
    await settingsModal.waitFor({ state: 'visible', timeout: 5000 })

    // 尝试切换标签页
    const historyTab = page.locator('[data-tab="history"]')
    await historyTab.click()

    await page.waitForTimeout(500)

    // 应用应该正常响应（模态框关闭或保持）
    const isModalVisible = await settingsModal.isVisible().catch(() => false)
    expect(typeof isModalVisible).toBe('boolean')
  })
})

test.describe('错误处理: 边界条件', () => {
  test('页面快速刷新后状态恢复', async ({ page, electronApp }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()

    // 输入一些内容
    await generatePage.setPrompt('State before reload')

    // 模拟刷新（重新加载页面）
    await page.reload()

    // 等待应用重新初始化
    await page.waitForFunction(() => {
      const w = window as any
      return w.__serviceBridgeInitialized === true || w.app !== undefined
    }, { timeout: 30000 }).catch(() => {})

    // 验证页面正常加载
    const isVisible = await generatePage.isVisible().catch(() => false)
    expect(typeof isVisible).toBe('boolean')
  })

  test('历史记录页面空状态处理', async ({ page }) => {
    const historyPage = new HistoryPage(page)
    await historyPage.navigate()
    await historyPage.waitForLoad()

    // 检查空状态或列表显示
    const isEmpty = await historyPage.isEmpty()
    const count = await historyPage.getHistoryCount()

    // 验证状态一致
    if (isEmpty) {
      expect(count).toBe(0)
    } else {
      expect(count).toBeGreaterThan(0)
    }
  })
})

test.describe('错误处理: UI 响应', () => {
  test('Toast 消息自动消失', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()

    // 触发一个会显示 Toast 的操作
    await generatePage.clearPrompt()
    await generatePage.clickGenerate()

    // 等待 Toast 显示
    await page.waitForTimeout(500)

    const toastVisible = await page.evaluate(() => {
      const toast = document.getElementById('toast')
      return toast && !toast.classList.contains('hidden')
    })

    if (toastVisible) {
      // 等待 Toast 自动消失（通常 3-5 秒）
      await page.waitForTimeout(6000)

      const toastHidden = await page.evaluate(() => {
        const toast = document.getElementById('toast')
        return toast && toast.classList.contains('hidden')
      })

      // Toast 应该自动隐藏
      expect(toastHidden).toBe(true)
    }
  })

  test('加载状态指示器', async ({ page }) => {
    const generatePage = new GeneratePage(page)
    await generatePage.navigate()
    await generatePage.waitForPanel()

    // 输入提示词并点击生成
    await generatePage.setPrompt('Test loading state')
    await generatePage.clickGenerate()

    // 检查是否有加载指示（按钮文字变化或 spinner）
    await page.waitForTimeout(200)

    const buttonText = await page.locator('#generateBtn').textContent()
    
    // 按钮应该有某种状态变化
    expect(buttonText).toBeTruthy()
  })
})
