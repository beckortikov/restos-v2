// Чистая логика ТВ-табло выдачи (/board) — без React/DOM, чтобы покрыть тестами.
// Табло сворачивает per-dish KDS-позиции (order_items.station_status, которым
// рулит кухонное приложение) в заказы: «Готовится» / «Готово».

import type { KdsBoardItem } from '@/lib/queries'

export const COOK_TARGET_MIN = 8 // на эту шкалу (мин) растёт полоса готовки

// Заказ, все позиции которого так и остались pending (никто не начал готовить) и
// старше этого порога, считаем брошенным и убираем с табло. Причина: позиция при
// создании получает station_status='pending' по умолчанию; заказы, которые
// никогда не попали на планшет кухни и не были передвинуты (незакрытые черновики,
// тестовые, заказы прошлого дня в рамках сегодняшней смены), иначе висят в
// «Готовится» вечно. cooking/ready показываем ВСЕГДА, независимо от возраста —
// их реально готовят / они ждут выдачи.
export const HIDE_STUCK_PENDING_MIN = 90

export type BoardOrder = {
  orderNumber: number
  cooking: boolean // есть позиции pending/cooking → ещё готовится
  maxAgeSeconds: number // возраст самой «старой» позиции — для полосы прогресса
  readyAt: string // когда заказ доготовился (max status_at готовых позиций)
}

// Свернуть per-dish позиции в заказы: заказ «готовится», пока есть хоть одна
// позиция pending/cooking; «готов», когда все оставшиеся позиции ready (served
// в выборку не попадают — уходят, как только повар отметил «Выдан»).
//
// hideStuckPendingSec — заказы, у которых ВСЕ позиции pending и старше порога,
// отбрасываем (см. HIDE_STUCK_PENDING_MIN): их никто не готовит, это мусор на
// табло. Заказ остаётся, если есть хоть одна cooking/ready позиция ИЛИ свежий
// pending (заказ только поступил и ждёт очереди — его показать надо).
export function aggregate(items: KdsBoardItem[], hideStuckPendingSec = HIDE_STUCK_PENDING_MIN * 60): BoardOrder[] {
  type Acc = BoardOrder & { active: boolean }
  const byOrder = new Map<number, Acc>()
  for (const it of items) {
    const n = it.orderNumber || 0
    if (!n) continue
    let o = byOrder.get(n)
    if (!o) {
      o = { orderNumber: n, cooking: false, maxAgeSeconds: 0, readyAt: '', active: false }
      byOrder.set(n, o)
    }
    const st = it.stationStatus
    const started = st === 'cooking' || st === 'ready'
    const freshPending = st === 'pending' && it.ageSeconds < hideStuckPendingSec
    if (started || freshPending) o.active = true
    if (st === 'pending' || st === 'cooking') o.cooking = true
    if (it.ageSeconds > o.maxAgeSeconds) o.maxAgeSeconds = it.ageSeconds
    if (st === 'ready' && it.statusAt > o.readyAt) o.readyAt = it.statusAt
  }
  // active=false ⇔ все позиции pending и старше порога → брошенный заказ, скрыть.
  return [...byOrder.values()].filter(o => o.active).map(({ active: _active, ...o }) => o)
}

// Прогресс готовки 0..1. Возраст берём по ЧАСАМ СЕРВЕРА (ageSeconds на момент
// загрузки) + дельту локальных часов с момента загрузки — иммунно к расхождению
// часов телевизора (сравниваем только дельты локального времени, не абсолют).
// Никогда не 0 и не 1: пустая/полная полоса читались бы как «стоит» / «уже готово».
export function cookProgress(o: BoardOrder, now: number, dataUpdatedAt: number): number {
  const elapsedMs = o.maxAgeSeconds * 1000 + Math.max(0, now - dataUpdatedAt)
  const p = elapsedMs / (COOK_TARGET_MIN * 60_000)
  return Math.min(0.97, Math.max(0.06, p))
}

// Разложить заказы на две колонки табло. «Готовится» — самый старый вверху
// (дольше всех ждёт); «Готово» — самый свежеготовый первым (для подсветки/звука).
export function splitBoard(orders: BoardOrder[]): { cooking: BoardOrder[]; ready: BoardOrder[] } {
  const cooking = orders.filter(o => o.cooking).sort((a, b) => b.maxAgeSeconds - a.maxAgeSeconds)
  const ready = orders.filter(o => !o.cooking).sort((a, b) => (b.readyAt || '').localeCompare(a.readyAt || ''))
  return { cooking, ready }
}
