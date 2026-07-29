// Общий период вкладок «Отчёты» (ДДС ↔ ОПиУ).
//
// У страниц разные компоненты фильтра и разные типы: ДДС использует
// RangePreset ('yesterday' есть, 'all' нет), ОПиУ — PeriodKey ('all' есть,
// 'yesterday' нет). Поэтому храним период как строку в одном ключе и при
// чтении проверяем, поддерживает ли его конкретная страница; если нет —
// откатываемся на 'month'. Так «выбрал июль → переключил вкладку → тот же
// июль» работает, а несовместимые значения не ломают экран.
//
// Баланс сюда не входит осознанно: бухгалтерский баланс — срез на текущий
// момент, диапазон дат для него не имеет смысла.

const KEY = 'finance:period'
const KEY_FROM = 'finance:period:from'
const KEY_TO = 'finance:period:to'

/** Прочитать общий период. Вернёт fallback, если значение не поддерживается страницей. */
export function readSharedPeriod<T extends string>(supported: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(KEY)
    if (v && (supported as readonly string[]).includes(v)) return v as T
  } catch {}
  return fallback
}

/** Запомнить период для остальных вкладок «Отчётов». */
export function writeSharedPeriod(period: string, from?: string, to?: string): void {
  try {
    localStorage.setItem(KEY, period)
    if (from !== undefined) localStorage.setItem(KEY_FROM, from)
    if (to !== undefined) localStorage.setItem(KEY_TO, to)
  } catch {}
}

/** Границы произвольного периода — чтобы «Свой» диапазон тоже переносился. */
export function readSharedCustomRange(): { from: string; to: string } {
  try {
    return {
      from: localStorage.getItem(KEY_FROM) ?? '',
      to: localStorage.getItem(KEY_TO) ?? '',
    }
  } catch {
    return { from: '', to: '' }
  }
}
