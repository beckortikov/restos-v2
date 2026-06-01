'use client'

/**
 * OrderTotalsBlock — блок «Подытог / Скидка / Обслуживание / Чаевые / Итого»,
 * который рендерится в нижней части списка позиций. Презентационный.
 */

import { formatCurrency } from '@/lib/helpers'

interface OrderTotalsBlockProps {
  subtotal: number
  discountAmount: number
  includeService: boolean
  servicePercent: number
  serviceAmount: number
  tipAmount: number
  totalWithService: number
}

export function OrderTotalsBlock({
  subtotal,
  discountAmount,
  includeService,
  servicePercent,
  serviceAmount,
  tipAmount,
  totalWithService,
}: OrderTotalsBlockProps) {
  const hasExtras = discountAmount > 0 || (includeService && serviceAmount > 0) || tipAmount > 0
  return (
    <div className="bg-muted/30">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-sm font-semibold">Подытог</span>
        <span className="text-base font-bold">{formatCurrency(subtotal)}</span>
      </div>
      {discountAmount > 0 && (
        <div className="flex items-center justify-between px-4 py-1 text-xs text-muted-foreground">
          <span>Скидка</span>
          <span>−{formatCurrency(discountAmount)}</span>
        </div>
      )}
      {includeService && servicePercent > 0 && serviceAmount > 0 && (
        <div className="flex items-center justify-between px-4 py-1 text-xs text-muted-foreground">
          <span>Обслуживание ({servicePercent}%)</span>
          <span>+{formatCurrency(serviceAmount)}</span>
        </div>
      )}
      {tipAmount > 0 && (
        <div className="flex items-center justify-between px-4 py-1 text-xs text-muted-foreground">
          <span>Чаевые</span>
          <span>+{formatCurrency(tipAmount)}</span>
        </div>
      )}
      {hasExtras && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-border/60">
          <span className="text-sm font-bold">Итого</span>
          <span className="text-sm font-bold">{formatCurrency(totalWithService)}</span>
        </div>
      )}
    </div>
  )
}
