'use client'

import {
  BottomSheet as Dialog,
  BottomSheetContent as DialogContent,
  BottomSheetHeader as DialogHeader,
  BottomSheetTitle as DialogTitle,
  BottomSheetDescription as DialogDescription,
} from '@/components/ui/bottom-sheet'
import { X } from 'lucide-react'
import { type Table } from '@/lib/types'
import { OrderComposer } from '@/components/order/order-composer'

interface CreateOrderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  preselectedTable?: Table
  /** Suggested label when opening a new tab on a table that already has open orders. */
  defaultTabLabel?: string
  /** Called after the order is successfully created (for parent refresh). */
  onSubmitted?: (orderId: string) => void
}

export function CreateOrderDialog({
  open,
  onOpenChange,
  preselectedTable,
  defaultTabLabel,
  onSubmitted,
}: CreateOrderDialogProps) {
  const initialOrderType = preselectedTable ? 'hall' : undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:h-full h-[100dvh] max-h-[100dvh] md:max-h-none w-screen md:w-auto md:max-w-5xl rounded-none md:rounded-lg flex flex-col p-0 gap-0 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border shrink-0">
          <DialogHeader className="space-y-0 flex-1 min-w-0">
            <DialogTitle className="text-base font-semibold truncate">
              {preselectedTable ? `Заказ — ${preselectedTable.name}` : 'Новый заказ'}
            </DialogTitle>
            <DialogDescription className="sr-only">Выберите блюда и оформите заказ</DialogDescription>
          </DialogHeader>
          <button
            onClick={() => onOpenChange(false)}
            aria-label="Закрыть"
            className="size-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0">
          {open && (
            <OrderComposer
              mode="new"
              compactMode
              initialTableId={preselectedTable?.id}
              initialOrderType={initialOrderType}
              initialGuests={preselectedTable?.capacity ?? 1}
              initialTabLabel={defaultTabLabel}
              onSubmitted={(res) => {
                onSubmitted?.(res.orderId)
                onOpenChange(false)
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
