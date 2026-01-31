// e2e/fixtures/electron.ts
/**
 * Playwright Electron 测试 Fixtures
 * 提供 Electron 应用启动和页面管理
 * 
 * 基于 Context7 Playwright + Electron 最佳实践
 * @see https://playwright.dev/docs/api/class-electron
 */

import { test as base, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import * as path from 'path'

export interface ElectronFixtures {
  electronApp: ElectronApplication
  page: Page
}

/**
 * 获取 Electron 主进程入口路径
 * 支持开发模式和生产模式
 */
function getMainProcessPath(): string {
  // 优先使用构建后的文件
  const builtPath = path.join(__dirname, '../../dist/main/index.js')
  const devPath = path.join(__dirname, '../../')
  
  // 检查是否存在构建文件
  try {
    require.resolve(builtPath)
    return builtPath
  } catch {
    return devPath
  }
}

/**
 * 扩展的 Playwright test fixture
 * 自动管理 Electron 应用的启动和关闭
 */
export const test = base.extend<ElectronFixtures>({
  electronApp: async ({}, use) => {
    const mainPath = getMainProcessPath()
    console.log(`[E2E] Launching Electron from: ${mainPath}`)
    
    // 启动 Electron 应用
    const app = await electron.launch({
      args: [mainPath],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        // 禁用硬件加速以提高测试稳定性
        ELECTRON_DISABLE_GPU: '1',
        // 禁用沙箱以支持 CI 环境
        ELECTRON_DISABLE_SANDBOX: process.env.CI ? '1' : undefined
      },
      timeout: 60000 // 60 秒超时
    })

    // 等待应用就绪
    await app.evaluate(async ({ app }) => {
      await app.whenReady()
    })

    console.log('[E2E] Electron app launched successfully')
    await use(app)

    // 测试完成后关闭应用
    await app.close()
    console.log('[E2E] Electron app closed')
  },

  page: async ({ electronApp }, use) => {
    // 获取主窗口
    const page = await electronApp.firstWindow()
    console.log(`[E2E] Got main window: ${await page.title()}`)
    
    // 等待页面完全加载
    await page.waitForLoadState('domcontentloaded')
    
    // 等待应用初始化完成（ServiceBridge 或 app）
    await page.waitForFunction(() => {
      const w = window as any
      // 检查 ServiceBridge 或传统 app 对象
      return w.__serviceBridgeInitialized === true || w.app !== undefined
    }, { timeout: 30000 }).catch(() => {
      console.log('[E2E] Warning: app not initialized within timeout')
    })

    await use(page)
  }
})

export { expect } from '@playwright/test'

/**
 * 辅助函数：等待应用完全就绪
 */
export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const w = window as any
    // 检查核心功能是否可用
    return (w.app && typeof w.app.showToast === 'function') || 
           (w.toastManagerTS && typeof w.toastManagerTS.show === 'function')
  }, { timeout: 30000 })
}

/**
 * 辅助函数：等待 ServiceBridge 初始化完成
 */
export async function waitForServiceBridge(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    return (window as any).__serviceBridgeInitialized === true
  }, { timeout: 30000 })
}

/**
 * 辅助函数：切换到指定标签页
 */
export async function switchToTab(page: Page, tabName: string): Promise<void> {
  await page.click(`[data-tab="${tabName}"]`)
  await page.waitForSelector(`#${tabName}Panel:not(.hidden)`, { timeout: 5000 })
}

/**
 * 辅助函数：获取 Toast 消息
 */
export async function getToastMessage(page: Page): Promise<string> {
  const toast = await page.waitForSelector('#toast:not(.hidden)', { timeout: 5000 })
  const message = await toast.$('#toastMessage')
  return message ? await message.textContent() || '' : ''
}

/**
 * 辅助函数：截取屏幕快照用于调试
 */
export async function takeDebugScreenshot(page: Page, name: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  await page.screenshot({
    path: `e2e/screenshots/${name}-${timestamp}.png`,
    fullPage: true
  })
}

/**
 * 辅助函数：执行主进程代码
 */
export async function evaluateInMain<R>(
  electronApp: ElectronApplication, 
  fn: () => R | Promise<R>
): Promise<R> {
  return electronApp.evaluate(({ app }, fn) => {
    // @ts-ignore - fn is passed as serialized function
    return fn()
  }, fn)
}

/**
 * 启动应用的便捷函数（用于非 fixture 场景）
 */
export async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const mainPath = getMainProcessPath()
  
  const app = await electron.launch({
    args: [mainPath],
    env: {
      ...process.env,
      NODE_ENV: 'test'
    }
  })
  
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  
  return { app, window }
}

// ============ V15 新增: 增强 Fixtures ============

/**
 * 历史记录 Mock 数据
 */
export interface MockHistoryItem {
  id: string
  type: string
  prompt: string
  urls: string[]
  timestamp: number
  model: string
}

/**
 * 预填充历史记录
 * 用于测试历史记录相关功能
 */
export async function withHistory(page: Page, items?: MockHistoryItem[]): Promise<void> {
  const defaultItems: MockHistoryItem[] = items || [
    {
      id: 'test-hist-001',
      type: 'text2img',
      prompt: 'E2E Test - Beautiful sunset over the ocean',
      urls: ['https://example.com/test-image-1.png'],
      timestamp: Date.now() - 3600000,
      model: 'flux-schnell'
    },
    {
      id: 'test-hist-002',
      type: 'text2img',
      prompt: 'E2E Test - Cyberpunk city at night',
      urls: ['https://example.com/test-image-2.png'],
      timestamp: Date.now() - 7200000,
      model: 'flux-pro'
    }
  ]

  await page.evaluate((historyItems) => {
    // 尝试通过 StorageBridge 设置历史记录
    const storageBridge = (window as any).storageBridgeTS
    if (storageBridge && typeof storageBridge.set === 'function') {
      storageBridge.set('history', historyItems)
    } else {
      // 降级到 localStorage
      localStorage.setItem('history', JSON.stringify(historyItems))
    }
  }, defaultItems)
}

/**
 * 预配置 API Key
 * 用于测试需要 API 认证的功能
 */
export async function withApiKey(page: Page, apiKey?: string): Promise<void> {
  const key = apiKey || 'sk-test-e2e-api-key-for-testing-purposes'

  await page.evaluate((testApiKey) => {
    // 尝试通过 StorageBridge 设置 API Key
    const storageBridge = (window as any).storageBridgeTS
    if (storageBridge && typeof storageBridge.set === 'function') {
      storageBridge.set('apiKey', testApiKey)
    } else {
      // 降级到 localStorage
      localStorage.setItem('apiKey', testApiKey)
    }
  }, key)
}

/**
 * 预选模型
 * 用于测试特定模型的功能
 */
export async function withModel(page: Page, modelKey: string = 'flux-schnell'): Promise<void> {
  await page.evaluate((model) => {
    // 尝试通过 StorageBridge 设置默认模型
    const storageBridge = (window as any).storageBridgeTS
    if (storageBridge && typeof storageBridge.set === 'function') {
      storageBridge.set('selectedModel', model)
    } else {
      // 降级到 localStorage
      localStorage.setItem('selectedModel', model)
    }

    // 如果 ModelSelectorManager 可用，直接切换模型
    const modelSelector = (window as any).modelSelectorManagerTS
    if (modelSelector && typeof modelSelector.selectModel === 'function') {
      modelSelector.selectModel(model)
    }
  }, modelKey)
}

/**
 * 清除所有测试数据
 * 用于测试后清理
 */
export async function clearTestData(page: Page): Promise<void> {
  await page.evaluate(() => {
    const storageBridge = (window as any).storageBridgeTS
    if (storageBridge && typeof storageBridge.clear === 'function') {
      storageBridge.clear()
    } else {
      localStorage.clear()
    }
  })
}

/**
 * 配置站点
 * 用于测试不同站点配置
 */
export async function withSite(page: Page, siteKey: string = 'siliconflow'): Promise<void> {
  await page.evaluate((site) => {
    const storageBridge = (window as any).storageBridgeTS
    if (storageBridge && typeof storageBridge.set === 'function') {
      storageBridge.set('currentSite', site)
    } else {
      localStorage.setItem('currentSite', site)
    }
  }, siteKey)
}

/**
 * 配置语言
 * 用于测试国际化
 */
export async function withLanguage(page: Page, langCode: string = 'zh-CN'): Promise<void> {
  await page.evaluate((lang) => {
    const storageBridge = (window as any).storageBridgeTS
    if (storageBridge && typeof storageBridge.set === 'function') {
      storageBridge.set('language', lang)
    } else {
      localStorage.setItem('language', lang)
    }

    // 如果 I18nService 可用，直接切换语言
    const i18n = (window as any).i18nServiceTS
    if (i18n && typeof i18n.setLanguage === 'function') {
      i18n.setLanguage(lang)
    }
  }, langCode)
}

/**
 * 综合配置函数
 * 一次性设置多个测试配置
 */
export interface TestSetupOptions {
  apiKey?: string
  model?: string
  site?: string
  language?: string
  history?: MockHistoryItem[]
}

export async function setupTestEnvironment(page: Page, options: TestSetupOptions = {}): Promise<void> {
  if (options.apiKey) {
    await withApiKey(page, options.apiKey)
  }
  if (options.model) {
    await withModel(page, options.model)
  }
  if (options.site) {
    await withSite(page, options.site)
  }
  if (options.language) {
    await withLanguage(page, options.language)
  }
  if (options.history) {
    await withHistory(page, options.history)
  }

  // 重新加载页面以应用配置
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
}
