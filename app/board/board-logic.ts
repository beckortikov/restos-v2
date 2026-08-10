// Чистая логика ТВ-табло выдачи (/board) — без React/DOM, чтобы покрыть тестами.
// Табло сворачивает per-dish KDS-позиции (order_items.station_status, которым
// рулит кухонное приложение) в заказы: «Готовится» / «Готово».

import type { KdsBoardItem } from '@/lib/queries'

export const COOK_TARGET_MIN = 8 // на эту шкалу (мин) растёт полоса готовки

export type BoardOrder = {
  orderNumber: number
  cooking: boolean // есть позиции pending/cooking → ещё готовится
  maxAgeSeconds: number // возраст самой «старой» позиции — для полосы прогресса
  readyAt: string // когда заказ доготовился (max status_at готовых позиций)
}

// Свернуть per-dish позиции в заказы: заказ «готовится», пока есть хоть одна
// позиция pending/cooking; «готов», когда все оставшиеся позиции ready (served
// в выборку не попадают — уходят, как только повар отметил «Выдан»).
export function aggregate(items: KdsBoardItem[]): BoardOrder[] {
  const byOrder = new Map<number, BoardOrder>()
  for (const it of items) {
    const n = it.orderNumber || 0
    if (!n) continue
    let o = byOrder.get(n)
    if (!o) {
      o = { orderNumber: n, cooking: false, maxAgeSeconds: 0, readyAt: '' }
      byOrder.set(n, o)
    }
    if (it.stationStatus === 'pending' || it.stationStatus === 'cooking') o.cooking = true
    if (it.ageSeconds > o.maxAgeSeconds) o.maxAgeSeconds = it.ageSeconds
    if (it.stationStatus === 'ready' && it.statusAt > o.readyAt) o.readyAt = it.statusAt
  }
  return [...byOrder.values()]
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
