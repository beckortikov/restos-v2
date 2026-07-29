import type { OrderPayment, PaymentMethod } from '@/lib/types'

// Единый словарь способов оплаты.
//
// До этого словарь `{cash:'Наличные', card:'Карта', transfer:'Перевод'}` был
// продублирован в семи местах с расхождениями: где-то card/transfer оба
// назывались «Безналичные», где-то «Банк. карта», а про значение 'split'
// (которое бэкенд реально пишет в order.payment_method при смешанной оплате)
// знал ровно один файл — остальные показывали пустоту.
//
// Новый и правленый код берёт лейблы отсюда; старые экраны переводятся по
// мере касания, чтобы не тащить рефакторинг в несвязанные коммиты.

export const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Наличные',
  card: 'Карта',
  transfer: 'Перевод',
  split: 'Смешанная',
}

export function paymentLabel(method?: string | null): string {
  if (!method) return ''
  return PAYMENT_LABELS[method] ?? method
}

// isCashMethod — нужен, чтобы выбрать иконку (купюра vs карта).
export function isCashMethod(method?: string | null): boolean {
  return method === 'cash'
}

/**
 * describePayment — человекочитаемое «чем и куда» для закрытого заказа.
 *
 * Возвращает:
 *  - `label`: «Наличные» / «Карта» / «Смешанная»
 *  - `account`: имя счёта для одиночной оплаты («Касса», «Алиф»), пусто для смешанной
 *  - `parts`: расшифровка смешанной оплаты, по одной строке на часть
 *
 * Источник — order.payments (с 3.16.111 бэкенд заполняет его и для одиночной
 * оплаты, вместе с денормализованным account_name). Для заказов, закрытых до
 * этого, payments пуст — тогда откатываемся на order.paymentMethod без счёта:
 * счёт по ним хранится только в financial_operations и в списке недоступен.
 */
export interface PaymentSummary {
  label: string
  account: string
  parts: { method: string; label: string; amount: number; account: string }[]
  isMixed: boolean
}

export function describePayment(order: {
  paymentMethod?: string | null
  payments?: OrderPayment[] | null
}): PaymentSummary | null {
  const parts = (order.payments ?? []).map(p => ({
    method: p.method as string,
    label: paymentLabel(p.method),
    amount: p.amount,
    account: p.accountName ?? '',
  }))

  if (parts.length > 1) {
    return { label: PAYMENT_LABELS.split, account: '', parts, isMixed: true }
  }
  if (parts.length === 1) {
    return { label: parts[0].label, account: parts[0].account, parts, isMixed: false }
  }
  // Легаси: заказ закрыт до того, как payments стал заполняться всегда.
  if (order.paymentMethod) {
    return { label: paymentLabel(order.paymentMethod), account: '', parts: [], isMixed: order.paymentMethod === 'split' }
  }
  return null
}

// Узкий тип для мест, где метод точно один из трёх (выбор при оплате).
export const SINGLE_PAYMENT_METHODS: PaymentMethod[] = ['cash', 'card', 'transfer']
