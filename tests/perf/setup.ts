import { Page } from '@playwright/test'

export const PERF_API = process.env.PERF_API || 'http://localhost:3001'

/**
 * Перед загрузкой любой страницы выставляем `window.restosDesktop`, чтобы
 * lib/supabase.ts:18 переключился на локальный сервер вместо облака.
 *
 * `addInitScript` гарантирует, что код выполняется ДО React-инициализации
 * (раньше любого `import.meta.env`-обращения к VITE_SUPABASE_URL).
 */
export async function injectDesktopShim(page: Page): Promise<void> {
  await page.addInitScript((apiUrl) => {
    ;(window as any).restosDesktop = { apiUrl, version: 'perf-test' }
    // Подсказываем фронту что мы в local-mode (на всякий случай).
    try {
      localStorage.setItem('restos-active-mode', 'local')
      localStorage.setItem('restos-local-server-url', apiUrl)
    } catch {}
  }, PERF_API)
}
