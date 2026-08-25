'use client'

import { useState, useEffect, Fragment } from 'react'
import {
  fetchNetworkShifts, fetchNetworkShiftZReport,
  type NetworkShiftRow, type NetworkShiftsResult, type ShiftZReport,
} from '@/lib/queries/shifts'
import { fetchNetworkDashboard, type NetworkDashboardBranch } from '@/lib/queries/transfers'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { NotInNetwork, isNotInNetwork } from '@/components/network-empty'
import { KpiCard } from '@/components/dashboard/kpi-card'
import { ZReportBreakdown } from '@/components/shifts/z-report-breakdown'
import { Clock, Store, ChevronDown, ChevronRight, AlertTriangle, Banknote, ShoppingBag, CircleDot } from 'lucide-react'

// «Операции» на central скрыты целиком (Ф-С4) — карта зала/конвейер заказов
// читают живой статус, который сеть не реплицирует. Но cash_shifts — сводный
// список смен по сети возможен без всяких новых зависимостей (владелец,
// 2026-08-25: «дай возможность сводно смотреть все данные смены филиалов»).
// Разбор ОДНОЙ смены (клик по строке) — тот же ZReportBreakdown, что и на
// локальной странице /operations/shifts — NetworkService.ShiftZReport отдаёт
// байт-в-байт тот же формат, просто посчитанный с подменённым tenant.

type Range = 'today' | '7d' | '30d' | 'all'

const RANGES: { key: Range; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
  { key: 'all', label: 'Всё время' },
]

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function fmtDT(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function NetworkShiftsPage() {
  const [range, setRange] = useState<Range>('today')
  const [branchId, setBranchId] = useState('')
  const [status, setStatus] = useState<'' | 'open' | 'closed'>('')
  const [data, setData] = useState<NetworkShiftsResult | null>(null)
  const [branches, setBranches] = useState<NetworkDashboardBranch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notInNetwork, setNotInNetwork] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandedZ, setExpandedZ] = useState<ShiftZReport | null>(null)
  const [expandedZLoading, setExpandedZLoading] = useState(false)

  // Список точек сети — период-независимый, грузим один раз для фильтра.
  useEffect(() => {
    fetchNetworkDashboard({}).then(d => setBranches(d.branches ?? [])).catch(() => {})
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    const from = range === 'today' ? isoDaysAgo(0) : range === '7d' ? isoDaysAgo(6) : range === '30d' ? isoDaysAgo(29) : undefined
    fetchNetworkShifts({ from, branchId: branchId || undefined, status: status || undefined })
      .then(d => { if (alive) { setData(d); setError(null) } })
      .catch(e => {
        if (!alive) return
        if (isNotInNetwork(e)) setNotInNetwork(true)
        else setError(humanizeError(e))
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [range, branchId, status])

  const toggleExpand = (row: NetworkShiftRow) => {
    if (expandedId === row.id) { setExpandedId(null); return }
    setExpandedId(row.id)
    setExpandedZ(null)
    setExpandedZLoading(true)
    fetchNetworkShiftZReport(row.id)
      .then(setExpandedZ)
      .catch(() => setExpandedZ(null))
      .finally(() => setExpandedZLoading(false))
  }

  if (loading && !data) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }
  if (notInNetwork) {
    return (
      <div className="p-4 md:p-6">
        <NotInNetwork what="смены сети" />
      </div>
    )
  }

  const t = data?.totals
  const outlets = branches.filter(b => b.kind !== 'central_warehouse')
  const shifts = data?.shifts ?? []

  return (
    <div className="p-4 md:p-6 space-y-5">
      {/* Шапка */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Clock className="size-5 text-primary" />
          <div>
            <h1 className="text-xl font-bold text-foreground">Смены сети</h1>
            <p className="text-xs text-muted-foreground">Кассовые смены всех точек из одного места</p>
          </div>
        </div>
        <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg">
          {RANGES.map(r => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${range === r.key ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="text-sm text-destructive bg-destructive/10 rounded-lg p-3">{error}</div>}

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="Открыто сейчас"
          value={String(t?.openCount ?? 0)}
          sub={`из ${outlets.length} точек`}
          icon={CircleDot}
          color="bg-emerald-500/10 text-emerald-600"
        />
        <KpiCard
          label="Выручка за период"
          value={formatCurrency(t?.revenue ?? 0)}
          icon={Banknote}
          color="bg-primary/10 text-primary"
        />
        <KpiCard
          label="Заказов"
          value={String(t?.ordersCount ?? 0)}
          icon={ShoppingBag}
          color="bg-blue-500/10 text-blue-600"
        />
        <KpiCard
          label="Расхождения"
          value={String(t?.discrepancyCount ?? 0)}
          sub={(t?.discrepancyCount ?? 0) > 0 ? 'есть недостачи/излишки' : 'всё сходится'}
          icon={AlertTriangle}
          color={(t?.discrepancyCount ?? 0) > 0 ? 'bg-rose-500/10 text-rose-600' : 'bg-muted text-muted-foreground'}
        />
      </div>

      {/* Фильтры */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={branchId}
          onChange={e => setBranchId(e.target.value)}
          className="text-sm border border-border rounded-lg px-3 py-1.5 bg-card text-foreground"
        >
          <option value="">Все точки</option>
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select
          value={status}
          onChange={e => setStatus(e.target.value as '' | 'open' | 'closed')}
          className="text-sm border border-border rounded-lg px-3 py-1.5 bg-card text-foreground"
        >
          <option value="">Все статусы</option>
          <option value="open">Открытые</option>
          <option value="closed">Закрытые</option>
        </select>
      </div>

      {/* Таблица */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium w-6" />
                <th className="px-4 py-2.5 text-left font-medium">Точка</th>
                <th className="px-4 py-2.5 text-left font-medium">Кассир</th>
                <th className="px-4 py-2.5 text-left font-medium">Открыта</th>
                <th className="px-4 py-2.5 text-left font-medium">Закрыта</th>
                <th className="px-4 py-2.5 text-right font-medium">Выручка</th>
                <th className="px-4 py-2.5 text-right font-medium">Заказов</th>
                <th className="px-4 py-2.5 text-right font-medium">Расхождение</th>
                <th className="px-4 py-2.5 text-left font-medium">Статус</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shifts.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-muted-foreground text-sm">Смен за период не найдено</td></tr>
              ) : shifts.map(s => (
                <Fragment key={s.id}>
                  <tr onClick={() => toggleExpand(s)} className="hover:bg-muted/20 cursor-pointer transition-colors">
                    <td className="px-4 py-2.5">
                      {expandedId === s.id
                        ? <ChevronDown className="size-3.5 text-muted-foreground" />
                        : <ChevronRight className="size-3.5 text-muted-foreground" />}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1.5 text-foreground font-medium">
                        <Store className="size-3.5 text-muted-foreground shrink-0" />{s.restaurantName}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{s.openedByName}</td>
                    <td className="px-4 py-2.5 text-muted-foreground tabular-nums">{fmtDT(s.openedAt)}</td>
                    <td className="px-4 py-2.5 text-muted-foreground tabular-nums">{fmtDT(s.closedAt)}</td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums text-foreground">{formatCurrency(s.cashRevenue + s.cardRevenue)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{s.ordersCount}</td>
                    <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${s.discrepancy != null && s.discrepancy !== 0 ? 'text-rose-600' : 'text-muted-foreground'}`}>
                      {s.discrepancy != null ? formatCurrency(s.discrepancy) : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      {s.status === 'open' ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                          <span className="size-1.5 rounded-full bg-emerald-500" />открыта
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">закрыта</span>
                      )}
                    </td>
                  </tr>
                  {expandedId === s.id && (
                    <tr>
                      <td colSpan={9} className="px-4 py-3 bg-muted/10">
                        <ZReportBreakdown z={expandedZ} loading={expandedZLoading} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {shifts.length >= 300 && (
          <p className="px-4 py-2 text-[11px] text-muted-foreground border-t border-border">
            Показаны последние 300 смен — сузьте период или точку, чтобы увидеть более узкий срез.
          </p>
        )}
      </div>
    </div>
  )
}
