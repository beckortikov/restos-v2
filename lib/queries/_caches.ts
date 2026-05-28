// Module-level caches shared across queries. Kept in their own module so
// every importing domain file sees the same singleton Map instance.
import { api, unwrapOr404 } from './_client'

// Item-id → order-id cache, populated on every fetchOrders/getOrder. Items
// don't carry their order_id back to several FE callers, so we resolve via
// this map. On miss → point lookup via GET /api/v1/order-items/{id}.
export const _orderItemIndex = new Map<string, string>()

export function _registerItems(orderId: string, items?: { id?: string }[] | null) {
  if (!Array.isArray(items)) return
  for (const it of items) {
    if (it && typeof it.id === 'string') _orderItemIndex.set(it.id, orderId)
  }
}

export async function _findOrderIdForItem(itemId: string): Promise<string | null> {
  const cached = _orderItemIndex.get(itemId)
  if (cached) return cached
  const row: any = await unwrapOr404(api.GET('/api/v1/order-items/{id}', { params: { path: { id: itemId } } }))
  if (!row) return null
  const orderId: string | undefined = row?.order_id
  if (orderId) {
    _orderItemIndex.set(itemId, orderId)
    return orderId
  }
  return null
}
