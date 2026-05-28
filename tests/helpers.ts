import { Page } from '@playwright/test'

export async function login(page: Page, username: string, password = '1234') {
  await page.goto('/login')
  await page.waitForLoadState('domcontentloaded')
  await page.getByPlaceholder('Введите логин').fill(username)
  await page.getByPlaceholder('Введите пароль').fill(password)
  await page.getByRole('button', { name: 'Войти' }).click()
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15000 })
}

export async function loginAsOwner(page: Page) { await login(page, 'aziz') }
export async function loginAsManager(page: Page) { await login(page, 'sanjar') }
export async function loginAsWaiter(page: Page) { await login(page, 'alisher') }
export async function loginAsCashier(page: Page) { await login(page, 'nilufar') }
export async function loginAsCook(page: Page) { await login(page, 'bobur') }

export async function waitForPageLoad(page: Page) {
  await page.waitForLoadState('domcontentloaded')
  // Wait for spinner to disappear (data loaded)
  await page.waitForSelector('.animate-spin', { state: 'detached', timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(500)
}

export async function navigateTo(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await waitForPageLoad(page)
}

// ─── POS / order fixtures ─────────────────────────────────────────────────

/**
 * Cashier POS fixture: переключает тип заказа на «Самовывоз», добавляет N
 * первых видимых блюд из меню и сабмитит. Возвращает orderId и orderNumber
 * созданного заказа (orderNumber берём из toast, orderId — из навигации).
 *
 * Хрупкость: если меню seed-а изменится, изменится только число блюд, не
 * имена — селектор по visible:true + цене.
 */
export async function createTakeawayOrderInPOS(
  page: Page,
  opts: { itemCount: number },
): Promise<{ orderNumber: string }> {
  // POS-кассира: iiko-style layout с drill-down. Ждём появления переключателя
  // «🍽 ЗАЛ / 🥡 С СОБОЙ» — он рендерится только когда меню/столы загружены.
  const togoBtn = page.getByRole('button', { name: /С СОБОЙ/i }).first()
  await togoBtn.waitFor({ state: 'visible', timeout: 15000 })
  await togoBtn.click()
  await page.waitForTimeout(300)

  // Сетка категорий — кнопки с подписью «X блюд[оа]?». Берём первую с
  // достаточным числом блюд, входим в неё.
  const firstCategory = page
    .locator('button')
    .filter({ visible: true, hasText: /\d+\s+блюд/i })
    .first()
  await firstCategory.waitFor({ state: 'visible', timeout: 10000 })
  await firstCategory.click()
  await page.waitForTimeout(300)

  // Внутри категории — карточки блюд. Они видимые, не disabled, содержат TJS.
  const priced = page
    .locator('button')
    .filter({ visible: true, hasText: /\d+[.,]?\d*\s*TJS/, hasNotText: /Создать заказ|С СОБОЙ|ЗАЛ|Доставка/ })
  await priced.first().waitFor({ state: 'visible', timeout: 10000 })

  // Если в одной категории меньше нужного — берём что есть из этой.
  const available = await priced.count()
  const target = Math.min(opts.itemCount, available)
  for (let i = 0; i < target; i++) {
    await priced.nth(i).click()
    await page.waitForTimeout(200)
  }

  // Перехватим ответ от POST /rest/v1/orders — там реальный order_number и id.
  const orderResponsePromise = page.waitForResponse(
    res => res.url().includes('/rest/v1/orders') && res.request().method() === 'POST' && res.ok(),
    { timeout: 15000 },
  )

  // Submit. В POS-кассира — «Создать без оплаты»; в waiter — «Создать заказ».
  const submit = page.getByRole('button', { name: /Создать(\s+(заказ|без оплаты))/i }).first()
  await submit.waitFor({ state: 'visible', timeout: 5000 })
  await submit.click()

  const response = await orderResponsePromise
  const body = await response.json()
  // Supabase возвращает массив одной записью или объект — поддерживаем оба.
  const row = Array.isArray(body) ? body[0] : body
  const num = row?.order_number ?? row?.orderNumber
  if (num == null) throw new Error(`Нет order_number в ответе: ${JSON.stringify(body).slice(0, 200)}`)
  // Дождёмся toast'а — индикатор завершения UI-цепочки.
  await page.getByText(/Заказ создан/i).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  return { orderNumber: String(num) }
}

/**
 * На /operations/orders открывает диалог действий для заказа с указанным
 * orderNumber (видим как «#N» в первой колонке).
 */
export async function openOrderActionsDialog(page: Page, orderNumber: string): Promise<void> {
  if (!page.url().includes('/operations/orders')) {
    await navigateTo(page, '/operations/orders')
  }
  // Используем accessibility role «row» — точное совпадение, а не подстрока.
  const row = page.getByRole('row', { name: new RegExp(`^#${orderNumber}\\s`) }).first()
  await row.waitFor({ state: 'visible', timeout: 15000 })
  await row.click()
  // Диалог появляется — у него есть кнопка «Отменить весь заказ» или «Закрыть и оплатить».
  await page.getByRole('button', { name: /Отменить весь заказ|Закрыть и оплатить/ }).first()
    .waitFor({ state: 'visible', timeout: 10000 })
}

type VoidReasonValue = 'guest_changed_mind' | 'kitchen_error' | 'wrong_order' | 'damaged' | 'staff_error'

/**
 * В открытом OrderActionsDialog: клик XCircle на первой позиции → set qty
 * (default = текущий qty позиции) → reason → submit. Ждёт toast «Отменено: …».
 */
export async function voidFirstItemInDialog(
  page: Page,
  opts?: { reason?: VoidReasonValue },
): Promise<void> {
  // XCircle — кнопка с title="Списать позицию (для отчётности)".
  const xButton = page.getByTitle('Списать позицию (для отчётности)').first()
  await xButton.waitFor({ state: 'visible', timeout: 10000 })
  await xButton.click()

  if (opts?.reason) {
    const select = page.locator('select').first()
    await select.selectOption(opts.reason)
  }

  const submit = page.getByRole('button', { name: /Отменить\s+\d+\s+из\s+\d+/i }).first()
  await submit.waitFor({ state: 'visible', timeout: 5000 })
  // Перехватим ответ на refetch voids, который дёргается после createVoid —
  // без этого тест читает Подытог до того, как setVoids(fresh) успел
  // отработать, и видит старую сумму (см. order-actions-dialog ~L693).
  const voidsResponse = page.waitForResponse(
    res => res.url().includes('/rest/v1/order_voids') && res.request().method() === 'GET' && res.ok(),
    { timeout: 10000 },
  ).catch(() => null)
  await submit.click()
  await page.getByText(/Отменено:/).first().waitFor({ state: 'visible', timeout: 10000 })
  await voidsResponse
  // Дать React отрендериться с новым voids state.
  await page.waitForTimeout(150)
}

/** Парсит число «347,00 TJS» → 347. */
export function parseTjs(s: string | null | undefined): number {
  if (!s) return 0
  const m = s.replace(/\s/g, '').match(/-?[\d.,]+/)
  if (!m) return 0
  return Number(m[0].replace(',', '.'))
}

/** Читает значение «Подытог: X TJS» из открытого OrderActionsDialog. */
export async function readDialogSubtotal(page: Page): Promise<number> {
  const row = page.getByText(/^\s*Подытог\s*$/).first()
  await row.waitFor({ state: 'visible', timeout: 5000 })
  const parent = row.locator('xpath=..')
  const text = (await parent.textContent()) ?? ''
  return parseTjs(text)
}
