'use client'

import * as React from 'react'
import { Check } from 'lucide-react'
import { type MenuItem, type BundleSlot, type BundleSelectionInput } from '@/lib/types'
import { fetchBundleSlots } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { PosModal } from './pos-modal'
import type { BundleCartComponent } from '@/components/dialogs/bundle-picker-sheet'

// Нативный /pos2 пикер сборки сета — та же логика (валидация min/max, подсчёт
// суммы, сборка payload), что и в components/dialogs/bundle-picker-sheet.tsx
// для основной кассы, просто на PosModal + var(--pv-*) вместо vaul/Radix —
// у /pos2 своя дизайн-система, общие UI-примитивы с основной кассой не
// переиспользуются нигде (см. payment-panel.tsx/order-extras.tsx — тот же
// паттерн отдельного порта под pos2).

function slotHint(slot: BundleSlot): string {
  if (slot.minSelect <= 0 && slot.maxSelect <= 1) return 'по желанию'
  if (slot.minSelect <= 0) return `можно выбрать до ${slot.maxSelect}`
  if (slot.minSelect === slot.maxSelect) return slot.maxSelect === 1 ? 'обязательно' : `выберите ${slot.minSelect}`
  return `выберите от ${slot.minSelect} до ${slot.maxSelect}`
}

interface BundlePickerModalProps {
  /** Сет-продукт; null = закрыто. */
  product: MenuItem | null
  menuItems: MenuItem[]
  stoppedIds?: Set<string>
  onClose: () => void
  onConfirm: (result: { selection: BundleSelectionInput; components: BundleCartComponent[] }) => void
}

export function BundlePickerModal({ product, menuItems, stoppedIds, onClose, onConfirm }: BundlePickerModalProps) {
  const [slots, setSlots] = React.useState<BundleSlot[]>([])
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState(false)
  const [selected, setSelected] = React.useState<Record<string, string[]>>({})

  const menuItemsById = React.useMemo(() => new Map(menuItems.map(m => [m.id, m])), [menuItems])

  // menuItems намеренно не в deps — смена ссылки на меню между рендерами не
  // должна сбрасывать текущий выбор кассира. Рефетчим только на смену продукта.
  React.useEffect(() => {
    if (!product) { setSlots([]); setSelected({}); return }
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
  }, [product?.id])

  if (!product) return null

  const toggleOption = (slot: BundleSlot, optionId: string) => {
    setSelected(prev => {
      const cur = prev[slot.id] ?? []
      if (slot.maxSelect <= 1) return { ...prev, [slot.id]: [optionId] }
      if (cur.includes(optionId)) return { ...prev, [slot.id]: cur.filter(id => id !== optionId) }
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
    <PosModal open onClose={onClose} title={product.name} width="clamp(20rem,44vw,34rem)">
      <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '1rem' }}>
        {loading ? (
          <div className="flex items-center justify-center" style={{ padding: '2.5rem 0' }}>
            <span className="rounded-full animate-spin" style={{ width: '2rem', height: '2rem', border: '2px solid var(--pv-border)', borderTopColor: 'var(--pv-brand)' }} />
          </div>
        ) : loadError ? (
          <p className="text-center" style={{ color: 'var(--pv-occ-text)', fontSize: 'var(--pv-ctl)', padding: '1.5rem 0' }}>Не удалось загрузить состав сета</p>
        ) : slots.length === 0 ? (
          <p className="text-center" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', padding: '1.5rem 0' }}>Сет не настроен — обратитесь к менеджеру</p>
        ) : (
          slots.map(slot => {
            const curSelected = selected[slot.id] ?? []
            const atMax = slot.maxSelect > 1 && curSelected.length >= slot.maxSelect
            return (
              <div key={slot.id}>
                <div className="flex items-center justify-between" style={{ marginBottom: '0.5rem' }}>
                  <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>{slot.label}</span>
                  <span className="rounded-full font-medium" style={{
                    background: slot.minSelect > 0 ? 'var(--pv-brand-soft)' : 'var(--pv-bg)',
                    color: slot.minSelect > 0 ? 'var(--pv-brand)' : 'var(--pv-text-2)',
                    padding: '0.15rem 0.6rem', fontSize: '0.7rem',
                  }}>{slotHint(slot)}</span>
                </div>
                <div className="flex flex-wrap" style={{ gap: '0.5rem' }}>
                  {slot.options.map(opt => {
                    const on = curSelected.includes(opt.id)
                    const stopped = stoppedIds?.has(opt.optionMenuItemId) ?? false
                    const disabled = !on && atMax
                    return (
                      <button
                        key={opt.id}
                        onClick={() => toggleOption(slot, opt.id)}
                        disabled={disabled}
                        className="rounded-xl font-semibold border active:scale-95 transition-transform flex items-center"
                        style={{
                          gap: '0.4rem',
                          background: on ? 'var(--pv-brand)' : 'var(--pv-card)',
                          color: on ? '#fff' : disabled ? 'var(--pv-text-2)' : 'var(--pv-text)',
                          borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)',
                          padding: 'clamp(0.6rem,0.9vw,0.8rem) clamp(0.9rem,1.3vw,1.2rem)',
                          fontSize: 'var(--pv-ctl)',
                          opacity: disabled ? 0.5 : 1,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {slot.maxSelect > 1 && on && <Check style={{ width: '0.9em', height: '0.9em' }} />}
                        <span>{opt.optionMenuItemName ?? menuItemsById.get(opt.optionMenuItemId)?.name ?? '?'}</span>
                        <span style={{ opacity: 0.75, fontWeight: 400 }}>{formatCurrency(opt.price)}</span>
                        {stopped && (
                          <span className="rounded-full font-bold" style={{ background: 'var(--pv-occ-soft)', color: 'var(--pv-occ-text)', padding: '0.1rem 0.4rem', fontSize: '0.6rem' }}>СТОП</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })
        )}

        <div className="flex items-center justify-between rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.6rem 1rem' }}>
          <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Цена сета</span>
          <span className="font-bold" style={{ color: 'var(--pv-brand)', fontSize: 'clamp(1.1rem,1.5vw,1.35rem)' }}>{formatCurrency(totalPrice)}</span>
        </div>

        <button
          onClick={handleConfirm}
          disabled={!canConfirm}
          className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white active:scale-[0.98] transition-transform disabled:opacity-50"
          style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}
        >Добавить{canConfirm ? ` · ${formatCurrency(totalPrice)}` : ''}</button>
      </div>
    </PosModal>
  )
}
