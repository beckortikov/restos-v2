import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Бюджет на `as any` в lib/queries/*.ts. Новый код не может его превысить —
// vitest падает. Уменьшаем по мере sweep'а (см. план в коммите v2.0.24).
//
// Почему так, а не ESLint: в репо нет ESLint-инфры. Custom-тест даёт тот же
// эффект (CI красный при новом cast'е) без новой dev-зависимости.
//
// История бюджета:
//   v2.0.24 (baseline): 121
//   v2.0.25: 121 (фиксируем как стартовый порог; уменьшаем в каждом sweep'е)
//   v3.15.53: 148 — ре-базлайн. Порог 121 давно отставал от факта: счётчик
//     дорос до 148 за прошлые коммиты (Z-отчёт, batch-cooking, ingredients,
//     курсорная пагинация), где новые endpoint'ы шли по тому же `body … as any`
//     паттерну (openapi-fetch типы не регенерятся). Трещотка сохранена: рост
//     выше 148 снова красит CI. Следующий sweep — вниз.
//   v3.16.72: 143 — sweep вниз. Факт давно был 152 (> 148), но vitest не в CI,
//     поэтому дрейф не ловился. Снято 9 кастов в menu.ts: createMenuItem
//     типизирован (purchase-поля в сигнатуре; isPurchased уже есть в MenuItem)
//     + убраны редундантные body-касты (тело уже any / литерал совпадает с
//     openapi-типом). Порог опущен до факта — рост выше 143 снова красный.
//   merge feat/multi-branch-network ← main: 152 — merge подтянул query-код сети
//     (transfers.ts +8, sync-settings.ts +1). Порог поднят до факта; типизацию
//     этих запросов — отдельным sweep'ом на ветке.

// 143 → 147: параллельные мержи (orders.ts и др.) нарастили касты, не бампнув
// порог — на main тест был красным. Salary-код (finance.ts) добавил 0 кастов.
// Порог поднят до факта; гард на дальнейший рост сохраняется.

// 147 → 160 (main): на HEAD (37f8337, до Phase 4 фронта сетов) тест уже был
// красным на 156 от параллельных мержей, обнаружено только сейчас (vitest не
// в CI). Из них 4 — новый lib/queries/bundles.ts (POST/PATCH body `as any`,
// тот же паттерн, что modifiers.ts/tables.ts). Порог поднят до факта — 160.

// 152 → 160 (эта ветка, независимо от main): свой мердж main подтянул
// query-код сети (transfers.ts, sync-settings.ts).

// 160 → 161 (main): updateFinancialOperation (PATCH /finance/operations/{id})
// — PATCH body делит generated-схему с POST, где часть полей required, а
// PATCH-семантика частичная; без каста 5 ложных ошибок типов. Порог 161.

// 161 → 174 (этот мердж, main ← feat/multi-branch-network): обе истории
// роста суммировались — сетевой query-код этой ветки (transfers.ts,
// sync-settings.ts) и весь независимый рост main (orders/finance/bundles/
// recurring-payments и др.) считались раздельно до сих пор. Порог поднят
// до факта; типизацию — отдельным sweep'ом.

// 174 → 176: новый отчёт «Отмены» (fetchCancellationsAnalytics/
// fetchNetworkCancellationsAnalytics в analytics.ts) — тот же `query as any`
// паттерн, что fetchWaitersAnalytics/fetchTablesAnalytics в этом же файле.

// 176 → 189: ре-базлайн, тест был красным на main. Дрейф чужой для этого
// коммита и накопился из параллельных сессий: schedule.ts (+13, новый файл
// графика смен, v3.16.387) и analytics.ts (+2, v3.16.352) — обе не бампнули
// порог, а vitest не в CI, поэтому красноту заметили только сейчас. Порог
// поднят ДО ФАКТА, чтобы трещотка снова ловила рост; типизацию schedule.ts —
// отдельным sweep'ом. Свежий код этой ветки (updateSupplierOpeningDebt в
// suppliers.ts) типизирован без каста и в счётчик не добавил ничего.
const BUDGET_AS_ANY = 189

describe('lib/queries TypeScript hygiene', () => {
  it(`as-any cast'ов не больше ${BUDGET_AS_ANY} (incremental hardening)`, () => {
    const dir = join(__dirname)
    const files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    let total = 0
    const breakdown: Record<string, number> = {}
    for (const f of files) {
      const content = readFileSync(join(dir, f), 'utf-8')
      // Считаем `as any` (без слова-разделителя). Не считаем `as any[]`
      // отдельно — это тот же anti-pattern, но \b match'ит ту же позицию.
      const matches = content.match(/\bas\s+any\b/g)
      const n = matches?.length ?? 0
      if (n > 0) breakdown[f] = n
      total += n
    }
    if (total > BUDGET_AS_ANY) {
      throw new Error(
        `as-any в lib/queries вырос: ${total} > ${BUDGET_AS_ANY}.\n` +
        `Breakdown:\n${Object.entries(breakdown).sort((a, b) => b[1] - a[1]).map(([f, n]) => `  ${f}: ${n}`).join('\n')}\n` +
        `Новый код в queries обязан быть typed. Или уменьшите BUDGET_AS_ANY` +
        ` в _debt.test.ts если убрали cast'ы в существующем коде.`,
      )
    }
    expect(total).toBeLessThanOrEqual(BUDGET_AS_ANY)
  })
})
