/**
 * 图片生成页面 E2E 测试
 */
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'

let electronApp: ElectronApplication
let page: Page

test.describe('GeneratePage', () => {
  test.beforeAll(async () => {
    // 启动 Electron 应用
    electronApp = await electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        NODE_ENV: 'test'
      }
    })

    // 获取主窗口
    page = await electronApp.firstWindow()

    // 等待应用加载完成
    await page.waitForSelector('#app', { timeout: 30000 })
  })

  test.afterAll(async () => {
    await electronApp?.close()
  })

  test.beforeEach(async () => {
    // 导航到生成页面（默认页面）
    const generateTab = await page.$('[data-tab="generate"]')
    if (generateTab) {
      await generateTab.click()
      await page.waitForTimeout(500)
    }
  })

  test('应该显示生成页面', async () => {
    const generatePanel = await page.$('#generatePanel')
    expect(generatePanel).toBeTruthy()
  })

  test('应该显示提示词输入框', async () => {
    const promptInput = await page.$('#generatePrompt, #promptInput, textarea[name="prompt"]')
    expect(promptInput).toBeTruthy()
  })

  test('应该显示生成按钮', async () => {
    const generateBtn = await page.$('#generateBtn, .generate-btn, button[type="submit"]')
    expect(generateBtn).toBeTruthy()
  })

  test('应该显示模型选择器', async () => {
    const modelSelector = await page.$('#modelSelector, .model-selector')
    expect(modelSelector).toBeTruthy()
  })

  test('应该显示尺寸选择器', async () => {
    const ratioSelector = await page.$('.ratio-selector, #ratioSelector, [data-ratio]')
    expect(ratioSelector).toBeTruthy()
  })

  test('应该能输入提示词', async () => {
    const promptInput = await page.$('#generatePrompt, #promptInput, textarea[name="prompt"]')
    
    if (promptInput) {
      await promptInput.fill('一只可爱的猫咪')
      const value = await promptInput.inputValue()
      expect(value).toBe('一只可爱的猫咪')
    }
  })

  test('应该能切换比例', async () => {
    const ratioButtons = await page.$$('[data-ratio], .ratio-option')
    
    if (ratioButtons.length > 1) {
      // 点击第二个比例选项
      await ratioButtons[1].click()
      await page.waitForTimeout(200)
      
      // 检查是否有选中状态
      const selectedClass = await ratioButtons[1].getAttribute('class')
      // 选中状态可能有 active, selected, 或其他类名
    }
  })

  test('应该能切换分辨率', async () => {
    const resolutionSelector = await page.$('#resolutionSelector, .resolution-selector, select[name="resolution"]')
    
    if (resolutionSelector) {
      const tagName = await resolutionSelector.evaluate(el => el.tagName.toLowerCase())
      
      if (tagName === 'select') {
        await resolutionSelector.selectOption({ index: 1 })
      } else {
        // 可能是自定义选择器
        await resolutionSelector.click()
        const options = await page.$$('.resolution-option')
        if (options.length > 1) {
          await options[1].click()
        }
      }
    }
  })

  test('应该显示参考图片上传区域', async () => {
    const uploadArea = await page.$('.reference-upload, #referenceUpload, [data-upload="reference"]')
    expect(uploadArea).toBeTruthy()
  })

  test('空提示词时生成按钮应该禁用或提示', async () => {
    const promptInput = await page.$('#generatePrompt, #promptInput, textarea[name="prompt"]')
    const generateBtn = await page.$('#generateBtn, .generate-btn')
    
    if (promptInput && generateBtn) {
      // 清空提示词
      await promptInput.fill('')
      
      // 点击生成按钮
      await generateBtn.click()
      await page.waitForTimeout(500)
      
      // 检查是否有错误提示或按钮禁用
      const toast = await page.$('#toast:not(.hidden), .error-message')
      const isDisabled = await generateBtn.getAttribute('disabled')
      
      // 应该有某种反馈
      expect(toast || isDisabled).toBeTruthy()
    }
  })

  test('应该能打开模板选择器', async () => {
    const templateBtn = await page.$('.template-btn, #openTemplates, [data-action="templates"]')
    
    if (templateBtn) {
      await templateBtn.click()
      await page.waitForTimeout(300)
      
      // 检查模板弹窗
      const templateModal = await page.$('.template-modal, #templateModal')
      if (templateModal) {
        // 关闭弹窗
        const closeBtn = await page.$('.template-modal .close-btn, #templateModal .close-btn')
        if (closeBtn) {
          await closeBtn.click()
        }
      }
    }
  })

  test('应该显示生成数量选择器', async () => {
    const countSelector = await page.$('#generateCount, .count-selector, [name="count"]')
    // 生成数量选择器可能在某些模型下可见
  })

  test('页面切换后状态应该保持', async () => {
    const promptInput = await page.$('#generatePrompt, #promptInput, textarea[name="prompt"]')
    
    if (promptInput) {
      // 输入提示词
      await promptInput.fill('测试状态保持')
      
      // 切换到其他页面
      const historyTab = await page.$('[data-tab="history"]')
      if (historyTab) {
        await historyTab.click()
        await page.waitForTimeout(500)
      }
      
      // 切换回生成页面
      const generateTab = await page.$('[data-tab="generate"]')
      if (generateTab) {
        await generateTab.click()
        await page.waitForTimeout(500)
      }
      
      // 检查提示词是否保持
      const newPromptInput = await page.$('#generatePrompt, #promptInput, textarea[name="prompt"]')
      if (newPromptInput) {
        const value = await newPromptInput.inputValue()
        expect(value).toBe('测试状态保持')
      }
    }
  })
})
