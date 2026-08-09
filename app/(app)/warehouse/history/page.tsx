'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { formatTime, formatNum, formatCurrency } from '@/lib/helpers'
import type { StockMovementType, StockMovement, Warehouse, Ingredient } from '@/lib/types'
import { WRITEOFF_REASON_LABELS } from '@/lib/types'
import { fetchStockMovements, fetchWarehouses, fetchIngredients, fetchWriteoffs, fetchReceipts } from '@/lib/queries'
import { Search, List, Package, ChevronRight } from 'lucide-react'
import { DateFilter, inRange, type DateFilterValue } from '@/components/warehouse/date-filter'
import { useDataSync } from '@/hooks/use-data-sync'
import { MOVEMENT_TYPE_META, movementSubtitle } from '@/lib/warehouse-movements'
import { ItemStockCard, type MovementEnrich } from '@/components/warehouse/item-stock-card'

// Цвет бейджа склада (в тон инвентарю).
const WH_BADGE: Record<string, string> = {
  products: 'bg-emerald-100 text-emerald-700',
  purchased: 'bg-blue-100 text-blue-700',
  supplies: 'bg-zinc-100 text-zinc-600',
}
const KIND_ORDER = ['products', 'purchased', 'supplies']

type Tab = 'feed' | 'byItem'
type ItemStatus = 'all' | 'low' | 'out'

export default function HistoryPage() {
  const [tab, setTab] = useState<Tab>('feed')

  // ─── Лента ─────────────────────────────────────────────────────────────────
  const [filter, setFilter] = useState<StockMovementType | 'all'>('all')
  const [whId, setWhId] = useState<string>('all')
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [movements, setMovements] = useState<StockMovement[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [dateRange, setDateRange] = useState<DateFilterValue>(null)

  // ─── По товарам ──────────────────────────────────────────────────────────────
  const [items, setItems] = useState<Ingredient[]>([])
  const [itemSearch, setItemSearch] = useState('')
  const [itemWh, setItemWh] = useState<string>('all')
  const [itemStatus, setItemStatus] = useState<ItemStatus>('all')
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [enrich, setEnrich] = useState<MovementEnrich>({ writeoffById: new Map(), receiptById: new Map() })
  const [byItemLoaded, setByItemLoaded] = useState(false)

  useEffect(() => { fetchWarehouses().then(setWarehouses).catch(() => {}) }, [])

  // Фильтр по складу — серверный (у каждого склада свой отчёт движений).
  const fetchMovements = useCallback(async () => {
    const data = await fetchStockMovements({ warehouseId: whId === 'all' ? undefined : whId })
    setMovements(data)
  }, [whId])

  useEffect(() => {
    setLoading(true)
    fetchMovements().finally(() => setLoading(false))
  }, [fetchMovements])

  useDataSync(['stock_movements'], fetchMovements)

  // «По товарам»: номенклатуру и карты обогащения (кто списал / у кого куплено)
  // грузим лениво — только при первом открытии таба, один раз.
  useEffect(() => {
    if (tab !== 'byItem' || byItemLoaded) return
    setByItemLoaded(true)
    fetchIngredients().then(setItems).catch(() => {})
    Promise.all([fetchWriteoffs().catch(() => []), fetchReceipts().catch(() => [])]).then(([wos, receipts]) => {
      const writeoffById = new Map(wos.map(w => [w.id, { who: w.createdByName, reason: WRITEOFF_REASON_LABELS[w.reason] ?? w.description }]))
      const receiptById = new Map(receipts.map(r => [r.id, { supplier: r.supplierName }]))
      setEnrich({ writeoffById, receiptById })
    })
  }, [tab, byItemLoaded])

  const warehouseById = useMemo(() => new Map(warehouses.map(w => [w.id, w])), [warehouses])
  const orderedWh = useMemo(
    () => [...warehouses].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)),
    [warehouses],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return movements.filter((m) => {
      if (filter !== 'all' && m.type !== filter) return false
      if (!inRange(m.timestamp, dateRange)) return false
      if (q && !(
        (m.ingredientName ?? '').toLowerCase().includes(q) ||
        (m.description ?? '').toLowerCase().includes(q)
      )) return false
      return true
    })
  }, [movements, filter, dateRange, search])

  // Сводка-отчёт по отфильтрованной ленте: приход/расход + по типам.
  const feedSummary = useMemo(() => {
    let inflow = 0, outflow = 0
    const byType = new Map<StockMovementType, number>()
    for (const m of filtered) {
      if (m.qty > 0) inflow += m.qty
      else outflow += m.qty
      byType.set(m.type, (byType.get(m.type) ?? 0) + 1)
    }
    return { inflow, outflow, count: filtered.length, byType }
  }, [filtered])

  const itemsFiltered = useMemo(() => {
    const q = itemSearch.trim().toLowerCase()
    return items.filter((i) => {
      if (itemWh !== 'all' && i.warehouseId !== itemWh) return false
      if (itemStatus === 'out' && i.qty > 0) return false
      if (itemStatus === 'low' && !(i.qty > 0 && i.minQty > 0 && i.qty <= i.minQty)) return false
      if (q && !(i.name.toLowerCase().includes(q) || (i.category ?? '').toLowerCase().includes(q))) return false
      return true
    })
  }, [items, itemSearch, itemWh, itemStatus])
  const selectedItem = useMemo(() => items.find(i => i.id === selectedItemId) ?? null, [items, selectedItemId])

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-xl font-bold text-foreground">История движений</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Лента всех движений и полная история по каждому товару</p>
      </div>

      {/* Табы */}
      <div className="flex gap-1 bg-muted rounded-lg p-1 w-fit">
        {([['feed', 'Лента', List], ['byItem', 'По товарам', Package]] as const).map(([key, label, Icon]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors inline-flex items-center gap-1.5 ${tab === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            <Icon className="size-4" />{label}
          </button>
        ))}
      </div>

      {/* ═══════════════════════════ ЛЕНТА ═══════════════════════════════════ */}
      {tab === 'feed' && (
        <div className="space-y-4">
          {/* Сводка-отчёт по текущему фильтру */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-card rounded-xl border border-border p-3">
              <p className="text-xs text-muted-foreground">Приход</p>
              <p className="text-lg font-bold text-emerald-600 tabular-nums">+{formatNum(feedSummary.inflow)}</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-3">
              <p className="text-xs text-muted-foreground">Расход</p>
              <p className="text-lg font-bold text-destructive tabular-nums">{formatNum(feedSummary.outflow)}</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-3">
              <p className="text-xs text-muted-foreground">Операций</p>
              <p className="text-lg font-bold text-foreground tabular-nums">{feedSummary.count}</p>
            </div>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по товару или описанию…"
              className="w-full pl-10 pr-3 py-2.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>

          <DateFilter value={dateRange} onChange={setDateRange} />

          {orderedWh.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {[{ id: 'all', name: 'Все склады' }, ...orderedWh.map((w) => ({ id: w.id, name: w.name }))].map((w) => (
                <button key={w.id} onClick={() => setWhId(w.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${whId === w.id ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'}`}>
                  {w.name}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {(['all', 'in', 'out', 'semi', 'audit', 'adj'] as const).map((t) => {
              const meta = t !== 'all' ? MOVEMENT_TYPE_META[t] : null
              return (
                <button key={t} onClick={() => setFilter(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${filter === t ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'}`}>
                  {meta ? meta.label : 'Все'}
                </button>
              )
            })}
          </div>

          {loading ? (
            <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
          ) : (
            <div className="bg-card rounded-xl border border-border divide-y divide-border">
              {filtered.length === 0 ? (
                <p className="text-center text-muted-foreground text-sm py-10">Нет записей</p>
              ) : (
                filtered.map((m) => {
                  const meta = MOVEMENT_TYPE_META[m.type] ?? MOVEMENT_TYPE_META.adj
                  const Icon = meta.Icon
                  const wh = m.warehouseId ? warehouseById.get(m.warehouseId) : undefined
                  return (
                    <div key={m.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-muted/30 transition-colors">
                      <div className={`size-8 rounded-lg flex items-center justify-center shrink-0 ${meta.bg}`}>
                        <Icon className={`size-4 ${meta.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-foreground">{m.ingredientName}</span>
                          <span className={`text-xs px-2 py-0.5 rounded font-medium ${meta.bg} ${meta.color}`}>{meta.label}</span>
                          {whId === 'all' && wh && (
                            <span className={`text-xs px-2 py-0.5 rounded font-medium ${WH_BADGE[wh.kind] ?? 'bg-muted text-muted-foreground'}`}>{wh.name}</span>
                          )}
                          {m.belowZero && <span className="text-xs px-2 py-0.5 rounded font-medium bg-destructive/10 text-destructive">ниже 0</span>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{movementSubtitle(m.description)}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`text-sm font-semibold ${m.qty > 0 ? 'text-emerald-600' : 'text-destructive'}`}>{m.qty > 0 ? '+' : ''}{formatNum(m.qty)} {m.unit}</p>
                        <p className="text-xs text-muted-foreground">{formatTime(m.timestamp)}</p>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════ ПО ТОВАРАМ ══════════════════════════════ */}
      {tab === 'byItem' && (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,300px)_1fr] gap-4 items-start">
          {/* Список товаров + фильтры */}
          <div className="space-y-2.5">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="Поиск товара…"
                className="w-full pl-10 pr-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            {orderedWh.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {[{ id: 'all', name: 'Все' }, ...orderedWh.map((w) => ({ id: w.id, name: w.name }))].map((w) => (
                  <button key={w.id} onClick={() => setItemWh(w.id)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors ${itemWh === w.id ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'}`}>
                    {w.name}
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-1.5">
              {([['all', 'Все'], ['low', 'Мало'], ['out', 'Нет']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setItemStatus(k)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors ${itemStatus === k ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'}`}>
                  {label}
                </button>
              ))}
            </div>
            <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border max-h-[70vh] overflow-y-auto">
              {itemsFiltered.length === 0 ? (
                <p className="text-center text-muted-foreground text-sm py-8">Ничего не найдено</p>
              ) : (
                itemsFiltered.map((i) => {
                  const active = i.id === selectedItemId
                  const out = i.qty <= 0
                  const low = i.qty > 0 && i.minQty > 0 && i.qty <= i.minQty
                  return (
                    <button key={i.id} onClick={() => setSelectedItemId(i.id)}
                      className={`w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors ${active ? 'bg-primary/10' : 'hover:bg-muted/40'}`}>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${active ? 'text-primary' : 'text-foreground'}`}>{i.name}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{i.category}</p>
                      </div>
                      <span className={`text-xs font-semibold tabular-nums shrink-0 ${out ? 'text-destructive' : low ? 'text-amber-600' : 'text-muted-foreground'}`}>{formatNum(i.qty)} {i.unit}</span>
                      <ChevronRight className="size-4 text-muted-foreground/40 shrink-0" />
                    </button>
                  )
                })
              )}
            </div>
          </div>

          {/* Карточка выбранного товара */}
          <div className="bg-card rounded-xl border border-border p-4 md:p-5 min-h-[300px]">
            {selectedItem ? (
              <ItemStockCard ingredient={selectedItem} enrich={enrich} />
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center py-16">
                <Package className="size-10 text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">Выберите товар слева —<br />покажу всю его историю: куплен, продан, списан, кем и когда</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
