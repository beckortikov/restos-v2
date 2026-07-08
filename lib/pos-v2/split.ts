// Чистая логика «разделить счёт по позициям» /pos2 — вынесена из
// app/pos2/ticket/page.tsx. Сервер сам считает суммы по item.price×qty;
// клиент только группирует позиции по назначенной части.

export interface ItemAssignment {
  splitNumber: number
  items: { orderItemId: string }[]
}

/** Группирует id позиций по назначенной части (1..parts). Пустые части
 *  опускаются, поэтому длина результата = число непустых частей.
 *
 *  itemPart: map orderItemId → номер части; отсутствующие считаются частью 1.
 *  Часть, вышедшая за диапазон [1, parts] (например пользователь уменьшил число
 *  частей уже после назначения), клампится в диапазон — так позиция никогда не
 *  выпадает из счёта целиком (иначе была бы неоплаченной). */
export function buildItemAssignments(
  itemIds: string[],
  itemPart: Record<string, number>,
  parts: number,
): ItemAssignment[] {
  const total = Math.max(1, Math.floor(parts))
  const partOf = (id: string): number => {
    const raw = itemPart[id] ?? 1
    if (!(raw >= 1)) return 1
    return raw > total ? total : Math.floor(raw)
  }
  const out: ItemAssignment[] = []
  for (let p = 1; p <= total; p++) {
    const items = itemIds
      .filter(id => partOf(id) === p)
      .map(id => ({ orderItemId: id }))
    if (items.length) out.push({ splitNumber: p, items })
  }
  return out
}

/** Разбиение валидно, только если позиции разнесены минимум на 2 части. */
export function isSplitValid(assignments: ItemAssignment[]): boolean {
  return assignments.length >= 2
}
