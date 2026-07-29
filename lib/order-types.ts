import type { OrderType } from '@/lib/types'
import type { Restaurant } from '@/lib/types'

// Единый источник правды по типам заказа для нового POS.
//
// Раньше словарь { hall: 'Зал', takeaway: ..., delivery: 'Доставка' } был
// продублирован в восьми с лишним файлах, причём лейбл takeaway расходился:
// «Самовывоз» в одних местах и «С собой» в других. При добавлении доставки
// (052) это гарантировало бы разъезд ещё сильнее, поэтому новый и правленый
// код берёт лейблы отсюда. Старые экраны переводятся по мере касания — разом
// не трогаем, чтобы не тащить в этот коммит несвязанный рефакторинг.

// ORDER_TYPE_LABELS — короткая форма для кнопок POS (влезает в узкую кнопку).
export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  hall: 'ЗАЛ',
  takeaway: 'С СОБОЙ',
  delivery: 'ДОСТАВКА',
}

// ORDER_TYPE_TITLES — форма для заголовков, списков и чеков.
export const ORDER_TYPE_TITLES: Record<OrderType, string> = {
  hall: 'Зал',
  takeaway: 'С собой',
  delivery: 'Доставка',
}

// isTogo — «не зал»: заказ без стола, без обслуживания и без официанта.
// Доставка ведёт себя ровно как «с собой» — так и было задумано при её
// добавлении, отличается только меткой и контактами курьера.
export function isTogo(type: OrderType | string | null | undefined): boolean {
  return type === 'takeaway' || type === 'delivery'
}

// availableOrderTypes — какие типы показывать в переключателе POS.
//
// Доставка появляется третьей кнопкой только когда включена в настройках;
// выключение НЕ прячет уже созданные заказы-доставки, оно влияет только на
// выбор типа для нового заказа.
export function availableOrderTypes(rest: Restaurant | null | undefined): OrderType[] {
  const base: OrderType[] = ['hall', 'takeaway']
  return rest?.deliveryEnabled ? [...base, 'delivery'] : base
}

// isPrepayMode — «оплата вперёд»: заказ нельзя создать, не оплатив.
//
// Зеркалит серверный kitchenOnPay() (orders_runner.go): фастфуд включает режим
// сам, legacy-флаг kitchenOnPay оставлен для зала со столами. Держать логику
// в одном хелпере важно — если UI и бэк разойдутся, касса покажет кнопку
// «Создать без оплаты», а кухня всё равно не получит бегунок до оплаты.
export function isPrepayMode(rest: Restaurant | null | undefined): boolean {
  if (!rest) return false
  return rest.tablesEnabled === false || rest.kitchenOnPay === true
}

/**
 * canCreateWithoutPayment — можно ли создать заказ, не оплачивая его.
 *
 * В фастфуде нельзя: гость платит на кассе и сразу забирает. Но доставка —
 * исключение, и по делу: заказ принимают по телефону, а деньги приходят от
 * курьера позже. Без этого пришлось бы держать неоплаченный заказ в голове
 * до возвращения курьера.
 */
export function canCreateWithoutPayment(
  rest: Restaurant | null | undefined,
  type: OrderType | string | null | undefined,
): boolean {
  if (type === 'delivery') return true
  return !isPrepayMode(rest)
}

// needsDeliveryContacts — спросить ли телефон и адрес перед оплатой.
export function needsDeliveryContacts(
  rest: Restaurant | null | undefined,
  type: OrderType | string | null | undefined,
): boolean {
  return type === 'delivery' && (rest?.deliveryContactsRequired ?? true)
}
