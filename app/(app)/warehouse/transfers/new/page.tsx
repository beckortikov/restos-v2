'use client'

import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { fetchIngredients, fetchWarehouses } from '@/lib/queries/stock'
import { fetchBranches, createTransfer, type Branch } from '@/lib/queries/transfers'
import { type Ingredient, type Warehouse } from '@/lib/types'
import { DecimalInput } from '@/components/ui/decimal-input'
import { formatNum } from '@/lib/helpers'
import { ArrowLeft, Trash2, Send, Search, Package, Box, ShoppingCart } from 'lucide-react'
import { toast } from 'sonner'

interface Row { ingredientId: string; qty: number }

type KindFilter = 'all' | 'products' | 'purchased' | 'supplies'

export default function NewTransferPage() {
  const { restaurantId } = useAuth()
  const navigate = useNavigate()
  const [branches, setBranches] = useState<Branch[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [toId, setToId] = useState('')
  const [note, setNote] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<KindFilter>('all')
  const [catFilter, setCatFilter] = useState('all')

  useEffect(() => {
    Promise.all([fetchBranches(), fetchIngredients(), fetchWarehouses()]).then(([b, ing, wh]) => {
      setBranches(b)
      setIngredients(ing)
      setWarehouses(wh)
    })
  }, [])

  // Получатели — все филиалы сети, кроме текущего.
  const receivers = useMemo(() => branches.filter(b => b.id !== restaurantId), [branches, restaurantId])

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const removeRow = (i: number) => setRows(rs => rs.filter((_, idx) => idx !== i))

  function addOrIncrementIngredient(ing: Ingredient) {
    setRows(prev => {
      const idx = prev.findIndex(r => r.ingredientId === ing.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...next[idx], qty: next[idx].qty + 1 }
        return next
      }
      return [...prev, { ingredientId: ing.id, qty: 1 }]
    })
  }

  // Склад товара: по warehouse_id (мультисклад). Не размеченные (legacy NULL) —
  // фоллбэк по is_food, чтобы товар не пропал из списка.
  const warehouseById = useMemo(() => new Map(warehouses.map(w => [w.id, w])), [warehouses])
  const kindOf = (ing: Ingredient): 'products' | 'purchased' | 'supplies' => {
    const k = ing.warehouseId ? warehouseById.get(ing.warehouseId)?.kind : undefined
    if (k === 'products' || k === 'purchased' || k === 'supplies') return k
    return ing.isFood === false ? 'supplies' : 'products'
  }
  const KIND_LABELS: Record<'products' | 'purchased' | 'supplies', string> = {
    products: 'Продукт', purchased: 'Покупной', supplies: 'Хозтовар',
  }

  const filteredIngredients = useMemo(() => {
    const q = search.trim().toLowerCase()
    return ingredients.filter(ing => {
      if (filter !== 'all' && kindOf(ing) !== filter) return false
      if (catFilter !== 'all' && (ing.category || '') !== catFilter) return false
      if (q && !ing.name.toLowerCase().includes(q)) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ingredients, filter, catFilter, search, warehouseById])

  const countByKind = useMemo(() => {
    const c: Record<'products' | 'purchased' | 'supplies', number> = { products: 0, purchased: 0, supplies: 0 }
    for (const i of ingredients) c[kindOf(i)]++
    return c
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ingredients, warehouseById])

  // Категории товаров текущего фильтра — чипы под поиском.
  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const ing of ingredients) {
      if (filter !== 'all' && kindOf(ing) !== filter) continue
      if (ing.category) set.add(ing.category)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ru'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ingredients, filter, warehouseById])

  const valid = toId && rows.some(r => r.ingredientId && r.qty > 0)

  const submit = async () => {
    if (!valid) return
    setSaving(true)
    try {
      await createTransfer({
        toRestaurantId: toId,
        note: note || undefined,
        lines: rows.filter(r => r.ingredientId && r.qty > 0).map(r => ({ ingredientId: r.ingredientId, qty: r.qty })),
      })
      toast.success('Перемещение отправлено')
      navigate('/warehouse/transfers')
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось отправить')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col min-h-screen">
      <div className="sticky top-0 z-10 bg-background border-b border-border">
        <div className="flex items-center gap-3 px-4 md:px-6 py-3">
          <button onClick={() => navigate('/warehouse/transfers')} className="rounded-lg p-1.5 hover:bg-muted">
            <ArrowLeft className="size-5" />
          </button>
          <h1 className="flex-1 text-base md:text-lg font-bold text-foreground truncate">Новое перемещение</h1>
          <button
            onClick={submit}
            disabled={!valid || saving}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Send className="size-4" />
            {saving ? 'Отправка...' : 'Отправить'}
          </button>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_minmax(360px,420px)] gap-4 md:gap-6 p-4 md:p-6">
        {/* LEFT — meta + ingredient picker */}
        <div className="space-y-4">
          {receivers.length === 0 && (
            <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
              Нет филиалов-получателей. Ресторан должен быть в сети.
            </div>
          )}

          <div className="bg-card border border-border rounded-xl p-4 space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Получатель</label>
            <select
              value={toId}
              onChange={e => setToId(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">— выберите филиал —</option>
              {receivers.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>

          {/* Filter tabs */}
          <div className="bg-card border border-border rounded-xl p-3 space-y-3">
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { v: 'all', label: 'Все', count: ingredients.length, icon: null },
                  { v: 'products', label: 'Продукты', count: countByKind.products, icon: Package },
                  { v: 'purchased', label: 'Покупные товары', count: countByKind.purchased, icon: ShoppingCart },
                  { v: 'supplies', label: 'Хозтовары', count: countByKind.supplies, icon: Box },
                ] as { v: KindFilter; label: string; count: number; icon: typeof Package | null }[]
              ).map(t => {
                const active = filter === t.v
                const Icon = t.icon
                return (
                  <button
                    key={t.v}
                    type="button"
                    onClick={() => { setFilter(t.v); setCatFilter('all') }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      active
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card border-border text-foreground hover:bg-muted'
                    }`}
                  >
                    {Icon && <Icon className="size-3.5" />}
                    {t.label}
                    <span className={`text-[10px] ${active ? 'opacity-80' : 'text-muted-foreground'}`}>{t.count}</span>
                  </button>
                )
              })}
            </div>

            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && filteredIngredients.length === 1) {
                    e.preventDefault()
                    addOrIncrementIngredient(filteredIngredients[0])
                    setSearch('')
                  }
                }}
                placeholder="Поиск ингредиента..."
                className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>

            {categories.length > 1 && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setCatFilter('all')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    catFilter === 'all'
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card border-border text-foreground hover:bg-muted'
                  }`}
                >
                  Все категории
                </button>
                {categories.map(cat => {
                  const active = catFilter === cat
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setCatFilter(active ? 'all' : cat)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        active
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-card border-border text-foreground hover:bg-muted'
                      }`}
                    >
                      {cat}
                    </button>
                  )
                })}
              </div>
            )}

            {filteredIngredients.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                {ingredients.length === 0 ? 'На складе пока нет ингредиентов для перемещения.' : 'Ничего не найдено'}
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
                {filteredIngredients.map(ing => {
                  const row = rows.find(r => r.ingredientId === ing.id)
                  const inTransfer = !!row
                  return (
                    <button
                      key={ing.id}
                      type="button"
                      onClick={() => addOrIncrementIngredient(ing)}
                      className={`group text-left p-3.5 rounded-xl border-2 transition-all relative overflow-hidden flex flex-col justify-between h-24 ${
                        inTransfer
                          ? 'border-primary bg-primary/5 hover:bg-primary/10 shadow-sm'
                          : 'border-border bg-card hover:border-primary/50 hover:bg-muted/30 hover:shadow-sm'
                      }`}
                    >
                      <div>
                        <p className="font-semibold text-sm text-foreground leading-tight group-hover:text-primary transition-colors line-clamp-2">
                          {ing.name}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                          {KIND_LABELS[kindOf(ing)]}{ing.category ? ` · ${ing.category}` : ''}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Остаток</p>
                        <p className={`text-xs font-bold ${ing.qty <= 0 ? 'text-destructive' : 'text-foreground'}`}>
                          {formatNum(ing.qty)} {ing.unit}
                        </p>
                      </div>
                      {inTransfer && (
                        <div className="absolute top-2 right-2 bg-primary text-primary-foreground text-[10px] font-bold px-1.5 py-0.5 rounded shadow-sm">
                          {formatNum(row.qty)} {ing.unit}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — lines + note */}
        <div className="space-y-4 lg:sticky lg:top-[60px] lg:self-start">
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <h2 className="text-sm font-semibold text-foreground">
              Позиции <span className="text-muted-foreground font-normal">({rows.length})</span>
            </h2>
            {rows.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground border border-dashed border-border rounded-lg">
                Выберите товары слева
              </div>
            ) : (
              <div className="space-y-2">
                {rows.map((r, i) => {
                  const ing = ingredients.find(x => x.id === r.ingredientId)
                  return (
                    <div key={r.ingredientId} className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 truncate text-sm text-foreground">{ing?.name ?? '—'}</span>
                      <div className="w-24">
                        <DecimalInput value={r.qty} onChange={v => setRow(i, { qty: v })} />
                      </div>
                      <span className="text-xs text-muted-foreground w-8">{ing?.unit}</span>
                      <button onClick={() => removeRow(i)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted">
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-4 space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Примечание</label>
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              placeholder="необязательно"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
