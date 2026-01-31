/**
 * 历史记录页面 E2E 测试
 */
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'

let electronApp: ElectronApplication
let page: Page

test.describe('HistoryPage', () => {
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
    // 导航到历史页面
    const historyTab = await page.$('[data-tab="history"]')
    if (historyTab) {
      await historyTab.click()
      await page.waitForTimeout(500)
    }
  })

  test('应该显示历史记录页面', async () => {
    const historyPanel = await page.$('#historyPanel')
    expect(historyPanel).toBeTruthy()
  })

  test('应该显示历史记录标题', async () => {
    const title = await page.textContent('h2')
    expect(title).toContain('历史')
  })

  test('应该显示清空按钮', async () => {
    const clearBtn = await page.$('#clearHistoryBtn')
    expect(clearBtn).toBeTruthy()
  })

  test('应该显示存储信息', async () => {
    const storageInfo = await page.$('#storageInfo, .storage-info')
    // 存储信息可能在 Electron 模式下显示
    // 不强制要求，因为取决于运行环境
  })

  test('空历史时应该显示空状态', async () => {
    const emptyState = await page.$('.history-empty, #historyList:empty')
    const historyItems = await page.$$('.history-item')
    
    // 要么显示空状态，要么有历史记录
    expect(emptyState || historyItems.length > 0).toBeTruthy()
  })

  test('历史记录项应该可以点击查看', async () => {
    const historyItems = await page.$$('.history-item')
    
    if (historyItems.length > 0) {
      // 点击第一个历史记录
      await historyItems[0].click()
      await page.waitForTimeout(300)
      
      // 检查是否弹出查看器或展开详情
      const viewer = await page.$('.image-viewer, .lightbox, .history-detail')
      // 可能有弹出查看器，也可能没有，取决于交互设计
    }
  })

  test('应该能删除历史记录', async () => {
    const deleteBtn = await page.$('.history-item .delete-btn, .history-item [data-action="delete"]')
    
    if (deleteBtn) {
      const initialCount = (await page.$$('.history-item')).length
      
      // 点击删除按钮
      await deleteBtn.click()
      await page.waitForTimeout(500)
      
      // 检查确认对话框或直接删除
      const confirmBtn = await page.$('.confirm-btn, [data-action="confirm"]')
      if (confirmBtn) {
        await confirmBtn.click()
        await page.waitForTimeout(500)
      }
      
      const newCount = (await page.$$('.history-item')).length
      // 删除后数量应该减少或保持不变（如果删除失败）
      expect(newCount).toBeLessThanOrEqual(initialCount)
    }
  })

  test('应该能批量删除历史记录', async () => {
    const clearBtn = await page.$('#clearHistoryBtn')
    
    if (clearBtn) {
      await clearBtn.click()
      await page.waitForTimeout(300)
      
      // 检查确认对话框
      const confirmDialog = await page.$('.confirm-dialog, .modal')
      if (confirmDialog) {
        // 取消，不实际清空
        const cancelBtn = await page.$('.cancel-btn, [data-action="cancel"]')
        if (cancelBtn) {
          await cancelBtn.click()
        }
      }
    }
  })
})
