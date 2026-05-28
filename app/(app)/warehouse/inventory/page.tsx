'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { type Ingredient } from '@/lib/types'
import { fetchIngredients, fetchIngredientCategories, createIngredient, updateIngredient } from '@/lib/queries'

import { Search, AlertTriangle, TrendingDown, Package, Plus } from 'lucide-react'
import { ManageIngredientDialog } from '@/components/dialogs/manage-ingredient-dialog'
import { toast } from 'sonner'

function StockLevel({ qty, minQty }: { qty: number; minQty: number }) {
  const pct = Math.min(100, (qty / (minQty * 3)) * 100)
  const color = qty < minQty ? 'bg-destructive' : qty < minQty * 1.5 ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground w-16 text-right">
        {qty < minQty ? '⚠ мало' : qty < minQty * 1.5 ? '~ норма' : '✓ ок'}
      </span>
    </div>
  )
}

// Virtualized table for ingredients lists > 50 rows. Uses a CSS grid layout to
// mirror the columns of the original <table> while keeping rows as absolutely
// positioned divs so @tanstack/react-virtual can place them.
function VirtualIngredientsTable({ items, onEdit }: { items: Ingredient[]; onEdit: (ing: Ingredient) => void }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 8,
  })
  const cols = 'grid-cols-[minmax(180px,2fr)_minmax(120px,1fr)_120px_120px_160px_140px_140px]'
  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className={`grid ${cols} min-w-[700px] bg-muted/40 border-b border-border`}>
        {['Наименование', 'Категория', 'Остаток', 'Мин. порог', 'Уровень', 'Цена', 'Стоимость'].map((h) => (
          <div key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</div>
        ))}
      </div>
      <div ref={parentRef} className="overflow-auto h-[calc(100vh-360px)] min-h-[400px]">
        <div className="min-w-[700px]" style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {rowVirtualizer.getVirtualItems().map(v => {
            const ing = items[v.index]
            return (
              <div
                key={ing.id}
                onClick={() => onEdit(ing)}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
                className={`grid ${cols} border-b border-border hover:bg-muted/30 transition-colors cursor-pointer items-center ${ing.qty < ing.minQty ? 'bg-destructive/5' : ''}`}
              >
                <div className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {ing.qty < ing.minQty && <AlertTriangle className="size-3.5 text-amber-500 shrink-0" />}
                    <span className="font-medium text-foreground">{ing.name}</span>
                  </div>
                </div>
                <div className="px-4 py-3">
                  <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">{ing.category}</span>
                </div>
                <div className="px-4 py-3">
                  <span className={`font-bold ${ing.qty < ing.minQty ? 'text-destructive' : 'text-foreground'}`}>{formatNum(ing.qty)}</span>
                  <span className="text-muted-foreground text-xs ml-1">{ing.unit}</span>
                </div>
                <div className="px-4 py-3 text-sm text-muted-foreground">{formatNum(ing.minQty)} {ing.unit}</div>
                <div className="px-4 py-3"><StockLevel qty={ing.qty} minQty={ing.minQty} /></div>
                <div className="px-4 py-3 text-sm text-foreground">
                  {formatCurrency(ing.pricePerUnit)}/{ing.unit}
                  {ing.wastePercent > 0 && <span className="block text-xs text-amber-600">отходы {ing.wastePercent}%</span>}
                </div>
                <div className="px-4 py-3 text-sm font-medium text-foreground">{formatCurrency(ing.qty * ing.pricePerUnit)}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default function InventoryPage() {
  const { canDo } = useAuth()
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [tab, setTab] = useState<'food' | 'supplies'>('food')
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [ingredientCategories, setIngredientCategories] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingIngredient, setEditingIngredient] = useState<Ingredient | undefined>(undefined)

  const reload = useCallback(() => {
    fetchIngredients().then(setIngredients).catch(() => {})
    fetchIngredientCategories().then(setIngredientCategories).catch(() => {})
  }, [])

  useEffect(() => {
    fetchIngredients().then((data) => { setIngredients(data); setLoading(false) }).catch(() => setLoading(false))
    fetchIngredientCategories().then(setIngredientCategories)
  }, [reload])

  // Poll every 15s ONLY in local mode (Desktop app / Local DB)
  useEffect(() => {
    let isLocal = false
    try { isLocal = localStorage.getItem('restos-sync-mode') === 'local' } catch {}
    
    if (isLocal) {
      const interval = setInterval(reload, 2000)
      return () => clearInterval(interval)
    }
  }, [reload])

  async function handleIngredientSubmit(data: { name: string; category: string; unit: string; initialQty?: number; minQty: number; pricePerUnit: number; wastePercent?: number; isFood?: boolean }) {
    try {
      if (editingIngredient) {
        await updateIngredient(editingIngredient.id, {
          name: data.name,
          category: data.category,
          min_qty: data.minQty,
          unit: data.unit,
          price_per_unit: data.pricePerUnit,
          waste_percent: data.wastePercent ?? 0,
          is_food: data.isFood ?? true,
        })
        // Update qty if changed — PATCH /api/v1/stock/ingredients/{id} on v4
        // accepts qty (the server clamps + records a manual-adjustment stock
        // movement so the audit trail stays intact).
        if (data.initialQty !== undefined && data.initialQty !== editingIngredient.qty) {
          const { api, unwrap } = await import('@/lib/api')
          await unwrap(api.PATCH('/api/v1/stock/ingredients/{id}', {
            params: { path: { id: editingIngredient.id } },
            body: { qty: String(data.initialQty) } as any,
          }))
        }
        toast.success(data.isFood ? 'Ингредиент обновлён' : 'Хозтовар обновлён')
      } else {
        await createIngredient({
          name: data.name,
          category: data.category,
          qty: data.initialQty ?? 0,
          min_qty: data.minQty,
          unit: data.unit,
          price_per_unit: data.pricePerUnit,
          waste_percent: data.wastePercent ?? 0,
          is_food: data.isFood ?? true,
        })
        toast.success('Ингредиент добавлен')
      }
      const updated = await fetchIngredients()
      setIngredients(updated)
      fetchIngredientCategories().then(setIngredientCategories)
    } catch {
      toast.error('Ошибка при сохранении ингредиента')
    }
  }

  function openCreateDialog() {
    // Pre-set a "fake" ingredient to pass isFood based on active tab
    setEditingIngredient(undefined)
    setDialogOpen(true)
  }

  function openEditDialog(ing: Ingredient) {
    setEditingIngredient(ing)
    setDialogOpen(true)
  }

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  const tabItems = ingredients.filter(i => tab === 'food' ? i.isFood !== false : i.isFood === false)
  const tabCategories = [...new Set(tabItems.map(i => i.category))].sort()

  const filtered = tabItems.filter((i) => {
    const matchSearch = i.name.toLowerCase().includes(search.toLowerCase())
    const matchCat = category === 'all' || i.category === category
    return matchSearch && matchCat
  })

  const lowCount = tabItems.filter((i) => i.qty < i.minQty).length
  const totalValue = tabItems.reduce((s, i) => s + i.qty * i.pricePerUnit, 0)
  const suppliesCount = ingredients.filter(i => i.isFood === false).length

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Остатки на складе</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {ingredients.length} позиций · Стоимость: {formatCurrency(totalValue)}
            {lowCount > 0 && <span className="text-amber-600 ml-2">· {lowCount} ниже нормы</span>}
          </p>
        </div>
        {canDo('inventory.manage') && (
          <button
            onClick={openCreateDialog}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors w-full sm:w-auto justify-center"
          >
            <Plus className="size-4" />
            {tab === 'food' ? 'Добавить ингредиент' : 'Добавить хозтовар'}
          </button>
        )}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 bg-muted rounded-lg p-1 w-fit">
        <button
          onClick={() => { setTab('food'); setCategory('all') }}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === 'food' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
        >
          Продукты
        </button>
        <button
          onClick={() => { setTab('supplies'); setCategory('all') }}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === 'supplies' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
        >
          Хозтовары {suppliesCount > 0 && <span className="ml-1 text-xs text-muted-foreground">({suppliesCount})</span>}
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
        <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
          <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Package className="size-5 text-primary" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Позиций</p>
            <p className="text-xl font-bold text-foreground">{tabItems.length}</p>
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
          <div className="size-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
            <AlertTriangle className="size-5 text-amber-600" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Ниже нормы</p>
            <p className="text-xl font-bold text-foreground">{lowCount}</p>
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
          <div className="size-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
            <TrendingDown className="size-5 text-blue-600" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Стоимость склада</p>
            <p className="text-base font-bold text-foreground">{formatCurrency(totalValue)}</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Поиск по названию..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-4 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 w-56"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setCategory('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${category === 'all' ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'}`}
          >
            Все
          </button>
          {tabCategories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${category === c ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {filtered.length > 50 ? (
        <VirtualIngredientsTable items={filtered} onEdit={openEditDialog} />
      ) : (
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {['Наименование', 'Категория', 'Остаток', 'Мин. порог', 'Уровень', 'Цена', 'Стоимость'].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((ing) => (
              <tr key={ing.id} onClick={() => openEditDialog(ing)} className={`border-b border-border last:border-0 hover:bg-muted/30 transition-colors cursor-pointer ${ing.qty < ing.minQty ? 'bg-destructive/5' : ''}`}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {ing.qty < ing.minQty && <AlertTriangle className="size-3.5 text-amber-500 shrink-0" />}
                    <span className="font-medium text-foreground">{ing.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">{ing.category}</span>
                </td>
                <td className="px-4 py-3">
                  <span className={`font-bold ${ing.qty < ing.minQty ? 'text-destructive' : 'text-foreground'}`}>
                    {formatNum(ing.qty)}
                  </span>
                  <span className="text-muted-foreground text-xs ml-1">{ing.unit}</span>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{formatNum(ing.minQty)} {ing.unit}</td>
                <td className="px-4 py-3 w-40"><StockLevel qty={ing.qty} minQty={ing.minQty} /></td>
                <td className="px-4 py-3 text-sm text-foreground">
                  {formatCurrency(ing.pricePerUnit)}/{ing.unit}
                  {ing.wastePercent > 0 && <span className="block text-xs text-amber-600">отходы {ing.wastePercent}%</span>}
                </td>
                <td className="px-4 py-3 text-sm font-medium text-foreground">{formatCurrency(ing.qty * ing.pricePerUnit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      )}

      <ManageIngredientDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        ingredient={editingIngredient}
        defaultIsFood={tab === 'food'}
        onSubmit={handleIngredientSubmit}
      />
    </div>
  )
}
