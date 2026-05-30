'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency } from '@/lib/helpers'
import { fetchUsers, fetchServiceAccrualByWaiter, fetchServicePayoutByWaiter } from '@/lib/queries'
import type { User } from '@/lib/types'
import { exportToExcel } from '@/lib/export-excel'
import { HandCoins, Download } from 'lucide-react'
import { toast } from 'sonner'

type Preset = 'today' | 'week' | 'month' | 'custom'

// Локальная ISO-строка без TZ-конверсии. toISOString() сдвигает в UTC и в
// таймзонах с положительным смещением (UTC+5 для TJ) локальное 02.05 00:00
// превращается в 01.05 19:00 UTC; затем .slice(0,10) даёт «01.05» вместо
// «02.05» — пресет «Сегодня» начинал захватывать вчера.
function localISO(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  // RFC3339 требует timezone suffix (Z или ±HH:MM). Без него Go-бэк
  // отвергает «bad ?from (RFC3339 required)». Раньше слали голое
  // "YYYY-MM-DDTHH:MM:SS" — годилось для PG TIMESTAMP, но v4-бэк строгий.
  const tzMin = -d.getTimezoneOffset() // getTimezoneOffset is inverted
  const sign = tzMin >= 0 ? '+' : '-'
  const tzAbs = Math.abs(tzMin)
  const tzH = pad(Math.floor(tzAbs / 60))
  const tzM = pad(tzAbs % 60)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${tzH}:${tzM}`
}

function rangeFor(preset: Preset): { from: string; to: string } {
  const now = new Date()
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  if (preset === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
    return { from: localISO(start), to: localISO(endOfDay) }
  }
  if (preset === 'week') {
    const start = new Date(now)
    start.setDate(start.getDate() - 6)
    start.setHours(0, 0, 0, 0)
    return { from: localISO(start), to: localISO(endOfDay) }
  }
  // month default
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  return { from: localISO(start), to: localISO(endOfDay) }
}

interface Row {
  waiterId: string | null
  waiterName: string
  ordersCount: number
  accrued: number
  paid: number
  remaining: number
}

export default function ServiceReportPage() {
  const { canDo } = useAuth()
  const [preset, setPreset] = useState<Preset>('month')
  const initial = rangeFor('month')
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [accrual, payout, users] = await Promise.all([
        fetchServiceAccrualByWaiter(from, to),
        fetchServicePayoutByWaiter(from, to),
        fetchUsers(),
      ])
      const userMap = new Map<string, User>(users.map(u => [u.id, u]))
      const built: Row[] = accrual.map(r => {
        const wid = r.waiterId
        const paid = wid ? (payout[wid] ?? 0) : 0
        const name = wid ? (userMap.get(wid)?.name ?? 'Неизвестно') : 'Без официанта'
        return {
          waiterId: wid,
          waiterName: name,
          ordersCount: r.ordersCount,
          accrued: r.accrued,
          paid,
          remaining: Math.max(0, r.accrued - paid),
        }
      })
      // Add waiters with payouts but no accrual in this period (refunded over-payments shouldn't happen but be safe)
      for (const [wid, paid] of Object.entries(payout)) {
        if (built.some(r => r.waiterId === wid)) continue
        built.push({
          waiterId: wid,
          waiterName: userMap.get(wid)?.name ?? 'Неизвестно',
          ordersCount: 0,
          accrued: 0,
          paid,
          remaining: 0,
        })
      }
      built.sort((a, b) => b.accrued - a.accrued)
      setRows(built)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const totals = useMemo(() => ({
    orders: rows.reduce((s, r) => s + r.ordersCount, 0),
    accrued: rows.reduce((s, r) => s + r.accrued, 0),
    paid: rows.reduce((s, r) => s + r.paid, 0),
    remaining: rows.reduce((s, r) => s + r.remaining, 0),
  }), [rows])

  const applyPreset = (p: Preset) => {
    setPreset(p)
    if (p !== 'custom') {
      const r = rangeFor(p)
      setFrom(r.from)
      setTo(r.to)
    }
  }

  if (!canDo('finance.view')) {
    return <div className="p-6 flex items-center justify-center h-64"><p className="text-muted-foreground">Нет доступа</p></div>
  }

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <HandCoins className="size-5 text-blue-600" />
            Обслуживание официантов
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">Начисления из чеков и выплаты по периоду</p>
        </div>
        <button
          onClick={() => exportToExcel(
            rows.map(r => ({
              waiter: r.waiterName,
              orders: r.ordersCount,
              accrued: r.accrued,
              paid: r.paid,
              remaining: r.remaining,
            })),
            [
              { key: 'waiter', header: 'Официант' },
              { key: 'orders', header: 'Заказов' },
              { key: 'accrued', header: 'Начислено' },
              { key: 'paid', header: 'Выплачено' },
              { key: 'remaining', header: 'Остаток' },
            ],
            'Обслуживание'
          )}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted"
        >
          <Download className="size-3.5" />Excel
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 bg-card border border-border rounded-xl p-3">
        <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg">
          {(['today', 'week', 'month', 'custom'] as Preset[]).map(p => (
            <button key={p} onClick={() => applyPreset(p)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${preset === p ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
              {p === 'today' ? 'Сегодня' : p === 'week' ? '7 дней' : p === 'month' ? 'Месяц' : 'Свой'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={from.slice(0, 10)}
            onChange={e => { setPreset('custom'); setFrom(new Date(e.target.value + 'T00:00:00').toISOString()) }}
            className="px-2 py-1 text-xs bg-card border border-border rounded-md" />
          <span className="text-xs text-muted-foreground">—</span>
          <input type="date" value={to.slice(0, 10)}
            onChange={e => { setPreset('custom'); setTo(new Date(e.target.value + 'T23:59:59').toISOString()) }}
            className="px-2 py-1 text-xs bg-card border border-border rounded-md" />
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-xs text-muted-foreground">Заказов</p>
          <p className="text-2xl font-bold text-foreground mt-1">{totals.orders}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-xs text-muted-foreground">Начислено</p>
          <p className="text-2xl font-bold text-blue-700 mt-1">{formatCurrency(totals.accrued)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-xs text-muted-foreground">Выплачено</p>
          <p className="text-2xl font-bold text-emerald-600 mt-1">{formatCurrency(totals.paid)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-xs text-muted-foreground">Остаток</p>
          <p className="text-2xl font-bold text-amber-600 mt-1">{formatCurrency(totals.remaining)}</p>
        </div>
      </div>

      {/* Table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Официант</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">Заказов</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">Начислено</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">Выплачено</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">Остаток</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Загрузка...</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Нет данных за выбранный период</td></tr>
              )}
              {!loading && rows.map(r => (
                <tr key={r.waiterId ?? 'none'} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <span className={`font-medium ${r.waiterId ? 'text-foreground' : 'text-muted-foreground italic'}`}>{r.waiterName}</span>
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground">{r.ordersCount}</td>
                  <td className="px-4 py-3 text-right text-blue-700 font-medium">{r.accrued > 0 ? formatCurrency(r.accrued) : '—'}</td>
                  <td className="px-4 py-3 text-right text-emerald-600">{r.paid > 0 ? formatCurrency(r.paid) : '—'}</td>
                  <td className="px-4 py-3 text-right">
                    {r.remaining > 0 ? <span className="font-bold text-amber-600">{formatCurrency(r.remaining)}</span> : <span className="text-muted-foreground">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="bg-muted/40 border-t border-border">
                  <td className="px-4 py-3 text-xs font-bold text-muted-foreground uppercase">Итого</td>
                  <td className="px-4 py-3 text-right font-bold text-foreground">{totals.orders}</td>
                  <td className="px-4 py-3 text-right font-bold text-blue-700">{formatCurrency(totals.accrued)}</td>
                  <td className="px-4 py-3 text-right font-bold text-emerald-600">{formatCurrency(totals.paid)}</td>
                  <td className="px-4 py-3 text-right font-bold text-amber-600">{formatCurrency(totals.remaining)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  )
}
