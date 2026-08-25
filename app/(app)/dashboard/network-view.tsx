'use client'

import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import {
  fetchNetworkDashboard, fetchNetworkMonthlyRevenue,
  type NetworkDashboard, type NetworkMonthlyRevenueRow,
} from '@/lib/queries/transfers'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { NotInNetwork, isNotInNetwork } from '@/components/network-empty'
import { KpiCard, AlertItem } from '@/components/dashboard/kpi-card'
import {
  Network, Store, Warehouse, TrendingUp, Wallet, Banknote, BarChart3, ArrowRight,
  CircleDot, Truck, CalendarClock, Users, ChefHat,
} from 'lucide-react'

// Сетевой дашборд central (Ф-С1). Central — офис: продаж на нём нет, поэтому
// «Карта зала»/«Конвейер заказов» локального дашборда (живой статус стола/
// заказа — намеренно не реплицируется, см. isBranchView) заменены таблицей
// точек сети. Всё остальное — та же визуальная структура и те же компоненты
// (KpiCard/AlertItem), что у локального дашборда: KPI-плитки, «Требует
// внимания», график «Динамика выручки» — просто на сетевых данных вместо
// локальных. «Смотреть как филиал» (BranchSelector) возвращает обычный
// локальный дашборд выбранного филиала — эта вьюха там не рендерится.

type Range = 'today' | '7d' | '30d'

const RANGES: { key: Range; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
]

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
function monthLabel(key: string): string {
  const [y, m] = key.split('-')
  return `${MONTHS_SHORT[Number(m) - 1] ?? m} ${String(y).slice(2)}`
}

export function NetworkDashboardView() {
  const [data, setData] = useState<NetworkDashboard | null>(null)
  const [trend, setTrend] = useState<NetworkMonthlyRevenueRow[]>([])
  const [range, setRange] = useState<Range>('today')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notInNetwork, setNotInNetwork] = useState(false)

  useEffect(() => {
    const from = range === 'today' ? isoDaysAgo(0) : range === '7d' ? isoDaysAgo(6) : isoDaysAgo(29)
    let alive = true
    fetchNetworkDashboard({ from })
      .then(d => { if (alive) { setData(d); setError(null) } })
      .catch(e => {
        if (!alive) return
        if (isNotInNetwork(e)) setNotInNetwork(true)
        else setError(humanizeError(e))
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [range])

  useEffect(() => {
    fetchNetworkMonthlyRevenue(6).then(setTrend).catch(() => setTrend([]))
  }, [])

  // Автообновление раз в минуту — дашборд висит на экране в офисе.
  useEffect(() => {
    const t = setInterval(() => {
      const from = range === 'today' ? isoDaysAgo(0) : range === '7d' ? isoDaysAgo(6) : isoDaysAgo(29)
      fetchNetworkDashboard({ from }).then(setData).catch(() => {})
    }, 60000)
    return () => clearInterval(t)
  }, [range])

  const trendChart = useMemo(
    () => trend.map(r => ({ month: monthLabel(r.month), Выручка: r.revenue, Прибыль: r.profit })),
    [trend],
  )

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }
  if (notInNetwork) {
    return (
      <div className="p-4 md:p-6">
        <NotInNetwork what="сводный дашборд сети" />
      </div>
    )
  }

  const branches = data?.branches ?? []
  const outlets = branches.filter(b => b.kind !== 'central_warehouse')
  const hasAlerts = (data?.supplierDebtCount ?? 0) > 0 || (data?.duePaymentsCount ?? 0) > 0

  return (
    <div className="p-4 md:p-6 space-y-5">
      {/* Шапка */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Network className="size-5 text-primary" />
          <div>
            <h1 className="text-xl font-bold text-foreground">Дашборд сети</h1>
            <p className="text-xs text-muted-foreground">
              Все филиалы вместе · {data?.openShifts ?? 0} из {outlets.length} точек сейчас работают
            </p>
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

      {error && <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700">{error}</div>}

      {/* KPI сети — те же плитки, что на локальном дашборде */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2.5 md:gap-3">
        <KpiCard
          label={range === 'today' ? 'Выручка сети сегодня' : 'Выручка сети за период'}
          value={formatCurrency(data?.revenue ?? 0)}
          sub={`${data?.ordersCount ?? 0} закрытых заказов`}
          icon={TrendingUp}
          color="bg-emerald-500/10 text-emerald-600"
          href="/network/summary"
        />
        <KpiCard
          label="Точек в сети"
          value={String(outlets.length)}
          sub={`${data?.openShifts ?? 0} работают сейчас`}
          icon={Store}
          color="bg-primary/10 text-primary"
        />
        <KpiCard
          label="Средний чек по сети"
          value={formatCurrency(data?.avgCheck ?? 0)}
          icon={BarChart3}
          color="bg-violet-500/10 text-violet-600"
          href="/network/summary"
        />
        <KpiCard
          label="Касса сети (все счета)"
          value={formatCurrency(data?.totalCash ?? 0)}
          sub="все узлы"
          icon={Wallet}
          color="bg-blue-500/10 text-blue-600"
          href="/finance/accounts"
        />
        <KpiCard
          label={range === 'today' ? 'Расходы сети сегодня' : 'Расходы сети за период'}
          value={formatCurrency(data?.expenses ?? 0)}
          sub={`Чистый: ${formatCurrency((data?.revenue ?? 0) - (data?.expenses ?? 0))}`}
          icon={Banknote}
          color="bg-red-500/10 text-red-600"
          href="/finance/cashflow"
        />
      </div>

      {/* Требует внимания — по всей сети, независимо от периода */}
      {hasAlerts && (
        <div className="bg-card rounded-xl border border-amber-200/70 dark:border-amber-900/40 p-3.5 md:p-4">
          <h2 className="text-sm font-semibold text-foreground mb-2.5 flex items-center gap-2">
            <CircleDot className="size-4 text-amber-500" />
            Требует внимания
          </h2>
          <div className="flex flex-wrap gap-2">
            {(data?.supplierDebtCount ?? 0) > 0 && (
              <AlertItem
                icon={Truck}
                text={`Долг поставщикам по сети: ${formatCurrency(data!.supplierDebt)} (${data!.supplierDebtCount} накладных)`}
                severity="warn"
                href="/network/expenses"
              />
            )}
            {(data?.duePaymentsCount ?? 0) > 0 && (
              <AlertItem
                icon={CalendarClock}
                text={`${data!.duePaymentsCount} платеж${data!.duePaymentsCount > 1 ? 'ей' : ''} к оплате в ближайшие 7 дней: ${formatCurrency(data!.duePayments)}`}
                severity="warn"
                href="/network/expenses"
              />
            )}
          </div>
        </div>
      )}

      {/* Динамика выручки сети */}
      <div className="bg-card rounded-xl border border-border p-4 md:p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <BarChart3 className="size-4 text-muted-foreground" />
              Динамика выручки сети
            </h2>
            <p className="text-muted-foreground text-[11px] mt-0.5">За последние месяцы, вся сеть</p>
          </div>
          <Link to="/network/pnl" className="text-[11px] text-primary hover:underline flex items-center gap-0.5">
            Отчёты по сети <ArrowRight className="size-3" />
          </Link>
        </div>
        {trendChart.length === 0 ? (
          <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">Нет данных</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={trendChart} margin={{ top: 5, right: 5, bottom: 0, left: 10 }}>
              <defs>
                <linearGradient id="gNetRev" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gNetPro" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }} axisLine={false} tickLine={false} />
              <YAxis
                tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`}
              />
              <Tooltip
                contentStyle={{ backgroundColor: 'var(--color-card)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }}
                formatter={(val: number) => [formatCurrency(val), '']}
              />
              <Area type="monotone" dataKey="Выручка" stroke="var(--color-primary)" fill="url(#gNetRev)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="Прибыль" stroke="#10b981" fill="url(#gNetPro)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Точки сети — замена «Карты зала»/«Конвейера заказов»: те читают
          живой статус стола/заказа, который сеть намеренно не реплицирует. */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Store className="size-4 text-muted-foreground" /> Точки сети
          </h2>
          <Link to="/network/summary" className="text-[11px] text-primary hover:underline flex items-center gap-0.5">
            Подробнее <ArrowRight className="size-3" />
          </Link>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Точка</th>
              <th className="px-3 py-2 text-right font-medium">Выручка</th>
              <th className="px-3 py-2 text-right font-medium">Заказы</th>
              <th className="px-3 py-2 text-right font-medium">Деньги на счетах</th>
              <th className="px-3 py-2 text-right font-medium">Смена</th>
            </tr>
          </thead>
          <tbody>
            {branches.map(b => (
              <tr key={b.id} className="border-t border-border">
                <td className="px-3 py-2.5">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    {b.kind === 'central_warehouse'
                      ? <Warehouse className="size-4 text-amber-600" />
                      : <Store className="size-4 text-muted-foreground" />}
                    {b.name}
                    {b.kind === 'central_warehouse' && (
                      <span className="text-[10px] font-normal text-muted-foreground">(центр)</span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums font-medium">{formatCurrency(b.revenue)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{b.ordersCount}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(b.cashBalance)}</td>
                <td className="px-3 py-2.5 text-right">
                  {b.kind === 'central_warehouse' ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : b.openShift ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                      <span className="size-1.5 rounded-full bg-emerald-500" /> открыта
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">закрыта</span>
                  )}
                </td>
              </tr>
            ))}
            {branches.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">В сети пока нет филиалов</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Быстрые переходы */}
      <div className="grid sm:grid-cols-3 gap-2">
        <Link to="/network/staff" className="flex items-center justify-between rounded-xl border border-border p-3 text-sm hover:bg-muted/50 transition-colors">
          <span className="inline-flex items-center gap-2"><Users className="size-4 text-muted-foreground" /> Персонал сети</span>
          <ArrowRight className="size-4 text-muted-foreground" />
        </Link>
        <Link to="/network/expenses" className="flex items-center justify-between rounded-xl border border-border p-3 text-sm hover:bg-muted/50 transition-colors">
          <span className="inline-flex items-center gap-2"><Wallet className="size-4 text-muted-foreground" /> Расходы за филиалы</span>
          <ArrowRight className="size-4 text-muted-foreground" />
        </Link>
        <Link to="/warehouse/nomenclature" className="flex items-center justify-between rounded-xl border border-border p-3 text-sm hover:bg-muted/50 transition-colors">
          <span className="inline-flex items-center gap-2"><ChefHat className="size-4 text-muted-foreground" /> Сопоставление товаров</span>
          <ArrowRight className="size-4 text-muted-foreground" />
        </Link>
      </div>

      <p className="text-xs text-muted-foreground">
        Данные приходят от филиалов синхронизацией и могут отставать на минуту-другую.
      </p>
    </div>
  )
}
