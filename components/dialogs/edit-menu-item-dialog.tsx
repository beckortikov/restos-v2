'use client'

import { useState, useEffect, useRef } from 'react'
import { Plus, Trash2, Timer, Search, X } from 'lucide-react'
import { DishImageUpload } from '@/components/dish-image'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  UNITS,
  ALL_STATIONS, STATION_LABELS, STATION_ICONS,
  type TechCardLine,
  type MenuItem,
  type Ingredient,
  type SemiFinishedType,
} from '@/lib/types'
import { fetchIngredients, fetchSemiTypes, fetchMenuCategories } from '@/lib/queries'
import { DecimalInput } from '@/components/ui/decimal-input'
import { useAuth } from '@/lib/auth-store'

interface MenuItemForm {
  name: string
  category: string
  price: number
  emoji: string
  imageUrl?: string
  cogs: number
  cookTimeMin?: number | null
  station: string
  isAvailable: boolean
  isBatchCooking?: boolean
  lowStockThreshold?: number
  isPurchased?: boolean
  purchasePrice?: number
  purchaseUnit?: string
  purchaseMinQty?: number
  unit: 'piece' | 'g' | 'kg'
  unitSize: number
  saleStep: number
  techCard: TechCardLine[]
}

interface EditMenuItemDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  menuItem: MenuItem
  onSubmit: (data: MenuItemForm) => void
  onDelete?: (id: string) => void
  onArchive?: (id: string) => void
}

const emptyTechLine: TechCardLine = {
  name: '',
  qty: 0,
  unit: '',
}

// ─── Ingredient/Semi Combobox ──────────────────────────────────────────────
function IngredientCombobox({
  ingredients,
  semiTypes,
  selectedIngredientId,
  selectedSemiId,
  selectedName,
  onSelectIngredient,
  onSelectSemi,
  onClear,
}: {
  ingredients: Ingredient[]
  semiTypes: SemiFinishedType[]
  selectedIngredientId?: string
  selectedSemiId?: string
  selectedName: string
  onSelectIngredient: (id: string) => void
  onSelectSemi: (id: string) => void
  onClear: () => void
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
  const filteredIngs = ingredients.filter(i => i.name.toLowerCase().includes(q)).slice(0, 6)
  const filteredSemis = semiTypes.filter(s => s.name.toLowerCase().includes(q)).slice(0, 4)
  const hasResults = filteredIngs.length > 0 || filteredSemis.length > 0

  if (selectedIngredientId || selectedSemiId) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-sm bg-card border border-border rounded-lg">
        <span className="flex-1 truncate">{selectedName}</span>
        <button type="button" onClick={onClear} className="shrink-0 p-0.5 hover:bg-muted rounded">
          <X className="size-3.5 text-muted-foreground" />
        </button>
      </div>
    )
  }

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); setIsOpen(true) }}
          onFocus={() => setIsOpen(true)}
          placeholder="Поиск..."
          className="w-full pl-7 pr-2 py-1.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>
      {isOpen && hasResults && (
        <div className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto bg-card border border-border rounded-lg shadow-lg">
          {filteredIngs.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/50">Ингредиенты</div>
              {filteredIngs.map(ing => (
                <button key={ing.id} type="button"
                  onClick={() => { onSelectIngredient(ing.id); setQuery(''); setIsOpen(false) }}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex justify-between">
                  <span>{ing.name}</span>
                  <span className="text-xs text-muted-foreground">{ing.unit}</span>
                </button>
              ))}
            </>
          )}
          {filteredSemis.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/50 border-t border-border">Полуфабрикаты</div>
              {filteredSemis.map(s => (
                <button key={s.id} type="button"
                  onClick={() => { onSelectSemi(s.id); setQuery(''); setIsOpen(false) }}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex justify-between">
                  <span>{s.name}</span>
                  <span className="text-xs text-muted-foreground">{s.outputUnit}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function EditMenuItemDialog({ open, onOpenChange, menuItem, onSubmit, onDelete, onArchive }: EditMenuItemDialogProps) {
  const { restaurant } = useAuth()
  const techCardsEnabled = restaurant?.techCardsEnabled ?? true
  const [form, setForm] = useState<MenuItemForm>({
    name: '',
    category: '',
    price: 0,
    emoji: '',
    cogs: 0,
    cookTimeMin: null,
    station: 'hot_kitchen',
    isAvailable: true,
    lowStockThreshold: 5,
    unit: 'piece',
    unitSize: 1,
    saleStep: 0,
    techCard: [{ ...emptyTechLine }],
  })

  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [semiTypes, setSemiTypes] = useState<SemiFinishedType[]>([])
  const [menuCategories, setMenuCategories] = useState<string[]>([])
  const [dataLoaded, setDataLoaded] = useState(false)

  useEffect(() => {
    if (open && !dataLoaded) {
      Promise.all([fetchIngredients(), fetchSemiTypes(), fetchMenuCategories()])
        .then(([i, s, c]) => { setIngredients(i); setSemiTypes(s); setMenuCategories(c); setDataLoaded(true) })
    }
  }, [open, dataLoaded])

  useEffect(() => {
    if (open && menuItem) {
      // Heuristic: detect purchased item (station showcase + single tech line with qty=1)
      const isPurchased = menuItem.station === 'showcase' && menuItem.techCard.length === 1 && menuItem.techCard[0].qty === 1
      setForm({
        name: menuItem.name,
        category: menuItem.category,
        price: menuItem.price,
        emoji: menuItem.emoji,
        imageUrl: menuItem.imageUrl,
        cogs: menuItem.cogs,
        cookTimeMin: menuItem.cookTimeMin ?? null,
        station: menuItem.station || 'hot_kitchen',
        isAvailable: menuItem.isAvailable,
        isBatchCooking: menuItem.isBatchCooking ?? false,
        lowStockThreshold: menuItem.lowStockThreshold ?? 5,
        isPurchased,
        unit: menuItem.unit || 'piece',
        unitSize: menuItem.unitSize ?? 1,
        saleStep: menuItem.saleStep ?? 0,
        techCard: menuItem.techCard.length > 0 ? [...menuItem.techCard] : [{ ...emptyTechLine }],
      })
    }
  }, [open, menuItem])

  function updateTechLine(index: number, patch: Partial<TechCardLine>) {
    setForm((prev) => {
      const techCard = [...prev.techCard]
      techCard[index] = { ...techCard[index], ...patch }
      return { ...prev, techCard }
    })
  }

  function selectIngredient(index: number, id: string) {
    const ing = ingredients.find((i) => i.id === id)
    if (!ing) return
    updateTechLine(index, { ingredientId: id, semiId: undefined, name: ing.name, unit: ing.unit })
  }

  function selectSemi(index: number, id: string) {
    const semi = semiTypes.find((s) => s.id === id)
    if (!semi) return
    updateTechLine(index, { semiId: id, ingredientId: undefined, name: semi.name, unit: semi.outputUnit })
  }

  function clearTechLine(index: number) {
    updateTechLine(index, { ingredientId: undefined, semiId: undefined, name: '', unit: '', qty: 0 })
  }

  function addTechLine() {
    setForm((prev) => ({ ...prev, techCard: [...prev.techCard, { ...emptyTechLine }] }))
  }

  function removeTechLine(index: number) {
    setForm((prev) => ({ ...prev, techCard: prev.techCard.filter((_, i) => i !== index) }))
  }

  function handleSubmit() {
    onSubmit(form)
    onOpenChange(false)
  }

  function handleDelete() {
    if (onDelete) {
      onDelete(menuItem.id)
      onOpenChange(false)
    }
  }

  function handleArchive() {
    if (onArchive) {
      onArchive(menuItem.id)
      onOpenChange(false)
    }
  }

  const techCardValid = form.techCard.length === 0 || form.techCard.every((l) => (l.ingredientId || l.semiId) && l.qty > 0)
  const canSubmit = !!form.name && !!form.category && form.price > 0 && (
    !techCardsEnabled
      ? true
      : form.isPurchased
        ? (form.purchasePrice ?? 0) > 0 && !!form.purchaseUnit
        : techCardValid
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle>Редактировать блюдо</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Photo upload */}
          <div className="flex items-start gap-4">
            <DishImageUpload
              imageUrl={form.imageUrl}
              emoji={form.emoji || undefined}
              onImageUploaded={(url) => setForm((p) => ({ ...p, imageUrl: url }))}
            />
            <div className="text-xs text-muted-foreground pt-2">
              <p className="font-medium text-foreground">Фото блюда</p>
              <p className="mt-0.5">Нажмите чтобы загрузить фото. Если нет фото — будет показан эмодзи.</p>
            </div>
          </div>

          {/* Row 1: Название, Категория */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Название</label>
              <input type="text" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="Плов"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Категория</label>
              <select value={form.category} onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30">
                <option value="">Выберите</option>
                {menuCategories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          {/* Row 2: Цена, Себестоимость, Готовность, Доступно */}
          <div className={`grid ${form.isPurchased ? 'grid-cols-2' : 'grid-cols-4'} gap-2`}>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {form.unit === 'g' ? 'Цена за 100г' : 'Цена'}
              </label>
              <DecimalInput value={form.price} onChange={(v) => setForm((p) => ({ ...p, price: v }))} min={0}
                className="w-full px-2 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            {!form.isPurchased && (
              <>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Себестоимость</label>
                  <DecimalInput value={form.cogs} onChange={(v) => setForm((p) => ({ ...p, cogs: v }))} min={0}
                    className="w-full px-2 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block flex items-center gap-1"><Timer className="size-3" />Готовность (мин)</label>
                  <input type="number" min={0} value={form.cookTimeMin ?? ''} onChange={(e) => setForm((p) => ({ ...p, cookTimeMin: e.target.value ? parseInt(e.target.value) : null }))} placeholder="25"
                    className="w-full px-2 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
              </>
            )}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Доступно</label>
              <button type="button" onClick={() => setForm((p) => ({ ...p, isAvailable: !p.isAvailable }))}
                className={`w-full px-2 py-2 text-sm font-medium rounded-lg border transition-colors ${form.isAvailable ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : 'bg-card border-border text-muted-foreground'}`}>
                {form.isAvailable ? 'Да' : 'Нет'}
              </button>
            </div>
          </div>

          {/* Row 3: Станция */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Станция</label>
            <div className="grid grid-cols-5 gap-1.5">
              {(form.isPurchased ? (['bar', 'showcase'] as const) : ALL_STATIONS).map(s => (
                <button key={s} type="button" onClick={() => setForm((p) => ({ ...p, station: s }))}
                  className={`flex flex-col items-center gap-0.5 py-2 rounded-lg border-2 transition-all ${form.station === s ? 'border-primary bg-primary/5 text-primary' : 'border-border hover:border-muted-foreground/30 text-foreground'}`}>
                  <span className="text-base">{STATION_ICONS[s]}</span>
                  <span className="text-[10px] font-medium leading-tight">{STATION_LABELS[s]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Toggles row */}
          <div className={`grid ${techCardsEnabled ? 'grid-cols-3' : 'grid-cols-2'} gap-2`}>
            {techCardsEnabled && (
              <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-muted/30">
                <div>
                  <p className="text-xs font-medium text-foreground">Покупной товар</p>
                  <p className="text-[10px] text-muted-foreground">Без техкарты</p>
                </div>
                <button type="button" onClick={() => setForm(p => ({ ...p, isPurchased: !p.isPurchased, isBatchCooking: false }))}
                  className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-2 ${form.isPurchased ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
                  <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform ${form.isPurchased ? 'translate-x-5' : ''}`} />
                </button>
              </div>
            )}
            <div className="px-3 py-2.5 rounded-lg border border-border bg-muted/30">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-foreground">Заготовочное</p>
                  <p className="text-[10px] text-muted-foreground">{techCardsEnabled ? 'Партиями' : 'Счётчик порций'}</p>
                </div>
                <button type="button" onClick={() => setForm(p => ({ ...p, isBatchCooking: !p.isBatchCooking, isPurchased: false }))}
                  className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-2 ${form.isBatchCooking ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
                  <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform ${form.isBatchCooking ? 'translate-x-5' : ''}`} />
                </button>
              </div>
              {form.isBatchCooking && (
                <div className="mt-2 pt-2 border-t border-border/50 flex items-center gap-2">
                  <label className="text-[10px] text-muted-foreground flex-1">Порог «заканчивается» (порц.)</label>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={form.lowStockThreshold ?? 5}
                    onChange={e => setForm(p => ({ ...p, lowStockThreshold: Math.max(1, Number(e.target.value) || 5) }))}
                    className="w-14 px-1.5 py-1 text-xs text-center bg-card border border-border rounded-md"
                  />
                </div>
              )}
            </div>
            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-muted/30">
              <div>
                <p className="text-xs font-medium text-foreground">За граммы</p>
                <p className="text-[10px] text-muted-foreground">Продажа на вес</p>
              </div>
              <button type="button" onClick={() => setForm(p => ({ ...p, unit: p.unit === 'g' ? 'piece' : 'g', unitSize: p.unit === 'g' ? 1 : 100, saleStep: p.unit === 'g' ? 0 : 50 }))}
                className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-2 ${form.unit === 'g' ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
                <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform ${form.unit === 'g' ? 'translate-x-5' : ''}`} />
              </button>
            </div>
          </div>

          {!techCardsEnabled ? null : form.isPurchased ? (
            /* Purchased item fields */
            <div className="space-y-3 p-4 rounded-xl border border-blue-200 bg-blue-50/50">
              <p className="text-xs font-medium text-blue-800">Закупочные данные</p>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground">Цена закупки</label>
                  <DecimalInput
                    value={form.purchasePrice || 0}
                    onChange={v => setForm(p => ({ ...p, purchasePrice: v, cogs: v }))}
                    min={0}
                    placeholder="0"
                    className="w-full px-2 py-1.5 text-sm bg-card border border-border rounded-lg" />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground">Единица</label>
                  <select value={form.purchaseUnit || ''}
                    onChange={e => setForm(p => ({ ...p, purchaseUnit: e.target.value }))}
                    className="w-full px-2 py-1.5 text-sm bg-card border border-border rounded-lg">
                    <option value="">Выберите</option>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground">Мин. остаток</label>
                  <DecimalInput
                    value={form.purchaseMinQty || 0}
                    onChange={v => setForm(p => ({ ...p, purchaseMinQty: v }))}
                    min={0}
                    placeholder="0"
                    className="w-full px-2 py-1.5 text-sm bg-card border border-border rounded-lg" />
                </div>
              </div>
              <p className="text-[10px] text-blue-600">Покупной товар. Приёмка через накладные.</p>
            </div>
          ) : (
            <>
            {/* Tech card with search */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Техкарта</label>
              {form.techCard.map((line, i) => (
                <div key={i} className="flex items-end gap-2 p-2.5 bg-muted/50 rounded-lg border border-border">
                  <div className="flex-1 min-w-[160px] space-y-1">
                    <span className="text-[10px] text-muted-foreground">Ингредиент / полуфабрикат</span>
                    <IngredientCombobox
                      ingredients={ingredients}
                      semiTypes={semiTypes}
                      selectedIngredientId={line.ingredientId}
                      selectedSemiId={line.semiId}
                      selectedName={line.name}
                      onSelectIngredient={(id) => selectIngredient(i, id)}
                      onSelectSemi={(id) => selectSemi(i, id)}
                      onClear={() => clearTechLine(i)}
                    />
                  </div>
                  <div className="w-20 space-y-1">
                    <span className="text-[10px] text-muted-foreground">Кол-во</span>
                    <DecimalInput value={line.qty} onChange={(v) => updateTechLine(i, { qty: v })} min={0}
                      className="w-full px-2 py-1.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30" />
                  </div>
                  <div className="w-16 space-y-1">
                    <span className="text-[10px] text-muted-foreground">Ед.</span>
                    <select value={line.unit}
                      onChange={(e) => updateTechLine(i, { unit: e.target.value })}
                      className="w-full px-1 py-1.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30">
                      <option value="">—</option>
                      {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                  {form.techCard.length > 1 && (
                    <button type="button" onClick={() => removeTechLine(i)}
                      className="p-1.5 text-destructive hover:bg-destructive/10 rounded-lg transition-colors">
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
              ))}
              <button type="button" onClick={addTechLine}
                className="flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors">
                <Plus className="size-4" /> Добавить ингредиент
              </button>
            </div>
            </>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <div className="flex flex-col sm:flex-row gap-2 sm:mr-auto">
            {onArchive && (
              <button type="button" onClick={handleArchive}
                className="px-4 py-2 text-sm font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors">
                Архивировать
              </button>
            )}
            {onDelete && (
              <button type="button" onClick={handleDelete}
                className="px-4 py-2 text-sm font-medium text-destructive bg-destructive/10 border border-destructive/30 rounded-lg hover:bg-destructive/20 transition-colors">
                Удалить блюдо
              </button>
            )}
          </div>
          <button type="button" onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted transition-colors">
            Отмена
          </button>
          <button type="button" onClick={handleSubmit} disabled={!canSubmit}
            className="px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none">
            Сохранить
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
