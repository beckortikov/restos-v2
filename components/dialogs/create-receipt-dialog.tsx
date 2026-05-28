// TODO: deprecated — use /warehouse/receipts/new full-page editor instead.
'use client'

import { useState, useEffect, useRef } from 'react'
import { Plus, Trash2, Search, X } from 'lucide-react'
import { DecimalInput } from '@/components/ui/decimal-input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { formatCurrency } from '@/lib/helpers'
import { dMul, dSub, dSum } from '@/lib/decimal'
import {
  type ReceiptPaymentType,
  type Supplier,
  type Ingredient,
} from '@/lib/types'
import { fetchSuppliers, fetchIngredients } from '@/lib/queries'

interface ReceiptLineForm {
  ingredientId: string
  name: string
  qty: number
  unit: string
  pricePerUnit: number
}

interface ReceiptForm {
  supplierId: string
  lines: ReceiptLineForm[]
  paymentType: ReceiptPaymentType
  paidAmount: number
  note: string
}

interface CreateReceiptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (receipt: ReceiptForm & { totalAmount: number; debtAmount: number }) => void
}

const emptyLine: ReceiptLineForm = {
  ingredientId: '',
  name: '',
  qty: 0,
  unit: '',
  pricePerUnit: 0,
}

// ─── Search Combobox for Suppliers ─────────────────────────────────────────
function SupplierCombobox({
  suppliers,
  selectedId,
  onSelect,
}: {
  suppliers: Supplier[]
  selectedId: string
  onSelect: (id: string) => void
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

  const selected = suppliers.find(s => s.id === selectedId)
  const filtered = suppliers.filter(s => s.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8)

  if (selected) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-sm bg-card border border-border rounded-lg">
        <span className="flex-1">{selected.name}</span>
        <button type="button" onClick={() => onSelect('')} className="shrink-0 p-0.5 hover:bg-muted rounded">
          <X className="size-3.5 text-muted-foreground" />
        </button>
      </div>
    )
  }

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <input type="text" value={query}
          onChange={e => { setQuery(e.target.value); setIsOpen(true) }}
          onFocus={() => setIsOpen(true)}
          placeholder="Поиск поставщика..."
          className="w-full pl-8 pr-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30" />
      </div>
      {isOpen && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto bg-card border border-border rounded-lg shadow-lg">
          {filtered.map(s => (
            <button key={s.id} type="button"
              onClick={() => { onSelect(s.id); setQuery(''); setIsOpen(false) }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors">
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Search Combobox for Ingredients ───────────────────────────────────────
function IngredientLineCombobox({
  ingredients,
  selectedId,
  selectedName,
  onSelect,
  onClear,
}: {
  ingredients: Ingredient[]
  selectedId: string
  selectedName: string
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

  if (selectedId) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-sm bg-card border border-border rounded-lg">
        <span className="flex-1 truncate">{selectedName}</span>
        <button type="button" onClick={onClear} className="shrink-0 p-0.5 hover:bg-muted rounded">
          <X className="size-3.5 text-muted-foreground" />
        </button>
      </div>
    )
  }

  const q = query.toLowerCase()
  const foodIngs = ingredients.filter(i => i.isFood !== false && i.name.toLowerCase().includes(q)).slice(0, 6)
  const nonFoodIngs = ingredients.filter(i => i.isFood === false && i.name.toLowerCase().includes(q)).slice(0, 4)
  const hasResults = foodIngs.length > 0 || nonFoodIngs.length > 0

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <input type="text" value={query}
          onChange={e => { setQuery(e.target.value); setIsOpen(true) }}
          onFocus={() => setIsOpen(true)}
          placeholder="Поиск..."
          className="w-full pl-7 pr-2 py-1.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30" />
      </div>
      {isOpen && hasResults && (
        <div className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto bg-card border border-border rounded-lg shadow-lg">
          {foodIngs.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/50">Продукты</div>
              {foodIngs.map(ing => (
                <button key={ing.id} type="button"
                  onClick={() => { onSelect(ing.id); setQuery(''); setIsOpen(false) }}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex justify-between">
                  <span>{ing.name}</span>
                  <span className="text-xs text-muted-foreground">{ing.unit}</span>
                </button>
              ))}
            </>
          )}
          {nonFoodIngs.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/50 border-t border-border">Хозтовары</div>
              {nonFoodIngs.map(ing => (
                <button key={ing.id} type="button"
                  onClick={() => { onSelect(ing.id); setQuery(''); setIsOpen(false) }}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex justify-between">
                  <span>{ing.name}</span>
                  <span className="text-xs text-muted-foreground">{ing.unit}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main Dialog ───────────────────────────────────────────────────────────
export function CreateReceiptDialog({ open, onOpenChange, onSubmit }: CreateReceiptDialogProps) {
  const [form, setForm] = useState<ReceiptForm>({
    supplierId: '',
    lines: [{ ...emptyLine }],
    paymentType: 'paid',
    paidAmount: 0,
    note: '',
  })

  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [dataLoaded, setDataLoaded] = useState(false)

  useEffect(() => {
    if (open && !dataLoaded) {
      Promise.all([fetchSuppliers(), fetchIngredients()])
        .then(([s, i]) => { setSuppliers(s); setIngredients(i); setDataLoaded(true) })
    }
  }, [open, dataLoaded])

  const total = dSum(form.lines.map(l => dMul(l.qty, l.pricePerUnit)))
  const debt =
    form.paymentType === 'paid'
      ? 0
      : form.paymentType === 'credit'
        ? total
        : Math.max(0, dSub(total, form.paidAmount))

  function updateLine(index: number, patch: Partial<ReceiptLineForm>) {
    setForm((prev) => {
      const lines = [...prev.lines]
      lines[index] = { ...lines[index], ...patch }
      return { ...prev, lines }
    })
  }

  function selectIngredient(index: number, ingredientId: string) {
    const ing = ingredients.find((i) => i.id === ingredientId)
    if (!ing) return
    updateLine(index, { ingredientId, name: ing.name, unit: ing.unit, pricePerUnit: ing.pricePerUnit })
  }

  function clearLine(index: number) {
    updateLine(index, { ingredientId: '', name: '', unit: '', qty: 0, pricePerUnit: 0 })
  }

  function addLine() {
    setForm((prev) => ({ ...prev, lines: [...prev.lines, { ...emptyLine }] }))
  }

  function removeLine(index: number) {
    setForm((prev) => ({ ...prev, lines: prev.lines.filter((_, i) => i !== index) }))
  }

  function handleSubmit() {
    onSubmit({
      ...form,
      totalAmount: total,
      debtAmount: debt,
      paidAmount: form.paymentType === 'paid' ? total : form.paymentType === 'credit' ? 0 : form.paidAmount,
    })
    onOpenChange(false)
  }

  const canSubmit = form.supplierId && form.lines.length > 0 && form.lines.every((l) => l.ingredientId && l.qty > 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle>Новая накладная</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Supplier */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Поставщик</label>
            <SupplierCombobox
              suppliers={suppliers}
              selectedId={form.supplierId}
              onSelect={(id) => setForm(p => ({ ...p, supplierId: id }))}
            />
          </div>

          {/* Lines */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Позиции</label>
            {form.lines.map((line, i) => (
              <div key={i} className="flex items-end gap-2 p-2.5 bg-muted/50 rounded-lg border border-border">
                <div className="flex-1 min-w-[160px] space-y-1">
                  <span className="text-[10px] text-muted-foreground">Ингредиент</span>
                  <IngredientLineCombobox
                    ingredients={ingredients}
                    selectedId={line.ingredientId}
                    selectedName={`${line.name} (${line.unit})`}
                    onSelect={(id) => selectIngredient(i, id)}
                    onClear={() => clearLine(i)}
                  />
                </div>
                <div className="w-20 space-y-1">
                  <span className="text-[10px] text-muted-foreground">Кол-во</span>
                  <DecimalInput value={line.qty} onChange={(v) => updateLine(i, { qty: v })}
                    className="w-full px-2 py-1.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div className="w-24 space-y-1">
                  <span className="text-[10px] text-muted-foreground">Цена/{line.unit || 'ед'}</span>
                  <DecimalInput value={line.pricePerUnit} onChange={(v) => updateLine(i, { pricePerUnit: v })}
                    className="w-full px-2 py-1.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div className="w-24 text-right text-sm font-medium pt-5">
                  {formatCurrency(dMul(line.qty, line.pricePerUnit))}
                </div>
                {form.lines.length > 1 && (
                  <button type="button" onClick={() => removeLine(i)}
                    className="p-1.5 text-destructive hover:bg-destructive/10 rounded-lg transition-colors">
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={addLine}
              className="flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors">
              <Plus className="size-4" /> Добавить позицию
            </button>
          </div>

          {/* Payment type */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Тип оплаты</label>
            <div className="flex gap-2">
              {(['paid', 'credit', 'partial'] as ReceiptPaymentType[]).map((t) => (
                <button key={t} type="button"
                  onClick={() => setForm((p) => ({ ...p, paymentType: t }))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    form.paymentType === t
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card border-border text-foreground hover:bg-muted'
                  }`}>
                  {t === 'paid' ? 'Оплачено' : t === 'credit' ? 'В долг' : 'Частично'}
                </button>
              ))}
            </div>
          </div>

          {/* Partial paid amount */}
          {form.paymentType === 'partial' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Оплаченная сумма</label>
              <DecimalInput value={form.paidAmount} min={0} max={total}
                onChange={(v) => setForm((p) => ({ ...p, paidAmount: v }))}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
          )}

          {/* Totals */}
          <div className="flex justify-between items-center p-3 bg-muted/50 rounded-lg border border-border">
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">Итого</div>
              <div className="text-lg font-bold text-foreground">{formatCurrency(total)}</div>
            </div>
            {debt > 0 && (
              <div className="space-y-1 text-right">
                <div className="text-sm text-muted-foreground">Долг</div>
                <div className="text-lg font-bold text-destructive">{formatCurrency(debt)}</div>
              </div>
            )}
          </div>

          {/* Note */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Примечание</label>
            <textarea value={form.note} onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))}
              rows={2} placeholder="Комментарий к накладной..."
              className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none" />
          </div>
        </div>

        <DialogFooter>
          <button type="button" onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted transition-colors">
            Отмена
          </button>
          <button type="button" onClick={handleSubmit} disabled={!canSubmit}
            className="px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none">
            Создать накладную
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
