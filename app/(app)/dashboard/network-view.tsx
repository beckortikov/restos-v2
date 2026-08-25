'use client'

import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell,
} from 'recharts'
import {
  fetchNetworkDashboard, fetchNetworkMonthlyRevenue, fetchNetworkDashboardDetail, fetchNetworkAccounts,
  type NetworkDashboard, type NetworkMonthlyRevenueRow, type NetworkDashboardDetail, type NetworkAccountRow,
} from '@/lib/queries/transfers'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { NotInNetwork, isNotInNetwork } from '@/components/network-empty'
import { KpiCard, AlertItem } from '@/components/dashboard/kpi-card'
import {
  Network, Store, Warehouse, TrendingUp, Wallet, Banknote, BarChart3, ArrowRight,
  CircleDot, Truck, CalendarClock, Users, ChefHat, CreditCard, Package,
} from 'lucide-react'

const ORDER_TYPE_LABELS: Record<string, string> = { hall: 'Зал', delivery: 'Доставка', takeaway: 'С собой' }
const PIE_COLORS = ['#e87c4f', '#4f9ee8', '#5cb85c', '#f0ad4e', '#d9534f', '#9b59b6']

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
  const [detail, setDetail] = useState<NetworkDashboardDetail | null>(null)
  const [accounts, setAccounts] = useState<NetworkAccountRow[]>([])
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
    // Тяжёлая item-level часть — отдельным запросом, не блокирует KPI/алерты
    // выше (см. головной комментарий DashboardDetail на бэке).
    fetchNetworkDashboardDetail({ from }).then(d => { if (alive) setDetail(d) }).catch(() => {})
    return () => { alive = false }
  }, [range])

  useEffect(() => {
    fetchNetworkMonthlyRevenue(6).then(setTrend).catch(() => setTrend([]))
    // Счета сети — остаток «сейчас», от периода не зависит, грузим один раз.
    fetchNetworkAccounts().then(r => setAccounts(r.accounts)).catch(() => setAccounts([]))
  }, [])

  // Автообновление раз в минуту — дашборд висит на экране в офисе.
  useEffect(() => {
    const t = setInterval(() => {
      const from = range === 'today' ? isoDaysAgo(0) : range === '7d' ? isoDaysAgo(6) : isoDaysAgo(29)
      fetchNetworkDashboard({ from }).then(setData).catch(() => {})
      fetchNetworkDashboardDetail({ from }).then(setDetail).catch(() => {})
    }, 60000)
    return () => clearInterval(t)
  }, [range])

  const trendChart = useMemo(
    () => trend.map(r => ({ month: monthLabel(r.month), Выручка: r.revenue, Прибыль: r.profit })),
    [trend],
  )

  const hourlyChart = useMemo(
    () => (detail?.hourlyRevenue ?? []).map(h => ({ hour: `${h.hour}:00`, revenue: h.revenue })),
    [detail],
  )
  const dishesDonut = useMemo(() => {
    const top = (detail?.topDishes ?? []).map(d => ({ name: d.name, value: d.revenue }))
    const topTotal = top.reduce((s, d) => s + d.value, 0)
    const grandTotal = data?.revenue ?? 0
    const rest = grandTotal - topTotal
    if (rest > 0.005) top.push({ name: 'Прочее', value: rest })
    return top
  }, [detail, data])
  const typesPie = useMemo(
    () => (detail?.ordersByType ?? []).map(t => ({ name: ORDER_TYPE_LABELS[t.type] ?? t.type, value: t.count })),
    [detail],
  )
  const paymentTotal = detail
    ? detail.paymentBreakdown.cash + detail.paymentBreakdown.card + detail.paymentBreakdown.transfer
    : 0
  const totalCashFromAccounts = useMemo(() => accounts.reduce((s, a) => s + a.balance, 0), [accounts])

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

      {/* Выручка по часам / Топ блюда (донат) / Заказы по типам — по всей сети */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground mb-3">Выручка по часам</h2>
          {hourlyChart.every(h => h.revenue === 0) ? (
            <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground">Нет продаж</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={hourlyChart}>
                <XAxis dataKey="hour" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} width={40} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Bar dataKey="revenue" fill="#e87c4f" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-card rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground mb-3">Топ блюда сети</h2>
          {dishesDonut.length === 0 ? (
            <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground">Нет продаж</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={dishesDonut} dataKey="value" nameKey="name" innerRadius={40} outerRadius={70} paddingAngle={2}>
                  {dishesDonut.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-card rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground mb-3">Заказы по типам</h2>
          {typesPie.length === 0 ? (
            <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground">Нет заказов</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={typesPie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name, value }) => `${name}: ${value}`}>
                  {typesPie.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
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

      {/* Способы оплаты / Счета / Топ блюда / Категории / Низкий остаток — по всей сети */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <div className="bg-card rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <CreditCard className="size-4 text-primary" />
            Способы оплаты сети
          </h2>
          <div className="space-y-2">
            {([
              { key: 'cash', label: 'Наличные', icon: Banknote, color: 'text-emerald-600 bg-emerald-500/10' },
              { key: 'card', label: 'Карта', icon: CreditCard, color: 'text-blue-600 bg-blue-500/10' },
              { key: 'transfer', label: 'Перевод', icon: ArrowRight, color: 'text-violet-600 bg-violet-500/10' },
            ] as const).map(({ key, label, icon: Icon, color }) => {
              const val = detail?.paymentBreakdown[key] ?? 0
              const pct = paymentTotal > 0 ? Math.round(val / paymentTotal * 100) : 0
              return (
                <div key={key} className="flex items-center gap-2.5">
                  <div className={`size-7 rounded-md flex items-center justify-center shrink-0 ${color}`}>
                    <Icon className="size-3.5" />
                  </div>
                  <span className="text-xs font-medium text-muted-foreground flex-1 min-w-0 truncate">{label}</span>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-foreground tabular-nums leading-none">{formatCurrency(val)}</p>
                    <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5">{pct}%</p>
                  </div>
                </div>
              )
            })}
            <div className="border-t border-border pt-2 mt-1 flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">Итого</span>
              <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(paymentTotal)}</span>
            </div>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Wallet className="size-4 text-muted-foreground" />
              Счета сети
            </h2>
            <Link to="/finance/accounts" className="text-[11px] text-primary hover:underline flex items-center gap-0.5">
              Все <ArrowRight className="size-3" />
            </Link>
          </div>
          <div className="space-y-2.5 max-h-[260px] overflow-y-auto">
            {accounts.map(acc => (
              <div key={acc.id} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className={`size-7 rounded-lg flex items-center justify-center text-[10px] font-bold shrink-0 ${acc.type === 'cash' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                    {acc.type === 'cash' ? '₸' : '🏦'}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm text-foreground truncate">{acc.name}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{acc.branchName}</p>
                  </div>
                </div>
                <span className="text-sm font-semibold shrink-0">{formatCurrency(acc.balance)}</span>
              </div>
            ))}
            {accounts.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">Нет счетов</p>}
          </div>
          <div className="border-t border-border pt-2 mt-2.5 flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground font-medium">Итого</span>
            <span className="text-base font-bold">{formatCurrency(totalCashFromAccounts)}</span>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground">🔥 Топ блюда сети</h2>
          </div>
          {(detail?.topDishes ?? []).length === 0 ? (
            <p className="text-muted-foreground text-xs text-center py-4">Нет продаж</p>
          ) : (
            <div className="space-y-2">
              {detail!.topDishes.map((d, i) => (
                <div key={d.name} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`size-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${i === 0 ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground'}`}>{i + 1}</span>
                    <span className="text-sm truncate">{d.name}</span>
                    <span className="text-[11px] text-muted-foreground shrink-0">x{d.qty}</span>
                  </div>
                  <span className="text-sm font-medium shrink-0">{formatCurrency(d.revenue)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-card rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
            <BarChart3 className="size-4 text-muted-foreground" />
            Категории сети
          </h2>
          {(detail?.categorySales ?? []).length === 0 ? (
            <p className="text-muted-foreground text-xs text-center py-4">Нет продаж</p>
          ) : (
            <div className="space-y-2.5">
              {(() => {
                const catTotal = detail!.categorySales.reduce((s, c) => s + c.revenue, 0)
                return detail!.categorySales.map(c => {
                  const pct = catTotal > 0 ? Math.round(c.revenue / catTotal * 100) : 0
                  return (
                    <div key={c.name}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm truncate min-w-0">{c.name}</span>
                        <span className="text-sm font-medium shrink-0 ml-2 tabular-nums">{formatCurrency(c.revenue)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })
              })()}
            </div>
          )}
        </div>

        <div className="bg-card rounded-xl border border-border p-4 md:col-span-2 xl:col-span-1">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Package className="size-4 text-muted-foreground" />
              Склад сети: низкий остаток
            </h2>
            <Link to="/warehouse/inventory" className="text-[11px] text-primary hover:underline flex items-center gap-0.5">
              Склад <ArrowRight className="size-3" />
            </Link>
          </div>
          {(detail?.lowStock ?? []).length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5">
              <CircleDot className="size-3.5" />
              Все в норме
            </div>
          ) : (
            <div className="space-y-2 max-h-[260px] overflow-y-auto">
              {detail!.lowStock.map((ing, i) => {
                const pct = ing.minQty > 0 ? Math.min((ing.qty / ing.minQty) * 100, 100) : 100
                return (
                  <div key={`${ing.branchName}:${ing.name}:${i}`}>
                    <div className="flex items-center justify-between mb-1 gap-2">
                      <span className="text-xs font-medium truncate">{ing.name} <span className="text-muted-foreground font-normal">· {ing.branchName}</span></span>
                      <span className="text-[11px] text-muted-foreground shrink-0">
                        <span className="text-destructive font-medium">{ing.qty}</span>/{ing.minQty} {ing.unit}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${pct < 50 ? 'bg-destructive' : 'bg-amber-400'}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
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
