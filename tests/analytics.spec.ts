import { test, expect } from '@playwright/test'
import { loginAsOwner, navigateTo } from './helpers'

test.describe('Analytics pages', () => {
  test('ABC menu page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/analytics/abc-menu')
    await expect(page.getByRole('heading', { name: /ABC.*меню/i })).toBeVisible({ timeout: 10000 })
  })

  test('ABC inventory page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/analytics/abc-inventory')
    await expect(page.getByRole('heading', { name: /ABC.*склад/i })).toBeVisible({ timeout: 10000 })
  })

  test('tables analytics loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/analytics/tables')
    await expect(page.getByRole('heading', { name: /столам/i }).first()).toBeVisible({ timeout: 10000 })
  })

  test('waiter analytics loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/analytics/waiters')
    await expect(page.getByRole('heading', { name: /официант/i })).toBeVisible({ timeout: 10000 })
  })

  test('peak hours loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/analytics/peak-hours')
    await expect(page.getByRole('heading', { name: /Пиковые/i })).toBeVisible({ timeout: 10000 })
  })

  test('food cost loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/analytics/food-cost')
    await expect(page.getByRole('heading', { name: /себестоимост/i })).toBeVisible({ timeout: 10000 })
  })

  test('forecast loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/analytics/forecast')
    await expect(page.getByRole('heading', { name: /Прогноз/i }).first()).toBeVisible({ timeout: 10000 })
  })
})
