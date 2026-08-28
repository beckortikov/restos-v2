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
