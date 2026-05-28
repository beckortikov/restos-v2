'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { fetchIngredients, fetchSemiStock, fetchMenuItems, createWriteoff } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { dMul, dSum } from '@/lib/decimal'
import { type Ingredient, type WriteoffReason, WRITEOFF_REASON_LABELS } from '@/lib/types'
import { useAuth } from '@/lib/auth-store'
import { Search, Minus, Plus, X, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

const REASONS: WriteoffReason[] = ['spoilage', 'breakage', 'tasting', 'expired', 'other']

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

export function CreateWriteoffDialog({ open, onOpenChange, onSuccess }: {
  open: boolean; onOpenChange: (open: boolean) => void; onSuccess: () => void
}) {
  const { user } = useAuth()
  const [allItems, setAllItems] = useState<SelectableItem[]>([])
  const [reason, setReason] = useState<WriteoffReason>('spoilage')
  const [description, setDescription] = useState('')
  const [lines, setLines] = useState<WriteoffLine[]>([])
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [activeGroup, setActiveGroup] = useState('all')

  useEffect(() => {
    if (open) {
      Promise.all([fetchIngredients(), fetchSemiStock(), fetchMenuItems()]).then(([ings, semis, menuItems]) => {
        const items: SelectableItem[] = [
          ...ings.filter(i => i.isFood !== false && !['drinks', 'Напитки'].includes(i.category)).map(i => ({ id: i.id, name: i.name, qty: i.qty, unit: i.unit, pricePerUnit: i.pricePerUnit, group: 'ingredient' })),
          ...ings.filter(i => i.isFood !== false && ['drinks', 'Напитки'].includes(i.category)).map(i => ({ id: i.id, name: i.name, qty: i.qty, unit: i.unit, pricePerUnit: i.pricePerUnit, group: 'drinks' })),
          ...ings.filter(i => i.isFood === false).map(i => ({ id: i.id, name: i.name, qty: i.qty, unit: i.unit, pricePerUnit: i.pricePerUnit, group: 'supply' })),
          ...semis.map(s => ({ id: s.id, name: s.name, qty: s.qty, unit: s.unit, pricePerUnit: s.pricePerUnit, group: 'semi' })),
          ...menuItems.filter(m => m.isBatchCooking && (m.preparedQty || 0) > 0).map(m => ({
            id: m.id, name: m.name, qty: m.preparedQty || 0, unit: 'порц.', pricePerUnit: m.cogs || 0, group: 'batch',
          })),
          ...menuItems.filter(m => m.station === 'showcase' && m.isAvailable).map(m => {
            const mi = ings.find(i => i.name.toLowerCase() === m.name.toLowerCase())
            return { id: mi?.id || m.id, name: m.name, qty: mi?.qty ?? 0, unit: mi?.unit || 'шт.', pricePerUnit: mi?.pricePerUnit || m.price, group: 'showcase' }
          }),
        ]
        const showcaseNames = new Set(items.filter(i => i.group === 'showcase').map(i => i.name.toLowerCase()))
        setAllItems(items.filter(i => !((i.group === 'ingredient' || i.group === 'drinks') && showcaseNames.has(i.name.toLowerCase()))))
      })
      setReason('spoilage')
      setDescription('')
      setLines([])
      setSearch('')
      setActiveGroup('all')
    }
  }, [open])

  // Available groups (only show tabs for groups that have items)
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
    setLines(prev => prev.map(l => l.ingredientId === id ? { ...l, qty: Math.max(0.1, l.qty + delta) } : l))
  }

  const removeLine = (id: string) => {
    setLines(prev => prev.filter(l => l.ingredientId !== id))
  }

  const totalCost = dSum(lines.map(l => dMul(l.qty, l.pricePerUnit)))
  const canSubmit = lines.length > 0 && lines.every(l => l.qty > 0)

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSaving(true)
    try {
      await createWriteoff({ reason, description: description.trim() || undefined, lines, createdBy: user?.id })
      toast.success('Списание оформлено')
      onOpenChange(false)
      onSuccess()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] flex flex-col rounded-xl p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>Новое списание</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 space-y-4">
          {/* Reason chips */}
          <div className="flex flex-wrap gap-1.5">
            {REASONS.map(r => (
              <button key={r} type="button" onClick={() => setReason(r)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${reason === r ? 'bg-red-600 text-white border-red-600' : 'bg-card border-border hover:bg-muted'}`}>
                {WRITEOFF_REASON_LABELS[r]}
              </button>
            ))}
          </div>

          {/* Comment */}
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Комментарий (необязательно)"
            className="w-full px-3 py-2.5 text-sm bg-background border border-border rounded-lg" />

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по названию..."
              className="w-full pl-10 pr-4 py-2.5 text-sm bg-background border border-border rounded-xl" />
          </div>

          {/* Group tabs */}
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            <button onClick={() => setActiveGroup('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border whitespace-nowrap transition-colors ${activeGroup === 'all' ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border hover:bg-muted'}`}>
              Все
            </button>
            {availableGroups.map(g => (
              <button key={g} onClick={() => setActiveGroup(g)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border whitespace-nowrap transition-colors ${activeGroup === g ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border hover:bg-muted'}`}>
                {GROUP_LABELS[g].icon} {GROUP_LABELS[g].label}
              </button>
            ))}
          </div>

          {/* Item grid — click to add */}
          <div className="grid grid-cols-2 gap-2 max-h-52 overflow-y-auto">
            {filtered.map(item => {
              const inCart = lines.find(l => l.ingredientId === item.id)
              return (
                <button key={item.id} onClick={() => addItem(item)}
                  className={`text-left px-3 py-2.5 rounded-lg border text-xs transition-colors ${inCart ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted'}`}>
                  <p className="font-medium text-foreground truncate">{item.name}</p>
                  <p className="text-muted-foreground mt-0.5">{item.qty} {item.unit} · {formatCurrency(item.pricePerUnit)}/{item.unit}</p>
                  {inCart && <p className="text-primary font-semibold mt-0.5">В корзине: {inCart.qty}</p>}
                </button>
              )
            })}
            {filtered.length === 0 && (
              <p className="col-span-2 text-center text-xs text-muted-foreground py-6">Ничего не найдено</p>
            )}
          </div>

          {/* Selected lines */}
          {lines.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-border">
              <p className="text-xs font-semibold text-muted-foreground uppercase">К списанию ({lines.length})</p>
              {lines.map(line => {
                const item = allItems.find(i => i.id === line.ingredientId)
                const overStock = item ? line.qty > item.qty : false
                return (
                  <div key={line.ingredientId} className="flex items-center gap-2 bg-red-50 rounded-lg px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{line.name}</p>
                      {overStock && <p className="text-[10px] text-red-500">Больше остатка ({item?.qty} {line.unit})</p>}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => updateQty(line.ingredientId, -1)} className="size-7 rounded bg-white border border-border flex items-center justify-center hover:bg-muted">
                        <Minus className="size-3" />
                      </button>
                      <span className="text-sm font-bold w-10 text-center">{line.qty}</span>
                      <button onClick={() => updateQty(line.ingredientId, 1)} className="size-7 rounded bg-white border border-border flex items-center justify-center hover:bg-muted">
                        <Plus className="size-3" />
                      </button>
                      <span className="text-xs text-muted-foreground w-10">{line.unit}</span>
                      <span className="text-xs font-medium text-red-600 w-16 text-right">{formatCurrency(dMul(line.qty, line.pricePerUnit))}</span>
                      <button onClick={() => removeLine(line.ingredientId)} className="p-1 text-muted-foreground hover:text-red-600">
                        <X className="size-3.5" />
                      </button>
                    </div>
                  </div>
                )
              })}
              <div className="flex items-center justify-between pt-2">
                <span className="text-sm font-semibold text-foreground">Итого</span>
                <span className="text-lg font-bold text-red-600">{formatCurrency(totalCost)}</span>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="px-5 pb-5 pt-3 border-t border-border">
          <button onClick={() => onOpenChange(false)} className="px-4 py-2.5 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted">
            Отмена
          </button>
          <button onClick={handleSubmit} disabled={!canSubmit || saving}
            className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-2">
            <Trash2 className="size-4" />
            {saving ? 'Оформление...' : 'Оформить списание'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
