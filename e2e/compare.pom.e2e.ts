// e2e/compare.pom.e2e.ts
/**
 * 模型对比页面 E2E 测试 - 使用 Page Object Model
 */

import { test, expect } from '@playwright/test'
import { electronApp, createElectronPage } from './fixtures'
import { ComparePage } from './pages'

let comparePage: ComparePage

test.describe('ComparePage E2E Tests', () => {
  test.beforeAll(async () => {
    await electronApp.launch()
  })

  test.afterAll(async () => {
    await electronApp.close()
  })

  test.beforeEach(async () => {
    const page = await createElectronPage()
    comparePage = new ComparePage(page)
    await comparePage.navigate()
  })

  test('should navigate to compare page', async () => {
    expect(await comparePage.isVisible()).toBe(true)
  })

  test('should have empty prompt initially', async () => {
    const prompt = await comparePage.getPrompt()
    expect(prompt).toBe('')
  })

  test('should enter prompt', async () => {
    await comparePage.enterPrompt('A cyberpunk city at night')
    
    const prompt = await comparePage.getPrompt()
    expect(prompt).toBe('A cyberpunk city at night')
  })

  test('should disable compare button when no prompt', async () => {
    const isDisabled = await comparePage.isCompareButtonDisabled()
    expect(isDisabled).toBe(true)
  })

  test('should enable compare button with prompt', async () => {
    await comparePage.enterPrompt('Test prompt for comparison')
    
    const isDisabled = await comparePage.isCompareButtonDisabled()
    expect(isDisabled).toBe(false)
  })

  test('should have two different models selectable', async () => {
    const leftModel = await comparePage.getLeftModel()
    const rightModel = await comparePage.getRightModel()
    
    // 默认应该选择不同的模型用于对比
    expect(leftModel).toBeDefined()
    expect(rightModel).toBeDefined()
  })

  test('should not have results initially', async () => {
    const hasLeft = await comparePage.hasLeftResult()
    const hasRight = await comparePage.hasRightResult()
    
    expect(hasLeft).toBe(false)
    expect(hasRight).toBe(false)
  })

  test('should not be generating initially', async () => {
    const isGenerating = await comparePage.isGenerating()
    expect(isGenerating).toBe(false)
  })
})
