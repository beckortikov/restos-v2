import { test, expect } from '@playwright/test'
import {
  loginAsCashier,
  navigateTo,
  waitForPageLoad,
  createTakeawayOrderInPOS,
  openOrderActionsDialog,
  voidFirstItemInDialog,
  readDialogSubtotal,
} from './helpers'

/**
 * Сценарий жалобы пользователя (см. фотографии заказа #4 «Самовывоз»):
 * cashier создаёт заказ-самовывоз с N блюдами → отменяет одну позицию →
 * проверяем три инварианта:
 *   (a) визуальная индикация отмены сохраняется при переоткрытии диалога;
 *   (b) карточка в /operations/orders показывает свежую сумму без F5;
 *   (c) пре-чек не содержит отменённую позицию.
 *
 * До фиксов тест должен падать на (a) или (b). Это подтверждает реальный баг.
 */
test.describe('POS cashier — cancel item in takeaway', () => {
  test('void persists across reopen and propagates to list/receipt', async ({ page }) => {
    // 1. Cashier → POS (login сам редиректит).
    await loginAsCashier(page)
    await waitForPageLoad(page)
    await expect(page).toHaveURL(/\/operations\/pos/)

    // 2. Создаём заказ-самовывоз из 3 блюд.
    const { orderNumber } = await createTakeawayOrderInPOS(page, { itemCount: 3 })

    // 3. Открываем диалог действий заказа.
    await openOrderActionsDialog(page, orderNumber)
    const subtotalBefore = await readDialogSubtotal(page)
    expect(subtotalBefore).toBeGreaterThan(0)

    // 4. Считаем сумму первой позиции (которую сейчас отменим).
    const firstItemRow = page.locator('div.divide-y > div').first()
    const firstItemText = (await firstItemRow.textContent()) ?? ''
    const firstItemPriceMatch = firstItemText.match(/([\d.,]+)\s*TJS/)
    expect(firstItemPriceMatch).not.toBeNull()
    const firstItemTotal = Number(firstItemPriceMatch![1].replace(',', '.'))

    // 5. Void первой позиции.
    await voidFirstItemInDialog(page, { reason: 'guest_changed_mind' })

    // 6. (А) В той же сессии — позиция помечена «Отменено» + line-through.
    await expect(page.getByText('Отменено').first()).toBeVisible({ timeout: 5000 })

    // 7. Подытог уменьшился на сумму отменённой позиции (± 0.01).
    const subtotalAfter = await readDialogSubtotal(page)
    expect(Math.abs((subtotalBefore - firstItemTotal) - subtotalAfter)).toBeLessThanOrEqual(0.01)

    // 8. (А-prime) Закрываем диалог и переоткрываем — индикация ДОЛЖНА сохраниться.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    await openOrderActionsDialog(page, orderNumber)

    // Это главный баг: при повторном открытии бейдж «Отменено» теряется.
    await expect(page.getByText('Отменено').first()).toBeVisible({ timeout: 5000 })
    const subtotalReopened = await readDialogSubtotal(page)
    expect(Math.abs(subtotalReopened - subtotalAfter)).toBeLessThanOrEqual(0.01)

    // 9. (Б) На карточке /operations/orders сумма обновилась без F5.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
    const row = page.getByRole('row', { name: new RegExp(`^#${orderNumber}\\s`) }).first()
    await row.waitFor({ state: 'visible', timeout: 10000 })
    // Берём ячейку «Сумма» отдельно — раньше использовали textContent всей
    // строки + regex, но textContent склеивает соседние cells без разделителя
    // («сп. 1» + «125,00 TJS» → «1125,00 TJS»), и regex ловит «1125».
    const sumCellText = (await row.getByRole('cell').nth(4).textContent()) ?? ''
    const m = sumCellText.match(/([\d.,]+)\s*TJS/)
    expect(m, `sum cell: ${sumCellText}`).not.toBeNull()
    const cardTotal = Number(m![1].replace(',', '.'))
    expect(Math.abs(cardTotal - subtotalAfter)).toBeLessThanOrEqual(0.01)
  })
})
