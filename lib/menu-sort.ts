// Сортировка блюд в витрине POS/pos2 (060).
//
// По умолчанию — алфавит (А-Я, numeric-aware: «Пицца 10» < «Пицца 2» не бывает).
// Когда byPopularity=true — внутри категории самые продаваемые вверху по очереди
// (за окно, обычно 30 дней), а при равных/нулевых продажах тайбрейк — алфавит.
// Так хиты не «прыгают» случайно, а низ списка остаётся предсказуемым.

const alpha = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true })

export function sortMenuItems<T extends { id: string; name: string }>(
  items: T[],
  byPopularity: boolean,
  popularity: Map<string, number>,
): T[] {
  if (!byPopularity) return [...items].sort(alpha)
  return [...items].sort((a, b) => {
    const pa = popularity.get(a.id) ?? 0
    const pb = popularity.get(b.id) ?? 0
    if (pa !== pb) return pb - pa // хиты вверх
    return alpha(a, b)
  })
}
