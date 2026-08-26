'use client'

import { useState, useEffect, useRef } from 'react'
import { Plus, Trash2, Search, X, Layers, PackageCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { BundleSlot, BundleSlotOption, MenuItem } from '@/lib/types'
import {
  fetchBundleSlots, createBundleSlot, updateBundleSlot, deleteBundleSlot,
  createBundleSlotOption, updateBundleSlotOption, deleteBundleSlotOption,
} from '@/lib/queries'
import { formatCurrency, isFixedBundleSlot } from '@/lib/helpers'
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
          {isFixedBundleSlot(slot) ? (
            <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-400 px-1.5 py-0.5 rounded shrink-0">
              входит всегда
            </span>
          ) : (
            <>
              <span className="text-[10px] font-semibold text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
                {slot.minSelect === slot.maxSelect ? `${slot.minSelect} из ${slot.options.length}` : `${slot.minSelect}–${slot.maxSelect} из ${slot.options.length}`}
              </span>
              {slot.isRequired && (
                <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 dark:bg-amber-950/40 dark:text-amber-400 px-1.5 py-0.5 rounded shrink-0">обязателен</span>
              )}
            </>
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

// FixedGroupCreator — быстрое добавление НЕСКОЛЬКИХ обязательных пунктов
// сета одним подтверждением: владелец собирает список блюд (поиск → клик →
// в список, повторить), жмёт «Создать» один раз — и создаётся ОДИН слот
// (min=max=N, все опции is_default) вместо N отдельных слотов-«обязателен».
// Это и есть «неизменяемая» часть сета — см. isFixedBundleSlot в lib/helpers.ts,
// оба кассовых пикера по этому же признаку рисуют такой слот как готовый
// список без кнопок выбора.
function FixedGroupCreator({ bundleMenuItemId, menuItems, exclude, sortOrder, onDone, onCancel }: {
  bundleMenuItemId: string
  menuItems: MenuItem[]
  exclude: Set<string>
  sortOrder: number
  onDone: () => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState('')
  const [picked, setPicked] = useState<MenuItem[]>([])
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const pickedIds = new Set(picked.map(m => m.id))
  const q = query.toLowerCase()
  const filtered = menuItems
    .filter(m => !exclude.has(m.id) && !pickedIds.has(m.id) && m.name.toLowerCase().includes(q))
    .slice(0, 8)

  const handleCreate = async () => {
    if (!label.trim()) {
      toast.error('Укажите название группы')
      return
    }
    if (picked.length === 0) {
      toast.error('Добавьте хотя бы одно блюдо')
      return
    }
    setCreating(true)
    try {
      const slot = await createBundleSlot({
        bundleMenuItemId, label: label.trim(), isRequired: true,
        minSelect: picked.length, maxSelect: picked.length, sortOrder,
      })
      await Promise.all(picked.map(item =>
        createBundleSlotOption({ slotId: slot.id, optionMenuItemId: item.id, price: item.price, isDefault: true })
      ))
      onDone()
    } catch {
      toast.error('Не удалось создать группу')
      onDone()
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="border border-dashed border-emerald-500/40 rounded-xl p-3.5 space-y-3 bg-emerald-50/30 dark:bg-emerald-950/10">
      <p className="text-xs text-muted-foreground leading-relaxed">
        Для блюд, которые входят в сет ВСЕГДА, без выбора гостя — соберите список ниже,
        они станут одной группой «входит всегда» вместо отдельного слота на каждое блюдо.
      </p>
      <input
        type="text"
        value={label}
        onChange={e => setLabel(e.target.value)}
        placeholder="Название группы (напр. «Всегда в комплекте»)"
        autoFocus
        className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
      {picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {picked.map(item => (
            <span key={item.id} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 rounded-full">
              {item.name}
              <button type="button" onClick={() => setPicked(p => p.filter(m => m.id !== item.id))} className="p-0.5 hover:bg-emerald-200 dark:hover:bg-emerald-900 rounded-full transition-colors">
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div ref={ref} className="relative">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setIsOpen(true) }}
            onFocus={() => setIsOpen(true)}
            placeholder="Найти и добавить блюдо..."
            className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
          />
        </div>
        {isOpen && (filtered.length > 0 || query.trim() !== '') && (
          <div className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto bg-card border border-border rounded-lg shadow-lg">
            {filtered.length > 0 ? filtered.map(m => (
              <button
                key={m.id}
                type="button"
                onClick={() => { setPicked(p => [...p, m]); setQuery('') }}
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
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="flex-1 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50"
        >
          {creating ? 'Создание…' : `Создать (${picked.length})`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={creating}
          className="py-1.5 px-3 text-xs font-semibold text-muted-foreground hover:bg-muted rounded-lg transition-colors"
        >
          Отмена
        </button>
      </div>
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
  const [showFixedGroup, setShowFixedGroup] = useState(false)

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
  const usedOptionIds = new Set(slots.flatMap(s => s.options.map(o => o.optionMenuItemId)))

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
      {slots.length === 0 && !showNewSlot && !showFixedGroup && (
        <p className="text-xs text-muted-foreground leading-relaxed">
          Сет собирается из слотов («Бургер», «Гарнир», «Напиток») — в каждом один или
          несколько вариантов из настоящего меню. Гость увидит выбор только там, где в
          слоте больше одного варианта; один вариант в слоте подставляется автоматически.
          Цена сета складывается из цен, которые вы зададите на вариантах — здесь же,
          дешевле их обычной цены в меню. Если несколько блюд входят в сет ВСЕГДА, без
          выбора — не создавайте слот на каждое, соберите их одной группой кнопкой
          «Добавить группу «входит всегда»» ниже.
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
      ) : showFixedGroup ? (
        <FixedGroupCreator
          bundleMenuItemId={bundleMenuItemId}
          menuItems={pickableItems}
          exclude={usedOptionIds}
          sortOrder={slots.length}
          onDone={() => { setShowFixedGroup(false); reload() }}
          onCancel={() => setShowFixedGroup(false)}
        />
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setShowNewSlot(true)}
            className="flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-primary/80 transition-colors py-1.5 px-3 rounded-lg hover:bg-primary/5 border border-dashed border-primary/20 flex-1 justify-center min-w-40"
          >
            <Plus className="size-4" /> Добавить слот
          </button>
          <button
            type="button"
            onClick={() => setShowFixedGroup(true)}
            className="flex items-center gap-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 transition-colors py-1.5 px-3 rounded-lg hover:bg-emerald-500/5 border border-dashed border-emerald-500/30 flex-1 justify-center min-w-40"
          >
            <PackageCheck className="size-4" /> Добавить группу «входит всегда»
          </button>
        </div>
      )}
    </div>
  )
}
