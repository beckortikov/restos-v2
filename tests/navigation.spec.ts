import { test, expect } from '@playwright/test'
import { loginAsOwner, loginAsWaiter, loginAsCashier, loginAsCook, waitForPageLoad, navigateTo } from './helpers'

test.describe('Navigation & Role-based access', () => {
  test('owner sees all sidebar sections', async ({ page }) => {
    await loginAsOwner(page)
    await waitForPageLoad(page)
    // Check sidebar nav buttons
    await expect(page.locator('nav').getByText('Операции')).toBeVisible()
    await expect(page.locator('nav').getByText('Склад')).toBeVisible()
    await expect(page.locator('nav').getByText('Финансы')).toBeVisible()
    await expect(page.locator('nav').getByText('Аналитика')).toBeVisible()
    await expect(page.locator('nav').getByText('Настройки')).toBeVisible()
  })

  test('waiter goes to waiter UI and has no finance access', async ({ page }) => {
    await loginAsWaiter(page)
    await waitForPageLoad(page)
    // У waiter отдельный mobile UI без desktop sidebar — проверяем реальные
    // инварианты: посадочный URL и отсутствие доступа к финансам.
    await expect(page).toHaveURL(/\/waiter\/tables/)
    await page.goto('/finance/balance')
    await page.waitForLoadState('domcontentloaded')
    await expect(page).not.toHaveURL(/\/finance\/balance/)
  })

  test('cook sees only kitchen', async ({ page }) => {
    await loginAsCook(page)
    await waitForPageLoad(page)
    await expect(page.locator('nav >> text=Кухня')).toBeVisible()
    // Should NOT see orders or finance
    await expect(page.locator('nav >> text=Заказы')).not.toBeVisible()
    await expect(page.locator('nav >> text=ДДС')).not.toBeVisible()
  })

  test('all owner pages load without errors', async ({ page }) => {
    await loginAsOwner(page)
    const pages = [
      '/dashboard',
      '/operations/table-map',
      '/operations/orders',
      '/operations/kitchen',
      '/operations/pos',
      '/operations/shifts',
      '/warehouse/inventory',
      '/warehouse/menu',
      '/warehouse/receipts',
      '/warehouse/suppliers',
      '/warehouse/semi',
      '/warehouse/writeoffs',
      '/warehouse/history',
      '/warehouse/inventory-check',
      '/finance/cashflow',
      '/finance/pnl',
      '/finance/balance',
      '/finance/accounts',
      '/finance/payroll',
      '/finance/budget',
      '/analytics/abc-menu',
      '/analytics/abc-inventory',
      '/analytics/tables',
      '/analytics/waiters',
      '/analytics/peak-hours',
      '/analytics/food-cost',
      '/analytics/forecast',
      '/settings',
      '/settings/users',
    ]
    for (const path of pages) {
      await navigateTo(page, path)
      // Check no error text on page
      const errorText = await page.locator('text=Application error').count()
      expect(errorText, `Error on ${path}`).toBe(0)
    }
  })
})
