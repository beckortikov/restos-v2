'use client'

import { useState } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { type Order } from '@/lib/types'
import { splitOrderEqual } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { dAdd, dDiv, dMul, dRound } from '@/lib/decimal'
import { Users, Minus, Plus } from 'lucide-react'
import { toast } from 'sonner'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  order: Order
  onSuccess: () => void
}

export function SplitBillDialog({ open, onOpenChange, order, onSuccess }: Props) {
  const [numGuests, setNumGuests] = useState(2)
  const [saving, setSaving] = useState(false)

  const servicePercent = order.servicePercent ?? 0
  const splitSubtotal = dRound(dDiv(order.total, numGuests))
  const splitService = dRound(dDiv(dMul(splitSubtotal, servicePercent), 100))
  const splitTotal = dAdd(splitSubtotal, splitService)

  const handleSplit = async () => {
    setSaving(true)
    try {
      await splitOrderEqual(order.id, numGuests, servicePercent)
      toast.success(`Счёт разделён на ${numGuests} частей`)
      onOpenChange(false)
      onSuccess()
    } catch (e) {
      console.error(e)
      toast.error('Ошибка разделения')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md rounded-xl">
        <DialogHeader>
          <DialogTitle>Разделить счёт</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {/* Order summary */}
          <div className="bg-muted/50 rounded-xl p-4">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Заказ</span>
              <span className="font-bold text-foreground">{formatCurrency(order.total)}</span>
            </div>
            {servicePercent > 0 && (
              <div className="flex justify-between text-sm mt-1">
                <span className="text-muted-foreground">Обслуживание {servicePercent}%</span>
                <span className="text-foreground">{formatCurrency(dRound(dDiv(dMul(order.total, servicePercent), 100)))}</span>
              </div>
            )}
          </div>

          {/* Guest count */}
          <div className="flex items-center justify-center gap-4">
            <button
              onClick={() => setNumGuests(Math.max(2, numGuests - 1))}
              className="size-10 rounded-xl border border-border flex items-center justify-center hover:bg-muted transition-colors"
            >
              <Minus className="size-4" />
            </button>
            <div className="text-center">
              <div className="flex items-center gap-2">
                <Users className="size-5 text-muted-foreground" />
                <span className="text-3xl font-bold text-foreground">{numGuests}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">гостей</p>
            </div>
            <button
              onClick={() => setNumGuests(Math.min(10, numGuests + 1))}
              className="size-10 rounded-xl border border-border flex items-center justify-center hover:bg-muted transition-colors"
            >
              <Plus className="size-4" />
            </button>
          </div>

          {/* Split preview */}
          <div className="bg-primary/5 rounded-xl p-4 space-y-2 border border-primary/20">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Каждый гость платит</p>
            <p className="text-2xl font-bold text-primary">{formatCurrency(splitTotal)}</p>
            <div className="text-xs text-muted-foreground space-y-0.5">
              <div className="flex justify-between">
                <span>Подитог</span>
                <span>{formatCurrency(splitSubtotal)}</span>
              </div>
              {servicePercent > 0 && (
                <div className="flex justify-between">
                  <span>Обслуживание {servicePercent}%</span>
                  <span>{formatCurrency(splitService)}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <button onClick={() => onOpenChange(false)}
            className="px-4 py-2.5 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted transition-colors">
            Отмена
          </button>
          <button onClick={handleSplit} disabled={saving}
            className="px-5 py-2.5 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50">
            {saving ? 'Разделение...' : `Разделить на ${numGuests}`}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
