'use client'

import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { fetchNetworkDashboard, type NetworkDashboard } from '@/lib/queries/transfers'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { NotInNetwork, isNotInNetwork } from '@/components/network-empty'
import {
  Network, Store, Warehouse, Receipt, Wallet, TrendingDown, ArrowRight, Users, CircleDot,
} from 'lucide-react'

// Сетевой дашборд central (Ф-С1). Central — офис: продаж на нём нет, локальный
// дашборд показывал нули и кассовые виджеты (карта зала, конвейер). Владельцу
// сети на главном экране нужен свод по всем филиалам разом — он и рисуется
// здесь из одного сводного эндпоинта (все данные уже реплицированы, узлы не
// опрашиваются). Переключение «смотреть как филиал» (BranchSelector) при этом
// продолжает показывать обычный локальный дашборд выбранного филиала.

type Range = 'today' | '7d' | '30d'

const RANGES: { key: Range; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
]

/** Начало локального календарного дня N дней назад — ISO для бэка. */
function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

export function NetworkDashboardView() {
  const [data, setData] = useState<NetworkDashboard | null>(null)
  const [range, setRange] = useState<Range>('today')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notInNetwork, setNotInNetwork] = useState(false)

  const load = useCallback(() => {
    const from = range === 'today' ? isoDaysAgo(0) : range === '7d' ? isoDaysAgo(6) : isoDaysAgo(29)
    return fetchNetworkDashboard({ from })
      .then(d => { setData(d); setError(null) })
      .catch(e => {
        if (isNotInNetwork(e)) setNotInNetwork(true)
        else setError(humanizeError(e))
      })
  }, [range])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  // Автообновление раз в минуту — дашборд висит на экране в офисе.
  useEffect(() => {
    const t = setInterval(load, 60000)
    return () => clearInterval(t)
  }, [load])

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

  return (
    <div className="p-4 md:p-6 space-y-5">
      {/* Шапка: это свод сети, не касса */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Network className="size-5 text-primary" />
          <div>
            <h1 className="text-xl font-bold text-foreground">Сеть — сводка</h1>
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

      {/* KPI сети */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Receipt className="size-3.5" /> Выручка сети</p>
          <p className="text-2xl font-bold text-foreground mt-1">{formatCurrency(data?.revenue ?? 0)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {data?.ordersCount ?? 0} заказов · средний чек {formatCurrency(data?.avgCheck ?? 0)}
          </p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5"><TrendingDown className="size-3.5" /> Расходы сети</p>
          <p className="text-2xl font-bold text-destructive mt-1">{formatCurrency(data?.expenses ?? 0)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">без внутренних переводов</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Wallet className="size-3.5" /> Деньги сети</p>
          <p className="text-2xl font-bold text-foreground mt-1">{formatCurrency(data?.totalCash ?? 0)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">все счета всех узлов</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5"><CircleDot className="size-3.5" /> Смены</p>
          <p className="text-2xl font-bold text-foreground mt-1">{data?.openShifts ?? 0}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">открыто сейчас</p>
        </div>
      </div>

      {/* Разбивка по филиалам */}
      <div className="overflow-x-auto rounded-xl border border-border">
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

      {/* Быстрые переходы в рабочие разделы центра */}
      <div className="grid sm:grid-cols-3 gap-2">
        <Link to="/network/summary" className="flex items-center justify-between rounded-xl border border-border p-3 text-sm hover:bg-muted/50 transition-colors">
          <span className="inline-flex items-center gap-2"><Network className="size-4 text-muted-foreground" /> Отчёты по сети</span>
          <ArrowRight className="size-4 text-muted-foreground" />
        </Link>
        <Link to="/network/staff" className="flex items-center justify-between rounded-xl border border-border p-3 text-sm hover:bg-muted/50 transition-colors">
          <span className="inline-flex items-center gap-2"><Users className="size-4 text-muted-foreground" /> Персонал сети</span>
          <ArrowRight className="size-4 text-muted-foreground" />
        </Link>
        <Link to="/network/expenses" className="flex items-center justify-between rounded-xl border border-border p-3 text-sm hover:bg-muted/50 transition-colors">
          <span className="inline-flex items-center gap-2"><Wallet className="size-4 text-muted-foreground" /> Расходы за филиалы</span>
          <ArrowRight className="size-4 text-muted-foreground" />
        </Link>
      </div>

      <p className="text-xs text-muted-foreground">
        Данные приходят от филиалов синхронизацией и могут отставать на минуту-другую.
      </p>
    </div>
  )
}
