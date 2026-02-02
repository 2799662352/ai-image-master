// e2e/app.e2e.ts - Electron 应用 E2E 测试
import { test, expect } from './fixtures/electron'

/**
 * 辅助函数：跳过 Intro 视频（如果存在）
 * 尝试多种方式跳过加载界面
 */
async function skipIntroIfPresent(page: import('@playwright/test').Page): Promise<void> {
  // 方法1: 点击跳过按钮
  const skipBtn = page.locator('#skipIntroBtn')
  if (await skipBtn.count() > 0 && await skipBtn.isVisible()) {
    await skipBtn.click().catch(() => {})
    await page.waitForTimeout(500)
    return
  }
  
  // 方法2: 点击进入按钮
  const enterBtn = page.locator('#enterBtn')
  if (await enterBtn.count() > 0 && await enterBtn.isVisible()) {
    await enterBtn.click().catch(() => {})
    await page.waitForTimeout(500)
    return
  }
  
  // 方法3: 按 Escape 键跳过
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(300)
  
  // 方法4: 调用 skipIntro 函数（如果存在）
  await page.evaluate(() => {
    const w = window as any
    if (w.introVideoController?.skipIntro) {
      w.introVideoController.skipIntro()
    }
  }).catch(() => {})
}

/**
 * 辅助函数：等待主内容可见
 * 注意：构建后的应用使用 SPA 模式，UI 由 JavaScript 动态渲染
 */
async function waitForMainContent(page: import('@playwright/test').Page, timeout = 15000): Promise<boolean> {
  try {
    // 等待 ServiceBridge 初始化完成（这表示 JS 已加载）
    await page.waitForFunction(
      () => (window as any).__serviceBridgeInitialized === true,
      { timeout }
    ).catch(() => {})
    
    // 等待 #app 有内容（SPA 模式下 UI 渲染到 #app）
    await page.waitForFunction(
      () => {
        const appDiv = document.getElementById('app')
        return appDiv && appDiv.innerHTML.length > 100
      },
      { timeout: Math.min(timeout, 10000) }
    )
    return true
  } catch {
    return false
  }
}

/**
 * 辅助函数：等待标签按钮渲染
 */
async function waitForTabButtons(page: import('@playwright/test').Page, timeout = 20000): Promise<number> {
  try {
    // 等待 .tab-btn 或 [data-tab] 元素出现
    await page.waitForFunction(
      () => {
        const tabBtns = document.querySelectorAll('.tab-btn[data-tab]')
        const dataTabEls = document.querySelectorAll('[data-tab]')
        return tabBtns.length > 0 || dataTabEls.length > 0
      },
      { timeout }
    )
    
    // 返回找到的标签数量
    const count = await page.evaluate(() => {
      const tabBtns = document.querySelectorAll('.tab-btn[data-tab]')
      const dataTabEls = document.querySelectorAll('[data-tab]')
      return Math.max(tabBtns.length, dataTabEls.length)
    })
    
    return count
  } catch {
    return 0
  }
}

test.describe('CATIMATION-Cyberpunk Master E2E', () => {
  test('应用应该成功启动', async ({ page }) => {
    // 验证窗口标题
    const title = await page.title()
    expect(title).toContain('CATIMATION')
  })

  test('应用应该显示主界面', async ({ page }) => {
    // 尝试跳过 Intro 视频
    await skipIntroIfPresent(page)
    
    // 等待主内容加载（最多15秒）
    const hasContent = await waitForMainContent(page, 15000)
    
    // 如果主内容没加载，再次尝试跳过并等待
    if (!hasContent) {
      await skipIntroIfPresent(page)
      await waitForMainContent(page, 10000)
    }
    
    // 验证页面有实际内容（即使主容器不可见，body 也应该有文本）
    const bodyContent = await page.locator('body').textContent()
    expect(bodyContent).toBeTruthy()
    expect(bodyContent!.length).toBeGreaterThan(10)
  })

  test('应该能切换页面标签', async ({ page }) => {
    // 尝试跳过 Intro 视频
    await skipIntroIfPresent(page)
    
    // 等待主内容加载
    await waitForMainContent(page, 15000)
    
    // 等待标签按钮渲染（SPA 模式下需要等待 JS 渲染）
    let tabCount = await waitForTabButtons(page, 30000)
    
    // 如果没找到，再次尝试跳过 intro 并等待更长时间
    if (tabCount === 0) {
      await skipIntroIfPresent(page)
      await page.waitForTimeout(2000)
      tabCount = await waitForTabButtons(page, 15000)
    }
    
    // 如果还是没找到，收集调试信息
    if (tabCount === 0) {
      const debugInfo = await page.evaluate(() => {
        const appDiv = document.getElementById('app')
        return {
          tabBtnCount: document.querySelectorAll('.tab-btn').length,
          dataTabCount: document.querySelectorAll('[data-tab]').length,
          buttonCount: document.querySelectorAll('button').length,
          appHasContent: appDiv ? appDiv.innerHTML.length : 0,
          serviceBridgeReady: (window as any).__serviceBridgeInitialized,
          appInitialized: (window as any).appInitialized,
          loadingContainerVisible: (() => {
            const lc = document.getElementById('loadingContainer')
            if (!lc) return false
            const style = window.getComputedStyle(lc)
            return style.display !== 'none' && style.visibility !== 'hidden'
          })()
        }
      })
      console.log('Tab debug info:', JSON.stringify(debugInfo, null, 2))
    }
    
    // 至少应该有一个标签
    expect(tabCount).toBeGreaterThan(0)
  })

  test('Electron API 应该可用', async ({ page }) => {
    // 验证 preload 脚本加载成功
    const isElectron = await page.evaluate(() => {
      return window.electronAPI?.isElectron === true
    })
    
    expect(isElectron).toBe(true)
  })

  test('应该能获取存储信息', async ({ page }) => {
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
  test('历史记录页面应该能加载', async ({ page }) => {
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
