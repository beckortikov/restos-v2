'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { type StockWriteoff, type WriteoffReason, WRITEOFF_REASON_LABELS } from '@/lib/types'
import { fetchWriteoffs } from '@/lib/queries'
import { useDataSync } from '@/hooks/use-data-sync'
import { Trash2, Plus, ChevronRight, Search } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { DateFilter, inRange, type DateFilterValue } from '@/components/warehouse/date-filter'

const ALL_REASONS: WriteoffReason[] = ['spoilage', 'breakage', 'tasting', 'expired', 'other']

// Цвет плитки причины — семантический (порча=красный, дегустация=синий и т.д.).
const REASON_TONE: Record<WriteoffReason, string> = {
  spoilage: 'bg-red-100 dark:bg-red-500/15 text-red-600',
  breakage: 'bg-amber-100 dark:bg-amber-500/15 text-amber-600',
  tasting: 'bg-blue-100 dark:bg-blue-500/15 text-blue-600',
  expired: 'bg-orange-100 dark:bg-orange-500/15 text-orange-600',
  other: 'bg-muted text-muted-foreground',
}

export default function WriteoffsPage() {
  const { canDo } = useAuth()
  const navigate = useNavigate()
  const [writeoffs, setWriteoffs] = useState<StockWriteoff[]>([])
  const [loading, setLoading] = useState(true)
  const [reasonFilter, setReasonFilter] = useState<WriteoffReason | 'all'>('all')
  const [search, setSearch] = useState('')
  const [dateRange, setDateRange] = useState<DateFilterValue>(null)
  const [actionItem, setActionItem] = useState<StockWriteoff | null>(null)

  const reload = useCallback(async () => {
    try { setWriteoffs(await fetchWriteoffs()) } finally { setLoading(false) }
  }, [])

  useEffect(() => { reload() }, [reload])

  // Real-time: списание на другом терминале появляется без перезахода.
  useDataSync(['stock_writeoffs', 'ingredients'], reload)

  // База — после поиска и дат (но ДО фильтра по причине, чтобы плитки причин
  // показывали корректные счётчики и оставались переключаемыми).
  const base = useMemo(() => {
    const q = search.trim().toLowerCase()
    return writeoffs.filter(w => {
      if (!inRange(w.createdAt, dateRange)) return false
      if (!q) return true
      return (
        (w.description ?? '').toLowerCase().includes(q) ||
        WRITEOFF_REASON_LABELS[w.reason].toLowerCase().includes(q) ||
        w.lines.some(l => l.name.toLowerCase().includes(q))
      )
    })
  }, [writeoffs, search, dateRange])

  const filtered = useMemo(
    () => reasonFilter === 'all' ? base : base.filter(w => w.reason === reasonFilter),
    [base, reasonFilter],
  )

  const totalCost = base.reduce((s, w) => s + w.totalCost, 0)
  const byReason = useMemo(() => {
    const map: Record<string, { count: number; cost: number }> = {}
    for (const w of base) {
      if (!map[w.reason]) map[w.reason] = { count: 0, cost: 0 }
      map[w.reason].count++
      map[w.reason].cost += w.totalCost
    }
    return map
  }, [base])

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Списания</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {base.length} акт{base.length === 1 ? '' : base.length < 5 ? 'а' : 'ов'} на {formatCurrency(totalCost)}
          </p>
        </div>
        {canDo('writeoffs.create') && (
          <button
            onClick={() => navigate('/warehouse/writeoffs/new')}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors w-full sm:w-auto justify-center"
          >
            <Plus className="size-4" />
            Новое списание
          </button>
        )}
      </div>

      {/* Search */}
      {writeoffs.length > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по товару, причине или комментарию…"
            className="w-full pl-10 pr-3 py-2.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      )}

      {/* Date filter */}
      {writeoffs.length > 0 && <DateFilter value={dateRange} onChange={setDateRange} />}

      {/* Reason chips (also filter) */}
      {writeoffs.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {ALL_REASONS.map(reason => {
            const stat = byReason[reason]
            const active = reasonFilter === reason
            return (
              <button
                key={reason}
                onClick={() => setReasonFilter(active ? 'all' : reason)}
                className={`bg-card rounded-xl border-2 p-3 text-left transition-colors ${
                  active ? 'border-primary' : 'border-border hover:border-primary/30'
                }`}
              >
                <p className="text-xs text-muted-foreground">{WRITEOFF_REASON_LABELS[reason]}</p>
                <p className="text-lg font-bold text-foreground">{stat?.count ?? 0}</p>
                {(stat?.cost ?? 0) > 0 && (
                  <p className="text-xs text-destructive font-medium">{formatCurrency(stat.cost)}</p>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Empty states */}
      {writeoffs.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-12 text-center">
          <Trash2 className="size-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="font-medium text-foreground">Нет списаний</p>
          <p className="text-sm text-muted-foreground mt-1">Создайте первый акт списания</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center text-sm text-muted-foreground">
          Ничего не найдено по текущим фильтрам
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
          {filtered.map(wo => (
            <button
              key={wo.id}
              type="button"
              onClick={() => setActionItem(wo)}
              className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/40 transition-colors"
            >
              <div className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${REASON_TONE[wo.reason]}`}>
                <Trash2 className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground text-sm">{WRITEOFF_REASON_LABELS[wo.reason]}</span>
                  <span className="text-xs text-muted-foreground">
                    {wo.lines.length} позиц{wo.lines.length === 1 ? 'ия' : wo.lines.length < 5 ? 'ии' : 'ий'}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                  <span>{new Date(wo.createdAt).toLocaleDateString('ru')}</span>
                  <span>{new Date(wo.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</span>
                  {wo.createdByName && <span className="truncate">· {wo.createdByName}</span>}
                </div>
                {wo.description && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{wo.description}</p>
                )}
              </div>
              <span className="text-sm font-bold text-destructive tabular-nums shrink-0">{formatCurrency(wo.totalCost)}</span>
              <ChevronRight className="size-4 text-muted-foreground shrink-0" />
            </button>
          ))}
        </div>
      )}

      {/* Детали акта списания (read-only) */}
      <Dialog open={!!actionItem} onOpenChange={(v) => { if (!v) setActionItem(null) }}>
        <DialogContent className="sm:max-w-lg rounded-xl max-h-[85vh] overflow-y-auto">
          {actionItem && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className={`size-7 rounded-lg flex items-center justify-center ${REASON_TONE[actionItem.reason]}`}>
                    <Trash2 className="size-4" />
                  </span>
                  Списание · {WRITEOFF_REASON_LABELS[actionItem.reason]}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-1">
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span>{new Date(actionItem.createdAt).toLocaleDateString('ru')}</span>
                  <span>·</span>
                  <span>{new Date(actionItem.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</span>
                  {actionItem.createdByName && <><span>·</span><span>{actionItem.createdByName}</span></>}
                </div>
                {actionItem.description && (
                  <p className="text-xs text-muted-foreground">Комментарий: {actionItem.description}</p>
                )}
                <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                  {actionItem.lines.map((line, idx) => (
                    <div key={idx} className="flex items-center gap-3 px-3 py-2">
                      <span className="text-sm text-foreground flex-1 truncate">{line.name}</span>
                      <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                        {formatNum(line.qty)} {line.unit}
                      </span>
                      <span className="text-sm font-semibold text-destructive tabular-nums w-24 text-right">
                        {formatCurrency(line.cost)}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between px-3 py-2 bg-muted/30">
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Итого</span>
                    <span className="text-sm font-bold text-destructive tabular-nums">{formatCurrency(actionItem.totalCost)}</span>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <button
                  type="button"
                  onClick={() => setActionItem(null)}
                  className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
                >
                  Закрыть
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
