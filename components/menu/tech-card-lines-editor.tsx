'use client'

import { useState, useEffect, useRef } from 'react'
import { Plus, Trash2, Search, X, CheckCircle2 } from 'lucide-react'
import { UNITS, type TechCardLine, type Ingredient, type SemiFinishedType } from '@/lib/types'
import { DecimalInput } from '@/components/ui/decimal-input'

const emptyTechLine: TechCardLine = { name: '', qty: 0, unit: '' }

// ─── Ingredient/Semi Combobox ──────────────────────────────────────────────
// Общий для продукта и размерных вариантов пикер строки тех. карты. Если
// заданы matchingSemiIds (значения шкалы размера текущего варианта) —
// подходящие по размеру полуфабрикаты идут первыми с отметкой ✓.
export function IngredientCombobox({
  ingredients,
  semiTypes,
  selectedIngredientId,
  selectedSemiId,
  selectedName,
  matchingSemiIds,
  onSelectIngredient,
  onSelectSemi,
  onClear,
  onQuickCreate,
}: {
  ingredients: Ingredient[]
  semiTypes: SemiFinishedType[]
  selectedIngredientId?: string
  selectedSemiId?: string
  selectedName: string
  matchingSemiIds?: Set<string>
  onSelectIngredient: (id: string) => void
  onSelectSemi: (id: string) => void
  onClear: () => void
  onQuickCreate?: (name: string) => void
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
  const filteredSemis = semiTypes
    .filter(s => s.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const am = matchingSemiIds?.has(a.sizeScaleValueId ?? '') ? 0 : 1
      const bm = matchingSemiIds?.has(b.sizeScaleValueId ?? '') ? 0 : 1
      return am - bm
    })
    .slice(0, 4)
  const hasResults = filteredIngs.length > 0 || filteredSemis.length > 0

  if (selectedIngredientId || selectedSemiId) {
    const selectedSemi = selectedSemiId ? semiTypes.find(s => s.id === selectedSemiId) : undefined
    const semiMismatch = !!selectedSemi && !!matchingSemiIds && matchingSemiIds.size > 0 && !matchingSemiIds.has(selectedSemi.sizeScaleValueId ?? '')
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 px-3 py-2 text-sm bg-background border border-border rounded-lg">
          <span className="flex-1 truncate font-medium">{selectedName}</span>
          <button type="button" onClick={onClear} className="shrink-0 p-0.5 hover:bg-muted rounded text-muted-foreground transition-colors">
            <X className="size-3.5" />
          </button>
        </div>
        {semiMismatch && (
          <p className="text-[10px] text-amber-600 font-medium px-1">⚠ другая шкала размеров — проверьте заготовку</p>
        )}
      </div>
    )
  }

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); setIsOpen(true) }}
          onFocus={() => setIsOpen(true)}
          placeholder="Поиск ингредиента или полуфабриката..."
          className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
        />
      </div>
      {isOpen && (hasResults || query.trim() !== '') && (
        <div className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto bg-card border border-border rounded-lg shadow-lg">
          {filteredIngs.length > 0 && (
            <>
              <div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">Ингредиенты</div>
              {filteredIngs.map(ing => (
                <button key={ing.id} type="button"
                  onClick={() => { onSelectIngredient(ing.id); setQuery(''); setIsOpen(false) }}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-muted transition-colors flex justify-between items-center">
                  <span className="text-foreground font-medium">{ing.name}</span>
                  <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{ing.unit}</span>
                </button>
              ))}
            </>
          )}
          {filteredSemis.length > 0 && (
            <>
              <div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30 border-t border-border">Полуфабрикаты</div>
              {filteredSemis.map(s => {
                const matches = matchingSemiIds?.has(s.sizeScaleValueId ?? '')
                return (
                  <button key={s.id} type="button"
                    onClick={() => { onSelectSemi(s.id); setQuery(''); setIsOpen(false) }}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-muted transition-colors flex justify-between items-center">
                    <span className="text-foreground font-medium flex items-center gap-1">
                      {matches && <CheckCircle2 className="size-3.5 text-emerald-600 shrink-0" />}
                      {s.name}
                    </span>
                    <span className="text-xs text-muted-foreground bg-primary/10 text-primary px-1.5 py-0.5 rounded font-semibold">{s.outputUnit} (п/ф)</span>
                  </button>
                )
              })}
            </>
          )}
          {query.trim() !== '' && onQuickCreate && (
            <button
              type="button"
              onClick={() => {
                onQuickCreate(query.trim())
                setQuery('')
                setIsOpen(false)
              }}
              className="w-full text-left px-4 py-2.5 text-xs font-semibold text-primary hover:bg-primary/5 transition-colors border-t border-border flex items-center gap-2"
            >
              <Plus className="size-4" />
              <span>Создать продукт «{query.trim()}»</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Строки тех. карты (контролируемый компонент) ──────────────────────────
// Используется и для базовой техкарты продукта, и для техкарты отдельного
// размерного варианта (menu_item_id разный, форма одна и та же).
export function TechCardLinesEditor({
  lines,
  onChange,
  ingredients,
  semiTypes,
  matchingSemiIds,
  onQuickCreate,
}: {
  lines: TechCardLine[]
  onChange: (next: TechCardLine[]) => void
  ingredients: Ingredient[]
  semiTypes: SemiFinishedType[]
  matchingSemiIds?: Set<string>
  onQuickCreate?: (name: string, targetIndex: number) => void
}) {
  function updateLine(index: number, patch: Partial<TechCardLine>) {
    onChange(lines.map((l, i) => i === index ? { ...l, ...patch } : l))
  }
  function selectIngredient(index: number, id: string) {
    const ing = ingredients.find(i => i.id === id)
    if (!ing) return
    updateLine(index, { ingredientId: id, semiId: undefined, name: ing.name, unit: ing.unit })
  }
  function selectSemi(index: number, id: string) {
    const semi = semiTypes.find(s => s.id === id)
    if (!semi) return
    updateLine(index, { semiId: id, ingredientId: undefined, name: semi.name, unit: semi.outputUnit })
  }
  function clearLine(index: number) {
    updateLine(index, { ingredientId: undefined, semiId: undefined, name: '', unit: '', qty: 0 })
  }
  function addLine() {
    onChange([...lines, { ...emptyTechLine }])
  }
  function removeLine(index: number) {
    onChange(lines.filter((_, i) => i !== index))
  }

  return (
    <div className="space-y-3">
      <div className="space-y-3">
        {lines.map((line, i) => (
          <div key={i} className="flex items-start gap-3 p-3 bg-muted/20 border border-border/50 rounded-xl relative group">
            <div className="flex-1 min-w-[200px] space-y-1">
              <span className="text-[10px] font-semibold text-muted-foreground block">Ингредиент / Полуфабрикат</span>
              <IngredientCombobox
                ingredients={ingredients}
                semiTypes={semiTypes}
                selectedIngredientId={line.ingredientId}
                selectedSemiId={line.semiId}
                selectedName={line.name}
                matchingSemiIds={matchingSemiIds}
                onSelectIngredient={(id) => selectIngredient(i, id)}
                onSelectSemi={(id) => selectSemi(i, id)}
                onClear={() => clearLine(i)}
                onQuickCreate={onQuickCreate ? (name) => onQuickCreate(name, i) : undefined}
              />
            </div>
            <div className="w-24 space-y-1">
              <span className="text-[10px] font-semibold text-muted-foreground block">Кол-во</span>
              <DecimalInput
                value={line.qty}
                onChange={(v) => updateLine(i, { qty: v })}
                min={0}
                className="w-full px-3 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="w-20 space-y-1">
              <span className="text-[10px] font-semibold text-muted-foreground block">Ед.</span>
              <select
                value={line.unit}
                onChange={(e) => updateLine(i, { unit: e.target.value })}
                className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">—</option>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            {lines.length > 1 && (
              <div className="space-y-1">
                <span className="text-[10px] block select-none" aria-hidden>&nbsp;</span>
                <button
                  type="button"
                  onClick={() => removeLine(i)}
                  className="p-2 text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                >
                  <Trash2 className="size-4.5" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addLine}
        className="flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-primary/80 transition-colors py-1.5 px-3 rounded-lg hover:bg-primary/5 border border-dashed border-primary/20 w-full justify-center"
      >
        <Plus className="size-4" /> Добавить ингредиент
      </button>
    </div>
  )
}

export { emptyTechLine }
