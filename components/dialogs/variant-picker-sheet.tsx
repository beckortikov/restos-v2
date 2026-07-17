'use client'

import * as React from 'react'
import { Drawer as DrawerPrimitive } from 'vaul'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { type MenuItem } from '@/lib/types'
import { formatCurrency } from '@/lib/helpers'

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

interface VariantPickerSheetProps {
  /** Продукт-родитель с attributes; null = закрыто. */
  product: MenuItem | null
  /** Живые варианты продукта (menu_items с parentId=product.id). */
  variants: MenuItem[]
  /** id вариантов в backend стоп-листе (для бейджа СТОП). */
  stoppedIds?: Set<string>
  onClose: () => void
  /** Подтверждение: выбранный вариант (стоп-гейтинг делает вызывающий код). */
  onSelect: (variant: MenuItem) => void
  /** If rendered inside another vaul drawer, set true to use NestedRoot. */
  nested?: boolean
  /** id уже выбранного варианта (например при смене размера в строке чека) —
   *  открывает пикер с этим выбором вместо первого значения каждого атрибута. */
  initialVariantId?: string
}

/**
 * Пикер комбинации атрибутов (Размер/Вкус): по ряду кнопок на атрибут,
 * резолвит выбор в конкретный вариант (menu_item) и отдаёт его onSelect.
 */
export function VariantPickerSheet({
  product, variants, stoppedIds, onClose, onSelect, nested = false, initialVariantId,
}: VariantPickerSheetProps) {
  const isMobile = useIsMobile()
  const open = !!product

  const body = product ? (
    <VariantBody product={product} variants={variants} stoppedIds={stoppedIds} onClose={onClose} onSelect={onSelect} initialVariantId={initialVariantId} />
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
            <DrawerPrimitive.Title className="sr-only">Выбор варианта</DrawerPrimitive.Title>
            <DrawerPrimitive.Description className="sr-only">Выберите размер или вкус</DrawerPrimitive.Description>
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
          <DialogPrimitive.Title className="sr-only">Выбор варианта</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Выберите размер или вкус</DialogPrimitive.Description>
          {body}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function VariantBody({
  product, variants, stoppedIds, onClose, onSelect, initialVariantId,
}: {
  product: MenuItem
  variants: MenuItem[]
  stoppedIds?: Set<string>
  onClose: () => void
  onSelect: (variant: MenuItem) => void
  initialVariantId?: string
}) {
  const attrs = product.attributes ?? []
  const [sel, setSel] = React.useState<Record<string, string>>(() => {
    const initialVariant = initialVariantId ? variants.find(v => v.id === initialVariantId) : undefined
    const initialValueIds = new Set(initialVariant?.variantValueIds ?? [])
    const init: Record<string, string> = {}
    for (const a of attrs) {
      if (a.values.length === 0) continue
      const preselected = a.values.find(v => initialValueIds.has(v.id))
      init[a.id] = preselected?.id ?? a.values[0].id
    }
    return init
  })

  const resolved = React.useMemo(() => {
    const key = Object.values(sel).sort().join(',')
    return variants.find(v => [...(v.variantValueIds ?? [])].sort().join(',') === key) ?? null
  }, [sel, variants])

  const resolvedStopped = !!resolved && (resolved.isAvailable === false || (stoppedIds?.has(resolved.id) ?? false))

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-2xl sm:text-3xl shrink-0">{product.emoji || '🧾'}</span>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-foreground text-sm sm:text-base truncate">{product.name}</h3>
          <p className="text-xs text-muted-foreground">Выберите вариант</p>
        </div>
        <button onClick={onClose} className="size-9 rounded-lg hover:bg-muted flex items-center justify-center shrink-0">
          <X className="size-5" />
        </button>
      </div>

      {attrs.map(attr => (
        <div key={attr.id}>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{attr.name}</label>
          <div className="flex flex-wrap gap-2">
            {attr.values.map(val => {
              const on = sel[attr.id] === val.id
              return (
                <button
                  key={val.id}
                  onClick={() => setSel(prev => ({ ...prev, [attr.id]: val.id }))}
                  className={`min-h-12 min-w-16 px-5 py-3 rounded-xl text-base font-semibold border-2 active:scale-95 transition-colors ${on
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-foreground border-border hover:border-muted-foreground/40'}`}
                >
                  {val.label}
                </button>
              )
            })}
          </div>
        </div>
      ))}

      <div className="bg-primary/5 border border-primary/20 rounded-xl p-3 sm:p-4 text-center">
        <p className="text-[10px] sm:text-xs uppercase text-muted-foreground mb-0.5 sm:mb-1">Цена</p>
        <p className="text-2xl sm:text-3xl font-bold text-primary flex items-center justify-center gap-2">
          {resolved ? formatCurrency(resolved.price) : '—'}
          {resolvedStopped && <span className="text-[10px] px-1.5 py-0.5 bg-destructive/10 text-destructive rounded-full font-bold">СТОП</span>}
        </p>
      </div>

      <div className="flex gap-2 sm:gap-3 pt-1">
        <button
          onClick={onClose}
          className="flex-1 px-3 py-3 text-sm font-medium text-foreground bg-muted rounded-xl"
        >Отмена</button>
        <button
          onClick={() => { if (resolved) onSelect(resolved) }}
          disabled={!resolved}
          className="flex-[2] px-3 py-3 text-sm font-semibold text-primary-foreground bg-primary rounded-xl disabled:opacity-50 active:scale-95"
        >{initialVariantId ? 'Изменить' : 'Добавить'}{resolved ? ` · ${formatCurrency(resolved.price)}` : ''}</button>
      </div>
    </div>
  )
}
