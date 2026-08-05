'use client'

import { useState, useMemo } from 'react'
import { Plus, Minus, Trash2, Search, CheckCircle2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { UNITS, type TechCardLine, type Ingredient, type SemiFinishedType } from '@/lib/types'
import { DecimalInput } from '@/components/ui/decimal-input'
import { createIngredient } from '@/lib/queries'
import { toast } from 'sonner'

const emptyTechLine: TechCardLine = { name: '', qty: 0, unit: '' }

type PickTarget =
  | { kind: 'ingredient'; ing: Ingredient }
  | { kind: 'semi'; semi: SemiFinishedType }

// ─── Строки тех. карты (контролируемый компонент) ──────────────────────────
// Используется и для базовой техкарты продукта, и для техкарты отдельного
// размерного варианта (menu_item_id разный, форма одна и та же), и — на
// правах action-sheet-встройки (ADR-задача #49 М5) — прямо в списке блюд.
//
// Пикер устроен по образцу create-writeoff-dialog.tsx («собрать корзину из
// N позиций с количествами» — та же задача, что у списания): поиск + чипы
// Ингредиенты/Полуфабрикаты → тап по строке добавляет/увеличивает qty →
// список снизу со степперами. Раньше здесь было N независимых comboboxов
// (по одному на строку) без ранжирования и без степперов — рецепт из 20
// позиций требовал 20 отдельных поисков.
//
// onQuickCreate?: делегированный режим — если родитель его передал (как
// комбо-таб в new/page.tsx), создание нового товара идёт через его
// собственный диалог: мы добавляем пустую строку-плейсхолдер и просим
// родителя её заполнить по индексу, как раньше делал каждый ряд-комбобокс.
// Если onQuickCreate не передан — компонент показывает свой диалог создания
// сам (самодостаточный режим) и уведомляет родителя через onIngredientCreated,
// чтобы тот при желании обновил свой общий список ingredients.
export function TechCardLinesEditor({
  lines,
  onChange,
  ingredients,
  semiTypes,
  matchingSemiIds,
  onQuickCreate,
  onIngredientCreated,
}: {
  lines: TechCardLine[]
  onChange: (next: TechCardLine[]) => void
  ingredients: Ingredient[]
  semiTypes: SemiFinishedType[]
  matchingSemiIds?: Set<string>
  onQuickCreate?: (name: string, targetIndex: number) => void
  onIngredientCreated?: (ingredient: Ingredient) => void
}) {
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState<'all' | 'ingredient' | 'semi'>('all')
  const [quickCreateName, setQuickCreateName] = useState<string | null>(null)
  const [newUnit, setNewUnit] = useState('кг')
  const [newCategory, setNewCategory] = useState('Продукты')
  const [newIsFood, setNewIsFood] = useState(true)
  const [newMinQty, setNewMinQty] = useState(0)
  const [newPrice, setNewPrice] = useState(0)
  const [creating, setCreating] = useState(false)

  function lineId(l: TechCardLine) {
    return l.ingredientId ? `i:${l.ingredientId}` : l.semiId ? `s:${l.semiId}` : undefined
  }

  function updateLine(id: string, patch: Partial<TechCardLine>) {
    onChange(lines.map(l => lineId(l) === id ? { ...l, ...patch } : l))
  }

  function removeLine(id: string) {
    onChange(lines.filter(l => lineId(l) !== id))
  }

  function addOrBump(target: PickTarget) {
    const id = target.kind === 'ingredient' ? `i:${target.ing.id}` : `s:${target.semi.id}`
    const existing = lines.find(l => lineId(l) === id)
    if (existing) {
      updateLine(id, { qty: existing.qty + 1 })
      return
    }
    const newLine: TechCardLine = target.kind === 'ingredient'
      ? { ingredientId: target.ing.id, name: target.ing.name, unit: target.ing.unit, qty: 1 }
      : { semiId: target.semi.id, name: target.semi.name, unit: target.semi.outputUnit, qty: 1 }
    // Пустая строка-заготовка (её сеют VariantTechCardsEditor/страницы, пока
    // рецепт ещё не начат) сюда не в счёт — заменяем её первым реальным добавлением.
    onChange([...lines.filter(l => l.ingredientId || l.semiId), newLine])
  }

  function bumpQty(line: TechCardLine, delta: number) {
    const id = lineId(line)
    if (!id) return
    updateLine(id, { qty: Math.max(0.1, line.qty + delta) })
  }

  const q = search.trim().toLowerCase()
  function rank(name: string) {
    const n = name.toLowerCase()
    if (n === q) return 0
    if (n.startsWith(q)) return 1
    return 2
  }

  const filteredIngs = useMemo(() => {
    if (group === 'semi') return []
    return ingredients
      .filter(i => !q || i.name.toLowerCase().includes(q))
      .sort((a, b) => rank(a.name) - rank(b.name))
  }, [ingredients, q, group])

  const filteredSemis = useMemo(() => {
    if (group === 'ingredient') return []
    return semiTypes
      .filter(s => !q || s.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const am = matchingSemiIds?.has(a.sizeScaleValueId ?? '') ? 0 : 1
        const bm = matchingSemiIds?.has(b.sizeScaleValueId ?? '') ? 0 : 1
        if (am !== bm) return am - bm
        return rank(a.name) - rank(b.name)
      })
  }, [semiTypes, q, group, matchingSemiIds])

  const activeLines = lines.filter(l => l.ingredientId || l.semiId)

  function triggerQuickCreate() {
    const trimmed = search.trim()
    if (!trimmed) return
    if (onQuickCreate) {
      const targetIndex = lines.length
      onChange([...lines, { ...emptyTechLine }])
      onQuickCreate(trimmed, targetIndex)
      setSearch('')
      return
    }
    setQuickCreateName(trimmed)
    setNewUnit('кг')
    setNewCategory('Продукты')
    setNewIsFood(true)
    setNewMinQty(0)
    setNewPrice(0)
  }

  async function handleCreateIngredient(e: React.FormEvent) {
    e.preventDefault()
    if (creating || !quickCreateName?.trim()) return
    setCreating(true)
    try {
      const ing = await createIngredient({
        name: quickCreateName.trim(),
        category: newCategory.trim() || 'Продукты',
        qty: 0,
        min_qty: newMinQty || 0,
        unit: newUnit,
        price_per_unit: newPrice || 0,
        is_food: newIsFood,
      })
      if (ing) {
        onIngredientCreated?.(ing)
        addOrBump({ kind: 'ingredient', ing })
        setQuickCreateName(null)
        setSearch('')
        toast.success(`Товар «${ing.name}» создан и добавлен в техкарту`)
      }
    } catch {
      toast.error('Ошибка создания товара')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Поиск ингредиента или полуфабриката..."
          className="w-full h-11 pl-9 pr-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
        />
      </div>

      {semiTypes.length > 0 && (
        <div className="flex gap-1.5">
          {(['all', 'ingredient', 'semi'] as const).map(g => (
            <button
              key={g}
              type="button"
              onClick={() => setGroup(g)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border whitespace-nowrap transition-colors ${
                group === g ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border hover:bg-muted'
              }`}
            >
              {g === 'all' ? 'Все' : g === 'ingredient' ? 'Ингредиенты' : 'Полуфабрикаты'}
            </button>
          ))}
        </div>
      )}

      <div className="border border-border rounded-xl overflow-hidden bg-card">
        <div className="max-h-52 overflow-y-auto divide-y divide-border">
          {filteredIngs.map(ing => {
            const inCart = lines.find(l => l.ingredientId === ing.id)
            return (
              <button
                key={ing.id}
                type="button"
                onClick={() => addOrBump({ kind: 'ingredient', ing })}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors ${inCart ? 'bg-primary/5' : ''}`}
              >
                <span className="flex-1 min-w-0 truncate text-sm font-medium text-foreground">{ing.name}</span>
                {inCart && <span className="shrink-0 text-xs font-semibold text-primary">в техкарте: {inCart.qty} {inCart.unit}</span>}
                <span className="shrink-0 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{ing.unit}</span>
              </button>
            )
          })}
          {filteredSemis.map(s => {
            const inCart = lines.find(l => l.semiId === s.id)
            const matches = matchingSemiIds?.has(s.sizeScaleValueId ?? '')
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => addOrBump({ kind: 'semi', semi: s })}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors ${inCart ? 'bg-primary/5' : ''}`}
              >
                <span className="flex-1 min-w-0 truncate text-sm font-medium text-foreground flex items-center gap-1">
                  {matches && <CheckCircle2 className="size-3.5 text-emerald-600 shrink-0" />}
                  {s.name}
                </span>
                {inCart && <span className="shrink-0 text-xs font-semibold text-primary">в техкарте: {inCart.qty} {inCart.unit}</span>}
                <span className="shrink-0 text-xs text-muted-foreground bg-primary/10 text-primary px-1.5 py-0.5 rounded font-semibold">{s.outputUnit} (п/ф)</span>
              </button>
            )
          })}
          {filteredIngs.length === 0 && filteredSemis.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">Ничего не найдено</div>
          )}
          {q !== '' && group !== 'semi' && (
            <button
              type="button"
              onClick={triggerQuickCreate}
              className="w-full flex items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-primary hover:bg-primary/5 transition-colors border-t border-border"
            >
              <Plus className="size-4" />
              Создать продукт «{search.trim()}»
            </button>
          )}
        </div>
      </div>

      {activeLines.length > 0 && (
        <div className="space-y-2 pt-1">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1">В техкарте ({activeLines.length})</p>
          {activeLines.map(line => {
            const id = lineId(line)!
            return (
              <div key={id} className="flex items-center gap-2 bg-muted/20 border border-border/50 rounded-xl px-3 py-2">
                <span className="flex-1 min-w-0 truncate text-sm font-medium text-foreground">{line.name}</span>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => bumpQty(line, -1)}
                    className="size-7 rounded bg-card border border-border flex items-center justify-center hover:bg-muted transition-colors"
                  >
                    <Minus className="size-3" />
                  </button>
                  <DecimalInput
                    value={line.qty}
                    onChange={v => updateLine(id, { qty: v })}
                    min={0}
                    className="w-16 px-2 py-1 text-sm text-center bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button
                    type="button"
                    onClick={() => bumpQty(line, 1)}
                    className="size-7 rounded bg-card border border-border flex items-center justify-center hover:bg-muted transition-colors"
                  >
                    <Plus className="size-3" />
                  </button>
                </div>
                <select
                  value={line.unit}
                  onChange={e => updateLine(id, { unit: e.target.value })}
                  className="shrink-0 w-16 h-8 px-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
                <button
                  type="button"
                  onClick={() => removeLine(id)}
                  className="shrink-0 size-8 flex items-center justify-center text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {!onQuickCreate && (
        <Dialog open={quickCreateName !== null} onOpenChange={(o) => !o && setQuickCreateName(null)}>
          <DialogContent className="sm:max-w-md rounded-xl">
            <DialogHeader>
              <DialogTitle>Создать новый продукт</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreateIngredient} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground">Название</label>
                <input
                  type="text"
                  required
                  value={quickCreateName ?? ''}
                  onChange={e => setQuickCreateName(e.target.value)}
                  placeholder="Например, Картофель свежий"
                  className="w-full h-11 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold text-foreground">Ед. измерения</label>
                  <select
                    value={newUnit}
                    onChange={e => setNewUnit(e.target.value)}
                    className="w-full h-11 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    {['кг', 'г', 'л', 'мл', 'шт', 'порц', 'бут', 'пач'].map(u => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold text-foreground">Категория</label>
                  <input
                    type="text"
                    value={newCategory}
                    onChange={e => setNewCategory(e.target.value)}
                    placeholder="Продукты"
                    className="w-full h-11 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground">Тип товара</label>
                <div className="flex gap-2">
                  {([{ v: true, label: 'Продукт / ингредиент' }, { v: false, label: 'Хозтовары / другое' }] as const).map(t => (
                    <button
                      key={t.label}
                      type="button"
                      onClick={() => setNewIsFood(t.v)}
                      className={`flex-1 h-11 px-3 rounded-lg text-xs font-semibold border transition-colors ${
                        newIsFood === t.v ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-border text-foreground hover:bg-muted'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold text-foreground">Мин. остаток</label>
                  <DecimalInput
                    min={0}
                    value={newMinQty}
                    onChange={v => setNewMinQty(v)}
                    className="w-full h-11 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold text-foreground">Закупочная цена</label>
                  <DecimalInput
                    min={0}
                    value={newPrice}
                    onChange={v => setNewPrice(v)}
                    className="w-full h-11 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              </div>

              <DialogFooter className="pt-2">
                <button
                  type="button"
                  onClick={() => setQuickCreateName(null)}
                  className="h-11 px-4 text-sm font-semibold text-foreground bg-background border border-border rounded-lg hover:bg-muted transition-colors"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={creating || !quickCreateName?.trim()}
                  className="h-11 px-4 text-sm font-semibold text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
                >
                  {creating ? 'Создание...' : 'Создать и добавить'}
                </button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

export { emptyTechLine }
