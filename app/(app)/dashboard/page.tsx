'use client'

import { useState, useEffect, useMemo } from 'react'
import { lazy, Suspense } from 'react'
import { Link } from 'react-router-dom'
import { formatCurrency, getTimeSince, calcLineCogs, calcLineTotal } from '@/lib/helpers'
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { useAuth } from '@/lib/auth-store'
import {
  ORDER_STATUS_LABELS,
  type Order,
  type FinancialAccount,
  type Ingredient,
  type FinancialOperation,
  type Table,
  type Zone,
  type Supplier,
  type User,
  type MenuItem,
} from '@/lib/types'
import {
  fetchOrders,
  fetchFinancialAccounts,
  fetchIngredients,
  fetchFinancialOperations,
  fetchTables,
  fetchZones,
  fetchSuppliers,
  fetchUsers,
  fetchMenuItems,
} from '@/lib/queries'
import {
  TrendingUp,
  TrendingDown,
  ShoppingBag,
  Wallet,
  AlertTriangle,
  Clock,
  ChefHat,
  Users as UsersIcon,
  MapPin,
  CreditCard,
  Package,
  ArrowRight,
  CircleDot,
  Timer,
  Receipt,
  BarChart3,
  Banknote,
  Truck,
} from 'lucide-react'

const RevenueChart = lazy(() => import('@/components/charts/revenue-chart'))

// ─── Helpers ──────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10)

const STATUS_COLORS: Record<string, string> = {
  free: 'bg-emerald-400',
  occupied: 'bg-primary',
  reserved: 'bg-blue-400',
  bill_requested: 'bg-amber-400',
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────
function KpiCard({
  label, value, sub, icon: Icon, color = 'primary', href,
}: {
  label: string; value: string; sub?: string
  icon: React.ElementType; color?: string; href?: string
}) {
  // ВАЖНО: используем react-router-dom <Link>, а не <a href>. В Electron
  // file:// нативный <a> уходит в browser navigation (file:///finance/...)
  // и показывает белый экран. Link делает SPA-навигацию через HashRouter.
  const cls = `bg-card rounded-xl border border-border p-4 md:p-5 ${href ? 'hover:border-primary/40 transition-colors cursor-pointer block' : ''}`
  const inner = (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide truncate">{label}</p>
        <p className="text-xl md:text-2xl font-bold text-foreground mt-1 leading-none">{value}</p>
        {sub && <p className="text-muted-foreground text-[11px] mt-1.5 truncate">{sub}</p>}
      </div>
      <div className={`size-9 md:size-10 rounded-lg flex items-center justify-center shrink-0 ${color}`}>
        <Icon className="size-4 md:size-5" />
      </div>
    </div>
  )
  return href ? <Link to={href} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>
}

// ─── Alert Item ──────────────────────────────────────────────────────────────
function AlertItem({ icon: Icon, text, severity = 'warn', href }: { icon: React.ElementType; text: string; severity?: 'warn' | 'error' | 'info'; href?: string }) {
  const colors = {
    warn: 'text-amber-600 bg-amber-50 border-amber-200',
    error: 'text-red-600 bg-red-50 border-red-200',
    info: 'text-blue-600 bg-blue-50 border-blue-200',
  }
  const cls = `flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-sm ${colors[severity]} ${href ? 'hover:opacity-80 transition-opacity' : ''}`
  const inner = (<>
    <Icon className="size-4 shrink-0" />
    <span className="truncate">{text}</span>
  </>)
  return href ? <Link to={href} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>
}

// ─── Mini Table Map ──────────────────────────────────────────────────────────
function MiniTableMap({ tables, zones }: { tables: Table[]; zones: Zone[] }) {
  const statusCount = {
    free: tables.filter(t => t.status === 'free').length,
    occupied: tables.filter(t => t.status === 'occupied').length,
    reserved: tables.filter(t => t.status === 'reserved').length,
    bill_requested: tables.filter(t => t.status === 'bill_requested').length,
  }
  const statusLabels: Record<string, string> = { free: 'Свободно', occupied: 'Занято', reserved: 'Бронь', bill_requested: 'Счёт' }

  return (
    <div className="space-y-4">
      {/* Status summary */}
      <div className="flex flex-wrap gap-3">
        {Object.entries(statusCount).map(([status, count]) => (
          <div key={status} className="flex items-center gap-1.5 text-xs">
            <span className={`size-2.5 rounded-full ${STATUS_COLORS[status]}`} />
            <span className="text-muted-foreground">{statusLabels[status]}</span>
            <span className="font-semibold text-foreground">{count}</span>
          </div>
        ))}
      </div>
      {/* Mini grid */}
      <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-1.5">
        {tables.map(t => (
          <div key={t.id} className={`rounded-lg px-2 py-1.5 text-center text-[11px] font-medium border ${
            t.status === 'free' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
            t.status === 'occupied' ? 'bg-primary/10 border-primary/30 text-primary' :
            t.status === 'reserved' ? 'bg-blue-50 border-blue-200 text-blue-700' :
            'bg-amber-50 border-amber-200 text-amber-700'
          }`}>
            {t.name}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Order Pipeline ──────────────────────────────────────────────────────────
function OrderPipeline({ orders }: { orders: Order[] }) {
  const active = orders.filter(o => o.status !== 'done')
  const stages = [
    { key: 'new', label: 'Новые', color: 'bg-blue-500', count: active.filter(o => o.status === 'new').length },
    { key: 'cooking', label: 'Готовятся', color: 'bg-amber-500', count: active.filter(o => o.status === 'cooking').length },
    { key: 'ready', label: 'К выдаче', color: 'bg-emerald-500', count: active.filter(o => o.status === 'ready').length },
    { key: 'served', label: 'Подано', color: 'bg-teal-500', count: active.filter(o => o.status === 'served').length },
  ]
  const total = stages.reduce((s, st) => s + st.count, 0)

  return (
    <div className="space-y-3">
      {/* Pipeline bar */}
      <div className="flex h-8 rounded-lg overflow-hidden bg-muted/30">
        {stages.map(st => (
          st.count > 0 && (
            <div key={st.key} className={`${st.color} flex items-center justify-center text-white text-xs font-bold transition-all`} style={{ width: total > 0 ? `${(st.count / total) * 100}%` : '0%' }}>
              {st.count}
            </div>
          )
        ))}
        {total === 0 && <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Нет активных</div>}
      </div>
      {/* Legend */}
      <div className="flex justify-between">
        {stages.map(st => (
          <div key={st.key} className="flex items-center gap-1.5 text-xs">
            <span className={`size-2 rounded-full ${st.color}`} />
            <span className="text-muted-foreground">{st.label}</span>
            <span className="font-bold text-foreground">{st.count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Dashboard Page ───────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { user } = useAuth()
  const [orders, setOrders] = useState<Order[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [operations, setOperations] = useState<FinancialOperation[]>([])
  const [tables, setTables] = useState<Table[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetchOrders(), fetchFinancialAccounts(), fetchIngredients(),
      fetchFinancialOperations(), fetchTables(), fetchZones(),
      fetchSuppliers(), fetchUsers(), fetchMenuItems(),
    ]).then(([o, fa, ing, fo, t, z, s, u, mi]) => {
      setOrders(o); setAccounts(fa); setIngredients(ing)
      setOperations(fo); setTables(t); setZones(z)
      setSuppliers(s); setUsers(u); setMenuItems(mi)
    }).finally(() => setLoading(false))
  }, [])

  // Auto-refresh every 30s
  useEffect(() => {
    if (loading) return
    const interval = setInterval(() => {
      Promise.all([fetchOrders(), fetchTables(), fetchFinancialAccounts(), fetchFinancialOperations()])
        .then(([o, t, fa, fo]) => {
          setOrders(o); setTables(t); setAccounts(fa); setOperations(fo)
        })
    }, 30000)
    return () => clearInterval(interval)
  }, [loading])

  // ─── Calculations (must be before any early return for hooks) ──────────────
  const todayStr = today()

  // Revenue
  const todayOrders = useMemo(() => orders.filter(o => o.status === 'done' && o.closedAt?.startsWith(todayStr)), [orders, todayStr])
  const todayRevenue = useMemo(() => todayOrders.reduce((s, o) => s + o.total, 0), [todayOrders])
  const todayOrdersCount = useMemo(() => orders.filter(o => o.createdAt?.startsWith(todayStr)).length, [orders, todayStr])
  const avgCheck = todayOrders.length > 0 ? todayRevenue / todayOrders.length : 0

  // COGS & margin
  const todayCogs = useMemo(() => todayOrders.reduce((s, o) => s + o.items.reduce((is, i) => is + calcLineCogs(i.cogs || 0, i.qty, i.unit, i.unitSize), 0), 0), [todayOrders])
  const grossMargin = todayRevenue > 0 ? ((todayRevenue - todayCogs) / todayRevenue * 100) : 0

  // Cash
  const totalCash = useMemo(() => accounts.reduce((s, a) => s + a.balance, 0), [accounts])

  // Alerts
  const lowStock = useMemo(() => ingredients.filter(i => i.qty < i.minQty), [ingredients])
  const longCooking = useMemo(() => orders.filter(o => {
    if (o.status !== 'cooking') return false
    const mins = (Date.now() - new Date(o.createdAt).getTime()) / 60000
    return mins > 30
  }), [orders])
  const overdueSuppliers = useMemo(() => suppliers.filter(s => s.currentDebt > 0), [suppliers])
  const billRequested = useMemo(() => tables.filter(t => t.status === 'bill_requested'), [tables])

  // Active orders
  const activeOrders = useMemo(() => orders.filter(o => o.status !== 'done'), [orders])

  // Today's expenses
  const todayExpenses = useMemo(() => operations
    .filter(o => o.type === 'out' && o.date === todayStr)
    .reduce((s, o) => s + o.amount, 0), [operations, todayStr])

  // Top dishes today
  const topDishes = useMemo(() => {
    const dishSales: Record<string, { name: string; qty: number; revenue: number }> = {}
    todayOrders.forEach(o => o.items.forEach(i => {
      if (!dishSales[i.name]) dishSales[i.name] = { name: i.name, qty: 0, revenue: 0 }
      dishSales[i.name].qty += i.unit && i.unit !== 'piece' ? i.qty / (i.unitSize && i.unitSize > 0 ? i.unitSize : 1) : i.qty
      dishSales[i.name].revenue += calcLineTotal(i.price, i.qty, i.unit, i.unitSize)
    }))
    return Object.values(dishSales).sort((a, b) => b.revenue - a.revenue).slice(0, 5)
  }, [todayOrders])

  // Hourly revenue (chart 1)
  const hourlyRevenue = useMemo(() => {
    const buckets: Record<number, number> = {}
    for (let h = 10; h <= 22; h++) buckets[h] = 0
    todayOrders.forEach(o => {
      const h = new Date(o.createdAt).getHours()
      if (h >= 10 && h <= 22) buckets[h] += o.total
    })
    return Object.entries(buckets).map(([h, rev]) => ({ hour: `${h}:00`, revenue: rev }))
  }, [todayOrders])

  // Top dishes donut (chart 2) — reuse topDishes, add "Прочее"
  const donutData = useMemo(() => {
    const top5 = topDishes.map(d => ({ name: d.name, value: d.revenue }))
    const top5Total = top5.reduce((s, d) => s + d.value, 0)
    const allTotal = todayOrders.reduce((s, o) => s + o.total, 0)
    const rest = allTotal - top5Total
    if (rest > 0) top5.push({ name: 'Прочее', value: rest })
    return top5
  }, [topDishes, todayOrders])
  const DONUT_COLORS = ['#e87c4f', '#4f9ee8', '#5cb85c', '#f0ad4e', '#d9534f', '#9b59b6']

  // Orders by type (chart 3)
  const ordersByType = useMemo(() => {
    const todayAll = orders.filter(o => o.createdAt?.startsWith(todayStr))
    const labels: Record<string, string> = { hall: 'Зал', delivery: 'Доставка', takeaway: 'Самовывоз' }
    const counts: Record<string, number> = { hall: 0, delivery: 0, takeaway: 0 }
    todayAll.forEach(o => { if (counts[o.type] !== undefined) counts[o.type]++ })
    return Object.entries(counts).filter(([, v]) => v > 0).map(([k, v]) => ({ name: labels[k], value: v }))
  }, [orders, todayStr])
  const TYPE_COLORS = ['#e87c4f', '#4f9ee8', '#5cb85c']

  // Waiter performance today
  const waiterStats: Record<string, { name: string; orders: number; revenue: number }> = {}
  todayOrders.forEach(o => {
    if (!o.waiterId) return
    const w = users.find(u => u.id === o.waiterId)
    if (!w) return
    if (!waiterStats[o.waiterId]) waiterStats[o.waiterId] = { name: w.name, orders: 0, revenue: 0 }
    waiterStats[o.waiterId].orders++
    waiterStats[o.waiterId].revenue += o.total
  })
  const topWaiters = Object.values(waiterStats).sort((a, b) => b.revenue - a.revenue).slice(0, 5)

  // Recent operations
  const recentOps = operations.slice(0, 6)

  // Current date display
  const dateStr = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' })

  if (loading) return (
    <div className="p-6 flex items-center justify-center h-64">
      <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-foreground">Дашборд</h1>
          <p className="text-muted-foreground text-sm mt-0.5 capitalize">{dateStr}</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CircleDot className="size-3 text-emerald-500 animate-pulse" />
          Реальное время · обновление 30 сек
        </div>
      </div>

      {/* ═══ KPI Row ═══ */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2.5 md:gap-3">
        <KpiCard
          label="Выручка сегодня"
          value={formatCurrency(todayRevenue)}
          sub={`${todayOrders.length} закрытых заказов`}
          icon={TrendingUp}
          color="bg-emerald-500/10 text-emerald-600"
          href="/finance/cashflow"
        />
        <KpiCard
          label="Заказов сегодня"
          value={String(todayOrdersCount)}
          sub={`${activeOrders.length} активных сейчас`}
          icon={ShoppingBag}
          color="bg-primary/10 text-primary"
          href="/operations/orders"
        />
        <KpiCard
          label="Средний чек"
          value={formatCurrency(avgCheck)}
          sub={`Маржа ${(grossMargin || 0).toFixed(0)}%`}
          icon={Receipt}
          color="bg-violet-500/10 text-violet-600"
          href="/finance/pnl"
        />
        <KpiCard
          label="Касса (все счета)"
          value={formatCurrency(totalCash)}
          sub={accounts.map(a => a.name).join(' · ')}
          icon={Wallet}
          color="bg-blue-500/10 text-blue-600"
          href="/finance/accounts"
        />
        <KpiCard
          label="Расходы сегодня"
          value={formatCurrency(todayExpenses)}
          sub={`Чистый: ${formatCurrency(todayRevenue - todayExpenses)}`}
          icon={Banknote}
          color="bg-red-500/10 text-red-600"
          href="/finance/cashflow"
        />
      </div>

      {/* ═══ Alerts ═══ */}
      {(lowStock.length > 0 || longCooking.length > 0 || overdueSuppliers.length > 0 || billRequested.length > 0) && (
        <div className="bg-card rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber-500" />
            Требует внимания
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {lowStock.length > 0 && (
              <AlertItem
                icon={Package}
                text={`${lowStock.length} ингредиент${lowStock.length > 1 ? 'ов' : ''} ниже минимума: ${lowStock.slice(0, 3).map(i => i.name).join(', ')}`}
                severity="warn"
                href="/warehouse/inventory"
              />
            )}
            {longCooking.length > 0 && (
              <AlertItem
                icon={Timer}
                text={`${longCooking.length} заказ${longCooking.length > 1 ? 'ов' : ''} готовятся > 30 мин`}
                severity="error"
                href="/operations/kitchen"
              />
            )}
            {overdueSuppliers.length > 0 && (
              <AlertItem
                icon={Truck}
                text={`Долг поставщикам: ${formatCurrency(overdueSuppliers.reduce((s, sup) => s + sup.currentDebt, 0))}`}
                severity="warn"
                href="/warehouse/suppliers"
              />
            )}
            {billRequested.length > 0 && (
              <AlertItem
                icon={CreditCard}
                text={`${billRequested.length} стол${billRequested.length > 1 ? 'ов' : ''} ждут оплату`}
                severity="info"
                href="/operations/table-map"
              />
            )}
          </div>
        </div>
      )}

      {/* ═══ Operations (real-time) + Finance ═══ */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* LEFT: Operations overview */}
        <div className="xl:col-span-2 space-y-4">
          {/* Table map + Order pipeline */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Mini table map */}
            <div className="bg-card rounded-xl border border-border p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <MapPin className="size-4 text-muted-foreground" />
                  Карта зала
                </h2>
                <Link to="/operations/table-map" className="text-[11px] text-primary hover:underline flex items-center gap-0.5">
                  Открыть <ArrowRight className="size-3" />
                </Link>
              </div>
              <MiniTableMap tables={tables} zones={zones} />
            </div>

            {/* Order pipeline */}
            <div className="bg-card rounded-xl border border-border p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <ChefHat className="size-4 text-muted-foreground" />
                  Конвейер заказов
                </h2>
                <Link to="/operations/kitchen" className="text-[11px] text-primary hover:underline flex items-center gap-0.5">
                  Кухня <ArrowRight className="size-3" />
                </Link>
              </div>
              <OrderPipeline orders={orders} />

              {/* Latest active orders */}
              <div className="mt-4 space-y-1.5">
                {activeOrders.slice(0, 4).map(o => {
                  const table = o.tableId ? tables.find(t => t.id === o.tableId) : null
                  return (
                    <div key={o.id} className="flex items-center justify-between py-1.5 text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          o.status === 'new' ? 'bg-blue-100 text-blue-700' :
                          o.status === 'cooking' ? 'bg-amber-100 text-amber-700' :
                          'bg-emerald-100 text-emerald-700'
                        }`}>
                          {ORDER_STATUS_LABELS[o.status]}
                        </span>
                        <span className="text-foreground font-medium truncate">
                          {table?.name || (o.type === 'delivery' ? 'Доставка' : 'Самовывоз')}
                        </span>
                        <span className="text-muted-foreground">{o.items.length} поз.</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-medium text-foreground">{formatCurrency(o.total)}</span>
                        <span className="text-muted-foreground flex items-center gap-0.5">
                          <Clock className="size-3" />{getTimeSince(o.createdAt)}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Revenue chart */}
          <div className="bg-card rounded-xl border border-border p-4 md:p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <BarChart3 className="size-4 text-muted-foreground" />
                  Динамика выручки
                </h2>
                <p className="text-muted-foreground text-[11px] mt-0.5">За последние месяцы</p>
              </div>
              <Link to="/finance/pnl" className="text-[11px] text-primary hover:underline flex items-center gap-0.5">
                ОПиУ <ArrowRight className="size-3" />
              </Link>
            </div>
            <RevenueChart />
          </div>

          {/* ═══ Charts row: hourly revenue, top dishes donut, orders by type ═══ */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Выручка по часам */}
            <div className="bg-card rounded-xl border border-border p-4">
              <h2 className="text-sm font-semibold text-foreground mb-3">Выручка по часам</h2>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={hourlyRevenue}>
                  <XAxis dataKey="hour" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} width={40} />
                  <Tooltip formatter={(v: number) => formatCurrency(v)} />
                  <Bar dataKey="revenue" fill="#e87c4f" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Топ блюда (donut) */}
            <div className="bg-card rounded-xl border border-border p-4">
              <h2 className="text-sm font-semibold text-foreground mb-3">Топ блюда</h2>
              {donutData.length === 0 ? (
                <p className="text-muted-foreground text-xs text-center py-16">Нет продаж</p>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={donutData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={2}
                    >
                      {donutData.map((_, i) => (
                        <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v: number) => formatCurrency(v)} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Заказы по типам (pie) */}
            <div className="bg-card rounded-xl border border-border p-4">
              <h2 className="text-sm font-semibold text-foreground mb-3">Заказы по типам</h2>
              {ordersByType.length === 0 ? (
                <p className="text-muted-foreground text-xs text-center py-16">Нет заказов</p>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={ordersByType}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      label={({ name, value }) => `${name}: ${value}`}
                    >
                      {ordersByType.map((_, i) => (
                        <Cell key={i} fill={TYPE_COLORS[i % TYPE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT: Finance sidebar */}
        <div className="space-y-4">
          {/* Accounts */}
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Wallet className="size-4 text-muted-foreground" />
                Счета
              </h2>
              <Link to="/finance/accounts" className="text-[11px] text-primary hover:underline flex items-center gap-0.5">
                Все <ArrowRight className="size-3" />
              </Link>
            </div>
            <div className="space-y-2.5">
              {accounts.map(acc => (
                <div key={acc.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`size-7 rounded-lg flex items-center justify-center text-[10px] font-bold ${acc.type === 'cash' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                      {acc.type === 'cash' ? '₸' : '🏦'}
                    </div>
                    <span className="text-sm text-foreground">{acc.name}</span>
                  </div>
                  <span className="text-sm font-semibold">{formatCurrency(acc.balance)}</span>
                </div>
              ))}
              <div className="border-t border-border pt-2 flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground font-medium">Итого</span>
                <span className="text-base font-bold">{formatCurrency(totalCash)}</span>
              </div>
            </div>
          </div>

          {/* Top dishes today */}
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">🔥 Топ блюда сегодня</h2>
              <Link to="/analytics/abc-menu" className="text-[11px] text-primary hover:underline flex items-center gap-0.5">
                ABC <ArrowRight className="size-3" />
              </Link>
            </div>
            {topDishes.length === 0 ? (
              <p className="text-muted-foreground text-xs text-center py-4">Нет продаж сегодня</p>
            ) : (
              <div className="space-y-2">
                {topDishes.map((d, i) => (
                  <div key={d.name} className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`size-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                        i === 0 ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground'
                      }`}>{i + 1}</span>
                      <span className="text-sm truncate">{d.name}</span>
                      <span className="text-[11px] text-muted-foreground shrink-0">x{d.qty}</span>
                    </div>
                    <span className="text-sm font-medium shrink-0 ml-2">{formatCurrency(d.revenue)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Waiter ranking */}
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <UsersIcon className="size-4 text-muted-foreground" />
                Официанты сегодня
              </h2>
            </div>
            {topWaiters.length === 0 ? (
              <p className="text-muted-foreground text-xs text-center py-4">Нет данных</p>
            ) : (
              <div className="space-y-2.5">
                {topWaiters.map((w, i) => (
                  <div key={w.name} className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`size-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                        i === 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'
                      }`}>{i + 1}</span>
                      <span className="text-sm truncate">{w.name}</span>
                    </div>
                    <div className="text-right shrink-0 ml-2">
                      <p className="text-sm font-medium">{formatCurrency(w.revenue)}</p>
                      <p className="text-[10px] text-muted-foreground">{w.orders} заказ.</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Low stock */}
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Package className="size-4 text-muted-foreground" />
                Склад: низкий остаток
              </h2>
              <Link to="/warehouse/inventory" className="text-[11px] text-primary hover:underline flex items-center gap-0.5">
                Склад <ArrowRight className="size-3" />
              </Link>
            </div>
            {lowStock.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5">
                <CircleDot className="size-3.5" />
                Все в норме
              </div>
            ) : (
              <div className="space-y-2">
                {lowStock.map(ing => {
                  const pct = ing.minQty > 0 ? Math.min((ing.qty / ing.minQty) * 100, 100) : 100
                  return (
                    <div key={ing.id}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium">{ing.name}</span>
                        <span className="text-[11px] text-muted-foreground">
                          <span className="text-destructive font-medium">{ing.qty}</span>
                          /{ing.minQty} {ing.unit}
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

          {/* Recent operations */}
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">Последние операции</h2>
              <Link to="/finance/cashflow" className="text-[11px] text-primary hover:underline flex items-center gap-0.5">
                ДДС <ArrowRight className="size-3" />
              </Link>
            </div>
            <div className="space-y-2">
              {recentOps.map(op => (
                <div key={op.id} className="flex items-center justify-between py-0.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`size-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                      op.type === 'in' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                    }`}>
                      {op.type === 'in' ? '+' : '−'}
                    </span>
                    <span className="text-xs truncate text-foreground">{op.description || op.category}</span>
                  </div>
                  <span className={`text-xs font-medium shrink-0 ml-2 ${op.type === 'in' ? 'text-emerald-600' : 'text-destructive'}`}>
                    {op.type === 'in' ? '+' : '−'}{formatCurrency(op.amount)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
