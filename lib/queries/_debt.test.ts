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

const BUDGET_AS_ANY = 121

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
