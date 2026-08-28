import { api, unwrap } from './_client'
import type { OrderType } from '@/lib/types'

// Delivery relay (091, ADR-003 продолжение) — central пробивает заказ
// доставки ЗА филиал: узкая очередь, отдельная от общего sync_log (тот
// синкает только терминальные заказы раз в interval_sec). Позиции — по
// network_menu_item_id (мастер-меню сети, см. fetchNetworkMenu в
// transfers.ts), резолвятся на филиале через menu_items.master_id.
// Заказ материализуется там же в течение секунд (DeliveryPuller) — деньги/
// сток/смена считаются филиалу как за любой другой заказ, печатается
// кухонный тикет + пречек с адресом/телефоном.

export interface DeliveryRelayItemInput {
  networkMenuItemId: string
  qty: string
  /** Комбинация атрибутов («Стандарт»), если позиция — вариант товара с
   *  атрибутами (092). Сеть не хранит id вариантов — сами лейблы, в порядке
   *  атрибутов продукта, единственный портируемый идентификатор. */
  variantLabels?: string[]
}

export interface CreateDeliveryRelayInput {
  targetRestaurantId: string
  /** hall|takeaway|delivery — секция кассы филиала, куда попадёт заказ.
   *  Не задано → delivery (092). */
  orderType?: OrderType
  items: DeliveryRelayItemInput[]
  deliveryPhone?: string
  deliveryAddress?: string
  comment?: string
}

export async function createDeliveryRelay(input: CreateDeliveryRelayInput): Promise<{ id: string }> {
  const r = await unwrap(api.POST('/api/v1/delivery-relay', {
    body: {
      target_restaurant_id: input.targetRestaurantId,
      order_type: input.orderType,
      items: input.items.map(i => ({ network_menu_item_id: i.networkMenuItemId, qty: i.qty, variant_labels: i.variantLabels })),
      delivery_phone: input.deliveryPhone,
      delivery_address: input.deliveryAddress,
      comment: input.comment,
    },
  }))
  return { id: (r as { id: string }).id }
}

// Дозаказ (094) в уже отправленный и подтверждённый (delivered) заказ —
// central не создаёт новый заказ, а добавляет позиции в существующий (тот же
// путь, что и «дозаказ» официанта вживую: AddItems, кухонный тикет только на
// новые позиции). parentRelayId — id ИСХОДНОЙ create-строки.
export async function createDeliveryRelayAmend(parentRelayId: string, items: DeliveryRelayItemInput[]): Promise<{ id: string }> {
  const r = await unwrap(api.POST('/api/v1/delivery-relay/{id}/amend', {
    params: { path: { id: parentRelayId } },
    body: {
      items: items.map(i => ({ network_menu_item_id: i.networkMenuItemId, qty: i.qty, variant_labels: i.variantLabels })),
    },
  }))
  return { id: (r as { id: string }).id }
}

export interface DeliveryRelayHistoryLine {
  name: string
  qty: string
}

export interface DeliveryRelayHistoryItem {
  id: string
  targetRestaurantId: string
  targetRestaurantName: string
  orderType: OrderType
  kind: 'create' | 'amend'
  parentRelayId: string | null
  /** Статус ТРАНСПОРТА (pending/delivered/failed) — НЕ статус самого заказа,
   *  см. orderStatus. */
  status: 'pending' | 'delivered' | 'failed'
  error: string | null
  localOrderId: string | null
  /** Состав ЭТОЙ relay-строки (создания или дозаказа), человеко-читаемые
   *  имена — как оператор узнаёт, какой это заказ (когда на филиал за смену
   *  ушло несколько, а телефон/адрес не всегда заполнены). */
  itemLines: DeliveryRelayHistoryLine[]
  /** Тот же номер, что видит кассир на филиале и на чеке. */
  orderNumber: number | null
  deliveryPhone: string | null
  deliveryAddress: string | null
  comment: string | null
  /** Реальный статус заказа (new/open/.../closed/cancelled) — приезжает той
   *  же сетевой репликацией, что и остальная отчётность (не живьём), пусто
   *  пока не долетело синком или заказ ещё не завершён на филиале. */
  orderStatus: string | null
  orderTotal: string | null
  createdAt: string
}

export async function fetchDeliveryRelayHistory(limit = 50): Promise<DeliveryRelayHistoryItem[]> {
  const env: any = await unwrap(api.GET('/api/v1/delivery-relay/history', { params: { query: { limit } } }))
  const rows = Array.isArray(env?.orders) ? (env.orders as Record<string, unknown>[]) : []
  return rows.map(r => ({
    id: r.id as string,
    targetRestaurantId: r.target_restaurant_id as string,
    targetRestaurantName: (r.target_restaurant_name as string) ?? '',
    orderType: (r.order_type as OrderType) ?? 'delivery',
    kind: (r.kind as 'create' | 'amend') ?? 'create',
    parentRelayId: (r.parent_relay_id as string | null) ?? null,
    status: r.status as 'pending' | 'delivered' | 'failed',
    error: (r.error as string | null) ?? null,
    localOrderId: (r.local_order_id as string | null) ?? null,
    itemLines: Array.isArray(r.item_lines) ? (r.item_lines as Record<string, unknown>[]).map(l => ({ name: l.name as string, qty: l.qty as string })) : [],
    orderNumber: (r.order_number as number | null) ?? null,
    deliveryPhone: (r.delivery_phone as string | null) ?? null,
    deliveryAddress: (r.delivery_address as string | null) ?? null,
    comment: (r.comment as string | null) ?? null,
    orderStatus: (r.order_status as string | null) ?? null,
    orderTotal: (r.order_total as string | null) ?? null,
    createdAt: r.created_at as string,
  }))
}
