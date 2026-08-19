'use client'

import { useState, useEffect, useRef } from 'react'
import { Plus, Trash2, Search, X, Layers } from 'lucide-react'
import { toast } from 'sonner'
import type { BundleSlot, BundleSlotOption, MenuItem } from '@/lib/types'
import {
  fetchBundleSlots, createBundleSlot, updateBundleSlot, deleteBundleSlot,
  createBundleSlotOption, updateBundleSlotOption, deleteBundleSlotOption,
} from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { DecimalInput } from '@/components/ui/decimal-input'

// MenuItemPicker — поиск-и-выбор пункта меню (по образцу IngredientCombobox
// из tech-card-lines-editor.tsx, но без create-inline — компонент сета должен
// быть уже существующим настоящим блюдом).
function MenuItemPicker({ items, exclude, onSelect }: {
  items: MenuItem[]
  exclude: Set<string>
  onSelect: (item: MenuItem) => void
}) {
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const q = query.toLowerCase()
  const filtered = items
    .filter(m => !exclude.has(m.id) && m.name.toLowerCase().includes(q))
    .slice(0, 8)

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); setIsOpen(true) }}
          onFocus={() => setIsOpen(true)}
          placeholder="Найти блюдо для этого слота..."
          className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
        />
      </div>
      {isOpen && (filtered.length > 0 || query.trim() !== '') && (
        <div className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto bg-card border border-border rounded-lg shadow-lg">
          {filtered.length > 0 ? filtered.map(m => (
            <button
              key={m.id}
              type="button"
              onClick={() => { onSelect(m); setQuery(''); setIsOpen(false) }}
              className="w-full text-left px-4 py-2 text-sm hover:bg-muted transition-colors flex justify-between items-center"
            >
              <span className="text-foreground font-medium truncate">{m.name}</span>
              <span className="text-xs text-muted-foreground shrink-0 ml-2">{formatCurrency(m.price)}</span>
            </button>
          )) : (
            <p className="px-4 py-3 text-xs text-muted-foreground">Ничего не найдено</p>
          )}
        </div>
      )}
    </div>
  )
}

function OptionRow({ option, onPriceChange, onDelete }: {
  option: BundleSlotOption
  onPriceChange: (price: number) => void
  onDelete: () => void
}) {
  const [price, setPrice] = useState(option.price)
  const menuPrice = option.optionMenuItemPrice
  const cheaper = menuPrice != null && price < menuPrice

  return (
    <div className="flex items-center gap-2 py-1.5 pl-3 pr-1.5 bg-background border border-border/60 rounded-lg">
      <span className="flex-1 text-sm font-medium text-foreground truncate">{option.optionMenuItemName ?? option.optionMenuItemId}</span>
      {menuPrice != null && (
        <span className="text-[10px] text-muted-foreground shrink-0">в меню {formatCurrency(menuPrice)}</span>
      )}
      <div className="w-24 shrink-0">
        <DecimalInput
          value={price}
          onChange={v => { setPrice(v); onPriceChange(v) }}
          min={0}
          className="w-full px-2 py-1 text-sm text-right bg-muted/30 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>
      {cheaper && <span className="text-[10px] text-emerald-600 font-semibold shrink-0">в сете дешевле</span>}
      <button
        type="button"
        onClick={onDelete}
        className="shrink-0 p-1.5 text-destructive hover:bg-destructive/10 rounded-md transition-colors"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}

function SlotCard({ slot, menuItems, otherSlotOptionIds, onChanged }: {
  slot: BundleSlot
  menuItems: MenuItem[]
  otherSlotOptionIds: Set<string>
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleAddOption = async (item: MenuItem) => {
    setBusy(true)
    try {
      await createBundleSlotOption({ slotId: slot.id, optionMenuItemId: item.id, price: item.price, isDefault: slot.options.length === 0 })
      setAdding(false)
      onChanged()
    } catch (e) {
      toast.error('Не удалось добавить опцию')
    } finally {
      setBusy(false)
    }
  }

  const handlePriceChange = (optionId: string, price: number) => {
    updateBundleSlotOption(optionId, { price }).catch(() => toast.error('Не удалось сохранить цену'))
  }

  const handleDeleteOption = async (optionId: string) => {
    try {
      await deleteBundleSlotOption(optionId)
      onChanged()
    } catch {
      toast.error('Не удалось удалить опцию')
    }
  }

  const handleDeleteSlot = async () => {
    if (!confirm(`Удалить слот «${slot.label}» вместе со всеми его опциями?`)) return
    try {
      await deleteBundleSlot(slot.id)
      onChanged()
    } catch {
      toast.error('Не удалось удалить слот')
    }
  }

  return (
    <div className="border border-border rounded-xl p-3.5 space-y-2.5 bg-muted/10">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-bold text-foreground truncate">{slot.label}</span>
          <span className="text-[10px] font-semibold text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
            {slot.minSelect === slot.maxSelect ? `${slot.minSelect} из ${slot.options.length}` : `${slot.minSelect}–${slot.maxSelect} из ${slot.options.length}`}
          </span>
          {slot.isRequired && (
            <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 dark:bg-amber-950/40 dark:text-amber-400 px-1.5 py-0.5 rounded shrink-0">обязателен</span>
          )}
        </div>
        <button type="button" onClick={handleDeleteSlot} className="shrink-0 p-1.5 text-destructive hover:bg-destructive/10 rounded-md transition-colors">
          <Trash2 className="size-4" />
        </button>
      </div>

      <div className="space-y-1.5">
        {slot.options.map(opt => (
          <OptionRow
            key={opt.id}
            option={opt}
            onPriceChange={p => handlePriceChange(opt.id, p)}
            onDelete={() => handleDeleteOption(opt.id)}
          />
        ))}
      </div>

      {adding ? (
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <MenuItemPicker
              items={menuItems}
              exclude={new Set([...slot.options.map(o => o.optionMenuItemId), ...otherSlotOptionIds])}
              onSelect={handleAddOption}
            />
          </div>
          <button type="button" onClick={() => setAdding(false)} className="shrink-0 p-2 text-muted-foreground hover:bg-muted rounded-lg transition-colors">
            <X className="size-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={busy}
          className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80 transition-colors py-1.5 px-2.5 rounded-lg hover:bg-primary/5 border border-dashed border-primary/20 w-full justify-center disabled:opacity-50"
        >
          <Plus className="size-3.5" /> Добавить вариант в слот
        </button>
      )}
    </div>
  )
}

interface BundleSlotsEditorProps {
  bundleMenuItemId: string
  menuItems: MenuItem[]
}

// BundleSlotsEditor — секция «Слоты сета» в форме блюда: владелец собирает
// фастфуд-сет из настоящих пунктов меню (Бургер/Гарнир/Напиток), у каждого
// варианта — своя цена ВНУТРИ сета (обычно ниже цены в меню — сама скидка).
// Список слотов и опций живёт на бэке отдельными сущностями (bundle_slots/
// bundle_slot_options, миграция 073) — этот компонент их полностью
// самостоятельно грузит/сохраняет через lib/queries/bundles.ts.
export function BundleSlotsEditor({ bundleMenuItemId, menuItems }: BundleSlotsEditorProps) {
  const [slots, setSlots] = useState<BundleSlot[]>([])
  const [loading, setLoading] = useState(true)
  const [showNewSlot, setShowNewSlot] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newRequired, setNewRequired] = useState(true)
  const [newMin, setNewMin] = useState(1)
  const [newMax, setNewMax] = useState(1)
  const [creating, setCreating] = useState(false)

  const reload = async () => {
    try {
      const rows = await fetchBundleSlots(bundleMenuItemId, menuItems)
      setSlots(rows)
    } catch {
      toast.error('Не удалось загрузить слоты сета')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleMenuItemId])

  const pickableItems = menuItems.filter(m => !m.isBundle && m.id !== bundleMenuItemId)
  // Опции, уже занятые в ДРУГИХ слотах — не запрещено технически (напиток
  // мог бы теоретически быть в двух слотах), но обычно ошибка ввода, поэтому
  // не подсказываем их в пикере конкретного слота отдельно от собственных.

  const handleCreateSlot = async () => {
    if (!newLabel.trim()) {
      toast.error('Укажите название слота')
      return
    }
    if (newMin > newMax) {
      toast.error('Минимум не может быть больше максимума')
      return
    }
    setCreating(true)
    try {
      await createBundleSlot({
        bundleMenuItemId, label: newLabel.trim(), isRequired: newRequired,
        minSelect: newMin, maxSelect: newMax, sortOrder: slots.length,
      })
      setShowNewSlot(false)
      setNewLabel(''); setNewRequired(true); setNewMin(1); setNewMax(1)
      await reload()
    } catch (e) {
      toast.error('Не удалось создать слот')
    } finally {
      setCreating(false)
    }
  }

  if (loading) {
    return (
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
        <div className="size-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin mx-auto" />
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
      <h2 className="text-sm font-bold text-foreground flex items-center gap-1.5">
        <Layers className="size-4 text-primary" />
        Слоты сета
      </h2>
      {slots.length === 0 && !showNewSlot && (
        <p className="text-xs text-muted-foreground leading-relaxed">
          Сет собирается из слотов («Бургер», «Гарнир», «Напиток») — в каждом один или
          несколько вариантов из настоящего меню. Гость увидит выбор только там, где в
          слоте больше одного варианта; один вариант в слоте подставляется автоматически.
          Цена сета складывается из цен, которые вы зададите на вариантах — здесь же,
          дешевле их обычной цены в меню.
        </p>
      )}

      {slots.map(slot => (
        <SlotCard
          key={slot.id}
          slot={slot}
          menuItems={pickableItems}
          otherSlotOptionIds={new Set()}
          onChanged={reload}
        />
      ))}

      {showNewSlot ? (
        <div className="border border-dashed border-primary/30 rounded-xl p-3.5 space-y-3">
          <input
            type="text"
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            placeholder="Название слота (напр. «Бургер»)"
            autoFocus
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs text-foreground">
              <input type="checkbox" checked={newRequired} onChange={e => setNewRequired(e.target.checked)} className="size-3.5" />
              Обязателен
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Выбрать мин.
              <input
                type="number" min={0} value={newMin}
                onChange={e => setNewMin(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="w-14 px-2 py-1 text-sm bg-background border border-border rounded-md"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              макс.
              <input
                type="number" min={1} value={newMax}
                onChange={e => setNewMax(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="w-14 px-2 py-1 text-sm bg-background border border-border rounded-md"
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCreateSlot}
              disabled={creating}
              className="flex-1 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {creating ? 'Создание…' : 'Создать слот'}
            </button>
            <button
              type="button"
              onClick={() => setShowNewSlot(false)}
              className="py-1.5 px-3 text-xs font-semibold text-muted-foreground hover:bg-muted rounded-lg transition-colors"
            >
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowNewSlot(true)}
          className="flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-primary/80 transition-colors py-1.5 px-3 rounded-lg hover:bg-primary/5 border border-dashed border-primary/20 w-full justify-center"
        >
          <Plus className="size-4" /> Добавить слот
        </button>
      )}
    </div>
  )
}
