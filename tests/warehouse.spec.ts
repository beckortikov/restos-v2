import { test, expect } from '@playwright/test'
import { loginAsOwner, navigateTo } from './helpers'

test.describe('Inventory', () => {
  test('inventory page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/warehouse/inventory')
    await expect(page.getByRole('heading', { name: 'Остатки' })).toBeVisible({ timeout: 10000 })
  })
})

test.describe('Menu', () => {
  test('menu page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/warehouse/menu')
    await expect(page.getByRole('heading', { name: 'Меню и техкарты' })).toBeVisible({ timeout: 10000 })
  })
})

test.describe('Suppliers', () => {
  test('suppliers page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/warehouse/suppliers')
    await expect(page.getByRole('heading', { name: 'Поставщики' })).toBeVisible({ timeout: 10000 })
  })
})

test.describe('Receipts', () => {
  test('receipts page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/warehouse/receipts')
    await expect(page.getByRole('heading', { name: 'Накладные' })).toBeVisible({ timeout: 10000 })
  })
})

test.describe('Semi-finished', () => {
  test('semi page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/warehouse/semi')
    await expect(page.getByRole('heading', { name: 'Полуфабрикаты' })).toBeVisible({ timeout: 10000 })
  })
})

test.describe('Writeoffs', () => {
  test('writeoffs page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/warehouse/writeoffs')
    await expect(page.getByRole('heading', { name: 'Списания' })).toBeVisible({ timeout: 10000 })
  })
})

test.describe('History', () => {
  test('history page loads', async ({ page }) => {
    await loginAsOwner(page)
    await navigateTo(page, '/warehouse/history')
    await expect(page.getByRole('heading', { name: /истори/i })).toBeVisible({ timeout: 10000 })
  })
})
