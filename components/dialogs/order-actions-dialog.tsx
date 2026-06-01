'use client'

/**
 * OrderActionsDialog — тонкий Sheet-wrapper вокруг OrderActionsBody.
 * Раньше тут было 1469 строк (вся логика payments/discount/void/split/cancel
 * inline). Внутренности извлечены в components/dialogs/order-actions-body.tsx
 * чтобы переиспользовать из TableDetailSheet (карта зала) без дублирования.
 */

import {
  BottomSheet as Sheet,
  BottomSheetContent as SheetContent,
  BottomSheetHeader as SheetHeader,
  BottomSheetTitle as SheetTitle,
  BottomSheetDescription as SheetDescription,
} from '@/components/ui/bottom-sheet'
import { ORDER_STATUS_LABELS, type Order, type OrderStatus } from '@/lib/types'
import { OrderActionsBody, type OrderActionData } from './order-actions-body'

export type { OrderActionData } from './order-actions-body'

interface OrderActionsDialogProps {
  order: Order | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onAction: (action: string, data?: OrderActionData) => void
  onItemsChanged?: () => void
}

const STATUS_STYLE: Record<OrderStatus, { bg: string; text: string }> = {
  new: { bg: 'bg-blue-100', text: 'text-blue-700' },
  cooking: { bg: 'bg-amber-100', text: 'text-amber-700' },
  ready: { bg: 'bg-emerald-100', text: 'text-emerald-700' },
  served: { bg: 'bg-teal-100', text: 'text-teal-700' },
  bill_requested: { bg: 'bg-rose-100', text: 'text-rose-700' },
  done: { bg: 'bg-muted', text: 'text-muted-foreground' },
  cancelled: { bg: 'bg-zinc-200', text: 'text-zinc-700' },
}

const TYPE_LABELS: Record<string, string> = {
  hall: 'Зал',
  delivery: 'Доставка',
  takeaway: 'Самовывоз',
}

export function OrderActionsDialog({
  order,
  open,
  onOpenChange,
  onAction,
  onItemsChanged,
}: OrderActionsDialogProps) {
  if (!order) return null

  const style = STATUS_STYLE[order.status] ?? STATUS_STYLE.new

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="md:h-full h-[95vh] flex flex-col md:!max-w-lg lg:!max-w-xl p-0">
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle className="flex items-center gap-3">
            <span>Заказ #{order.orderNumber ?? order.id.slice(0, 8)}</span>
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium ${style.bg} ${style.text}`}
            >
              {ORDER_STATUS_LABELS[order.status]}
            </span>
          </SheetTitle>
          <SheetDescription>
            {TYPE_LABELS[order.type]}
          </SheetDescription>
        </SheetHeader>

        <OrderActionsBody
          key={order.id}
          order={order}
          onAction={onAction}
          onClose={() => onOpenChange(false)}
          onItemsChanged={onItemsChanged}
          hideMeta
        />
      </SheetContent>
    </Sheet>
  )
}
