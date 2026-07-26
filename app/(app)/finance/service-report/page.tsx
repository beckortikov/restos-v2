'use client'

import { FinanceTabs } from '@/components/finance/finance-tabs'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useDataSync } from '@/hooks/use-data-sync'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency } from '@/lib/helpers'
import { fetchUsers, fetchServiceAccrualByWaiter, fetchServicePayoutByWaiter, fetchServiceAccrualByShift, fetchServicePayoutByShift, fetchShifts } from '@/lib/queries'
import type { User, CashShift } from '@/lib/types'
import { exportToExcel } from '@/lib/export-excel'
import { HandCoins, Download } from 'lucide-react'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'
import { DateRangePresets, getPresetRange, readStoredPreset, type RangePreset } from '@/components/finance/date-range-presets'

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

function isoRangeFromYmd(fromYmd: string, toYmd: string): { from: string; to: string } {
  const [fy, fm, fd] = fromYmd.split('-').map(Number)
  const [ty, tm, td] = toYmd.split('-').map(Number)
  const start = new Date(fy, (fm || 1) - 1, fd || 1, 0, 0, 0, 0)
  const end = new Date(ty, (tm || 1) - 1, td || 1, 23, 59, 59, 999)
  return { from: localISO(start), to: localISO(end) }
}

function rangeForPreset(preset: RangePreset): { from: string; to: string } {
  const r = preset === 'custom' ? getPresetRange('month') : getPresetRange(preset)
  return isoRangeFromYmd(r.from, r.to)
}

interface Row {
  waiterId: string | null
  waiterName: string
  ordersCount: number
  accrued: number
  paid: number
  remaining: number
}

// Метка смены для селекта: «25.06 10:00–18:00 · Анна».
function shiftLabel(s: CashShift): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const o = new Date(s.openedAt)
  const day = `${pad(o.getDate())}.${pad(o.getMonth() + 1)}`
  const open = `${pad(o.getHours())}:${pad(o.getMinutes())}`
  let span = open
  if (s.status === 'open') {
    span = `${open}–сейчас`
  } else if (s.closedAt) {
    const c = new Date(s.closedAt)
    span = `${open}–${pad(c.getHours())}:${pad(c.getMinutes())}`
  }
  return `${day} ${span}${s.openedByName ? ` · ${s.openedByName}` : ''}`
}

export default function ServiceReportPage() {
  const { canDo } = useAuth()
  const [preset, setPreset] = useState<RangePreset>(() => readStoredPreset('service-report:preset', 'month'))
  const initial = rangeForPreset(preset === 'custom' ? 'month' : preset)
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [customFrom, setCustomFrom] = useState(getPresetRange('month').from)
  const [customTo, setCustomTo] = useState(getPresetRange('month').to)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  // Фильтр по смене: '' = весь период (по closed_at), иначе одна смена (по
  // shift_id — ровно как в Z-отчёте, без «непришедших» из соседних смен).
  const [shiftId, setShiftId] = useState('')
  const [shifts, setShifts] = useState<CashShift[]>([])

  useEffect(() => { fetchShifts(30).then(setShifts).catch(() => {}) }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [accrual, payout, users] = await Promise.all([
        shiftId ? fetchServiceAccrualByShift(shiftId) : fetchServiceAccrualByWaiter(from, to),
        shiftId ? fetchServicePayoutByShift(shiftId) : fetchServicePayoutByWaiter(from, to),
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
      toast.error(humanizeError(e, 'Ошибка загрузки'))
    } finally {
      setLoading(false)
    }
  }, [from, to, shiftId])

  useEffect(() => { load() }, [load])

  // Сервисный сбор начисляется при закрытии заказа и выплачивается финопой —
  // подписываемся, чтобы «к выплате» не отставало от кассы.
  useDataSync(['orders', 'financial_operations', 'cash_shifts'], load)

  const totals = useMemo(() => ({
    orders: rows.reduce((s, r) => s + r.ordersCount, 0),
    accrued: rows.reduce((s, r) => s + r.accrued, 0),
    paid: rows.reduce((s, r) => s + r.paid, 0),
    remaining: rows.reduce((s, r) => s + r.remaining, 0),
  }), [rows])

  const applyPreset = (p: RangePreset, r: { from: string; to: string }) => {
    setPreset(p)
    if (p === 'custom') {
      setCustomFrom(r.from)
      setCustomTo(r.to)
      if (r.from && r.to) {
        const iso = isoRangeFromYmd(r.from, r.to)
        setFrom(iso.from); setTo(iso.to)
      }
    } else {
      const iso = isoRangeFromYmd(r.from, r.to)
      setFrom(iso.from); setTo(iso.to)
    }
  }

  if (!canDo('finance.view')) {
    return <div className="p-6 flex items-center justify-center h-64"><p className="text-muted-foreground">Нет доступа</p></div>
  }

  return (
    <div className="p-4 md:p-6 space-y-5">
      <FinanceTabs />
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <HandCoins className="size-5 text-blue-600" />
            Обслуживание официантов
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">{shiftId ? 'Начисления и выплаты по выбранной смене (как в Z-отчёте)' : 'Начисления из чеков и выплаты по периоду'}</p>
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
      <div className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-xl p-3">
        <div className={shiftId ? 'opacity-40 pointer-events-none' : ''}>
          <DateRangePresets
            value={preset}
            onChange={(p, r) => applyPreset(p, r)}
            customFrom={customFrom}
            customTo={customTo}
            onCustomFromChange={(v) => { setPreset('custom'); setCustomFrom(v); if (v && customTo) { const iso = isoRangeFromYmd(v, customTo); setFrom(iso.from); setTo(iso.to) } }}
            onCustomToChange={(v) => { setPreset('custom'); setCustomTo(v); if (customFrom && v) { const iso = isoRangeFromYmd(customFrom, v); setFrom(iso.from); setTo(iso.to) } }}
            storageKey="service-report:preset"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Смена:</span>
          <select
            value={shiftId}
            onChange={(e) => setShiftId(e.target.value)}
            className="px-3 py-2 text-sm border border-border rounded-lg bg-card max-w-[260px]"
          >
            <option value="">Весь период</option>
            {shifts.map(s => (
              <option key={s.id} value={s.id}>{shiftLabel(s)}</option>
            ))}
          </select>
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

      {/* Карточки официантов — таблица на 5 колонок уезжала вбок на телефоне */}
      {loading ? (
        <div className="bg-card rounded-xl border border-border p-10 text-center text-sm text-muted-foreground">Загрузка…</div>
      ) : rows.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-10 text-center text-sm text-muted-foreground">Нет данных за выбранный период</div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
          {rows.map(r => (
            <div key={r.waiterId ?? 'none'} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
              <div className="size-9 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-bold shrink-0">
                {(r.waiterName || '?').charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium truncate ${r.waiterId ? 'text-foreground' : 'text-muted-foreground italic'}`}>{r.waiterName}</p>
                <p className="text-xs text-muted-foreground">
                  {r.ordersCount} заказ(ов) · начислено <span className="text-blue-700 font-medium">{formatCurrency(r.accrued)}</span>
                  {r.paid > 0 && <> · выплачено <span className="text-emerald-600 font-medium">{formatCurrency(r.paid)}</span></>}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">К выплате</p>
                <p className={`text-sm font-bold tabular-nums ${r.remaining > 0 ? 'text-amber-600' : 'text-muted-foreground'}`}>
                  {r.remaining > 0 ? formatCurrency(r.remaining) : '—'}
                </p>
              </div>
            </div>
          ))}
          {/* Итог по всем официантам */}
          <div className="flex items-center gap-3 px-4 py-3 bg-muted/30">
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex-1">
              Итого · {totals.orders} заказ(ов)
            </span>
            <span className="text-xs text-muted-foreground">
              начислено <span className="text-blue-700 font-semibold">{formatCurrency(totals.accrued)}</span>
              {totals.paid > 0 && <> · выплачено <span className="text-emerald-600 font-semibold">{formatCurrency(totals.paid)}</span></>}
            </span>
            <span className="text-sm font-bold text-amber-600 tabular-nums shrink-0">{formatCurrency(totals.remaining)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
