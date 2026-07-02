import { api, unwrap } from './_client'

// fetchAllPages — тянет ВСЕ страницы list-эндпоинта через курсор.
//
// Зачем: бэк зажимает limit до 200 (cursor.MaxLimit). Запрос вида
// `{ limit: 2000 }` молча возвращает только первые 200 строк, остальное
// теряется («блюда/товары свыше 200 пропадали»). Правильно — идти по
// next_cursor до конца.
//
// path — литерал эндпоинта (типы openapi обходим `as any`, т.к. helper общий).
// baseQuery — дополнительные query-параметры (include, from/to, фильтры).
// maxRows — потолок для append-only потоков (движения/логи), чтобы не тянуть
// всю историю. Для ограниченных каталогов (ингредиенты, блюда) не задаём.
export async function fetchAllPages(
  path: string,
  baseQuery: Record<string, unknown> = {},
  maxRows?: number,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  let cursor: string | undefined
  for (let guard = 0; guard < 1000; guard++) {
    const query: Record<string, unknown> = { ...baseQuery, limit: 200 }
    if (cursor) query.cursor = cursor
    const res: any = await unwrap((api.GET as any)(path, { params: { query } }))
    const page: Record<string, unknown>[] = Array.isArray(res?.data) ? res.data : []
    rows.push(...page)
    cursor = (res?.next_cursor as string) || undefined
    if (!cursor || page.length === 0) break
    if (maxRows != null && rows.length >= maxRows) break
  }
  return rows
}
