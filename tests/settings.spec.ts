import { test, expect } from '@playwright/test'
import { loginAsOwner, loginAsWaiter, navigateTo, waitForPageLoad } from './helpers'

test.describe('Settings', () => {
  test('restaurant settings page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/settings')
    await expect(page.getByRole('heading', { name: /Настройки ресторана/i })).toBeVisible({ timeout: 10000 })
  })

  test('permissions page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/settings/users')
    await expect(page.getByRole('heading', { name: /Персонал/i })).toBeVisible({ timeout: 10000 })
  })

  test('can switch to matrix tab', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/settings/users')
    await page.getByRole('button', { name: /Матрица/i }).click()
    await expect(page.getByText('Разрешение')).toBeVisible({ timeout: 5000 })
  })

  test('add employee button exists', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/settings/users')
    // Green add button
    await expect(page.locator('button.bg-emerald-600').first()).toBeVisible({ timeout: 10000 })
  })
})
