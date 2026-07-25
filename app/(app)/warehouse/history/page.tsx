'use client'

import { useState, useEffect, useMemo } from 'react'
import { formatTime, formatNum } from '@/lib/helpers'
import type { StockMovementType, StockMovement, Warehouse } from '@/lib/types'
import { fetchStockMovements, fetchWarehouses } from '@/lib/queries'
import { ArrowDownToLine, ArrowUpFromLine, FlaskConical, ClipboardCheck, SlidersHorizontal, CookingPot, Undo2, Search } from 'lucide-react'
import { DateFilter, inRange, type DateFilterValue } from '@/components/warehouse/date-filter'

const TYPE_META: Record<StockMovementType, { label: string; color: string; bg: string; Icon: React.ElementType }> = {
  in:    { label: 'Приход',        color: 'text-emerald-600', bg: 'bg-emerald-100', Icon: ArrowDownToLine },
  out:   { label: 'Списание',      color: 'text-destructive', bg: 'bg-red-100',     Icon: ArrowUpFromLine },
  return:{ label: 'Возврат',       color: 'text-orange-600',  bg: 'bg-orange-100',  Icon: Undo2 },
  batch: { label: 'Приготовление', color: 'text-purple-600',  bg: 'bg-purple-100',  Icon: CookingPot },
  semi:  { label: 'Производство',  color: 'text-blue-600',    bg: 'bg-blue-100',    Icon: FlaskConical },
  audit: { label: 'Инвентаризация',color: 'text-amber-600',   bg: 'bg-amber-100',   Icon: ClipboardCheck },
  adj:   { label: 'Корректировка', color: 'text-muted-foreground', bg: 'bg-muted', Icon: SlidersHorizontal },
}

// Цвет бейджа склада (в тон инвентарю).
const WH_BADGE: Record<string, string> = {
  products: 'bg-emerald-100 text-emerald-700',
  purchased: 'bg-blue-100 text-blue-700',
  supplies: 'bg-zinc-100 text-zinc-600',
}
const KIND_ORDER = ['products', 'purchased', 'supplies']

export default function HistoryPage() {
  const [filter, setFilter] = useState<StockMovementType | 'all'>('all')
  const [whId, setWhId] = useState<string>('all')
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [movements, setMovements] = useState<StockMovement[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [dateRange, setDateRange] = useState<DateFilterValue>(null)

  useEffect(() => { fetchWarehouses().then(setWarehouses).catch(() => {}) }, [])

  // Фильтр по складу — серверный (у каждого склада свой отчёт движений): при
  // смене склада перезапрашиваем его последние движения (не режем клиентом).
  useEffect(() => {
    setLoading(true)
    fetchStockMovements({ warehouseId: whId === 'all' ? undefined : whId })
      .then((data) => { setMovements(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [whId])

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

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">История движений</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Все операции прихода, списания и производства — по складам</p>
      </div>

      {/* Поиск по товару / описанию */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по товару или описанию…"
          className="w-full pl-10 pr-3 py-2.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>

      {/* Фильтр по датам */}
      <DateFilter value={dateRange} onChange={setDateRange} />

      {/* Фильтр по складу (мультисклад): у каждого склада свой отчёт движений */}
      {orderedWh.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {[{ id: 'all', name: 'Все склады' }, ...orderedWh.map((w) => ({ id: w.id, name: w.name }))].map((w) => {
            const active = whId === w.id
            return (
              <button
                key={w.id}
                onClick={() => setWhId(w.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                  active ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'
                }`}
              >
                {w.name}
              </button>
            )
          })}
        </div>
      )}

      {/* Фильтр по типу движения */}
      <div className="flex flex-wrap gap-2">
        {(['all', 'in', 'out', 'semi', 'audit', 'adj'] as const).map((t) => {
          const meta = t !== 'all' ? TYPE_META[t] : null
          const active = filter === t
          return (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                active
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card border-border text-foreground hover:bg-muted'
              }`}
            >
              {meta ? meta.label : 'Все'}
            </button>
          )
        })}
      </div>

      {/* List */}
      {loading ? (
        <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
      ) : (
        <div className="bg-card rounded-xl border border-border divide-y divide-border">
          {filtered.length === 0 ? (
            <p className="text-center text-muted-foreground text-sm py-10">Нет записей</p>
          ) : (
            filtered.map((m) => {
              // Фолбэк на 'adj' — защита от неизвестного/нового типа движения,
              // чтобы история не падала «Cannot read properties of undefined».
              const meta = TYPE_META[m.type] ?? TYPE_META.adj
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
                      {/* Склад показываем только в общем списке — при фильтре он и так один */}
                      {whId === 'all' && wh && (
                        <span className={`text-xs px-2 py-0.5 rounded font-medium ${WH_BADGE[wh.kind] ?? 'bg-muted text-muted-foreground'}`}>
                          {wh.name}
                        </span>
                      )}
                      {m.belowZero && (
                        <span className="text-xs px-2 py-0.5 rounded font-medium bg-destructive/10 text-destructive">
                          ниже 0
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{m.description}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-sm font-semibold ${m.qty > 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                      {m.qty > 0 ? '+' : ''}{formatNum(m.qty)} {m.unit}
                    </p>
                    <p className="text-xs text-muted-foreground">{formatTime(m.timestamp)}</p>
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
