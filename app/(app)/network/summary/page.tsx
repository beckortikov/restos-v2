'use client'

import { useState, useEffect, useMemo } from 'react'
import { fetchNetworkSummary, type NetworkSummary } from '@/lib/queries/transfers'
import { formatCurrency } from '@/lib/helpers'
import { Network, Store, Warehouse, TrendingUp } from 'lucide-react'

type Period = 'today' | 'week' | 'month' | 'all'

const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'week', label: 'Неделя' },
  { key: 'month', label: 'Месяц' },
  { key: 'all', label: 'Всё' },
]

function periodRange(p: Period): { from?: string } {
  const now = new Date()
  if (p === 'all') return {}
  const d = new Date(now)
  if (p === 'today') d.setHours(0, 0, 0, 0)
  else if (p === 'week') { d.setDate(d.getDate() - 7) }
  else if (p === 'month') { d.setMonth(d.getMonth() - 1) }
  return { from: d.toISOString() }
}

export default function NetworkSummaryPage() {
  const [period, setPeriod] = useState<Period>('month')
  const [summary, setSummary] = useState<NetworkSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchNetworkSummary(periodRange(period))
      .then(s => setSummary(s))
      .catch(e => setError(e?.message ?? 'Не удалось загрузить сводку'))
      .finally(() => setLoading(false))
  }, [period])

  const branches = useMemo(
    () => (summary?.branches ?? []).slice().sort((a, b) => b.revenue - a.revenue),
    [summary],
  )
  const total = summary?.totalRevenue ?? 0

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-3xl">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Network className="size-5 text-primary" />
          <h1 className="text-xl font-bold text-foreground">Сводка по сети</h1>
        </div>
        <div className="flex rounded-lg border border-border p-0.5 text-sm">
          {PERIODS.map(p => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`rounded-md px-2.5 py-1 ${period === p.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700">{error}</div>
      ) : (
        <>
          {/* Итог по сети */}
          <div className="rounded-xl border border-border bg-emerald-500/5 p-4">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <TrendingUp className="size-4 text-emerald-600" /> Выручка сети
            </div>
            <div className="mt-1 text-3xl font-bold text-foreground">{formatCurrency(total)}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{branches.length} филиалов</div>
          </div>

          {/* По филиалам */}
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Филиал</th>
                  <th className="px-3 py-2 text-right font-medium">Выручка</th>
                  <th className="px-3 py-2 text-right font-medium">Доля</th>
                </tr>
              </thead>
              <tbody>
                {branches.map(b => (
                  <tr key={b.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        {b.kind === 'central_warehouse'
                          ? <Warehouse className="size-4 text-amber-600" />
                          : <Store className="size-4 text-muted-foreground" />}
                        {b.name}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-medium">{formatCurrency(b.revenue)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {total > 0 ? Math.round((b.revenue / total) * 100) : 0}%
                    </td>
                  </tr>
                ))}
                {branches.length === 0 && (
                  <tr><td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">Нет данных по сети</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
