'use client'

import { useState, useEffect } from 'react'
import { formatTime, formatNum } from '@/lib/helpers'
import type { StockMovementType, StockMovement } from '@/lib/types'
import { fetchStockMovements } from '@/lib/queries'
import { ArrowDownToLine, ArrowUpFromLine, FlaskConical, ClipboardCheck, SlidersHorizontal, CookingPot } from 'lucide-react'

const TYPE_META: Record<StockMovementType, { label: string; color: string; bg: string; Icon: React.ElementType }> = {
  in:    { label: 'Приход',        color: 'text-emerald-600', bg: 'bg-emerald-100', Icon: ArrowDownToLine },
  out:   { label: 'Списание',      color: 'text-destructive', bg: 'bg-red-100',     Icon: ArrowUpFromLine },
  batch: { label: 'Приготовление', color: 'text-purple-600',  bg: 'bg-purple-100',  Icon: CookingPot },
  semi:  { label: 'Производство',  color: 'text-blue-600',    bg: 'bg-blue-100',    Icon: FlaskConical },
  audit: { label: 'Инвентаризация',color: 'text-amber-600',   bg: 'bg-amber-100',   Icon: ClipboardCheck },
  adj:   { label: 'Корректировка', color: 'text-muted-foreground', bg: 'bg-muted', Icon: SlidersHorizontal },
}

export default function HistoryPage() {
  const [filter, setFilter] = useState<StockMovementType | 'all'>('all')
  const [movements, setMovements] = useState<StockMovement[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStockMovements().then((data) => { setMovements(data); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  const filtered = movements.filter(
    (m) => filter === 'all' || m.type === filter
  )

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">История движений</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Все операции прихода, списания и производства</p>
      </div>

      {/* Filters */}
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
      <div className="bg-card rounded-xl border border-border divide-y divide-border">
        {filtered.length === 0 ? (
          <p className="text-center text-muted-foreground text-sm py-10">Нет записей</p>
        ) : (
          filtered.map((m) => {
            const meta = TYPE_META[m.type]
            const Icon = meta.Icon
            return (
              <div key={m.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-muted/30 transition-colors">
                <div className={`size-8 rounded-lg flex items-center justify-center shrink-0 ${meta.bg}`}>
                  <Icon className={`size-4 ${meta.color}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{m.ingredientName}</span>
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${meta.bg} ${meta.color}`}>{meta.label}</span>
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
    </div>
  )
}
