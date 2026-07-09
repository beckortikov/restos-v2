import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'

function getDbPassword(): string {
  try {
    const out = execSync('security find-generic-password -s restos-v4 -a postgres-password -w', { encoding: 'utf8' }).trim()
    if (out.startsWith('go-keyring-base64:')) {
      const b64 = out.replace('go-keyring-base64:', '')
      return Buffer.from(b64, 'base64').toString('utf8').trim()
    }
    return out
  } catch (e) {
    // Fallback to default restos password
    return 'restos'
  }
}

test.describe('Warehouse & Financial Flow E2E', () => {
  test.beforeAll(async () => {
    // Clear and truncate database before running E2E test to guarantee clean state
    const pwd = getDbPassword()
    const tablesToTruncate = [
      'audit_log', 'print_jobs', 'printers',
      'order_item_modifiers', 'order_voids', 'order_items', 'orders',
      'stock_movements', 'tech_card_lines', 'ingredients',
      'cash_shift_operations', 'cash_shifts',
      'sessions', 'menu_items', 'users', 'restaurants',
      'suppliers', 'stock_receipts', 'stock_receipt_lines',
      'stock_writeoffs', 'stock_writeoff_lines',
      'financial_accounts', 'financial_operations', 'custom_categories'
    ]
    const truncateQuery = `TRUNCATE TABLE ${tablesToTruncate.join(', ')} CASCADE;`
    
    try {
      execSync(
        `PGPASSWORD="${pwd}" psql -h 127.0.0.1 -p 54330 -U restos -d restos -c "${truncateQuery}"`,
        { stdio: 'ignore' }
      )
      console.log('[E2E DB] Truncated test tables successfully.')
    } catch (e) {
      console.error('[E2E DB] Truncate error (trying fallback to standard 5432):', e.message)
      try {
        execSync(
          `PGPASSWORD="restos" psql -h 127.0.0.1 -p 5432 -U restos -d restos_v4_test -c "${truncateQuery}"`,
          { stdio: 'ignore' }
        )
        console.log('[E2E DB] Truncated test tables on port 5432 successfully.')
      } catch (err) {
        console.error('[E2E DB] All truncates failed. Proceeding anyway.', err.message)
      }
    }
  })

  test('E2E: bootstrap → seed → receipt → writeoff → POS sale → financial reconciliation', async ({ page }) => {
    // 1. Visit /login, we should be redirected to /bootstrap because the DB is clean
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')
    
    // Check if we are on the bootstrap page
    await page.waitForURL('**/bootstrap', { timeout: 10000 })
    
    // Fill the bootstrap form
    await page.getByPlaceholder('Например: Кафе Пушкин').fill('E2E Test Restaurant')
    await page.getByPlaceholder('••••').fill('1234')
    await page.getByRole('button', { name: 'Создать и войти' }).click()
    
    // The bootstrap form submit is followed by an auto-login token set.
    // However, since restos-auth-user is not set in localStorage, the AuthGuard redirects the user to the PIN login screen.
    // We will handle this redirection by logging in with PIN 1234 on the login screen.
    await page.waitForURL('**/login', { timeout: 15000 })
    await page.getByRole('button', { name: '1', exact: true }).click()
    await page.getByRole('button', { name: '2', exact: true }).click()
    await page.getByRole('button', { name: '3', exact: true }).click()
    await page.getByRole('button', { name: '4', exact: true }).click()

    // Wait for redirect to dashboard
    await page.waitForURL('**/dashboard', { timeout: 15000 })

    // Set license_expires_at in the DB to bypass LicenseGate
    const pwd = getDbPassword()
    const updateQuery = `UPDATE restaurants SET license_expires_at = '2030-01-01 00:00:00';`
    try {
      execSync(
        `PGPASSWORD="${pwd}" psql -h 127.0.0.1 -p 54330 -U restos -d restos -c "${updateQuery}"`,
        { stdio: 'ignore' }
      )
      console.log('[E2E DB] Set license expires at successfully.')
    } catch (e) {
      try {
        execSync(
          `PGPASSWORD="restos" psql -h 127.0.0.1 -p 5432 -U restos -d restos_v4_test -c "${updateQuery}"`,
          { stdio: 'ignore' }
        )
        console.log('[E2E DB] Set license expires at on 5432 successfully.')
      } catch (err) {
        console.error('[E2E DB] Failed to update license_expires_at:', err.message)
      }
    }

    // Reload the page to apply the active license status
    await page.reload()
    await page.waitForURL('**/dashboard', { timeout: 15000 })
    
    // 2. Programmatically seed demo data, create tech card, and open cash shift
    const { cashAccId } = await page.evaluate(async () => {
      const token = localStorage.getItem('restos-v4-token')
      const rid = localStorage.getItem('restos-v4-restaurant-id')
      const baseUrl = 'http://127.0.0.1:3002'
      
      async function safeFetch(url: string, options: any = {}) {
        const method = options.method || 'GET'
        const defaultHeaders: any = {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        }
        if (method !== 'GET') {
          defaultHeaders['Idempotency-Key'] = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8)
            return v.toString(16)
          })
        }
        const fullUrl = `${baseUrl}${url}`
        const res = await fetch(fullUrl, {
          ...options,
          method,
          headers: {
            ...defaultHeaders,
            ...options.headers
          }
        })
        if (!res.ok) {
          throw new Error(`Fetch ${fullUrl} failed (${res.status}): ${await res.text()}`)
        }
        return res
      }

      // Seed demo dataset (menu, ingredients, tables, zones)
      await safeFetch(`/api/v1/restaurants/${rid}/seed?dataset=demo`, { method: 'POST' })

      // Create Cash account
      const cashRes = await safeFetch('/api/v1/finance/accounts', {
        method: 'POST',
        body: JSON.stringify({ name: 'Касса', type: 'cash', balance: '1000' })
      })
      const cashAcc = await cashRes.json()

      // Create Bank account
      await safeFetch('/api/v1/finance/accounts', {
        method: 'POST',
        body: JSON.stringify({ name: 'Банк', type: 'bank', balance: '1000' })
      })

      // Find ingredient "Мясо" and menu item "Плов"
      const ingResp = await safeFetch('/api/v1/stock/ingredients', { method: 'GET' })
      const ingredients = (await ingResp.json()).data || []
      const meat = ingredients.find(i => i.name === 'Мясо')
      if (!meat) throw new Error('Meat ingredient not found')

      const menuResp = await safeFetch('/api/v1/menu/items', { method: 'GET' })
      const menuItems = (await menuResp.json()).data || []
      const plov = menuItems.find(m => m.name === 'Плов')
      if (!plov) throw new Error('Plov menu item not found')

      // Update meat price_per_unit to 20
      await safeFetch(`/api/v1/stock/ingredients/${meat.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ price_per_unit: '20' })
      })

      // Update plov cogs to 4
      await safeFetch(`/api/v1/menu/items/${plov.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ cogs: '4' })
      })

      // Create Tech Card line: Plov (0.2 kg of Meat)
      await safeFetch('/api/v1/menu/tech-cards', {
        method: 'POST',
        body: JSON.stringify({
          menu_item_id: plov.id,
          ingredient_id: meat.id,
          name: 'Мясо',
          qty: '0.2',
          unit: 'kg'
        })
      })

      // Open cash shift
      await safeFetch('/api/v1/shifts', {
        method: 'POST',
        body: JSON.stringify({ opening_balance: '100', account_id: cashAcc.id })
      })

      return { cashAccId: cashAcc.id }
    })

    // Give Vite / React Query a quick moment to fetch changes
    await page.waitForTimeout(500)

    // 3. Navigate to Stock Receipt (Оприходование)
    await page.goto('/warehouse/receipts/new')
    await page.waitForLoadState('domcontentloaded')
    
    // Create / Search supplier
    const supplierInput = page.getByPlaceholder('Поиск поставщика...')
    await supplierInput.fill('Тестовый Поставщик UI')
    const createSupplierBtn = page.getByRole('button', { name: /Создать поставщика/i })
    await createSupplierBtn.click()
    
    // Verify toast
    await expect(page.getByText('Поставщик «Тестовый Поставщик UI» создан')).toBeVisible({ timeout: 5000 })
    
    // Click "Мясо" ingredient to add to receipt
    const meatCard = page.locator('button').filter({ hasText: 'Мясо' }).first()
    await meatCard.click()
    
    // Find receipt item table row
    const meatRow = page.getByRole('row', { name: /Мясо/i })
    await expect(meatRow).toBeVisible()
    
    // Enter Qty (10) and Price (25) in inputs
    const qtyInput = meatRow.locator('input').nth(0)
    const priceInput = meatRow.locator('input').nth(1)
    await qtyInput.fill('10')
    await priceInput.fill('25')
    
    // Select Account to charge ("Касса")
    const accountSelect = page.locator('select').first()
    await accountSelect.selectOption(cashAccId)
    
    // Submit receipt
    await page.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Накладная создана')).toBeVisible({ timeout: 5000 })
    
    // 4. Navigate to Stock Write-off (Списание)
    await page.goto('/warehouse/writeoffs/new')
    await page.waitForLoadState('domcontentloaded')
    
    // Click "Мясо" ingredient to add to write-off
    const writeoffMeatCard = page.locator('button').filter({ hasText: 'Мясо' }).first()
    await writeoffMeatCard.click()
    
    // Enter description
    await page.getByPlaceholder('Укажите подробную причину списания...').fill('Тестовое списание брака E2E')
    
    // Submit write-off (default Qty is 1)
    await page.getByRole('button', { name: 'Оформить списание' }).click()
    await expect(page.getByText('Списание оформлено')).toBeVisible({ timeout: 5000 })
    
    // 5. Navigate to POS to perform Tech Card sale
    await page.goto('/operations/pos')
    await page.waitForLoadState('domcontentloaded')
    
    // Select Takeaway (С СОБОЙ) order type
    const takeawayBtn = page.getByRole('button', { name: /С СОБОЙ/i }).first()
    await takeawayBtn.waitFor({ state: 'visible', timeout: 10000 })
    await takeawayBtn.click()
    
    // Search and click "Плов"
    const searchInput = page.locator('input[placeholder="Поиск блюда (введите название)"]:visible').first()
    await searchInput.fill('Плов')
    const plovTile = page.getByRole('button', { name: /Плов/i }).first()
    await plovTile.click()
    
    // Click Cash Payment button to close the order
    const cashPayBtn = page.getByRole('button', { name: /Нал\s*·/i }).first()
    await cashPayBtn.click()
    
    // Verify toast
    await expect(page.getByText(/Оплачено/i).first()).toBeVisible({ timeout: 10000 })
    
    // 6. Reconciliation: verify Cash Account Balance (1000 - 250 + 45 = 795 TJS)
    await page.goto('/finance/accounts')
    await page.waitForLoadState('domcontentloaded')
    
    // Find the Cash account card and verify it has 795.00
    const cashCard = page.locator('button').filter({ hasText: 'Касса' })
    await expect(cashCard.getByText(/795/)).toBeVisible({ timeout: 10000 })
    
    // 7. Verify P&L Report
    await page.goto('/finance/pnl')
    await page.waitForLoadState('domcontentloaded')
    
    // Verify values in PnL page:
    // - Revenue (Выручка): 45
    // - COGS (Себестоимость): 4
    // - Write-offs (Списания): 22.5
    //   Средневзвешенная себестоимость: Мясо 10 кг@20 (сид+патч) + приход 10 кг@25
    //   = (10·20 + 10·25)/20 = 22.5/кг; списание 1 кг = 22.5.
    await expect(page.getByText('Выручка').first().locator('xpath=..')).toContainText(/45/)
    await expect(page.getByText('Себестоимость').first().locator('xpath=..')).toContainText(/4/)
    await expect(page.getByText('— Списания (брак/порча)').locator('xpath=..')).toContainText(/22[.,]5/)
    
    // 8. Verify Cash Flow Report
    await page.goto('/finance/cashflow')
    await page.waitForLoadState('domcontentloaded')

    // Select custom date range on Cash Flow page to end tomorrow so it includes today's operations
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = tomorrow.toISOString().split('T')[0] // "YYYY-MM-DD"
    
    await page.getByRole('button', { name: 'Произвольно' }).click()
    const customToInput = page.locator('input[type="date"]').nth(1)
    await customToInput.fill(tomorrowStr)
    
    // Verify values in Cashflow page:
    // - Inflow (Поступления): 45
    // - Outflow (Выплаты): 250
    await expect(page.getByText('Поступления', { exact: true }).locator('xpath=..')).toContainText(/45/)
    await expect(page.getByText('Выплаты', { exact: true }).locator('xpath=..')).toContainText(/250/)
  })
})
