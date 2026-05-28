import { test, expect } from '@playwright/test'
import { login, loginAsOwner, loginAsWaiter, loginAsCashier, loginAsCook, waitForPageLoad } from './helpers'

test.describe('Authentication', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'RestOS' })).toBeVisible()
    await expect(page.getByPlaceholder('Введите пароль')).toBeVisible()
  })

  test('wrong password shows error', async ({ page }) => {
    await page.goto('/login')
    await page.getByPlaceholder('Введите логин').fill('aziz')
    await page.getByPlaceholder('Введите пароль').fill('wrong')
    await page.getByRole('button', { name: 'Войти' }).click()
    await expect(page.getByText('Неверный пароль')).toBeVisible({ timeout: 5000 })
  })

  test('wrong username shows error', async ({ page }) => {
    await page.goto('/login')
    await page.getByPlaceholder('Введите логин').fill('nonexistent')
    await page.getByPlaceholder('Введите пароль').fill('1234')
    await page.getByRole('button', { name: 'Войти' }).click()
    await expect(page.getByText('Пользователь не найден')).toBeVisible({ timeout: 5000 })
  })

  test('owner login redirects to dashboard', async ({ page }) => {
    await loginAsOwner(page)
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test('waiter login redirects to waiter tables', async ({ page }) => {
    await loginAsWaiter(page)
    // У waiter отдельный mobile UI на /waiter/tables, а не /operations/table-map.
    await expect(page).toHaveURL(/\/waiter\/tables/)
  })

  test('cashier login redirects to POS', async ({ page }) => {
    await loginAsCashier(page)
    await expect(page).toHaveURL(/\/operations\/pos/)
  })

  test('cook login redirects to kitchen', async ({ page }) => {
    await loginAsCook(page)
    await expect(page).toHaveURL(/\/operations\/kitchen/)
  })
})
