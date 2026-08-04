'use client'

import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  fetchNetworkSummary, fetchNetworkPnL, fetchNetworkCashflow, fetchNetworkWarehouse, fetchNetworkAccounts,
  type NetworkSummary, type NetworkPnL, type NetworkCashflow, type NetworkWarehouse, type NetworkAccounts,
} from '@/lib/queries/transfers'
import { formatCurrency } from '@/lib/helpers'
import { Network, Store, Warehouse, TrendingUp, ArrowRight, Wallet } from 'lucide-react'
import { NotInNetwork, isNotInNetwork } from '@/components/network-empty'
import { useAuth } from '@/lib/auth-store'
import { BRANCH_VIEW_KEY } from '@/hooks/use-branch-view'

type Period = 'today' | 'week' | 'month' | 'all'
type Tab = 'revenue' | 'pnl' | 'cashflow' | 'warehouse' | 'accounts'

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

// hasPeriod — ДДС/ОПиУ/Выручка считаются за диапазон дат; Склад и Счета —
// снимок текущего состояния (остаток на складе, баланс счёта прямо сейчас),
// периода не имеют.
const TABS: { key: Tab; label: string; hasPeriod: boolean }[] = [
  { key: 'revenue', label: 'Выручка', hasPeriod: true },
  { key: 'pnl', label: 'ОПиУ', hasPeriod: true },
  { key: 'cashflow', label: 'ДДС', hasPeriod: true },
  { key: 'warehouse', label: 'Склад', hasPeriod: false },
  { key: 'accounts', label: 'Счета', hasPeriod: false },
]

// ─── Общая таблица «по филиалам» — заголовок/строка/drill-down одинаковы во
// всех 5 вкладках, различаются только колонки-метрики. ───────────────────────
interface BranchRow {
  id: string
  name: string
  kind?: 'outlet' | 'central_warehouse' | null
}
interface BranchCol<T> {
  label: string
  render: (row: T) => React.ReactNode
}
function BranchTable<T extends BranchRow>({
  rows, columns, canDrillDown, myRestaurantId, onRowClick,
}: {
  rows: T[]
  columns: BranchCol<T>[]
  canDrillDown: boolean
  myRestaurantId: string | null | undefined
  onRowClick: (id: string) => void
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Филиал</th>
            {columns.map(c => (
              <th key={c.label} className="px-3 py-2 text-right font-medium">{c.label}</th>
            ))}
            {canDrillDown && <th className="w-8 px-3 py-2" aria-hidden />}
          </tr>
        </thead>
        <tbody>
          {rows.map(b => (
            <tr
              key={b.id}
              onClick={canDrillDown ? () => onRowClick(b.id) : undefined}
              className={`border-t border-border ${canDrillDown ? 'cursor-pointer hover:bg-muted/40 transition-colors' : ''}`}
              title={canDrillDown ? `Открыть отчёты филиала «${b.name}»` : undefined}
            >
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-1.5">
                  {b.kind === 'central_warehouse'
                    ? <Warehouse className="size-4 text-amber-600" />
                    : <Store className="size-4 text-muted-foreground" />}
                  {b.name}
                  {b.id === myRestaurantId && <span className="text-muted-foreground">(мой)</span>}
                </span>
              </td>
              {columns.map(c => (
                <td key={c.label} className="px-3 py-2 text-right">{c.render(b)}</td>
              ))}
              {canDrillDown && (
                <td className="px-3 py-2 text-muted-foreground">
                  <ArrowRight className="size-3.5" />
                </td>
              )}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={columns.length + 1 + (canDrillDown ? 1 : 0)} className="px-3 py-6 text-center text-muted-foreground">Нет данных по сети</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

interface AccountsBranchRow extends BranchRow {
  balance: number
  accountsCount: number
}

export default function NetworkSummaryPage() {
  const navigate = useNavigate()
  const { restaurantId, restaurant, canAccessRoles } = useAuth()
  // Drill-down («смотреть как этот филиал») требует того же гейта, что и сам
  // BranchSelector (components/branch-selector.tsx) — переключение реально
  // работает только с central_warehouse, филиалу оно ломает лицензионный
  // экран (см. branch-view-central-only). Некликабельно вне central — не
  // обещаем действие, которое ничего не сделает.
  const canDrillDown = canAccessRoles(['owner']) && restaurant?.kind === 'central_warehouse'

  const [tab, setTab] = useState<Tab>('revenue')
  const [period, setPeriod] = useState<Period>('month')
  const hasPeriod = TABS.find(t => t.key === tab)?.hasPeriod ?? false

  const [summary, setSummary] = useState<NetworkSummary | null>(null)
  const [pnl, setPnl] = useState<NetworkPnL | null>(null)
  const [cashflow, setCashflow] = useState<NetworkCashflow | null>(null)
  const [warehouse, setWarehouse] = useState<NetworkWarehouse | null>(null)
  const [accounts, setAccounts] = useState<NetworkAccounts | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notInNetwork, setNotInNetwork] = useState(false)

  const drillInto = (branchId: string) => {
    if (!canDrillDown) return
    if (branchId === restaurantId) localStorage.removeItem(BRANCH_VIEW_KEY)
    else localStorage.setItem(BRANCH_VIEW_KEY, branchId)
    // navigate() синхронно обновляет location (Hash- и BrowserRouter — оба
    // через History API) ДО возврата из вызова, поэтому reload сразу следом
    // подхватывает уже новый путь. Полный reload, а не точечная инвалидация
    // — тем же способом, что и сам BranchSelector.onChange, чтобы его
    // дропдаун в шапке тоже перечитал localStorage и показал верный филиал.
    navigate('/dashboard')
    window.location.reload()
  }

  useEffect(() => {
    setLoading(true)
    setError(null)
    setNotInNetwork(false)
    const range = periodRange(period)
    const req =
      tab === 'revenue' ? fetchNetworkSummary(range).then(setSummary) :
      tab === 'pnl' ? fetchNetworkPnL(range).then(setPnl) :
      tab === 'cashflow' ? fetchNetworkCashflow(range).then(setCashflow) :
      tab === 'warehouse' ? fetchNetworkWarehouse().then(setWarehouse) :
      fetchNetworkAccounts().then(setAccounts)
    req
      .catch(e => {
        if (isNotInNetwork(e)) setNotInNetwork(true)
        else setError(e?.message ?? 'Не удалось загрузить сводку')
      })
      .finally(() => setLoading(false))
  }, [tab, period])

  const revenueBranches = useMemo(
    () => (summary?.branches ?? []).slice().sort((a, b) => b.revenue - a.revenue),
    [summary],
  )
  const revenueTotal = summary?.totalRevenue ?? 0

  const pnlBranches = useMemo(
    () => (pnl?.branches ?? []).slice().sort((a, b) => b.revenue - a.revenue),
    [pnl],
  )
  const cashflowBranches = useMemo(
    () => (cashflow?.branches ?? []).slice().sort((a, b) => b.net - a.net),
    [cashflow],
  )
  const warehouseBranches = useMemo(
    () => (warehouse?.branches ?? []).slice().sort((a, b) => b.value - a.value),
    [warehouse],
  )
  // /network/accounts отдаёт плоский список счетов — сворачиваем в одну
  // строку на филиал (сумма балансов), чтобы таблица была того же вида, что
  // и у остальных 4 вкладок; отдельные счета видны на самой странице филиала.
  const accountsBranches = useMemo(() => {
    const byBranch = new Map<string, AccountsBranchRow>()
    for (const a of accounts?.accounts ?? []) {
      const row = byBranch.get(a.branchId) ?? { id: a.branchId, name: a.branchName, kind: a.branchKind, balance: 0, accountsCount: 0 }
      row.balance += a.balance
      row.accountsCount += 1
      byBranch.set(a.branchId, row)
    }
    return Array.from(byBranch.values()).sort((a, b) => b.balance - a.balance)
  }, [accounts])

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Network className="size-5 text-primary" />
          <h1 className="text-xl font-bold text-foreground">Сводка по сети</h1>
        </div>
        <div className="flex flex-wrap rounded-lg border border-border p-0.5 text-sm">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-md px-2.5 py-1 ${tab === t.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {hasPeriod && (
        <div className="flex justify-end">
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
      )}

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : notInNetwork ? (
        <NotInNetwork what="сводку по сети" />
      ) : error ? (
        <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700">{error}</div>
      ) : (
        <>
          {tab === 'revenue' && (
            <>
              <div className="rounded-xl border border-border bg-emerald-500/5 p-4">
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <TrendingUp className="size-4 text-emerald-600" /> Выручка сети
                </div>
                <div className="mt-1 text-3xl font-bold text-foreground">{formatCurrency(revenueTotal)}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{revenueBranches.length} филиалов</div>
              </div>
              <BranchTable
                rows={revenueBranches}
                canDrillDown={canDrillDown}
                myRestaurantId={restaurantId}
                onRowClick={drillInto}
                columns={[
                  { label: 'Выручка', render: b => formatCurrency(b.revenue) },
                  { label: 'Доля', render: b => `${revenueTotal > 0 ? Math.round((b.revenue / revenueTotal) * 100) : 0}%` },
                ]}
              />
            </>
          )}

          {tab === 'pnl' && pnl && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="rounded-xl border border-border bg-emerald-500/5 p-3">
                  <div className="text-xs text-muted-foreground">Выручка</div>
                  <div className="mt-1 text-lg font-bold text-foreground">{formatCurrency(pnl.total.revenue)}</div>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <div className="text-xs text-muted-foreground">Себестоимость</div>
                  <div className="mt-1 text-lg font-bold text-foreground">{formatCurrency(pnl.total.cogs)}</div>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <div className="text-xs text-muted-foreground">Списания</div>
                  <div className="mt-1 text-lg font-bold text-foreground">{formatCurrency(pnl.total.writeoffs)}</div>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <div className="text-xs text-muted-foreground">Хоз. расход</div>
                  <div className="mt-1 text-lg font-bold text-foreground">{formatCurrency(pnl.total.supplyExpenses)}</div>
                </div>
                <div className="rounded-xl border border-border bg-primary/5 p-3 col-span-2 sm:col-span-1">
                  <div className="text-xs text-muted-foreground">Валовая прибыль</div>
                  <div className="mt-1 text-lg font-bold text-foreground">{formatCurrency(pnl.total.grossProfit)}</div>
                </div>
              </div>
              <BranchTable
                rows={pnlBranches}
                canDrillDown={canDrillDown}
                myRestaurantId={restaurantId}
                onRowClick={drillInto}
                columns={[
                  { label: 'Выручка', render: b => formatCurrency(b.revenue) },
                  { label: 'COGS', render: b => formatCurrency(b.cogs) },
                  { label: 'Прибыль', render: b => formatCurrency(b.grossProfit) },
                ]}
              />
            </>
          )}

          {tab === 'cashflow' && cashflow && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl border border-border bg-emerald-500/5 p-3">
                  <div className="text-xs text-muted-foreground">Приход</div>
                  <div className="mt-1 text-lg font-bold text-foreground">{formatCurrency(cashflow.total.in)}</div>
                </div>
                <div className="rounded-xl border border-border bg-red-500/5 p-3">
                  <div className="text-xs text-muted-foreground">Расход</div>
                  <div className="mt-1 text-lg font-bold text-foreground">{formatCurrency(cashflow.total.out)}</div>
                </div>
                <div className="rounded-xl border border-border bg-primary/5 p-3">
                  <div className="text-xs text-muted-foreground">Чистый поток</div>
                  <div className="mt-1 text-lg font-bold text-foreground">{formatCurrency(cashflow.total.net)}</div>
                </div>
              </div>
              <BranchTable
                rows={cashflowBranches}
                canDrillDown={canDrillDown}
                myRestaurantId={restaurantId}
                onRowClick={drillInto}
                columns={[
                  { label: 'Приход', render: b => formatCurrency(b.in) },
                  { label: 'Расход', render: b => formatCurrency(b.out) },
                  { label: 'Чистый поток', render: b => formatCurrency(b.net) },
                ]}
              />
            </>
          )}

          {tab === 'warehouse' && warehouse && (
            <>
              <div className="rounded-xl border border-border bg-amber-500/5 p-4">
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Warehouse className="size-4 text-amber-600" /> Стоимость остатков склада
                </div>
                <div className="mt-1 text-3xl font-bold text-foreground">{formatCurrency(warehouse.totalValue)}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{warehouseBranches.length} филиалов</div>
              </div>
              <BranchTable
                rows={warehouseBranches}
                canDrillDown={canDrillDown}
                myRestaurantId={restaurantId}
                onRowClick={drillInto}
                columns={[{ label: 'Стоимость остатков', render: b => formatCurrency(b.value) }]}
              />
            </>
          )}

          {tab === 'accounts' && accounts && (
            <>
              <div className="rounded-xl border border-border bg-blue-500/5 p-4">
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Wallet className="size-4 text-blue-600" /> Всего денег в сети
                </div>
                <div className="mt-1 text-3xl font-bold text-foreground">{formatCurrency(accounts.totalBalance)}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{accounts.accounts.length} счетов, включая отключённые</div>
              </div>
              <BranchTable
                rows={accountsBranches}
                canDrillDown={canDrillDown}
                myRestaurantId={restaurantId}
                onRowClick={drillInto}
                columns={[
                  { label: 'Счетов', render: b => String(b.accountsCount) },
                  { label: 'Баланс', render: b => formatCurrency(b.balance) },
                ]}
              />
            </>
          )}

          {canDrillDown && (
            <p className="text-xs text-muted-foreground">Клик по филиалу — открыть его дашборд и отчёты.</p>
          )}
        </>
      )}
    </div>
  )
}
