import { api, unwrap, V4Error } from './_client'
import type {
  Order, OrderItem, OrderType, OrderStatus, PaymentMethod, OrderSplit,
  PaymentMethod as PaymentMethodType, OrderVoid, VoidReason,
} from '../types'
import { logAction } from './audit'
import {
  _mapV4Order, _mapV4Split, _mapV4Void,
} from './_mappers'
import { _findOrderIdForItem, _registerItems } from './_caches'

export interface FetchOrdersOptions {
  from?: string | Date
  to?: string | Date
  ids?: string[]
  shiftId?: string
  slim?: boolean
  /** Filter to orders on a specific table — server-side via ?table_id=. */
  tableId?: string
}

export async function fetchOrders(opts?: FetchOrdersOptions): Promise<Order[]> {
  const query: { limit: number; shift_id?: string; table_id?: string; from?: string; to?: string } = { limit: 1000 }
  if (opts?.shiftId) query.shift_id = opts.shiftId
  if (opts?.tableId) query.table_id = opts.tableId
  if (opts?.from) query.from = typeof opts.from === 'string' ? opts.from : opts.from.toISOString()
  if (opts?.to) query.to = typeof opts.to === 'string' ? opts.to : opts.to.toISOString()
  const env: any = await unwrap(api.GET('/api/v1/orders', { params: { query } }))
  let rows: any[] = Array.isArray(env?.data) ? env.data : Array.isArray(env) ? env : []
  if (opts?.ids && opts.ids.length > 0) {
    const set = new Set(opts.ids)
    rows = rows.filter(r => set.has(r.id))
  }
  const wantItems = !opts?.slim
  if (!wantItems) {
    return rows.map(r => _mapV4Order(r, []))
  }
  const out: Order[] = []
  for (const r of rows) {
    try {
      const detail: any = await unwrap(api.GET('/api/v1/orders/{id}', { params: { path: { id: r.id } } }))
      const items = detail?.items ?? detail?.order_items ?? []
      _registerItems(r.id, items)
      out.push(_mapV4Order(detail?.order ?? r, items))
    } catch {
      out.push(_mapV4Order(r, []))
    }
  }
  return out
}

export async function claimItemPrint(itemId: string): Promise<boolean> {
  const orderId = await _findOrderIdForItem(itemId)
  if (!orderId) return false
  try {
    const r: any = await unwrap(api.POST('/api/v1/orders/{id}/items/{itemId}/claim-print', {
      params: { path: { id: orderId, itemId } },
      body: { station: '', claimed_by: '' } as any,
    }))
    return !!r?.claimed
  } catch (e) {
    if (e instanceof V4Error && e.status === 409) return false
    return false
  }
}

export async function releaseItemPrint(itemId: string): Promise<void> {
  const orderId = await _findOrderIdForItem(itemId)
  if (!orderId) return
  try {
    await unwrap(api.POST('/api/v1/orders/{id}/items/{itemId}/release-print', {
      params: { path: { id: orderId, itemId } },
      body: {} as any,
    }))
  } catch {}
}

export async function markItemServed(itemId: string, servedBy?: string): Promise<void> {
  const orderId = await _findOrderIdForItem(itemId)
  if (!orderId) return
  try {
    await unwrap(api.POST('/api/v1/orders/{id}/items/{itemId}/served', {
      params: { path: { id: orderId, itemId } },
      body: { served_by: servedBy ?? null } as any,
    }))
  } catch {}
}

export async function unmarkItemServed(itemId: string): Promise<void> {
  const orderId = await _findOrderIdForItem(itemId)
  if (!orderId) return
  try {
    await unwrap(api.DELETE('/api/v1/orders/{id}/items/{itemId}/served', {
      params: { path: { id: orderId, itemId } },
    }))
  } catch {}
}

export async function claimItemCancelPrint(itemId: string): Promise<boolean> {
  const orderId = await _findOrderIdForItem(itemId)
  if (!orderId) return false
  try {
    const r: any = await unwrap(api.POST('/api/v1/orders/{id}/items/{itemId}/claim-cancel-print', {
      params: { path: { id: orderId, itemId } },
      body: { station: '', claimed_by: '' } as any,
    }))
    return !!r?.claimed
  } catch (e) {
    if (e instanceof V4Error && e.status === 409) return false
    return false
  }
}

export async function releaseItemCancelPrint(itemId: string): Promise<void> {
  const orderId = await _findOrderIdForItem(itemId)
  if (!orderId) return
  try {
    await unwrap(api.POST('/api/v1/orders/{id}/items/{itemId}/release-cancel-print', {
      params: { path: { id: orderId, itemId } },
      body: {} as any,
    }))
  } catch {}
}

export async function createOrder(order: { type: OrderType; tableId?: string; waiterId?: string; items: OrderItem[]; total: number; restaurantId?: string; shiftId?: string; guestsCount?: number; tabLabel?: string }) {
  const body: Record<string, unknown> = {
    type: order.type,
    table_id: order.tableId || null,
    shift_id: order.shiftId || null,
    guests_count: order.guestsCount && order.guestsCount > 0 ? order.guestsCount : null,
    comment: order.tabLabel && order.tabLabel.trim() ? order.tabLabel.trim() : null,
    items: order.items.map(i => ({
      menu_item_id: i.menuItemId,
      qty: String(i.qty),
      modifier_ids: (i.modifiers ?? []).map(m => m.modifierId).filter((x): x is string => !!x),
      // Snapshot overrides: позволяют кассе указать кастомные имя/цену/модификаторы
      // (для comp, скидок, кастомных единиц). Сервер делает shallow-merge поверх меню.
      name: i.name,
      price: i.price !== undefined ? String(i.price) : undefined,
      unit: i.unit,
      unit_size: i.unitSize !== undefined ? String(i.unitSize) : undefined,
      cogs: i.cogs !== undefined ? String(i.cogs) : undefined,
      modifiers: (i.modifiers ?? []).length
        ? (i.modifiers ?? []).map(m => ({
            modifier_id: m.modifierId,
            name: m.name,
            price: m.price !== undefined ? String(m.price) : undefined,
          }))
        : undefined,
    })),
  }
  const created: any = await unwrap(api.POST('/api/v1/orders', { body: body as any }))
  if (created?.id) {
    logAction('order.create', 'order', created.id, `Заказ ${order.type}`, {
      total: Number(created.total ?? 0),
      items: order.items.length,
      waiterId: order.waiterId ?? null,
      tableId: order.tableId ?? null,
    })
  }
  return created
}

export async function addItemsToOrder(orderId: string, newItems: import('../types').OrderItem[]): Promise<void> {
  if (!newItems.length) return
  const body = {
    items: newItems.map(i => ({
      menu_item_id: i.menuItemId,
      qty: String(i.qty),
      modifier_ids: (i.modifiers ?? []).map(m => m.modifierId).filter((x): x is string => !!x),
      name: i.name,
      price: i.price !== undefined ? String(i.price) : undefined,
      unit: i.unit,
      unit_size: i.unitSize !== undefined ? String(i.unitSize) : undefined,
      cogs: i.cogs !== undefined ? String(i.cogs) : undefined,
      modifiers: (i.modifiers ?? []).length
        ? (i.modifiers ?? []).map(m => ({
            modifier_id: m.modifierId,
            name: m.name,
            price: m.price !== undefined ? String(m.price) : undefined,
          }))
        : undefined,
    })),
  }
  const updated: any = await unwrap(api.POST('/api/v1/orders/{id}/items', {
    params: { path: { id: orderId } },
    body: body as any,
  }))
  if (updated?.id) {
    logAction('order.add_items', 'order', orderId, `Дозаказ +${newItems.length} поз.`, {
      newTotal: Number(updated.total ?? 0),
      items: newItems.map(i => i.name),
    })
  }
  return
}

export async function updateOrderTable(orderId: string, newTableId: string): Promise<void> {
  await unwrap(api.POST('/api/v1/orders/{id}/table', {
    params: { path: { id: orderId } },
    body: { new_table_id: newTableId } as any,
  }))
  logAction('order.move_table', 'order', orderId, undefined, { to: newTableId })
  return
}

export async function patchOrder(id: string, data: Partial<{ guestsCount: number; comment: string; customerId: string }>): Promise<void> {
  const body: Record<string, unknown> = {}
  if (data.guestsCount !== undefined) body.guests_count = data.guestsCount
  if (data.comment !== undefined) body.comment = data.comment
  if (data.customerId !== undefined) body.customer_id = data.customerId
  if (Object.keys(body).length === 0) return
  await unwrap(api.PATCH('/api/v1/orders/{id}', { params: { path: { id } }, body: body as any }))
}

export async function updateOrderStatus(id: string, status: OrderStatus, extra?: Partial<{ payment_method: string; ready_at: string; closed_at: string; cashier_id: string }>) {
  if (status === 'cancelled') {
    try { await cancelOrder(id, 'manual', extra?.cashier_id) } catch {}
  } else if (status === 'cooking') {
    await unwrap(api.POST('/api/v1/orders/{id}/start-cooking', {
      params: { path: { id } },
      body: extra?.cashier_id ? { cashier_id: extra.cashier_id } as any : {} as any,
    }))
  } else if (status === 'ready') {
    await unwrap(api.POST('/api/v1/orders/{id}/mark-ready', { params: { path: { id } }, body: {} as any }))
  } else if (status === 'served') {
    await unwrap(api.POST('/api/v1/orders/{id}/mark-served', { params: { path: { id } }, body: {} as any }))
  } else if (status === 'done') {
    console.warn('[updateOrderStatus] status=done requires payment — use closeOrderWithPayment')
  }
  logAction('order.status', 'order', id, status)
}

export async function deleteOrder(id: string) {
  try {
    await unwrap(api.POST('/api/v1/orders/{id}/cancel', {
      params: { path: { id } },
      body: { reason: 'deleted' } as any,
    }))
  } catch {}
  logAction('order.cancel', 'order', id)
}

interface CancelResult {
  cancelledItemIds: string[]
  newTotal: number
  cancelledTotal: number
  needsCancelPrint: boolean
}

export async function cancelOrderItem(orderItemId: string, reason: string, cancelledBy?: string): Promise<{ orderId: string; allCancelled: boolean; newTotal: number }> {
  if (!reason || !reason.trim()) throw new Error('Укажите причину отмены')
  const orderId = await _findOrderIdForItem(orderItemId)
  if (!orderId) throw new Error('Позиция не найдена')
  await unwrap(api.POST('/api/v1/orders/{id}/items/{itemId}/cancel', {
    params: { path: { id: orderId, itemId: orderItemId } },
    body: { reason: reason.trim() } as any,
  }))
  let newTotal = 0
  let allCancelled = false
  try {
    const detail: any = await unwrap(api.GET('/api/v1/orders/{id}', { params: { path: { id: orderId } } }))
    newTotal = Number(detail?.order?.total ?? 0)
    const items: any[] = detail?.items ?? []
    if (items.length > 0) allCancelled = items.every(i => !!i.cancelled_at)
  } catch {}
  void cancelledBy
  logAction('order.item.cancel', 'order_item', orderItemId, undefined, {
    orderId, reason: reason.trim(),
  })
  return { orderId, allCancelled, newTotal }
}

export async function cancelOrderItemPartial(
  itemId: string,
  qtyDelta: number,
  reason: string,
  cancelledBy?: string,
): Promise<{ orderId: string; allCancelled: boolean; newTotal: number }> {
  if (!reason || !reason.trim()) throw new Error('Укажите причину отмены')
  if (!qtyDelta || qtyDelta <= 0) throw new Error('Количество для отмены должно быть > 0')
  const orderId = await _findOrderIdForItem(itemId)
  if (!orderId) throw new Error('Позиция не найдена')
  await unwrap(api.POST('/api/v1/orders/{id}/items/{itemId}/cancel', {
    params: { path: { id: orderId, itemId } },
    body: { qty: String(qtyDelta), reason: reason.trim() } as any,
  }))
  let newTotal = 0
  let allCancelled = false
  try {
    const detail: any = await unwrap(api.GET('/api/v1/orders/{id}', { params: { path: { id: orderId } } }))
    newTotal = Number(detail?.order?.total ?? 0)
    const items: any[] = detail?.items ?? []
    if (items.length > 0) allCancelled = items.every(i => !!i.cancelled_at)
  } catch {}
  void cancelledBy
  logAction('order.item.partial_cancel', 'order_item', itemId, undefined, {
    orderId, cancelledQty: qtyDelta, reason: reason.trim(),
  })
  return { orderId, allCancelled, newTotal }
}

export async function cancelOrder(orderId: string, reason: string, cancelledBy?: string): Promise<CancelResult> {
  if (!reason || !reason.trim()) throw new Error('Укажите причину отмены')
  await unwrap(api.POST('/api/v1/orders/{id}/cancel', {
    params: { path: { id: orderId } },
    body: { reason: reason.trim() } as any,
  }))
  let cancelledItemIds: string[] = []
  let newTotal = 0
  let cancelledTotal = 0
  try {
    const detail: any = await unwrap(api.GET('/api/v1/orders/{id}', { params: { path: { id: orderId } } }))
    newTotal = Number(detail?.order?.total ?? 0)
    cancelledTotal = Number(detail?.order?.cancelled_total ?? 0)
    const items: any[] = detail?.items ?? []
    cancelledItemIds = items.filter(i => !!i.cancelled_at).map(i => i.id)
  } catch {}
  logAction('order.cancel', 'order', orderId, undefined, {
    reason: reason.trim(),
    cancelledItems: cancelledItemIds.length,
    cancelledTotal,
  })
  return { cancelledItemIds, newTotal, cancelledTotal, needsCancelPrint: cancelledItemIds.length > 0 }
}

export async function closeOrderWithPayment(
  orderId: string,
  paymentMethod: PaymentMethod,
  tableId: string | null,
  total: number,
  cogs: number,
  cashierId?: string,
  accountId?: string,
  accountName?: string,
  servicePercent?: number,
  serviceAmount?: number,
  totalWithService?: number,
  tipAmount?: number,
  discountAmount?: number,
  discountType?: string,
  discountValue?: number,
  discountReason?: string,
  payments?: import('../types').OrderPayment[],
) {
  void tableId; void total; void cogs; void accountName
  void serviceAmount; void discountAmount
  let shiftId: string | undefined
  try {
    const s: any = await unwrap(api.GET('/api/v1/shifts/active'))
    shiftId = s?.id
  } catch (e) {
    if (!(e instanceof V4Error && e.status === 404)) {
      // ignore — server might be temporarily down; client will retry
    }
  }
  if (!accountId) {
    try {
      const accs: any = await unwrap(api.GET('/api/v1/finance/accounts'))
      const arr: any[] = Array.isArray(accs?.data) ? accs.data : Array.isArray(accs) ? accs : []
      const want = paymentMethod === 'cash' ? 'cash' : 'bank'
      const match = arr.find(a => a.type === want) || arr[0]
      if (match?.id) accountId = match.id
    } catch {}
  }
  // Typed body — компилятор ловит missing/extra fields per openapi.yaml
  // (см. generated.ts components.requestBodies for /orders/{id}/close).
  // Передаём service_percent ВСЕГДА (включая 0), чтобы бэкенд знал, выключил
  // ли кассир toggle «Обслуживание». Без этого backend брал бы default ресторана
  // → sum(payments) != backend.total_with_service.
  type CloseBody = NonNullable<NonNullable<NonNullable<import('../api/generated').paths['/api/v1/orders/{id}/close']['post']['requestBody']>['content']['application/json']>>
  const body: CloseBody = {
    payment_method: paymentMethod as 'cash' | 'card' | 'transfer',
    account_id: accountId ?? '',
    shift_id: shiftId ?? '',
  }
  if (tipAmount && tipAmount > 0) body.tip_amount = String(tipAmount)
  if (servicePercent != null) body.service_percent = String(servicePercent)
  if (cashierId) body.cashier_id = cashierId
  if (discountType) body.discount_type = discountType as 'percent' | 'fixed'
  if (discountValue != null) body.discount_value = String(discountValue)
  if (discountReason) body.discount_reason = discountReason
  if (Array.isArray(payments) && payments.length > 0) {
    body.payments = payments.map(p => ({
      method: p.method as 'cash' | 'card' | 'transfer',
      amount: String(p.amount),
      account_id: p.accountId ?? '',
    }))
  }
  const closed = await unwrap(api.POST('/api/v1/orders/{id}/close', {
    params: { path: { id: orderId } },
    body,
  }))
  const finalTotal = totalWithService ?? Number(closed?.total_with_service ?? total)
  logAction('order.close', 'order', orderId, `Оплата ${paymentMethod}`, { total: finalTotal, paymentMethod })
  return closed
}

export async function deductStockForOrder(orderId: string) {
  void orderId
  return
}

export async function checkAutoReadyOrders(): Promise<string[]> {
  try {
    const r: any = await unwrap(api.POST('/api/v1/orders/auto-ready/check', { body: {} as any }))
    const ids: any = r?.order_ids ?? []
    return Array.isArray(ids) ? ids.map(String) : []
  } catch {
    return []
  }
}

export async function cleanupOrphanOrders(): Promise<number> {
  try {
    const r: any = await unwrap(api.POST('/api/v1/admin/cleanup/orphan-orders', { body: {} as any }))
    return Number(r?.cancelled ?? r?.cleaned ?? 0)
  } catch {
    return 0
  }
}

// ─── Splits ───────────────────────────────────────────────────────────────

export async function fetchOrderSplits(orderId: string): Promise<OrderSplit[]> {
  const env: any = await unwrap(api.GET('/api/v1/orders/{id}/splits', { params: { path: { id: orderId } } }))
  const arr: any[] = Array.isArray(env?.data) ? env.data : Array.isArray(env) ? env : []
  return arr.map(_mapV4Split)
}

export async function splitOrderEqual(orderId: string, numSplits: number, servicePercent: number) {
  // service_percent игнорируется бэком (берётся из order). Параметр оставлен
  // для backward-compat сигнатуры.
  void servicePercent
  await unwrap(api.POST('/api/v1/orders/{id}/splits/equal', {
    params: { path: { id: orderId } },
    body: { count: numSplits } as any,
  }))
}

// splitOrderByItems — отправляет в бэк группы с order_item_id (+ опциональным
// частичным qty). Сервер сам считает суммы по item.price и item.qty.
export async function splitOrderByItems(
  orderId: string,
  assignments: { splitNumber: number; items: { orderItemId: string; qty?: number }[] }[],
  servicePercent: number,
) {
  void servicePercent // сервер берёт service_percent из заказа; параметр сохранён для совместимости.
  await unwrap(api.POST('/api/v1/orders/{id}/splits/by-items', {
    params: { path: { id: orderId } },
    body: {
      groups: assignments.map(a => ({
        split_number: a.splitNumber,
        items: a.items.map(i => ({
          order_item_id: i.orderItemId,
          ...(i.qty != null ? { qty: String(i.qty) } : {}),
        })),
      })),
    } as any,
  }))
}

export async function paySplit(splitId: string, paymentMethod: PaymentMethodType, accountId: string, accountName: string, cashierId?: string) {
  await unwrap(api.POST('/api/v1/splits/{split_id}/pay', {
    params: { path: { split_id: splitId } },
    body: {
      payment_method: paymentMethod,
      account_id: accountId,
      account_name: accountName,
      cashier_id: cashierId ?? null,
    } as any,
  }))
}

export async function checkAndCloseOrder(orderId: string) {
  try {
    await unwrap(api.POST('/api/v1/orders/{id}/check-and-close', {
      params: { path: { id: orderId } },
      body: {} as any,
    }))
  } catch (e) {
    if (e instanceof V4Error && e.status === 404) return
    throw e
  }
}

export async function cancelSplits(orderId: string) {
  await unwrap(api.POST('/api/v1/orders/{id}/splits/cancel', {
    params: { path: { id: orderId } },
    body: {} as any,
  }))
}

export async function setOrderItemNote(orderId: string, itemId: string, note: string | null): Promise<void> {
  await unwrap(api.PATCH('/api/v1/orders/{id}/items/{itemId}/note', {
    params: { path: { id: orderId, itemId } },
    body: { note } as any,
  }))
  logAction('order.item.note', 'order_item', itemId, undefined, { orderId, note })
}

export async function printPreBill(orderId: string): Promise<{ jobId: string; status: string }> {
  const res: any = await unwrap(api.POST('/api/v1/orders/{id}/print-pre-bill', {
    params: { path: { id: orderId } },
  }))
  logAction('order.pre_bill.print', 'order', orderId)
  return { jobId: res?.job_id ?? '', status: res?.status ?? 'pending' }
}

export async function reopenOrder(orderId: string): Promise<void> {
  await unwrap(api.POST('/api/v1/orders/{id}/reopen', {
    params: { path: { id: orderId } },
    body: {} as any,
  }))
  logAction('order.reopen', 'order', orderId, 'Заказ открыт для редактирования')
}

// ─── Voids ────────────────────────────────────────────────────────────────

export async function createVoid(data: {
  orderId: string
  itemName: string
  itemQty: number
  itemPrice: number
  reason: VoidReason | string
  menuItemId?: string
}): Promise<OrderVoid> {
  const stored = typeof window !== 'undefined' ? localStorage.getItem('restos-auth-user') : null
  const currentUser = stored ? JSON.parse(stored) : null

  const row: any = await unwrap(api.POST('/api/v1/voids', {
    body: {
      order_id: data.orderId,
      item_name: data.itemName,
      item_qty: data.itemQty,
      item_price: String(data.itemPrice),
      reason: data.reason,
      approved_by_name: currentUser?.name ?? null,
      created_by_name: currentUser?.name ?? null,
    } as any,
  }))
  void data.menuItemId
  await logAction('order.void', 'order', data.orderId, data.itemName, {
    qty: data.itemQty,
    reason: data.reason,
    price: data.itemPrice,
  })
  return _mapV4Void(row)
}

export async function fetchVoidsForOrder(orderId: string): Promise<OrderVoid[]> {
  const env: any = await unwrap(api.GET('/api/v1/orders/{id}/voids', { params: { path: { id: orderId } } }))
  const arr: any[] = Array.isArray(env?.data) ? env.data : Array.isArray(env) ? env : []
  return arr.map(_mapV4Void)
}

export async function fetchVoidsForOrders(orderIds: string[]): Promise<Map<string, OrderVoid[]>> {
  const out = new Map<string, OrderVoid[]>()
  if (orderIds.length === 0) return out
  const env: any = await unwrap(api.GET('/api/v1/voids', { params: { query: { order_ids: orderIds.join(',') } } }))
  const arr: any[] = Array.isArray(env?.data) ? env.data : Array.isArray(env) ? env : []
  for (const r of arr) {
    const v = _mapV4Void(r)
    const existing = out.get(v.orderId)
    if (existing) existing.push(v)
    else out.set(v.orderId, [v])
  }
  return out
}
