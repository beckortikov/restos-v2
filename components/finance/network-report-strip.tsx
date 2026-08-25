'use client'

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { useBranchView } from '@/hooks/use-branch-view'
import { fetchNetworkCashflow, fetchNetworkPnL } from '@/lib/queries/transfers'
import { formatCurrency } from '@/lib/helpers'
import { Network, ArrowRight } from 'lucide-react'

// Ф-С3: на central локальные ДДС/ОПиУ показывают только сам центр (обычно
// нули — продаж там нет). Эта полоса добавляет над отчётом ИТОГ ПО ВСЕЙ СЕТИ
// за тот же период, чтобы владелец видел настоящую картину, не покидая
// страницу; полная разбивка по филиалам — в «Сводке по сети». Детальные
// сетевые срезы (по дням/категориям) сознательно не рисуются — Ф8 их не
// считает, они доступны через «смотреть как филиал».
//
// Видна ТОЛЬКО владельцу central вне branch-view; на филиалах и в режиме
// «смотреть как филиал» не рендерится и не делает запросов.

interface Props {
  kind: 'cashflow' | 'pnl'
  /** YYYY-MM-DD (как в фильтрах страниц) — пусто = всё время. */
  from?: string
  to?: string
}

type Totals = { a: number; b: number; net: number }

export function NetworkReportStrip({ kind, from, to }: Props) {
  const { restaurant } = useAuth()
  const isBranchView = useBranchView()
  const isCentral = restaurant?.kind === 'central_warehouse'
  const [totals, setTotals] = useState<Totals | null>(null)
  const [branchCount, setBranchCount] = useState(0)

  useEffect(() => {
    if (!isCentral || isBranchView) return
    const range = {
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
    }
    let alive = true
    if (kind === 'cashflow') {
      fetchNetworkCashflow(range)
        .then(r => {
          if (!alive) return
          setTotals({ a: r.total.in, b: r.total.out, net: r.total.net })
          setBranchCount(r.branches.length)
        })
        .catch(() => setTotals(null))
    } else {
      fetchNetworkPnL(range)
        .then(r => {
          if (!alive) return
          setTotals({ a: r.total.revenue, b: r.total.cogs + r.total.writeoffs + r.total.supplyExpenses, net: r.total.grossProfit })
          setBranchCount(r.branches.length)
        })
        .catch(() => setTotals(null))
    }
    return () => { alive = false }
  }, [isCentral, isBranchView, kind, from, to])

  if (!isCentral || isBranchView || !totals) return null

  const labels = kind === 'cashflow'
    ? { a: 'Приход', b: 'Расход', net: 'Чистый поток' }
    : { a: 'Выручка', b: 'Себестоимость и списания', net: 'Валовая прибыль' }

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary uppercase tracking-wide">
        <Network className="size-3.5" /> Вся сеть · {branchCount} узл.
      </span>
      <span className="text-sm text-muted-foreground">
        {labels.a}: <span className="font-bold text-emerald-600 tabular-nums">{formatCurrency(totals.a)}</span>
      </span>
      <span className="text-sm text-muted-foreground">
        {labels.b}: <span className="font-bold text-destructive tabular-nums">{formatCurrency(totals.b)}</span>
      </span>
      <span className="text-sm text-muted-foreground">
        {labels.net}: <span className={`font-bold tabular-nums ${totals.net >= 0 ? 'text-foreground' : 'text-destructive'}`}>{formatCurrency(totals.net)}</span>
      </span>
      <Link
        to="/network/summary"
        className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        по филиалам <ArrowRight className="size-3" />
      </Link>
    </div>
  )
}
