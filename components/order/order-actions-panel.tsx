'use client'

/**
 * OrderActionsPanel — inline-панель действий по существующему заказу в POS.
 *
 * v2.3.0 (major UI унификация): раньше это был полностью независимый
 * компонент (1265 строк) с собственной логикой items/discount/service/
 * mixed-payments/cancel/pre-check. Тот же набор действий жил в
 * OrderActionsBody (под TableDetailSheet / OrderActionsDialog). Драфт
 * накапливался, кнопки разъезжались.
 *
 * Теперь Panel — тонкий wrapper над OrderActionsBody (~80 строк), который:
 *   • Транслирует action-payload OrderActionsBody'я в direct API-вызовы
 *     (closeOrderWithPayment, cancelOrder, reopenOrder).
 *   • Пробрасывает результаты в `onClosed` / `onCancelled` / `onItemsChanged`
 *     callbacks, которые POS-композер использует для refresh tabs + сбросить
 *     selectedExistingOrderId.
 *   • Включает useCancelItemApi=true — кассирский void = cancel_at + kitchen
 *     reprint (поведение Panel v2.0+). В Sheet-консьюмерах остаётся
 *     старый createVoid (билл-void), пока не флипнем default в будущем.
 *   • liveTimeTick=true — счётчик «X мин назад» в Body тикает каждые 30 с.
 *
 * onOpenAdvanced (опционально): кнопка «Дополнительно» в Body не нужна, но
 * для совместимости с composer'ом prop остаётся — composer всё ещё может
 * открыть OrderActionsDialog поверх для расширенных сценариев. В новой
 * Body вся нужная функциональность уже есть (split-bill, mixed-payments,
 * reopen, tips), так что в v2.3+ kasse Advanced-сценарии должны быть
 * редкостью.
 */

import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import { cancelOrder, closeOrderWithPayment, reopenOrder, updateOrderStatus } from '@/lib/queries'
import { calcLineCogs } from '@/lib/helpers'
import type { Order, User } from '@/lib/types'
import { OrderActionsBody, type OrderActionData } from '@/components/dialogs/order-actions-body'

interface OrderActionsPanelProps {
  order: Order
  /** Список пользователей — был нужен в legacy для inline waiter-picker'а.
   *  В новой Body waiter-picker внутри meta-блока (через fetchUsers). Prop
   *  оставлен для совместимости signature, не используется. */
  users?: User[]
  onClosed?: () => void
  onCancelled?: () => void
  onItemsChanged?: () => void
  /** Открыть legacy OrderActionsDialog поверх — для редких сценариев,
   *  не покрытых унифицированной Body. v2.3.0 — Body уже покрывает всё,
   *  поэтому кнопка опциональна и в большинстве случаев не нужна. */
  onOpenAdvanced?: () => void
}

export function OrderActionsPanel({
  order,
  users: _users,
  onClosed,
  onCancelled,
  onItemsChanged,
  onOpenAdvanced: _onOpenAdvanced,
}: OrderActionsPanelProps) {
  const { user } = useAuth()

  const handleAction = useCallback(async (action: string, data?: OrderActionData) => {
    try {
      if (action === 'close_and_pay') {
        const cogs = data?.cogs ?? order.items.reduce(
          (s, i) => s + calcLineCogs(i.cogs || 0, i.qty, i.unit, i.unitSize),
          0,
        )
        await closeOrderWithPayment(
          order.id,
          data?.paymentMethod || 'cash',
          order.tableId || null,
          order.total,
          cogs,
          user?.id,
          data?.accountId,
          data?.accountName,
          data?.servicePercent,
          data?.serviceAmount,
          data?.totalWithService,
          data?.tipAmount,
          data?.discountAmount,
          data?.discountType,
          data?.discountValue,
          data?.discountReason,
          data?.payments,
          data?.skipReceipt,
        )
        toast.success(data?.skipReceipt ? 'Заказ закрыт без печати' : 'Заказ оплачен · чек на печать')
        onClosed?.()
      } else if (action === 'cancel') {
        // OrderCancelForm внутри Body уже сам вызвал cancelOrder API —
        // здесь только сигналим родителю обновить tabs/освободить стол.
        onCancelled?.()
      } else if (action === 'cancel_legacy') {
        // На случай если Body перейдёт на onAction('cancel_legacy') —
        // делаем явный API call. Сейчас не используется.
        await cancelOrder(order.id, 'Отменено кассиром', user?.id)
        onCancelled?.()
      } else if (action === 'reopen') {
        await reopenOrder(order.id)
        toast.success('Заказ открыт для редактирования')
        onItemsChanged?.()
      } else if (action === 'mark_ready') {
        await updateOrderStatus(order.id, 'ready', { ready_at: new Date().toISOString() })
        toast.success('Заказ готов к выдаче')
        onItemsChanged?.()
      } else if (action === 'start_cooking') {
        await updateOrderStatus(order.id, 'cooking')
        toast.success('Заказ отправлен на кухню')
        onItemsChanged?.()
      } else if (action === 'refresh') {
        onItemsChanged?.()
      }
    } catch (e) {
      toast.error(e instanceof Error ? `Ошибка: ${e.message}` : 'Ошибка операции')
    }
  }, [order, user?.id, onClosed, onCancelled, onItemsChanged])

  // onClose в OrderActionsBody вызывается когда Body «дозаказ» уводит в POS
  // (через goToAddItems) или хочет закрыть containing Sheet. В POS-композере
  // нечего закрывать (сайдбар не сворачивается), поэтому no-op. Body всё
  // равно сам делает navigate(...) куда нужно.
  const noop = useCallback(() => {}, [])

  return (
    <OrderActionsBody
      order={order}
      onAction={handleAction}
      onClose={noop}
      onItemsChanged={onItemsChanged}
      useCancelItemApi
      liveTimeTick
      lockServicePercent
    />
  )
}
