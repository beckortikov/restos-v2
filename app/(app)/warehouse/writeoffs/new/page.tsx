'use client'

import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchIngredients, fetchSemiStock, fetchMenuItems, createWriteoff } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { dMul, dSum } from '@/lib/decimal'
import { type WriteoffReason, WRITEOFF_REASON_LABELS } from '@/lib/types'
import { useAuth } from '@/lib/auth-store'
import { ArrowLeft, Search, Minus, Plus, Trash2, AlertTriangle, CheckCircle, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'

interface SelectableItem {
  id: string
  name: string
  qty: number
  unit: string
  pricePerUnit: number
  group: string
}

interface WriteoffLine {
  ingredientId: string
  name: string
  qty: number
  unit: string
  pricePerUnit: number
}

const GROUP_LABELS: Record<string, { icon: string; label: string }> = {
  ingredient: { icon: '🥩', label: 'Ингредиенты' },
  drinks:     { icon: '🥤', label: 'Напитки' },
  supply:     { icon: '🧹', label: 'Хозтовары' },
  semi:       { icon: '🧪', label: 'Полуфабрикаты' },
  batch:      { icon: '🍲', label: 'Готовые блюда' },
  showcase:   { icon: '🍰', label: 'Витрина' },
}

const REASONS_INFO = [
  { key: 'spoilage' as WriteoffReason, label: 'Порча', desc: 'Брак продуктов, гниль, порча', icon: '🍎', activeColor: 'border-red-500 bg-red-500/10 text-red-700 dark:text-red-400' },
  { key: 'breakage' as WriteoffReason, label: 'Бой', desc: 'Битая посуда, сломанная тара', icon: '🍽️', activeColor: 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  { key: 'tasting' as WriteoffReason, label: 'Дегустация', desc: 'Проработка новых блюд шефом', icon: '🍳', activeColor: 'border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-400' },
  { key: 'expired' as WriteoffReason, label: 'Просрочка', desc: 'Истекший срок годности сырья', icon: '⏰', activeColor: 'border-purple-500 bg-purple-500/10 text-purple-700 dark:text-purple-400' },
  { key: 'other' as WriteoffReason, label: 'Прочее', desc: 'Другие непредвиденные причины', icon: '📝', activeColor: 'border-slate-500 bg-slate-500/10 text-slate-700 dark:text-slate-400' },
]

export default function NewWriteoffPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [allItems, setAllItems] = useState<SelectableItem[]>([])
  const [reason, setReason] = useState<WriteoffReason>('spoilage')
  const [description, setDescription] = useState('')
  const [lines, setLines] = useState<WriteoffLine[]>([])
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [activeGroup, setActiveGroup] = useState('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([fetchIngredients(), fetchSemiStock(), fetchMenuItems()])
      .then(([ings, semis, menuItems]) => {
        const items: SelectableItem[] = [
          ...ings.filter(i => i.isFood !== false && !['drinks', 'Напитки'].includes(i.category)).map(i => ({ id: i.id, name: i.name, qty: i.qty, unit: i.unit, pricePerUnit: i.pricePerUnit, group: 'ingredient' })),
          ...ings.filter(i => i.isFood !== false && ['drinks', 'Напитки'].includes(i.category)).map(i => ({ id: i.id, name: i.name, qty: i.qty, unit: i.unit, pricePerUnit: i.pricePerUnit, group: 'drinks' })),
          ...ings.filter(i => i.isFood === false).map(i => ({ id: i.id, name: i.name, qty: i.qty, unit: i.unit, pricePerUnit: i.pricePerUnit, group: 'supply' })),
          ...semis.map(s => ({ id: s.id, name: s.name, qty: s.qty, unit: s.unit, pricePerUnit: s.pricePerUnit, group: 'semi' })),
          ...menuItems.filter(m => m.isBatchCooking && (m.preparedQty || 0) > 0).map(m => ({
            id: m.id, name: m.name, qty: m.preparedQty || 0, unit: 'порц.', pricePerUnit: m.cogs || 0, group: 'batch',
          })),
          // Витрина + бар (покупные товары). Связь с ингредиентом — по
          // ingredient_id из техкарты блюда (надёжно при переименовании),
          // фолбэк — по имени для старых записей без техкарты.
          ...menuItems.filter(m => (m.station === 'showcase' || m.station === 'bar') && m.isAvailable).map(m => {
            const tcIngId = m.techCard?.find(l => l.ingredientId)?.ingredientId
            const mi = (tcIngId ? ings.find(i => i.id === tcIngId) : undefined)
              ?? ings.find(i => i.name.toLowerCase() === m.name.toLowerCase())
            return { id: mi?.id || m.id, name: m.name, qty: mi?.qty ?? 0, unit: mi?.unit || 'шт.', pricePerUnit: mi?.pricePerUnit || m.price, group: 'showcase' }
          }),
        ]
        // Дедуп по id ингредиента: не показываем сырьё, уже представленное
        // витринным/барным товаром (раньше дедуп был по имени — рвался при переименовании).
        const showcaseIds = new Set(items.filter(i => i.group === 'showcase').map(i => i.id))
        setAllItems(items.filter(i => !((i.group === 'ingredient' || i.group === 'drinks') && showcaseIds.has(i.id))))
        setLoading(false)
      })
      .catch((err) => {
        console.error(err)
        toast.error('Не удалось загрузить товары')
        setLoading(false)
      })
  }, [])

  // Available groups
  const availableGroups = useMemo(() => {
    const groups = [...new Set(allItems.map(i => i.group))]
    return groups.filter(g => GROUP_LABELS[g])
  }, [allItems])

  // Filtered items
  const filtered = useMemo(() => {
    let items = allItems
    if (activeGroup !== 'all') items = items.filter(i => i.group === activeGroup)
    if (search.trim()) {
      const q = search.toLowerCase()
      items = items.filter(i => i.name.toLowerCase().includes(q))
    }
    return items
  }, [allItems, activeGroup, search])

  const addItem = (item: SelectableItem) => {
    const exists = lines.find(l => l.ingredientId === item.id)
    if (exists) {
      setLines(prev => prev.map(l => l.ingredientId === item.id ? { ...l, qty: l.qty + 1 } : l))
    } else {
      setLines(prev => [...prev, {
        ingredientId: item.id, name: item.name, qty: 1, unit: item.unit, pricePerUnit: item.pricePerUnit,
      }])
    }
  }

  const updateQty = (id: string, delta: number) => {
    setLines(prev => prev.map(l => l.ingredientId === id ? { ...l, qty: Math.max(0.1, Math.round((l.qty + delta) * 10) / 10) } : l))
  }

  const handleQtyChange = (id: string, val: string) => {
    const num = parseFloat(val) || 0
    setLines(prev => prev.map(l => l.ingredientId === id ? { ...l, qty: Math.max(0, num) } : l))
  }

  const removeLine = (id: string) => {
    setLines(prev => prev.filter(l => l.ingredientId !== id))
  }

  const totalCost = dSum(lines.map(l => dMul(l.qty, l.pricePerUnit)))
  const canSubmit = lines.length > 0 && lines.every(l => l.qty > 0)

  const handleSubmit = async () => {
    if (!canSubmit || saving) return
    setSaving(true)
    try {
      await createWriteoff({ reason, description: description.trim() || undefined, lines, createdBy: user?.id })
      toast.success('Списание оформлено')
      navigate('/warehouse/writeoffs')
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка списания'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      {/* Top Header */}
      <div className="sticky top-0 z-10 bg-background border-b border-border shadow-sm shrink-0">
        <div className="flex items-center gap-3 px-4 md:px-6 py-3">
          <button
            type="button"
            onClick={() => navigate('/warehouse/writeoffs')}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted px-2.5 py-1.5 rounded-lg transition-all"
          >
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">Назад к списку</span>
          </button>
          <div className="h-5 w-px bg-border hidden sm:block" />
          <h1 className="flex-1 text-base md:text-lg font-bold text-foreground truncate">
            Новое списание товаров
          </h1>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || saving}
            className="flex items-center gap-2 bg-destructive text-destructive-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-destructive/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            <CheckCircle className="size-4" />
            {saving ? 'Оформление...' : 'Оформить списание'}
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 p-4 md:p-6 max-w-[1600px] w-full mx-auto overflow-hidden">
        {/* Left Column: Selector */}
        <div className="lg:col-span-7 flex flex-col space-y-4 overflow-hidden h-[calc(100vh-140px)]">
          {/* Search and Category Filter Card */}
          <div className="bg-card border border-border rounded-xl p-4 shadow-sm shrink-0 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Быстрый поиск товаров по названию..."
                className="w-full pl-9 pr-4 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>

            {/* Category tabs */}
            <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
              <button
                onClick={() => setActiveGroup('all')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border whitespace-nowrap transition-all ${
                  activeGroup === 'all'
                    ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                    : 'bg-background border-border text-foreground hover:bg-muted'
                }`}
              >
                📦 Все товары
              </button>
              {availableGroups.map(g => (
                <button
                  key={g}
                  onClick={() => setActiveGroup(g)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border whitespace-nowrap transition-all ${
                    activeGroup === g
                      ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                      : 'bg-background border-border text-foreground hover:bg-muted'
                  }`}
                >
                  <span className="mr-1">{GROUP_LABELS[g].icon}</span>
                  {GROUP_LABELS[g].label}
                </button>
              ))}
            </div>
          </div>

          {/* Grid of Items */}
          <div className="flex-1 overflow-y-auto pr-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {filtered.map(item => {
                const inCart = lines.find(l => l.ingredientId === item.id)
                return (
                  <button
                    key={item.id}
                    onClick={() => addItem(item)}
                    className={`group text-left p-3.5 rounded-xl border-2 transition-all relative overflow-hidden flex flex-col justify-between h-28 ${
                      inCart
                        ? 'border-primary bg-primary/5 hover:bg-primary/10 shadow-sm'
                        : 'border-border bg-card hover:border-primary/50 hover:bg-muted/30 hover:shadow-sm'
                    }`}
                  >
                    <div>
                      <p className="font-semibold text-sm text-foreground leading-tight group-hover:text-primary transition-colors truncate">
                        {item.name}
                      </p>
                      <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground mt-1 block">
                        {GROUP_LABELS[item.group]?.label || item.group}
                      </span>
                    </div>

                    <div className="flex items-end justify-between mt-3">
                      <div>
                        <p className="text-xs text-muted-foreground">Остаток</p>
                        <p className={`text-xs font-bold ${item.qty <= 0 ? 'text-destructive' : 'text-foreground'}`}>
                          {item.qty} {item.unit}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Цена</p>
                        <p className="text-xs font-bold text-foreground">
                          {formatCurrency(item.pricePerUnit)}
                        </p>
                      </div>
                    </div>

                    {inCart && (
                      <div className="absolute top-2 right-2 bg-primary text-primary-foreground text-[10px] font-bold px-1.5 py-0.5 rounded shadow-sm">
                        {inCart.qty} {item.unit}
                      </div>
                    )}
                  </button>
                )
              })}

              {filtered.length === 0 && (
                <div className="col-span-full bg-card border border-border rounded-xl p-12 text-center">
                  <p className="text-sm text-muted-foreground">Ничего не найдено в этой группе</p>
                  {search && (
                    <button
                      onClick={() => setSearch('')}
                      className="text-xs text-primary hover:underline mt-2 font-medium"
                    >
                      Сбросить поиск
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Cart, Reason, Comment */}
        <div className="lg:col-span-5 flex flex-col space-y-4 overflow-hidden h-[calc(100vh-140px)]">
          {/* Parameters & Reasons */}
          <div className="bg-card border border-border rounded-xl p-4 shadow-sm shrink-0 space-y-4">
            <div>
              <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2.5">
                Причина списания
              </h2>
              <div className="grid grid-cols-5 gap-1.5">
                {REASONS_INFO.map(r => {
                  const isSelected = reason === r.key
                  return (
                    <button
                      key={r.key}
                      type="button"
                      onClick={() => setReason(r.key)}
                      title={`${r.label}: ${r.desc}`}
                      className={`flex flex-col items-center justify-center p-2 rounded-xl border-2 transition-all text-center aspect-square ${
                        isSelected
                          ? r.activeColor + ' border-current scale-[1.02] shadow-sm font-bold'
                          : 'border-border bg-background hover:bg-muted text-muted-foreground'
                      }`}
                    >
                      <span className="text-lg md:text-xl mb-1">{r.icon}</span>
                      <span className="text-[10px] leading-tight font-medium truncate w-full">
                        {r.label}
                      </span>
                    </button>
                  )}
                )}
              </div>
            </div>

            <div>
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-1.5">
                Описание / Комментарий
              </label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Укажите подробную причину списания..."
                rows={2}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all resize-none"
              />
            </div>
          </div>

          {/* Selected Lines / Cart List */}
          <div className="flex-1 bg-card border border-border rounded-xl shadow-sm flex flex-col overflow-hidden">
            <div className="p-4 border-b border-border/80 flex items-center justify-between shrink-0 bg-muted/10">
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                Позиции к списанию ({lines.length})
              </h3>
              {lines.length > 0 && (
                <button
                  type="button"
                  onClick={() => setLines([])}
                  className="text-xs text-destructive hover:underline font-semibold flex items-center gap-1"
                >
                  <Trash2 className="size-3.5" /> Очистить всё
                </button>
              )}
            </div>

            {/* Cart content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {lines.map(line => {
                const item = allItems.find(i => i.id === line.ingredientId)
                const overStock = item ? line.qty > item.qty : false
                return (
                  <div
                    key={line.ingredientId}
                    className={`border rounded-xl p-3 flex flex-col gap-2 transition-colors ${
                      overStock
                        ? 'border-destructive bg-destructive/5'
                        : 'border-border bg-background'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-sm text-foreground truncate">
                          {line.name}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          Цена: {formatCurrency(line.pricePerUnit)}/{line.unit}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeLine(line.ingredientId)}
                        className="text-muted-foreground hover:text-destructive p-1 rounded-md hover:bg-muted transition-colors shrink-0"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>

                    {overStock && (
                      <div className="flex items-center gap-1.5 text-xs text-destructive bg-destructive/10 px-2 py-1 rounded-md font-medium">
                        <AlertTriangle className="size-3.5 shrink-0" />
                        <span>Списывается больше остатка ({item?.qty} {line.unit})</span>
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-3 pt-1 border-t border-border/40 mt-1">
                      {/* Counter Controls */}
                      <div className="flex items-center gap-1 bg-muted/50 border border-border p-1 rounded-lg">
                        <button
                          type="button"
                          onClick={() => updateQty(line.ingredientId, -1)}
                          className="size-7 rounded-md bg-background border border-border flex items-center justify-center hover:bg-muted text-foreground transition-colors shrink-0"
                        >
                          <Minus className="size-3" />
                        </button>
                        <input
                          type="number"
                          value={line.qty}
                          step={line.unit === 'шт.' || line.unit === 'порц.' ? 1 : 0.1}
                          onChange={e => handleQtyChange(line.ingredientId, e.target.value)}
                          className="w-12 bg-transparent text-center text-sm font-bold focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <span className="text-xs text-muted-foreground px-1.5 shrink-0">
                          {line.unit}
                        </span>
                        <button
                          type="button"
                          onClick={() => updateQty(line.ingredientId, 1)}
                          className="size-7 rounded-md bg-background border border-border flex items-center justify-center hover:bg-muted text-foreground transition-colors shrink-0"
                        >
                          <Plus className="size-3" />
                        </button>
                      </div>

                      {/* Total line cost */}
                      <div className="text-right">
                        <span className="text-[10px] text-muted-foreground block">Сумма</span>
                        <span className="text-sm font-bold text-destructive">
                          {formatCurrency(dMul(line.qty, line.pricePerUnit))}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })}

              {lines.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                  <FileText className="size-8 text-muted-foreground/30 mb-2" />
                  <p className="text-sm">Список пуст</p>
                  <p className="text-xs text-muted-foreground max-w-[200px] mt-1 mx-auto">
                    Кликните по карточкам товаров слева, чтобы добавить их в списание
                  </p>
                </div>
              )}
            </div>

            {/* Total summary info */}
            {lines.length > 0 && (
              <div className="p-4 border-t border-border bg-muted/10 shrink-0 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Позиций к списанию</span>
                  <span className="font-semibold">{lines.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-base font-bold text-foreground">Итого убыток</span>
                  <span className="text-xl font-bold text-destructive">
                    {formatCurrency(totalCost)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
