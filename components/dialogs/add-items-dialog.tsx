'use client'

import {
  BottomSheet as Sheet,
  BottomSheetContent as SheetContent,
  BottomSheetHeader as SheetHeader,
  BottomSheetTitle as SheetTitle,
  BottomSheetDescription as SheetDescription,
} from '@/components/ui/bottom-sheet'
import { ChefHat, X } from 'lucide-react'
import { OrderComposer } from '@/components/order/order-composer'

interface AddItemsDialogProps {
  orderId: string
  open: boolean
  onClose: () => void
  onDone: () => void
  /** Optional context for the locked destination header (e.g. table name). */
  destinationLabel?: string
}

export function AddItemsDialog({ orderId, open, onClose, onDone, destinationLabel }: AddItemsDialogProps) {
  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <SheetContent className="md:h-full h-[100dvh] max-h-[100dvh] md:max-h-none w-screen md:w-auto md:max-w-5xl rounded-none md:rounded-lg flex flex-col p-0 gap-0 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border shrink-0">
          <SheetHeader className="space-y-0 flex-1 min-w-0">
            <SheetTitle className="flex items-center gap-2 text-base">
              <ChefHat className="size-5 text-primary" />
              Дозаказ
            </SheetTitle>
            <SheetDescription className="sr-only">Добавить блюда к заказу</SheetDescription>
          </SheetHeader>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="size-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0">
          {open && (
            <OrderComposer
              mode="add"
              orderId={orderId}
              compactMode
              destinationLabel={destinationLabel}
              onSubmitted={onDone}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
