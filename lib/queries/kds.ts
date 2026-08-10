import { api, unwrap } from './_client'

// KDS (per-dish кухонная доска). ВАЖНО: источник статусов здесь — это
// order_items.station_status (pending/cooking/ready/served), которым управляет
// кухонное приложение (Kotlin) через POST /kds/items/{id}/status. Это НЕ то же
// самое, что order.status (cooking/ready) — тот двигает только веб-экран кухни.
// ТВ-табло /board должно читать именно этот источник, иначе в фастфуде (где
// кухня работает из Kotlin-приложения) оно будет пустым.

export interface KdsBoardItem {
  id: string
  orderId: string
  orderNumber: number
  orderType: string
  name: string
  qty: string
  stationStatus: 'pending' | 'cooking' | 'ready' | 'served'
  createdAt: string
  /** Когда позиция последний раз сменила station_status (для «готово» — момент готовности). */
  statusAt: string
  /** Секунд с создания по ЧАСАМ СЕРВЕРА — прогресс считаем от него, не от часов ТВ. */
  ageSeconds: number
}

// fetchKdsItems — позиции «в работе» для кухонной доски. statuses — CSV-фильтр
// (пусто = дефолт бэка «в работе»). Для табло берём pending,cooking,ready:
// served уходит из выдачи, как только повар отметил «Выдан».
export async function fetchKdsItems(statuses?: string[]): Promise<KdsBoardItem[]> {
  const query = statuses && statuses.length ? { status: statuses.join(',') } : undefined
  const res: any = await unwrap(api.GET('/api/v1/kds/items', { params: { query: query as any } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : []
  return rows.map(r => ({
    id: r.id,
    orderId: r.order_id ?? '',
    orderNumber: r.order_number ?? 0,
    orderType: r.order_type ?? '',
    name: r.name ?? '',
    qty: r.qty ?? '',
    stationStatus: r.station_status ?? 'pending',
    createdAt: r.created_at ?? '',
    statusAt: r.status_at ?? r.created_at ?? '',
    ageSeconds: typeof r.age_seconds === 'number' ? r.age_seconds : 0,
  }))
}
