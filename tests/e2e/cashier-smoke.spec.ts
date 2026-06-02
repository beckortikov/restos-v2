import { test, expect } from '@playwright/test'
import { loginAsCashier, waitForPageLoad } from '../helpers'

/**
 * Cashier smoke — самый базовый сценарий «приложение жизнеспособно».
 *
 * Зачем: ловит регрессии в bootstrap-цепочке (login → роль-роутинг → POS
 * рендерится). Если этот тест упал — все остальные e2e тоже упадут, проще
 * чинить отсюда.
 *
 * Требует: Vite dev на :3000 (поднимается playwright.config webServer) +
 * Go-бэк на :3001 с seed-юзером `nilufar`/1234. Если бэк недоступен — тест
 * залогинится, но переход на POS таймаутит → smoke падает осмысленно.
 *
 * Покрытие: только «приложение открылось, login работает, POS отрендерился».
 * Глубокие сценарии — в pos-cashier-cancel-takeaway.spec.ts и др.
 */
test.describe('Cashier smoke', () => {
  test('login → POS grid renders', async ({ page }) => {
    await loginAsCashier(page)
    await expect(page).toHaveURL(/\/operations\/pos/, { timeout: 15_000 })
    await waitForPageLoad(page)

    // POS-UI кассира: переключатель «🍽 ЗАЛ / 🥡 С СОБОЙ» — стабильный якорь,
    // появляется только когда меню/столы успешно подгрузились с бэка.
    const togoToggle = page.getByRole('button', { name: /С СОБОЙ/i }).first()
    await expect(togoToggle).toBeVisible({ timeout: 15_000 })
  })
})
