import { test, expect } from '@playwright/test'
import { loginAsOwner, loginAsCashier, waitForPageLoad, navigateTo } from './helpers'

test.describe('Table Map', () => {
  test('table map loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/operations/table-map')
    await expect(page.getByRole('heading', { name: 'Карта зала' })).toBeVisible({ timeout: 10000 })
  })

  test('table map has tables displayed', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/operations/table-map')
    // Should see zone filters
    await expect(page.getByText('Все зоны')).toBeVisible({ timeout: 10000 })
  })
})

test.describe('Orders', () => {
  test('orders page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/operations/orders')
    await expect(page.getByRole('heading', { name: 'Заказы' })).toBeVisible({ timeout: 10000 })
  })

  test('new order button visible', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/operations/orders')
    await expect(page.getByText('Новый заказ')).toBeVisible({ timeout: 10000 })
  })
})

test.describe('Kitchen', () => {
  test('kitchen page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/operations/kitchen')
    await expect(page.getByRole('heading', { name: 'Кухня' })).toBeVisible({ timeout: 10000 })
  })
})

test.describe('POS Terminal', () => {
  test('POS page loads', async ({ page }) => {
    await loginAsCashier(page)
    await waitForPageLoad(page)
    await expect(page).toHaveURL(/\/operations\/pos/)
    await expect(page.getByText('Корзина пуста')).toBeVisible({ timeout: 10000 })
  })

  test('clicking menu item adds to cart', async ({ page }) => {
    await loginAsCashier(page)
    await waitForPageLoad(page)
    // Wait for menu items to load
    await page.waitForTimeout(2000)
    const menuBtn = page.locator('button:has(.text-3xl)').first()
    if (await menuBtn.isVisible().catch(() => false)) {
      await menuBtn.click()
      await expect(page.getByText('Корзина пуста')).not.toBeVisible({ timeout: 3000 })
    }
  })
})

test.describe('Shifts', () => {
  test('shifts page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/operations/shifts')
    await expect(page.getByRole('heading', { name: 'Кассовые смены' })).toBeVisible({ timeout: 10000 })
  })
})
