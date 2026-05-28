import { test, expect } from '@playwright/test'
import { loginAsOwner, navigateTo } from './helpers'

test.describe('Finance pages', () => {
  test('cashflow page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/finance/cashflow')
    await expect(page.getByRole('heading', { name: /ДДС|Cash Flow/i })).toBeVisible({ timeout: 10000 })
  })

  test('PnL page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/finance/pnl')
    await expect(page.getByRole('heading', { name: /ОПиУ|P&L/i }).first()).toBeVisible({ timeout: 10000 })
  })

  test('balance page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/finance/balance')
    await expect(page.getByRole('heading', { name: /Баланс/i })).toBeVisible({ timeout: 10000 })
  })

  test('accounts page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/finance/accounts')
    await expect(page.getByRole('heading', { name: /Счета/i })).toBeVisible({ timeout: 10000 })
  })

  test('payroll page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/finance/payroll')
    // На странице payroll стабильный якорь — таб-кнопка «Зарплата» в сегмент-
    // контроле «Зарплата / Табель / История». Heading-а с этим текстом нет.
    await expect(page.getByRole('button', { name: 'Зарплата' })).toBeVisible({ timeout: 10000 })
  })

  test('budget page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/finance/budget')
    await expect(page.getByRole('heading', { name: /Бюджет/i })).toBeVisible({ timeout: 10000 })
  })
})
