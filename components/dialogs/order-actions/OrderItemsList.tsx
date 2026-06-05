'use client'

/**
 * OrderItemsList — список позиций заказа с inline-формой void (списания) +
 * выбора количества и причины. Извлечён из OrderActionsBody.
 *
 * State (`voidingItemIdx`, `voidReason`, `voidQty`, `voidedIndices`) — лежит в
 * родителе и пробрасывается; компонент чисто презентационный + вызывает
 * createVoid через переданный handler.
 */

import { memo } from 'react'
import { toast } from 'sonner'
import { XCircle } from 'lucide-react'
import { formatCurrency, calcLineTotal, formatQty } from '@/lib/helpers'
import { VOID_REASON_LABELS, type Order, type VoidReason, type OrderVoid } from '@/lib/types'
import { createVoid, fetchVoidsForOrder, cancelOrderItem, cancelOrderItemPartial } from '@/lib/queries'
import { useAuth } from '@/lib/auth-store'

interface MenuItemMeta {
  id: string
  cookTimeMin?: number | null
  station?: string
}

interface OrderItemsListProps {
  order: Order
  menuItemsData: MenuItemMeta[]
  voids: OrderVoid[]
  voidedFlagsFromDb: boolean[]
  voidedIndices: Set<number>
  setVoidedIndices: React.Dispatch<React.SetStateAction<Set<number>>>
  voidingItemIdx: number | null
  setVoidingItemIdx: (idx: number | null) => void
  voidReason: VoidReason
  setVoidReason: (r: VoidReason) => void
  voidQty: number
  setVoidQty: (q: number) => void
  setVoids: React.Dispatch<React.SetStateAction<OrderVoid[]>>
  canDoVoid: boolean
  isOwnAsWaiter: boolean
  onItemsChanged?: () => void
  /** v2.3.0: при true вместо `createVoid` (биллинговый void) используется
   *  `cancelOrderItem`/`cancelOrderItemPartial` — выставляет cancelled_at,
   *  AutoPrintRunner печатает кухонную «ОТМЕНА». Это поведение
   *  OrderActionsPanel (POS). Дефолт false сохраняет совместимость с
   *  TableDetailSheet / OrdersTab / Waiter. */
  useCancelItemApi?: boolean
}

function OrderItemsListInner({
  order,
  menuItemsData,
  voids,
  voidedFlagsFromDb,
  voidedIndices,
  setVoidedIndices,
  voidingItemIdx,
  setVoidingItemIdx,
  voidReason,
  setVoidReason,
  voidQty,
  setVoidQty,
  setVoids,
  canDoVoid,
  isOwnAsWaiter,
  onItemsChanged,
  useCancelItemApi,
}: OrderItemsListProps) {
  const { user } = useAuth()
  return (
    <div className="divide-y divide-border">
      {order.items.map((item, i) => {
        const mi = menuItemsData.find(m => m.id === item.menuItemId)
        const isVoided = voidedIndices.has(i) || voidedFlagsFromDb[i] || false
        const isVoiding = voidingItemIdx === i
        const isCancelled = !!item.cancelledAt
        const inActiveStatus = order.status === 'new' || order.status === 'cooking' || order.status === 'ready'
        const canVoidItem = !isCancelled && !isVoided && inActiveStatus && (canDoVoid || isOwnAsWaiter)
        const isWeight = item.unit === 'g' || item.unit === 'kg'
        const lineTotal = calcLineTotal(item.price, item.qty, item.unit, item.unitSize)
        const qtyLabel = isWeight ? formatQty(item.qty, item.unit) : `x${item.qty}`
        const visuallyMuted = isVoided || isCancelled
        return (
          <div key={i} className={`px-4 py-2.5 ${visuallyMuted ? 'opacity-50 bg-muted/30' : ''}`}>
            <div className="flex items-center justify-between">
              <div className="text-sm flex items-center gap-1 flex-wrap">
                <span className={`font-medium ${visuallyMuted ? 'line-through' : ''}`}>{item.name}</span>
                <span className="text-muted-foreground"> {qtyLabel}</span>
                {mi?.cookTimeMin && (
                  <span className="ml-1.5 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">⏱ {mi.cookTimeMin} мин</span>
                )}
                {mi && mi.station === 'bar' && (
                  <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">☕ Бар</span>
                )}
                {mi && mi.station === 'showcase' && (
                  <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">🥟 Витрина</span>
                )}
                {isVoided && (
                  <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-50 text-red-600">Списано</span>
                )}
                {isCancelled && (
                  <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-700">Отменено</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-sm font-medium ${visuallyMuted ? 'line-through' : ''}`}>
                  {formatCurrency(lineTotal)}
                </span>
                {canVoidItem && (
                  <button
                    onClick={() => { setVoidingItemIdx(isVoiding ? null : i); setVoidQty(item.qty) }}
                    className="text-red-400 hover:text-red-600 transition-colors p-0.5"
                    title="Списать позицию (для отчётности)"
                  >
                    <XCircle className="size-4" />
                  </button>
                )}
              </div>
            </div>
            {isCancelled && item.cancelReason && (
              <div className="mt-1 text-[11px] text-muted-foreground italic">
                Причина: {item.cancelReason}
              </div>
            )}
            {isVoiding && (
              <div className="mt-2 p-2.5 rounded-lg bg-red-50 border border-red-200 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <label className="text-[10px] text-red-600 font-medium">Кол-во для отмены</label>
                    <div className="flex items-center gap-1 mt-0.5">
                      <button onClick={() => setVoidQty(Math.max(1, voidQty - 1))}
                        className="size-6 rounded bg-white border border-red-200 text-red-600 text-xs font-bold flex items-center justify-center">−</button>
                      <span className="w-6 text-center text-sm font-bold text-red-700">{voidQty}</span>
                      <button onClick={() => setVoidQty(Math.min(item.qty, voidQty + 1))}
                        className="size-6 rounded bg-white border border-red-200 text-red-600 text-xs font-bold flex items-center justify-center">+</button>
                      <span className="text-[10px] text-red-500 ml-1">из {item.qty}</span>
                    </div>
                  </div>
                  <div className="flex-1">
                    <label className="text-[10px] text-red-600 font-medium">Причина</label>
                    <select
                      value={voidReason}
                      onChange={(e) => setVoidReason(e.target.value as VoidReason)}
                      className="w-full text-xs rounded-md border border-red-200 bg-white px-2 py-1.5 mt-0.5 focus:outline-none focus:ring-1 focus:ring-red-300"
                    >
                      {(Object.entries(VOID_REASON_LABELS) as [VoidReason, string][]).map(([val, label]) => (
                        <option key={val} value={val}>{label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <button
                  onClick={async () => {
                    try {
                      if (useCancelItemApi && item.id) {
                        // v2.3.0 POS-path: cancel_at + kitchen reprint.
                        const reasonLabel = VOID_REASON_LABELS[voidReason]
                        if (voidQty >= item.qty) {
                          await cancelOrderItem(item.id, reasonLabel, user?.id)
                        } else {
                          await cancelOrderItemPartial(item.id, voidQty, reasonLabel, user?.id)
                        }
                      } else {
                        await createVoid({
                          orderId: order.id,
                          itemName: item.name,
                          itemQty: voidQty,
                          itemPrice: item.price,
                          reason: voidReason,
                          menuItemId: item.menuItemId,
                        })
                      }
                      if (voidQty >= item.qty) {
                        setVoidedIndices(prev => new Set(prev).add(i))
                      }
                      setVoidingItemIdx(null)
                      setVoidReason('guest_changed_mind')
                      setVoidQty(0)
                      toast.success(`Отменено: ${item.name} × ${voidQty}`)
                      try {
                        const fresh = await fetchVoidsForOrder(order.id)
                        setVoids(fresh)
                      } catch {}
                      onItemsChanged?.()
                    } catch (e) {
                      toast.error(e instanceof Error ? `Ошибка отмены: ${e.message}` : 'Ошибка отмены')
                    }
                  }}
                  className="w-full text-xs font-medium bg-red-600 text-white rounded-md py-1.5 hover:bg-red-700 transition-colors"
                >
                  Отменить {voidQty} из {item.qty}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export const OrderItemsList = memo(OrderItemsListInner)
