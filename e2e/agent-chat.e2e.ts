import { test, expect } from './fixtures/electron'

async function skipIntroIfPresent(page: import('@playwright/test').Page): Promise<void> {
  const skipButton = page.locator('#skipIntroBtn')
  if (await skipButton.count() > 0 && await skipButton.isVisible()) {
    await skipButton.click().catch(() => {})
    return
  }

  await page.keyboard.press('Escape').catch(() => {})
}

test('agent panel opens with keyboard shortcut', async ({ page }) => {
  await skipIntroIfPresent(page)
  await expect(page.getByRole('main')).toBeVisible({ timeout: 15000 })

  await page.keyboard.press('Control+Shift+A')
  await expect(page.getByText('CATIMATION Agent')).toBeVisible()
})
