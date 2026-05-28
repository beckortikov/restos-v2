'use client'

import * as React from 'react'
import { Drawer as DrawerPrimitive } from 'vaul'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { type MenuItem } from '@/lib/types'
import { formatCurrency, formatPriceLabel } from '@/lib/helpers'
import { dMul, dDiv } from '@/lib/decimal'
import { DecimalInput } from '@/components/ui/decimal-input'

function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  )
  React.useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    setIsMobile(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return isMobile
}

interface WeightInputSheetProps {
  item: MenuItem | null
  value: number
  onChange: (v: number) => void
  onClose: () => void
  onConfirm: () => void
  /** If this sheet is rendered inside another vaul drawer, set true to use NestedRoot. */
  nested?: boolean
}

export function WeightInputSheet({
  item, value, onChange, onClose, onConfirm, nested = false,
}: WeightInputSheetProps) {
  const isMobile = useIsMobile()
  const open = !!item

  const body = item ? (
    <WeightBody item={item} value={value} onChange={onChange} onClose={onClose} onConfirm={onConfirm} />
  ) : null

  if (isMobile) {
    const Root: any = nested ? DrawerPrimitive.NestedRoot : DrawerPrimitive.Root
    return (
      <Root open={open} onOpenChange={(v: boolean) => { if (!v) onClose() }} shouldScaleBackground={false}>
        <DrawerPrimitive.Portal>
          <DrawerPrimitive.Overlay className="fixed inset-0 z-[80] bg-black/60" />
          <DrawerPrimitive.Content
            className="fixed inset-x-0 bottom-0 z-[81] flex h-auto max-h-[92vh] flex-col rounded-t-2xl border border-border bg-background"
          >
            <div className="mx-auto mt-2 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" />
            <DrawerPrimitive.Title className="sr-only">Вес блюда</DrawerPrimitive.Title>
            <DrawerPrimitive.Description className="sr-only">Укажите вес порции</DrawerPrimitive.Description>
            <div className="overflow-y-auto p-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]">
              {body}
            </div>
          </DrawerPrimitive.Content>
        </DrawerPrimitive.Portal>
      </Root>
    )
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-[81] w-full max-w-md -translate-x-1/2 -translate-y-1/2 bg-card rounded-2xl border border-border shadow-xl max-h-[85vh] overflow-y-auto p-6 data-[state=open]:animate-in data-[state=closed]:animate-out"
        >
          <DialogPrimitive.Title className="sr-only">Вес блюда</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Укажите вес порции</DialogPrimitive.Description>
          {body}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function WeightBody({
  item, value, onChange, onClose, onConfirm,
}: {
  item: MenuItem
  value: number
  onChange: (v: number) => void
  onClose: () => void
  onConfirm: () => void
}) {
  const step = item.saleStep && item.saleStep > 0 ? item.saleStep : 10
  const unitSize = item.unitSize || 100
  const calcPrice = dMul(item.price, dDiv(value, unitSize))
  const unitLabel = item.unit === 'kg' ? 'кг' : 'г'
  const presets = item.unit === 'kg' ? [0.2, 0.5, 1, 1.5, 2] : [100, 200, 300, 500, 1000]
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-2xl sm:text-3xl shrink-0">{item.emoji || '⚖️'}</span>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-foreground text-sm sm:text-base truncate">{item.name}</h3>
          <p className="text-xs text-muted-foreground">{formatPriceLabel(item.price, item.unit, item.unitSize)}</p>
        </div>
        <button onClick={onClose} className="size-9 rounded-lg hover:bg-muted flex items-center justify-center shrink-0">
          <X className="size-5" />
        </button>
      </div>
      <div className="bg-primary/5 border border-primary/20 rounded-xl p-3 sm:p-4 text-center">
        <p className="text-[10px] sm:text-xs uppercase text-muted-foreground mb-0.5 sm:mb-1">К оплате</p>
        <p className="text-2xl sm:text-3xl font-bold text-primary">{formatCurrency(calcPrice)}</p>
        <p className="text-xs sm:text-sm text-muted-foreground mt-0.5 sm:mt-1">за {value}{unitLabel}</p>
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Вес ({unitLabel})</label>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onChange(Math.max(0, value - step))}
            className="size-11 sm:size-12 shrink-0 rounded-xl bg-muted text-foreground font-bold text-xl active:scale-95 flex items-center justify-center"
          >−</button>
          <DecimalInput
            min={0}
            value={value}
            onChange={v => onChange(Math.max(0, v))}
            className="flex-1 min-w-0 text-center text-xl sm:text-2xl font-bold py-2.5 sm:py-3 rounded-xl border-2 border-border bg-background focus:border-primary focus:outline-none"
          />
          <button
            onClick={() => onChange(value + step)}
            className="size-11 sm:size-12 shrink-0 rounded-xl bg-muted text-foreground font-bold text-xl active:scale-95 flex items-center justify-center"
          >+</button>
        </div>
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {presets.map(p => (
          <button
            key={p}
            onClick={() => onChange(p)}
            className="px-1.5 py-2 rounded-lg bg-muted text-xs font-semibold active:scale-95"
          >{p}{unitLabel}</button>
        ))}
      </div>
      <div className="flex gap-2 sm:gap-3 pt-1">
        <button
          onClick={onClose}
          className="flex-1 px-3 py-3 text-sm font-medium text-foreground bg-muted rounded-xl"
        >Отмена</button>
        <button
          onClick={onConfirm}
          disabled={value <= 0}
          className="flex-[2] px-3 py-3 text-sm font-semibold text-primary-foreground bg-primary rounded-xl disabled:opacity-50 active:scale-95"
        >Добавить · {formatCurrency(calcPrice)}</button>
      </div>
    </div>
  )
}
