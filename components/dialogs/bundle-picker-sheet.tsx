'use client'

import * as React from 'react'
import { Drawer as DrawerPrimitive } from 'vaul'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X, Check } from 'lucide-react'
import { type MenuItem, type BundleSlot, type BundleSelectionInput } from '@/lib/types'
import { fetchBundleSlots } from '@/lib/queries'
import { formatCurrency, isFixedBundleSlot } from '@/lib/helpers'

/** Один выбранный компонент сета — только для локального отображения разбивки
 *  строки корзины ДО ответа бэка. После отправки заказа реальные компоненты
 *  приходят как N отдельных OrderItem с bundleGroupId/bundleSlotLabel — эта
 *  разбивка больше не используется (см. CartLine.bundleComponents). */
export interface BundleCartComponent {
  optionMenuItemId: string
  slotLabel: string
  name: string
  emoji: string
  price: number
  cogs: number
}

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

function slotHint(slot: BundleSlot): string {
  if (slot.minSelect <= 0 && slot.maxSelect <= 1) return 'по желанию'
  if (slot.minSelect <= 0) return `можно выбрать до ${slot.maxSelect}`
  if (slot.minSelect === slot.maxSelect) return slot.maxSelect === 1 ? 'обязательно' : `выберите ${slot.minSelect}`
  return `выберите от ${slot.minSelect} до ${slot.maxSelect}`
}

interface BundlePickerSheetProps {
  /** Сет-продукт; null = закрыто. */
  product: MenuItem | null
  /** Всё меню — для резолва имени/эмодзи/себестоимости выбранных компонентов
   *  (fetchBundleSlots уже джойнит имя/цену для отображения, но cogs и emoji
   *  берём из этого списка). Намеренно не в deps фетч-эффекта — смена
   *  ссылки на меню между рендерами не должна сбрасывать текущий выбор. */
  menuItems: MenuItem[]
  /** id блюд в стоп-листе — компоненты в стопе показываются с бейджем, но
   *  выбор не блокируют (как и у VariantPickerSheet — предупреждение, не гейт). */
  stoppedIds?: Set<string>
  onClose: () => void
  onConfirm: (result: { selection: BundleSelectionInput; components: BundleCartComponent[] }) => void
  /** Если рендерится внутри другого vaul drawer — NestedRoot вместо Root. */
  nested?: boolean
}

export function BundlePickerSheet({
  product, menuItems, stoppedIds, onClose, onConfirm, nested = false,
}: BundlePickerSheetProps) {
  const isMobile = useIsMobile()
  const open = !!product

  const body = product ? (
    <BundleBody product={product} menuItems={menuItems} stoppedIds={stoppedIds} onClose={onClose} onConfirm={onConfirm} />
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
            <DrawerPrimitive.Title className="sr-only">Сборка сета</DrawerPrimitive.Title>
            <DrawerPrimitive.Description className="sr-only">Выберите компоненты сета</DrawerPrimitive.Description>
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
          <DialogPrimitive.Title className="sr-only">Сборка сета</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Выберите компоненты сета</DialogPrimitive.Description>
          {body}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function BundleBody({
  product, menuItems, stoppedIds, onClose, onConfirm,
}: {
  product: MenuItem
  menuItems: MenuItem[]
  stoppedIds?: Set<string>
  onClose: () => void
  onConfirm: (result: { selection: BundleSelectionInput; components: BundleCartComponent[] }) => void
}) {
  const [slots, setSlots] = React.useState<BundleSlot[]>([])
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState(false)
  const [selected, setSelected] = React.useState<Record<string, string[]>>({})

  const menuItemsById = React.useMemo(() => new Map(menuItems.map(m => [m.id, m])), [menuItems])

  // menuItems намеренно не в deps (см. проп-комментарий выше) — рефетчим только на смену продукта.
  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    fetchBundleSlots(product.id, menuItems)
      .then(loaded => {
        if (cancelled) return
        setSlots(loaded)
        const init: Record<string, string[]> = {}
        for (const slot of loaded) {
          const defaults = slot.options.filter(o => o.isDefault).slice(0, Math.max(slot.maxSelect, 1)).map(o => o.id)
          if (defaults.length > 0) init[slot.id] = defaults
        }
        setSelected(init)
      })
      .catch(() => { if (!cancelled) setLoadError(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [product.id])

  const toggleOption = (slot: BundleSlot, optionId: string) => {
    setSelected(prev => {
      const cur = prev[slot.id] ?? []
      if (slot.maxSelect <= 1) {
        return { ...prev, [slot.id]: [optionId] }
      }
      if (cur.includes(optionId)) {
        return { ...prev, [slot.id]: cur.filter(id => id !== optionId) }
      }
      if (cur.length >= slot.maxSelect) return prev
      return { ...prev, [slot.id]: [...cur, optionId] }
    })
  }

  const missingRequired = slots.filter(s => (selected[s.id]?.length ?? 0) < s.minSelect)
  const canConfirm = !loading && !loadError && slots.length > 0 && missingRequired.length === 0

  const totalPrice = slots.reduce((sum, s) => {
    const optIds = selected[s.id] ?? []
    return sum + optIds.reduce((ssum, optId) => ssum + (s.options.find(o => o.id === optId)?.price ?? 0), 0)
  }, 0)

  const handleConfirm = () => {
    if (!canConfirm) return
    const selSlots: { slotId: string; optionIds: string[] }[] = []
    const components: BundleCartComponent[] = []
    for (const slot of slots) {
      const optionIds = selected[slot.id] ?? []
      if (optionIds.length === 0) continue
      selSlots.push({ slotId: slot.id, optionIds })
      for (const optId of optionIds) {
        const opt = slot.options.find(o => o.id === optId)
        if (!opt) continue
        const mi = menuItemsById.get(opt.optionMenuItemId)
        components.push({
          optionMenuItemId: opt.optionMenuItemId,
          slotLabel: slot.label,
          name: opt.optionMenuItemName ?? mi?.name ?? '?',
          emoji: mi?.emoji ?? '',
          price: opt.price,
          cogs: mi?.cogs ?? 0,
        })
      }
    }
    onConfirm({ selection: { bundleMenuItemId: product.id, slots: selSlots }, components })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-2xl sm:text-3xl shrink-0">{product.emoji || '🧾'}</span>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-foreground text-sm sm:text-base truncate">{product.name}</h3>
          <p className="text-xs text-muted-foreground">Соберите сет</p>
        </div>
        <button onClick={onClose} className="size-9 rounded-lg hover:bg-muted flex items-center justify-center shrink-0">
          <X className="size-5" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <span className="size-8 border-2 border-muted-foreground/20 border-t-primary rounded-full animate-spin" />
        </div>
      ) : loadError ? (
        <p className="text-sm text-destructive text-center py-6">Не удалось загрузить состав сета</p>
      ) : slots.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">Сет не настроен — обратитесь к менеджеру</p>
      ) : (
        slots.map(slot => {
          // Слот без реального выбора (min=max=число опций — «входит всегда»,
          // см. isFixedBundleSlot): не рендерим кнопками — гостю/кассиру нечего
          // решать, только сообщаем список. И чище визуально при многих
          // фиксированных пунктах, и не даёт случайно "снять" обязательный выбор.
          if (isFixedBundleSlot(slot)) {
            return (
              <div key={slot.id}>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-foreground">{slot.label}</label>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">входит всегда</span>
                </div>
                <div className="flex flex-wrap gap-x-1.5 gap-y-1 text-sm text-foreground">
                  {slot.options.map((opt, i) => {
                    const stopped = stoppedIds?.has(opt.optionMenuItemId) ?? false
                    const name = opt.optionMenuItemName ?? menuItemsById.get(opt.optionMenuItemId)?.name ?? '?'
                    return (
                      <span key={opt.id} className="inline-flex items-center gap-1">
                        {name}{i < slot.options.length - 1 ? ',' : ''}
                        {stopped && <span className="text-[9px] px-1 py-0.5 bg-destructive/10 text-destructive rounded-full font-bold shrink-0">СТОП</span>}
                      </span>
                    )
                  })}
                </div>
              </div>
            )
          }
          const curSelected = selected[slot.id] ?? []
          const atMax = slot.maxSelect > 1 && curSelected.length >= slot.maxSelect
          return (
            <div key={slot.id}>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-foreground">{slot.label}</label>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                  slot.minSelect > 0 ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                }`}>{slotHint(slot)}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {slot.options.map(opt => {
                  const on = curSelected.includes(opt.id)
                  const stopped = stoppedIds?.has(opt.optionMenuItemId) ?? false
                  const disabled = !on && atMax
                  return (
                    <button
                      key={opt.id}
                      onClick={() => toggleOption(slot, opt.id)}
                      disabled={disabled}
                      className={`min-h-12 px-4 py-2.5 rounded-xl text-sm font-semibold border-2 active:scale-95 transition-colors flex items-center gap-1.5 ${on
                        ? 'bg-primary text-primary-foreground border-primary'
                        : disabled
                          ? 'bg-background text-muted-foreground/50 border-border cursor-not-allowed'
                          : 'bg-background text-foreground border-border hover:border-muted-foreground/40'}`}
                    >
                      {slot.maxSelect > 1 && on && <Check className="size-3.5 shrink-0" />}
                      <span>{opt.optionMenuItemName ?? menuItemsById.get(opt.optionMenuItemId)?.name ?? '?'}</span>
                      <span className="opacity-70 font-normal">{formatCurrency(opt.price)}</span>
                      {stopped && <span className="text-[9px] px-1 py-0.5 bg-destructive/10 text-destructive rounded-full font-bold shrink-0">СТОП</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })
      )}

      <div className="bg-primary/5 border border-primary/20 rounded-xl p-3 sm:p-4 text-center">
        <p className="text-[10px] sm:text-xs uppercase text-muted-foreground mb-0.5 sm:mb-1">Цена сета</p>
        <p className="text-2xl sm:text-3xl font-bold text-primary">{formatCurrency(totalPrice)}</p>
      </div>

      <div className="flex gap-2 sm:gap-3 pt-1">
        <button
          onClick={onClose}
          className="flex-1 px-3 py-3 text-sm font-medium text-foreground bg-muted rounded-xl"
        >Отмена</button>
        <button
          onClick={handleConfirm}
          disabled={!canConfirm}
          className="flex-[2] px-3 py-3 text-sm font-semibold text-primary-foreground bg-primary rounded-xl disabled:opacity-50 active:scale-95"
        >Добавить{canConfirm ? ` · ${formatCurrency(totalPrice)}` : ''}</button>
      </div>
    </div>
  )
}
