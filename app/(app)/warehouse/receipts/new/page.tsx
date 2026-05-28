'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Search,
  Plus,
  Trash2,
  Package,
  Box,
  CheckCircle,
  X,
} from 'lucide-react'
import { DecimalInput } from '@/components/ui/decimal-input'
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/helpers'
import { dMul, dSub, dSum } from '@/lib/decimal'
import {
  type ReceiptPaymentType,
  type Supplier,
  type Ingredient,
} from '@/lib/types'
import { fetchSuppliers, fetchIngredients, createReceipt } from '@/lib/queries'

interface ReceiptLineForm {
  ingredientId: string // empty string for manually-added free-form line
  name: string
  qty: number
  unit: string
  pricePerUnit: number
}

type CategoryFilter = 'all' | 'food' | 'nonfood'

// ─── Supplier combobox (same UX as legacy dialog) ──────────────────────────
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

  const selected = suppliers.find((s) => s.id === selectedId)
  const filtered = suppliers
    .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8)

  if (selected) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-sm bg-card border border-border rounded-lg">
        <span className="flex-1 truncate">{selected.name}</span>
        <button
          type="button"
          onClick={() => onSelect('')}
          className="shrink-0 p-0.5 hover:bg-muted rounded"
        >
          <X className="size-3.5 text-muted-foreground" />
        </button>
      </div>
    )
  }

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIsOpen(true)
          }}
          onFocus={() => setIsOpen(true)}
          placeholder="Поиск поставщика..."
          className="w-full pl-8 pr-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>
      {isOpen && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto bg-card border border-border rounded-lg shadow-lg">
          {filtered.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                onSelect(s.id)
                setQuery('')
                setIsOpen(false)
              }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────
export default function NewReceiptPage() {
  const navigate = useNavigate()

  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [loading, setLoading] = useState(true)

  const [supplierId, setSupplierId] = useState('')
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0])
  const [lines, setLines] = useState<ReceiptLineForm[]>([])
  const [paymentType, setPaymentType] = useState<ReceiptPaymentType>('paid')
  const [paidAmount, setPaidAmount] = useState(0)
  const [note, setNote] = useState('')

  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [search, setSearch] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    Promise.all([fetchSuppliers(), fetchIngredients()])
      .then(([s, i]) => {
        setSuppliers(s)
        setIngredients(i)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const total = useMemo(
    () => dSum(lines.map((l) => dMul(l.qty, l.pricePerUnit))),
    [lines],
  )
  const debt =
    paymentType === 'paid'
      ? 0
      : paymentType === 'credit'
        ? total
        : Math.max(0, dSub(total, paidAmount))

  const filteredIngredients = useMemo(() => {
    const q = search.trim().toLowerCase()
    return ingredients.filter((ing) => {
      if (filter === 'food' && ing.isFood === false) return false
      if (filter === 'nonfood' && ing.isFood !== false) return false
      if (q && !ing.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [ingredients, filter, search])

  const foodCount = ingredients.filter((i) => i.isFood !== false).length
  const nonFoodCount = ingredients.filter((i) => i.isFood === false).length

  function addOrIncrementIngredient(ing: Ingredient) {
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.ingredientId === ing.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...next[idx], qty: next[idx].qty + 1 }
        return next
      }
      return [
        ...prev,
        {
          ingredientId: ing.id,
          name: ing.name,
          qty: 1,
          unit: ing.unit,
          pricePerUnit: ing.pricePerUnit,
        },
      ]
    })
  }

  function addManualLine() {
    setLines((prev) => [
      ...prev,
      { ingredientId: '', name: '', qty: 0, unit: '', pricePerUnit: 0 },
    ])
  }

  function updateLine(index: number, patch: Partial<ReceiptLineForm>) {
    setLines((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], ...patch }
      return next
    })
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index))
  }

  function handleCancel() {
    if (lines.length > 0) {
      const ok = window.confirm('Несохранённые позиции будут утеряны. Выйти?')
      if (!ok) return
    }
    navigate('/warehouse/receipts')
  }

  const canSubmit =
    !!supplierId &&
    lines.length > 0 &&
    lines.every((l) => l.name.trim().length > 0 && l.qty > 0 && l.pricePerUnit >= 0)

  async function handleSubmit() {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    try {
      const supplier = suppliers.find((s) => s.id === supplierId)
      const finalPaid =
        paymentType === 'paid' ? total : paymentType === 'credit' ? 0 : paidAmount
      await createReceipt({
        supplierId,
        supplierName: supplier?.name ?? '',
        date,
        note: note || undefined,
        totalAmount: total,
        paymentType,
        paidAmount: finalPaid,
        debtAmount: debt,
        lines,
      })
      toast.success('Накладная создана')
      navigate('/warehouse/receipts')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка создания накладной')
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-screen">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-background border-b border-border">
        <div className="flex items-center gap-3 px-4 md:px-6 py-3">
          <button
            type="button"
            onClick={handleCancel}
            className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:bg-muted px-2 py-1.5 rounded-lg transition-colors"
          >
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">Отмена</span>
          </button>
          <h1 className="flex-1 text-base md:text-lg font-bold text-foreground truncate">
            Новая накладная
          </h1>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            <CheckCircle className="size-4" />
            {submitting ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>

      {/* Body: two-column on desktop, stacked on mobile */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_minmax(420px,460px)] gap-4 md:gap-6 p-4 md:p-6">
        {/* LEFT — meta + ingredient picker */}
        <div className="space-y-4">
          {/* Meta */}
          <div className="bg-card border border-border rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Поставщик</label>
              <SupplierCombobox
                suppliers={suppliers}
                selectedId={supplierId}
                onSelect={setSupplierId}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Дата</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          {/* Filter tabs */}
          <div className="bg-card border border-border rounded-xl p-3 space-y-3">
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { v: 'all', label: 'Все', count: ingredients.length, icon: null },
                  { v: 'food', label: 'Продукты', count: foodCount, icon: Package },
                  { v: 'nonfood', label: 'Хозтовары', count: nonFoodCount, icon: Box },
                ] as { v: CategoryFilter; label: string; count: number; icon: typeof Package | null }[]
              ).map((t) => {
                const active = filter === t.v
                const Icon = t.icon
                return (
                  <button
                    key={t.v}
                    type="button"
                    onClick={() => setFilter(t.v)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      active
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card border-border text-foreground hover:bg-muted'
                    }`}
                  >
                    {Icon && <Icon className="size-3.5" />}
                    {t.label}
                    <span className={`text-[10px] ${active ? 'opacity-80' : 'text-muted-foreground'}`}>
                      {t.count}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск ингредиента..."
                className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>

            {/* Ingredient grid */}
            {filteredIngredients.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                Ничего не найдено
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {filteredIngredients.map((ing) => {
                  const inReceipt = lines.some((l) => l.ingredientId === ing.id)
                  return (
                    <button
                      key={ing.id}
                      type="button"
                      onClick={() => addOrIncrementIngredient(ing)}
                      className={`group flex flex-col items-start gap-1.5 p-3 text-left rounded-xl border transition-all ${
                        inReceipt
                          ? 'bg-primary/10 border-primary'
                          : 'bg-card border-border hover:border-primary/60 hover:bg-muted/40'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 w-full">
                        {ing.isFood === false ? (
                          <Box className="size-3.5 text-amber-600 shrink-0" />
                        ) : (
                          <Package className="size-3.5 text-emerald-600 shrink-0" />
                        )}
                        <span className="text-xs font-semibold text-foreground truncate flex-1">
                          {ing.name}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {formatCurrency(ing.pricePerUnit)} / {ing.unit}
                      </div>
                      {inReceipt && (
                        <div className="text-[10px] font-medium text-primary">
                          Добавлено
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — lines + payment */}
        <div className="space-y-4 lg:sticky lg:top-[60px] lg:self-start lg:max-h-[calc(100vh-72px)] lg:overflow-y-auto lg:pr-1">
          {/* Lines */}
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">
                Позиции в накладной <span className="text-muted-foreground font-normal">({lines.length})</span>
              </h2>
            </div>

            {lines.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground border border-dashed border-border rounded-lg">
                Нажмите на карточку слева, чтобы добавить позицию
              </div>
            ) : (
              <div className="rounded-lg border border-border overflow-hidden">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="h-7 px-1.5 text-[9px] uppercase tracking-wider text-muted-foreground">Наименование</TableHead>
                      <TableHead className="h-7 px-1 text-[9px] uppercase tracking-wider text-muted-foreground w-14 text-right">Кол-во</TableHead>
                      <TableHead className="h-7 px-0.5 text-[9px] uppercase tracking-wider text-muted-foreground w-8 text-center">Ед.</TableHead>
                      <TableHead className="h-7 px-1 text-[9px] uppercase tracking-wider text-muted-foreground w-16 text-right">Цена</TableHead>
                      <TableHead className="h-7 px-1.5 text-[9px] uppercase tracking-wider text-muted-foreground w-20 text-right">Сумма</TableHead>
                      <TableHead className="h-7 w-6"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((line, i) => (
                      <TableRow key={i} className="group hover:bg-muted/30">
                        <TableCell className="px-1.5 py-1">
                          {line.ingredientId ? (
                            <span className="font-medium text-foreground text-xs leading-tight" title={line.name}>{line.name}</span>
                          ) : (
                            <input
                              type="text"
                              value={line.name}
                              onChange={(e) => updateLine(i, { name: e.target.value })}
                              placeholder="Название"
                              className="w-full px-1 py-0.5 text-xs bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary/30"
                            />
                          )}
                        </TableCell>
                        <TableCell className="px-1 py-1">
                          <DecimalInput
                            value={line.qty}
                            onChange={(v) => updateLine(i, { qty: v })}
                            className="w-full px-1 py-0.5 text-xs text-right bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                        </TableCell>
                        <TableCell className="px-0.5 py-1 text-center">
                          {line.ingredientId ? (
                            <span className="text-[10px] text-muted-foreground">{line.unit}</span>
                          ) : (
                            <input
                              type="text"
                              value={line.unit}
                              onChange={(e) => updateLine(i, { unit: e.target.value })}
                              placeholder="ед"
                              className="w-full px-0.5 py-0.5 text-[10px] text-center bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary/30"
                            />
                          )}
                        </TableCell>
                        <TableCell className="px-1 py-1">
                          <DecimalInput
                            value={line.pricePerUnit}
                            onChange={(v) => updateLine(i, { pricePerUnit: v })}
                            className="w-full px-1 py-0.5 text-xs text-right bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                        </TableCell>
                        <TableCell className="px-1.5 py-1 text-right font-semibold text-foreground tabular-nums text-xs">
                          {formatCurrency(dMul(line.qty, line.pricePerUnit))}
                        </TableCell>
                        <TableCell className="px-0.5 py-1 text-right">
                          <button
                            type="button"
                            onClick={() => removeLine(i)}
                            className="p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 rounded transition-all"
                            title="Удалить"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell colSpan={4} className="px-1.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Итого</TableCell>
                      <TableCell className="px-1.5 py-1.5 text-right font-bold text-foreground tabular-nums text-xs">{formatCurrency(total)}</TableCell>
                      <TableCell></TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            )}

            <button
              type="button"
              onClick={addManualLine}
              className="w-full flex items-center justify-center gap-1.5 py-2 text-sm text-primary hover:bg-primary/10 rounded-lg border border-dashed border-border transition-colors"
            >
              <Plus className="size-4" />
              Добавить вручную
            </button>
          </div>

          {/* Payment */}
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <h2 className="text-sm font-semibold text-foreground">Оплата</h2>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { v: 'paid', label: 'Сразу' },
                  { v: 'credit', label: 'Кредит' },
                  { v: 'partial', label: 'Частично' },
                ] as { v: ReceiptPaymentType; label: string }[]
              ).map((t) => {
                const active = paymentType === t.v
                return (
                  <button
                    key={t.v}
                    type="button"
                    onClick={() => setPaymentType(t.v)}
                    className={`px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      active
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card border-border text-foreground hover:bg-muted'
                    }`}
                  >
                    {t.label}
                  </button>
                )
              })}
            </div>

            {paymentType === 'partial' && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Сумма к оплате
                </label>
                <DecimalInput
                  value={paidAmount}
                  min={0}
                  max={total}
                  onChange={setPaidAmount}
                  className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Заметка</label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Комментарий к накладной..."
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
              />
            </div>

            <div className="pt-3 border-t border-border space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Итого</span>
                <span className="font-bold text-foreground">{formatCurrency(total)}</span>
              </div>
              {debt > 0 && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Долг</span>
                  <span className="font-bold text-destructive">{formatCurrency(debt)}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
