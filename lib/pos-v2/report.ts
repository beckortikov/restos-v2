// Чистые хелперы отчёта по смене /pos2 — вынесены из app/pos2/shift/page.tsx.

/** Процент изменения cur относительно was (для дельт vs прошлая смена).
 *  Возвращает null, если базы для сравнения нет (was <= 0) — тогда чип не
 *  показываем. */
export function deltaPct(cur: number, was: number): number | null {
  if (!(was > 0)) return null
  return ((cur - was) / was) * 100
}
