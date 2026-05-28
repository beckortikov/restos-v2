'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { type SemiFinishedType, type SemiFinishedStock, type Ingredient } from '@/lib/types'
import { fetchSemiTypes, fetchSemiStock, fetchIngredients, produceSemiFab, createSemiType, deleteSemiType } from '@/lib/queries'
import { Plus, FlaskConical, ChevronDown, ChevronRight, X, Trash2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { DecimalInput } from '@/components/ui/decimal-input'
import { dMul, dDiv } from '@/lib/decimal'

// ─── Ingredient Combobox ───────────────────────────────────────────────
function IngredientCombobox({
  ingredients,
  selectedId,
  selectedName,
  onSelect,
  onClear,
}: {
  ingredients: Ingredient[]
  selectedId?: string
  selectedName?: string
  onSelect: (id: string) => void
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
  const filtered = ingredients.filter(i => i.name.toLowerCase().includes(q)).slice(0, 10)

  if (selectedId) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-sm bg-background border border-border rounded-lg">
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
          placeholder="Поиск ингредиента..."
          className="w-full pl-7 pr-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>
      {isOpen && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto bg-card border border-border rounded-lg shadow-lg">
          {filtered.map(ing => (
            <button key={ing.id} type="button"
              onClick={() => { onSelect(ing.id); setQuery(''); setIsOpen(false) }}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex justify-between">
              <span>{ing.name}</span>
              <span className="text-xs text-muted-foreground">{ing.unit}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Unit conversion ───────────────────────────────────────────────
// Returns deduction in ingredient's stock unit given recipe unit
function convertToStock(qty: number, ingredientUnit: string, recipeUnit: string): number {
  const s = ingredientUnit.toLowerCase().trim()
  const r = recipeUnit.toLowerCase().trim()
  if (s === r) return qty
  if ((s === 'кг' || s === 'kg') && (r === 'г' || r === 'g' || r === 'гр')) return dDiv(qty, 1000)
  if ((s === 'г' || s === 'g' || s === 'гр') && (r === 'кг' || r === 'kg')) return dMul(qty, 1000)
  if ((s === 'л' || s === 'l') && (r === 'мл' || r === 'ml')) return dDiv(qty, 1000)
  if ((s === 'мл' || s === 'ml') && (r === 'л' || r === 'l')) return dMul(qty, 1000)
  return qty
}

const OUTPUT_UNITS = ['кг', 'г', 'л', 'мл', 'шт', 'порц', 'уп']

export default function SemiPage() {
  const { canDo } = useAuth()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [producing, setProducing] = useState<string | null>(null)
  const [qty, setQty] = useState(1)
  const [semiTypes, setSemiTypes] = useState<SemiFinishedType[]>([])
  const [semiStock, setSemiStock] = useState<SemiFinishedStock[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUnit, setNewUnit] = useState('кг')
  const [newYield, setNewYield] = useState(100)
  const [newRecipe, setNewRecipe] = useState<{ ingredientId: string; name: string; qtyPerUnit: number; unit: string }[]>([])
  const [saving, setSaving] = useState(false)

  const reload = () => {
    Promise.all([fetchSemiTypes(), fetchSemiStock(), fetchIngredients()])
      .then(([types, stock, ings]) => { setSemiTypes(types); setSemiStock(stock); setIngredients(ings) })
  }

  useEffect(() => {
    Promise.all([fetchSemiTypes(), fetchSemiStock(), fetchIngredients()])
      .then(([types, stock, ings]) => { setSemiTypes(types); setSemiStock(stock); setIngredients(ings); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  // Recipe line cost helper
  const recipeLineCost = (qtyPerUnit: number, recipeUnit: string, ingredientId: string): number => {
    const ing = ingredients.find(i => i.id === ingredientId)
    if (!ing) return 0
    // convert recipe qty to ingredient's stock unit, then multiply by price
    const inStockUnit = convertToStock(qtyPerUnit, ing.unit, recipeUnit)
    return dMul(inStockUnit, ing.pricePerUnit)
  }

  const handleCreate = async () => {
    if (!newName.trim()) { toast.error('Введите название'); return }
    if (newRecipe.length === 0) { toast.error('Добавьте хотя бы один ингредиент'); return }
    if (newRecipe.some(l => !l.ingredientId || l.qtyPerUnit <= 0)) { toast.error('Заполните все строки рецепта'); return }
    setSaving(true)
    try {
      await createSemiType(newName.trim(), newUnit, newRecipe, newYield)
      toast.success('Полуфабрикат создан')
      setShowCreate(false)
      setNewName('')
      setNewUnit('кг')
      setNewYield(100)
      setNewRecipe([])
      reload()
    } catch (e) {
      console.error(e)
      toast.error('Ошибка создания')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Удалить "${name}"?`)) return
    try {
      await deleteSemiType(id)
      toast.success('Удалено')
      reload()
    } catch {
      toast.error('Ошибка удаления')
    }
  }

  const addRecipeLine = () => {
    setNewRecipe(prev => [...prev, { ingredientId: '', name: '', qtyPerUnit: 0, unit: 'г' }])
  }

  const selectIngredient = (idx: number, id: string) => {
    const ing = ingredients.find(i => i.id === id)
    if (!ing) return
    // Default recipe unit: use smaller unit for weight/volume, otherwise ingredient's unit
    const u = ing.unit.toLowerCase().trim()
    let defaultUnit: string = ing.unit
    if (u === 'кг' || u === 'kg') defaultUnit = 'г'
    else if (u === 'л' || u === 'l') defaultUnit = 'мл'
    setNewRecipe(prev => prev.map((l, i) => i === idx ? { ...l, ingredientId: id, name: ing.name, unit: defaultUnit } : l))
  }

  const clearIngredient = (idx: number) => {
    setNewRecipe(prev => prev.map((l, i) => i === idx ? { ...l, ingredientId: '', name: '', unit: 'г' } : l))
  }

  // Allowed recipe units for a given ingredient (based on its stock unit).
  // Weight (кг/г), volume (л/мл) support conversion; pieces/packs/bunches are 1-to-1.
  const getRecipeUnitsFor = (ingredientId: string): string[] => {
    const ing = ingredients.find(i => i.id === ingredientId)
    if (!ing) return ['г', 'кг']
    const u = ing.unit.toLowerCase().trim()
    if (['кг', 'kg', 'г', 'g', 'гр'].includes(u)) return ['г', 'кг']
    if (['л', 'l', 'мл', 'ml'].includes(u)) return ['мл', 'л']
    // For pieces, packs, bunches, etc — use ingredient's unit as-is
    return [ing.unit]
  }

  // Cost estimate for create form
  const totalRecipeCost = useMemo(() => {
    return newRecipe.reduce((sum, l) => sum + recipeLineCost(l.qtyPerUnit, l.unit, l.ingredientId), 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newRecipe, ingredients])

  const filteredTypes = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return semiTypes
    return semiTypes.filter(t => t.name.toLowerCase().includes(q) || t.recipe.some(r => r.name.toLowerCase().includes(q)))
  }, [semiTypes, search])

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">Полуфабрикаты</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Производство заготовок из сырья</p>
      </div>

      {/* Stock */}
      {semiStock.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Текущие запасы</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {semiStock.map((s) => (
              <div key={s.id} className="bg-card rounded-xl border border-border p-4">
                <div className="flex items-center gap-2 mb-2">
                  <FlaskConical className="size-4 text-primary" />
                  <span className="font-semibold text-foreground text-sm">{s.name}</span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold text-foreground">{formatNum(s.qty)}</span>
                  <span className="text-sm text-muted-foreground">{s.unit}</span>
                </div>
                {s.pricePerUnit > 0 && (
                  <p className="text-xs text-foreground mt-1">
                    Себест.: <span className="font-semibold">{formatCurrency(s.pricePerUnit)}</span>/{s.unit}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">
                  Пр-во: {new Date(s.lastProducedAt).toLocaleDateString('ru')} {new Date(s.lastProducedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Types */}
      <div>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Типы полуфабрикатов</h2>
          {canDo('menu.edit') && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:bg-primary/90 transition-colors w-full sm:w-auto justify-center"
            >
              <Plus className="size-3.5" />Новый тип
            </button>
          )}
        </div>

        {/* Search */}
        {semiTypes.length > 0 && (
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Поиск по названию или ингредиенту..."
              className="w-full pl-9 pr-3 py-2.5 bg-card border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        )}

        {/* Create form */}
        {showCreate && (
          <div className="bg-card rounded-xl border border-border p-5 mb-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-foreground text-sm">Новый полуфабрикат</h3>
              <button onClick={() => setShowCreate(false)} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Название</label>
                <input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="Тесто дрожжевое"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Ед. выхода</label>
                <select
                  value={newUnit}
                  onChange={e => setNewUnit(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  {OUTPUT_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Выход (%)</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={newYield}
                  onChange={e => setNewYield(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {newYield < 100 ? `${100 - newYield}% потери при обработке` : 'Без потерь'}
                </p>
              </div>
            </div>

            {/* Recipe lines */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-muted-foreground">Рецептура (на 1 {newUnit} выхода)</label>
                <button onClick={addRecipeLine} className="text-xs text-primary hover:underline flex items-center gap-1">
                  <Plus className="size-3" />Ингредиент
                </button>
              </div>
              {newRecipe.length === 0 && (
                <p className="text-xs text-muted-foreground italic py-3 text-center bg-muted/30 rounded-lg">Нажмите «+ Ингредиент» чтобы добавить</p>
              )}
              <div className="space-y-2">
                {newRecipe.map((line, idx) => {
                  const allowedUnits = getRecipeUnitsFor(line.ingredientId)
                  const cost = recipeLineCost(line.qtyPerUnit, line.unit, line.ingredientId)
                  return (
                    <div key={idx} className="flex items-end gap-2 p-2 bg-muted/30 rounded-lg">
                      <div className="flex-1 min-w-0 space-y-1">
                        <span className="text-[10px] text-muted-foreground">Ингредиент</span>
                        <IngredientCombobox
                          ingredients={ingredients}
                          selectedId={line.ingredientId || undefined}
                          selectedName={line.name}
                          onSelect={(id) => selectIngredient(idx, id)}
                          onClear={() => clearIngredient(idx)}
                        />
                      </div>
                      <div className="w-24 space-y-1">
                        <span className="text-[10px] text-muted-foreground">Кол-во</span>
                        <DecimalInput
                          min={0}
                          value={line.qtyPerUnit}
                          onChange={v => setNewRecipe(prev => prev.map((l, i) => i === idx ? { ...l, qtyPerUnit: v } : l))}
                          className="w-full px-2 py-1.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                      </div>
                      <div className="w-20 space-y-1">
                        <span className="text-[10px] text-muted-foreground">Ед.</span>
                        <select
                          value={line.unit}
                          onChange={e => setNewRecipe(prev => prev.map((l, i) => i === idx ? { ...l, unit: e.target.value } : l))}
                          className="w-full px-2 py-1.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                        >
                          {allowedUnits.map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </div>
                      <div className="w-24 text-right pb-1.5">
                        <span className="text-[10px] text-muted-foreground block">Стоимость</span>
                        <span className="text-xs font-medium text-foreground">{cost > 0 ? formatCurrency(cost) : '—'}</span>
                      </div>
                      <button
                        onClick={() => setNewRecipe(prev => prev.filter((_, i) => i !== idx))}
                        className="p-1.5 text-destructive hover:bg-destructive/10 rounded-lg transition-colors self-center"
                        aria-label="Удалить"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  )
                })}
              </div>
              {newRecipe.length > 0 && totalRecipeCost > 0 && (
                <div className="mt-3 flex justify-end">
                  <span className="text-sm text-foreground">
                    Себестоимость 1 {newUnit}: <span className="font-bold">{formatCurrency(totalRecipeCost)}</span>
                  </span>
                </div>
              )}
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setShowCreate(false)}
                className="px-5 py-2.5 bg-muted text-foreground rounded-xl text-sm font-medium hover:bg-muted/80 transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={handleCreate}
                disabled={saving}
                className="flex-1 sm:flex-none px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {saving ? 'Сохранение...' : 'Создать полуфабрикат'}
              </button>
            </div>
          </div>
        )}

        {semiTypes.length === 0 && !showCreate && (
          <div className="bg-card rounded-xl border border-border p-8 text-center">
            <FlaskConical className="size-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">Нет типов полуфабрикатов</p>
            <p className="text-xs text-muted-foreground mt-1">Создайте первый тип нажав кнопку выше</p>
          </div>
        )}

        {semiTypes.length > 0 && filteredTypes.length === 0 && (
          <div className="bg-card rounded-xl border border-border p-8 text-center">
            <p className="text-sm text-muted-foreground">Ничего не найдено по запросу «{search}»</p>
          </div>
        )}

        <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
          {filteredTypes.map((type) => {
            const totalCost = type.recipe.reduce((sum, l) => sum + recipeLineCost(l.qtyPerUnit, l.unit, l.ingredientId), 0)
            return (
              <div key={type.id}>
                <div
                  onClick={() => setExpanded(expanded === type.id ? null : type.id)}
                  className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-muted/30 transition-colors text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FlaskConical className="size-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium text-foreground text-sm truncate">{type.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {type.recipe.length} ингр. · Выход: {type.yieldPercent}%
                        {type.yieldPercent < 100 && <span className="text-amber-600"> · Потери: {100 - type.yieldPercent}%</span>}
                        {totalCost > 0 && <span className="text-foreground"> · {formatCurrency(totalCost)}/{type.outputUnit}</span>}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {canDo('menu.edit') && (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); setProducing(type.id); setQty(1) }}
                          className="px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:bg-primary/90 transition-colors"
                        >
                          Произвести
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(type.id, type.name) }}
                          className="p-1.5 text-muted-foreground hover:text-destructive transition-colors"
                          aria-label="Удалить"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </>
                    )}
                    {expanded === type.id ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                  </div>
                </div>

                {/* Recipe */}
                {expanded === type.id && (
                  <div className="px-6 pb-4 bg-muted/20">
                    <p className="text-xs font-semibold text-muted-foreground mb-2 mt-2">Рецептура на 1 {type.outputUnit}:</p>
                    <div className="space-y-1">
                      {type.recipe.map((line) => {
                        const cost = recipeLineCost(line.qtyPerUnit, line.unit, line.ingredientId)
                        return (
                          <div key={line.ingredientId} className="flex items-center justify-between text-sm max-w-md">
                            <span className="text-foreground">{line.name}</span>
                            <div className="flex items-center gap-4 text-muted-foreground">
                              <span>{formatNum(line.qtyPerUnit)} {line.unit}</span>
                              <span className="text-foreground font-medium w-24 text-right">{cost > 0 ? formatCurrency(cost) : '—'}</span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Production form */}
                {producing === type.id && (
                  <div className="px-6 py-4 bg-primary/5 border-t border-border">
                    <p className="text-sm font-medium text-foreground mb-3">Произвести: {type.name}</p>
                    <div className="flex items-center gap-3 flex-wrap">
                      <label className="text-sm text-muted-foreground">Количество:</label>
                      <DecimalInput
                        min={0}
                        value={qty}
                        onChange={setQty}
                        className="w-28 px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                      />
                      <span className="text-sm text-muted-foreground">{type.outputUnit}</span>
                      <button
                        onClick={async () => {
                          if (qty <= 0) { toast.error('Введите количество'); return }
                          try {
                            await produceSemiFab(type.id, qty)
                            const [newStock, newIngs] = await Promise.all([fetchSemiStock(), fetchIngredients()])
                            setSemiStock(newStock)
                            setIngredients(newIngs)
                            setProducing(null)
                            toast.success(`Произведено ${formatNum(qty)} ${type.outputUnit} — ${type.name}`)
                          } catch {
                            toast.error('Ошибка при производстве')
                          }
                        }}
                        className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
                      >
                        Подтвердить
                      </button>
                      <button onClick={() => setProducing(null)} className="px-3 py-2 text-sm text-muted-foreground hover:bg-muted rounded-lg transition-colors">
                        Отмена
                      </button>
                    </div>
                    {qty > 0 && (
                      <div className="mt-3 pt-3 border-t border-border/60">
                        <p className="text-xs font-semibold text-muted-foreground mb-1.5">Будет списано со склада:</p>
                        <div className="space-y-0.5">
                          {type.recipe.map((line) => {
                            const totalRecipeQty = dMul(line.qtyPerUnit, qty)
                            return (
                              <p key={line.ingredientId} className="text-xs text-foreground">
                                <span className="text-destructive">−</span> {formatNum(totalRecipeQty)} {line.unit} {line.name}
                              </p>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
