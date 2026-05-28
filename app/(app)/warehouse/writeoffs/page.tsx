'use client'

import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { type StockWriteoff, type WriteoffReason, WRITEOFF_REASON_LABELS } from '@/lib/types'
import { fetchWriteoffs } from '@/lib/queries'
import { Trash2, Plus, ChevronDown, ChevronRight, Filter } from 'lucide-react'
import { CreateWriteoffDialog } from '@/components/dialogs/create-writeoff-dialog'

const ALL_REASONS: WriteoffReason[] = ['spoilage', 'breakage', 'tasting', 'expired', 'other']

export default function WriteoffsPage() {
  const { canDo } = useAuth()
  const [writeoffs, setWriteoffs] = useState<StockWriteoff[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [reasonFilter, setReasonFilter] = useState<WriteoffReason | 'all'>('all')

  const reload = async () => {
    const data = await fetchWriteoffs()
    setWriteoffs(data)
  }

  useEffect(() => {
    fetchWriteoffs()
      .then(data => { setWriteoffs(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    if (reasonFilter === 'all') return writeoffs
    return writeoffs.filter(w => w.reason === reasonFilter)
  }, [writeoffs, reasonFilter])

  const totalCost = writeoffs.reduce((s, w) => s + w.totalCost, 0)
  const byReason = useMemo(() => {
    const map: Record<string, { count: number; cost: number }> = {}
    for (const w of writeoffs) {
      const r = w.reason
      if (!map[r]) map[r] = { count: 0, cost: 0 }
      map[r].count++
      map[r].cost += w.totalCost
    }
    return map
  }, [writeoffs])

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  return (
    <div className="p-4 md:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Списания</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {writeoffs.length} акт{writeoffs.length === 1 ? '' : writeoffs.length < 5 ? 'а' : 'ов'} на {formatCurrency(totalCost)}
          </p>
        </div>
        {canDo('writeoffs.create') && (
          <button
            onClick={() => setDialogOpen(true)}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors w-full sm:w-auto justify-center"
          >
            <Plus className="size-4" />
            Новое списание
          </button>
        )}
      </div>

      {/* Stats by reason */}
      {writeoffs.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {ALL_REASONS.map(reason => {
            const stat = byReason[reason]
            return (
              <button
                key={reason}
                onClick={() => setReasonFilter(reasonFilter === reason ? 'all' : reason)}
                className={`bg-card rounded-xl border-2 p-3 text-left transition-colors ${
                  reasonFilter === reason ? 'border-primary' : 'border-border hover:border-primary/30'
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

      {/* Filter indicator */}
      {reasonFilter !== 'all' && (
        <div className="flex items-center gap-2">
          <Filter className="size-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            Фильтр: {WRITEOFF_REASON_LABELS[reasonFilter]} ({filtered.length})
          </span>
          <button onClick={() => setReasonFilter('all')} className="text-xs text-primary hover:underline">Сбросить</button>
        </div>
      )}

      {/* Empty state */}
      {writeoffs.length === 0 && (
        <div className="bg-card rounded-xl border border-border p-12 text-center">
          <Trash2 className="size-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="font-medium text-foreground">Нет списаний</p>
          <p className="text-sm text-muted-foreground mt-1">Создайте первый акт списания</p>
        </div>
      )}

      {/* Writeoff list */}
      <div className="space-y-3">
        {filtered.map(wo => {
          const isExpanded = expanded === wo.id
          return (
            <div key={wo.id} className="bg-card rounded-xl border border-border overflow-hidden">
              <div
                onClick={() => setExpanded(isExpanded ? null : wo.id)}
                className="flex items-center justify-between px-4 py-3.5 hover:bg-muted/30 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${
                    wo.reason === 'spoilage' ? 'bg-red-100 text-red-600' :
                    wo.reason === 'breakage' ? 'bg-amber-100 text-amber-600' :
                    wo.reason === 'tasting' ? 'bg-blue-100 text-blue-600' :
                    wo.reason === 'expired' ? 'bg-orange-100 text-orange-600' :
                    'bg-muted text-muted-foreground'
                  }`}>
                    <Trash2 className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground text-sm">{WRITEOFF_REASON_LABELS[wo.reason]}</span>
                      <span className="text-xs text-muted-foreground">
                        {wo.lines.length} позиц{wo.lines.length === 1 ? 'ия' : wo.lines.length < 5 ? 'ии' : 'ий'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                      <span>{new Date(wo.createdAt).toLocaleDateString('ru')}</span>
                      <span>{new Date(wo.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</span>
                      {wo.createdByName && <span>· {wo.createdByName}</span>}
                    </div>
                    {wo.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{wo.description}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-sm font-bold text-destructive">{formatCurrency(wo.totalCost)}</span>
                  {isExpanded ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                </div>
              </div>

              {isExpanded && (
                <div className="px-4 pb-4 border-t border-border bg-muted/20">
                  <table className="w-full text-sm mt-3">
                    <thead>
                      <tr className="text-xs text-muted-foreground">
                        <th className="text-left pb-2 font-medium">Ингредиент</th>
                        <th className="text-right pb-2 font-medium">Кол-во</th>
                        <th className="text-right pb-2 font-medium">Стоимость</th>
                      </tr>
                    </thead>
                    <tbody>
                      {wo.lines.map((line, idx) => (
                        <tr key={idx} className="border-t border-border/50">
                          <td className="py-1.5 text-foreground">{line.name}</td>
                          <td className="py-1.5 text-right text-muted-foreground">{formatNum(line.qty)} {line.unit}</td>
                          <td className="py-1.5 text-right font-medium text-destructive">{formatCurrency(line.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border">
                        <td colSpan={2} className="pt-2 font-semibold text-foreground">Итого</td>
                        <td className="pt-2 text-right font-bold text-destructive">{formatCurrency(wo.totalCost)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <CreateWriteoffDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={reload}
      />
    </div>
  )
}
