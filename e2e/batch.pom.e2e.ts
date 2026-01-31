// e2e/batch.pom.e2e.ts
/**
 * 批量生成页面 E2E 测试 - 使用 Page Object Model
 */

import { test, expect } from '@playwright/test'
import { electronApp, createElectronPage } from './fixtures'
import { BatchPage } from './pages'

let batchPage: BatchPage

test.describe('BatchPage E2E Tests', () => {
  test.beforeAll(async () => {
    await electronApp.launch()
  })

  test.afterAll(async () => {
    await electronApp.close()
  })

  test.beforeEach(async () => {
    const page = await createElectronPage()
    batchPage = new BatchPage(page)
    await batchPage.navigate()
  })

  test('should navigate to batch page', async () => {
    expect(await batchPage.isVisible()).toBe(true)
  })

  test('should have empty prompts initially', async () => {
    const count = await batchPage.getPromptCount()
    expect(count).toBe(0)
  })

  test('should enter multiple prompts', async () => {
    const prompts = [
      'A beautiful sunset',
      'A mountain landscape',
      'An ocean view'
    ]
    
    await batchPage.enterPrompts(prompts)
    
    const enteredPrompts = await batchPage.getPrompts()
    expect(enteredPrompts).toHaveLength(3)
    expect(enteredPrompts[0]).toBe('A beautiful sunset')
  })

  test('should clear prompts', async () => {
    await batchPage.enterPrompts(['Test prompt 1', 'Test prompt 2'])
    await batchPage.clickClear()
    
    const count = await batchPage.getPromptCount()
    expect(count).toBe(0)
  })

  test('should disable generate button when no prompts', async () => {
    const isDisabled = await batchPage.isGenerateButtonDisabled()
    expect(isDisabled).toBe(true)
  })

  test('should enable generate button with prompts', async () => {
    await batchPage.enterPrompts(['A test prompt'])
    
    const isDisabled = await batchPage.isGenerateButtonDisabled()
    expect(isDisabled).toBe(false)
  })

  test('should count prompts correctly', async () => {
    await batchPage.enterPrompts([
      'Prompt 1',
      'Prompt 2',
      'Prompt 3',
      '', // Empty line should be ignored
      'Prompt 4'
    ])
    
    const count = await batchPage.getPromptCount()
    expect(count).toBe(4)
  })
})
