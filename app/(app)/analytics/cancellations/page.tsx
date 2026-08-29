'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as XLSX from 'xlsx'
import { Undo2, Receipt, ListX, PackageX, Download } from 'lucide-react'

import { formatCurrency } from '@/lib/helpers'
import {
  fetchCancellationsAnalytics, fetchNetworkCancellationsAnalytics,
  type CancellationsReport, type NetworkCancellationsReport, type CancellationBucket,
} from '@/lib/queries/analytics'
import { DateRangePicker } from '@/components/ui/date-range-picker'
import { getPresetRange } from '@/components/finance/date-range-presets'
import { useAuth } from '@/lib/auth-store'
import { useBranchView } from '@/hooks/use-branch-view'

const today = () => new Date().toISOString().slice(0, 10)

const ORDER_TYPE_LABELS: Record<string, string> = { hall: 'Зал', takeaway: 'С собой', delivery: 'Доставка' }

function appendSheet(wb: XLSX.WorkBook, name: string, rows: Record<string, unknown>[]) {
  const ws = XLSX.utils.json_to_sheet(rows)
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31))
}

// Строки report.rows у local/network версий отличаются только наличием
// restaurant_name — приводим к общей форме для рендера таблицы одним кодом.
interface Row {
  kind: 'item_void' | 'order_cancel'
  orderNumber: number
  orderType: string | null
  tableName: string | null
  itemName: string | null
  itemQty: number | null
  amount: number
  reason: string | null
  createdByName: string | null
  approvedByName: string | null
  createdAt: string
  restaurantName?: string
}

const PAGE_SIZE = 50

export default function CancellationsPage() {
  const { canDo, restaurant } = useAuth()
  const isBranchView = useBranchView()
  const isCentral = restaurant?.kind === 'central_warehouse' && !isBranchView

  const [report, setReport] = useState<CancellationsReport | NetworkCancellationsReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)

  const initial = getPresetRange('week')
  const [dateFrom, setDateFrom] = useState(initial.from)
  const [dateTo, setDateTo] = useState(initial.to)

  useEffect(() => { setPage(0) }, [dateFrom, dateTo, isCentral])

  useEffect(() => {
    setLoading(true)
    const fetcher = isCentral ? fetchNetworkCancellationsAnalytics : fetchCancellationsAnalytics
    fetcher({ from: dateFrom, to: dateTo, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then(setReport)
      .catch(() => toast.error('Ошибка загрузки отчёта по отменам'))
      .finally(() => setLoading(false))
  }, [dateFrom, dateTo, isCentral, page])

  const rows: Row[] = useMemo(() => {
    if (!report) return []
    return report.rows.map(r => ({
      kind: r.kind,
      orderNumber: r.order_number,
      orderType: r.order_type,
      tableName: r.table_name,
      itemName: r.item_name,
      itemQty: r.item_qty,
      amount: Number(r.amount),
      reason: r.reason,
      createdByName: r.created_by_name,
      approvedByName: r.approved_by_name,
      createdAt: r.created_at,
      restaurantName: 'restaurant_name' in r ? r.restaurant_name : undefined,
    }))
  }, [report])

  function exportReport() {
    if (!report) return
    const wb = XLSX.utils.book_new()
    const dataRows = rows.map(r => ({
      '№ заказа': r.orderNumber,
      'Тип': r.orderType ? ORDER_TYPE_LABELS[r.orderType] ?? r.orderType : '',
      ...(isCentral ? { 'Филиал': r.restaurantName ?? '' } : {}),
      'Что': r.kind === 'item_void' ? (r.itemName ?? '') : 'Весь заказ',
      'Кол-во': r.itemQty ?? '',
      'Сумма': Number(r.amount.toFixed(2)),
      'Причина': r.reason ?? '',
      'Кто отменил': r.createdByName ?? '',
      'Когда': new Date(r.createdAt).toLocaleString('ru-RU'),
    }))
    appendSheet(wb, 'Отмены', dataRows)
    XLSX.writeFile(wb, `Отмены_${dateFrom}_${dateTo}.xlsx`)
  }

  const summary = report?.summary

  if (!loading && !canDo('analytics.view')) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        <p className="text-lg font-semibold">Нет доступа</p>
        <p className="text-sm mt-1">Эта страница доступна только владельцу и управляющему</p>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Undo2 className="size-5 text-primary" />
            <h1 className="text-xl font-bold text-foreground">Отмены</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {isCentral
              ? 'Что и почему отменялось по всей сети — отменённые позиции и целиком отменённые заказы'
              : 'Что и почему отменялось — отменённые позиции и целиком отменённые заказы'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DateRangePicker from={dateFrom} to={dateTo} maxDate={today()} onChange={r => { setDateFrom(r.from); setDateTo(r.to) }} />
          <button onClick={exportReport} className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-muted transition-colors" title="Выгрузить в Excel">
            <Download className="size-4" />
            <span className="hidden sm:inline">Excel</span>
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex h-64 items-center justify-center"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
      ) : !summary ? null : (
        <>
          {/* KPI */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 md:gap-3">
            <KpiCard label="Сумма отмен" value={formatCurrency(Number(summary.total_amount))} icon={Undo2} color="bg-rose-500/10 text-rose-600" />
            <KpiCard label="Событий" value={String(summary.total_count)} icon={ListX} color="bg-primary/10 text-primary" />
            <KpiCard label="Отмены позиций" value={formatCurrency(Number(summary.item_voids_amount))} icon={PackageX} color="bg-amber-500/10 text-amber-600" />
            <KpiCard label="Отмены заказов целиком" value={formatCurrency(Number(summary.order_cancels_amount))} icon={Receipt} color="bg-violet-500/10 text-violet-600" />
          </div>

          {/* Топ-списки: причины / сотрудники / блюда */}
          <div className="grid md:grid-cols-3 gap-3">
            <BucketCard title="Топ причин" buckets={summary.by_reason} empty="Причины не указаны" />
            <BucketCard title="Топ сотрудников" buckets={summary.by_employee} empty="Нет данных" />
            <BucketCard title="Топ отменяемых блюд" buckets={summary.by_dish} empty="Отмены целых заказов не несут блюда" />
          </div>

          {/* Динамика по дням */}
          <div className="bg-card rounded-xl border border-border p-4 md:p-5">
            <h2 className="text-sm font-semibold mb-3">Динамика по дням</h2>
            {summary.by_day.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">Нет отмен за период</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border">
                      <th className="text-left font-medium py-2 pr-2">Дата</th>
                      <th className="text-right font-medium py-2 px-2">Событий</th>
                      <th className="text-right font-medium py-2 pl-2">Сумма</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...summary.by_day].sort((a, b) => (a.name < b.name ? 1 : -1)).map(d => (
                      <tr key={d.name} className="border-b border-border/50 last:border-0">
                        <td className="py-2 pr-2 font-medium">{new Date(d.name + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{d.count}</td>
                        <td className="py-2 pl-2 text-right font-medium tabular-nums">{formatCurrency(Number(d.amount))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Построчный список за период */}
          <div className="bg-card rounded-xl border border-border p-4 md:p-5">
            <h2 className="text-sm font-semibold mb-3">Все отмены за период</h2>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-10">Нет отмен за выбранный период</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border">
                      <th className="text-left font-medium py-2 pr-2">Заказ</th>
                      {isCentral && <th className="text-left font-medium py-2 pr-2">Филиал</th>}
                      <th className="text-left font-medium py-2 pr-2">Что</th>
                      <th className="text-right font-medium py-2 px-2">Сумма</th>
                      <th className="text-left font-medium py-2 px-2">Причина</th>
                      <th className="text-left font-medium py-2 px-2">Кто</th>
                      <th className="text-left font-medium py-2 pl-2">Когда</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="border-b border-border/50 last:border-0">
                        <td className="py-2 pr-2 font-medium whitespace-nowrap">
                          №{r.orderNumber}
                          {r.orderType && <span className="text-muted-foreground font-normal"> · {ORDER_TYPE_LABELS[r.orderType] ?? r.orderType}</span>}
                          {r.tableName && <span className="text-muted-foreground font-normal"> · {r.tableName}</span>}
                        </td>
                        {isCentral && <td className="py-2 pr-2 text-muted-foreground">{r.restaurantName}</td>}
                        <td className="py-2 pr-2">
                          {r.kind === 'item_void'
                            ? <span>{r.itemName}{r.itemQty ? ` × ${r.itemQty}` : ''}</span>
                            : <span className="text-rose-600 font-medium">Весь заказ отменён</span>}
                        </td>
                        <td className="py-2 px-2 text-right font-medium tabular-nums">{formatCurrency(r.amount)}</td>
                        <td className="py-2 px-2 text-muted-foreground truncate max-w-[180px]">{r.reason ?? '—'}</td>
                        <td className="py-2 px-2 text-muted-foreground whitespace-nowrap">{r.createdByName ?? '—'}</td>
                        <td className="py-2 pl-2 text-muted-foreground whitespace-nowrap">{new Date(r.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
                  <span>Показано {page * PAGE_SIZE + 1}–{page * PAGE_SIZE + rows.length} из {report?.total ?? 0}</span>
                  <div className="flex gap-2">
                    <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))} className="px-2.5 py-1 rounded-md border border-border disabled:opacity-40 hover:bg-muted transition-colors">Назад</button>
                    <button disabled={(page + 1) * PAGE_SIZE >= (report?.total ?? 0)} onClick={() => setPage(p => p + 1)} className="px-2.5 py-1 rounded-md border border-border disabled:opacity-40 hover:bg-muted transition-colors">Показать ещё</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function KpiCard({ label, value, icon: Icon, color }: { label: string; value: string; icon: React.ElementType; color: string }) {
  return (
    <div className="bg-card rounded-xl border border-border p-3.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className={`size-7 rounded-md flex items-center justify-center ${color}`}><Icon className="size-3.5" /></div>
      </div>
      <p className="text-lg font-bold tabular-nums">{value}</p>
    </div>
  )
}

function BucketCard({ title, buckets, empty }: { title: string; buckets: CancellationBucket[]; empty: string }) {
  const max = Math.max(1, ...buckets.map(b => Number(b.amount)))
  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <h2 className="text-sm font-semibold mb-3">{title}</h2>
      {buckets.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-6">{empty}</p>
      ) : (
        <div className="space-y-2">
          {buckets.slice(0, 6).map(b => {
            const pct = Math.max(4, (Number(b.amount) / max) * 100)
            return (
              <div key={b.name}>
                <div className="flex items-center justify-between text-xs mb-0.5">
                  <span className="truncate max-w-[160px] text-foreground">{b.name}</span>
                  <span className="tabular-nums font-medium shrink-0 ml-2">{formatCurrency(Number(b.amount))}</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-rose-500/70" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
