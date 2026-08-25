'use client'

import { ShoppingBag, Users, CreditCard, Tag, MapPin, Banknote } from 'lucide-react'
import { formatCurrency } from '@/lib/helpers'
import { type ShiftZReport } from '@/lib/queries'

// ZReportBreakdown — полная разбивка Z-отчёта закрытой (или чужой, сетевой)
// смены: методы оплаты / категории / блюда / тип заказа / расходы / официанты.
// Вынесена из operations/shifts/page.tsx (была ClosedShiftZBreakdown), чтобы
// network/shifts/page.tsx мог показать тот же разбор смены филиала — формат
// ответа идентичен (NetworkService.ShiftZReport делегирует в тот же
// ShiftsService.ZReport, просто с подменённым tenant).
export function ZReportBreakdown({ z, loading }: { z: ShiftZReport | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
        <div className="size-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        Загрузка Z-отчёта…
      </div>
    )
  }
  if (!z) return <p className="text-xs text-muted-foreground py-2">Z-отчёт недоступен</p>
  const revenueTotal = z.revenueByMethod.reduce((s, m) => s + m.total, 0)
  return (
    <div className="space-y-3">
      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        <div className="bg-background rounded-lg p-2.5">
          <p className="text-xs text-muted-foreground">Выручка</p>
          <p className="font-bold text-primary tabular-nums">{formatCurrency(z.cashRevenue + z.cardRevenue)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">Нал {formatCurrency(z.cashRevenue)} · Безнал {formatCurrency(z.cardRevenue)}</p>
        </div>
        <div className="bg-background rounded-lg p-2.5">
          <p className="text-xs text-muted-foreground">Средний чек</p>
          <p className="font-bold text-foreground tabular-nums">{formatCurrency(z.avgCheck)}</p>
        </div>
        <div className="bg-background rounded-lg p-2.5">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><ShoppingBag className="size-3" />Заказов</p>
          <p className="font-bold text-foreground tabular-nums">{z.ordersCount}</p>
        </div>
        <div className="bg-background rounded-lg p-2.5">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Users className="size-3" />Гостей</p>
          <p className="font-bold text-foreground tabular-nums">{z.guestsCount || 0}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
        {/* Оплата по способам */}
        <div className="bg-background rounded-lg p-3 border border-border">
          <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5"><CreditCard className="size-3.5 text-muted-foreground" />Оплата по способам</h4>
          {z.revenueByMethod.length === 0 ? (
            <p className="text-xs text-muted-foreground">Нет данных</p>
          ) : (
            <div className="space-y-1 text-sm">
              {z.revenueByMethod.map(m => {
                const generic = m.paymentMethod === 'cash' ? 'Наличные' : m.paymentMethod === 'card' ? 'Банк. карта' : m.paymentMethod === 'transfer' ? 'Перевод' : m.paymentMethod || '—'
                const label = m.accountType === 'cash' ? generic : (m.accountName || generic)
                return (
                  <div key={m.accountId || m.paymentMethod || 'u'} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{label} <span className="text-[11px]">({m.ordersCount})</span></span>
                    <span className="font-medium text-foreground tabular-nums">{formatCurrency(m.total)}</span>
                  </div>
                )
              })}
              <div className="border-t border-border pt-1.5 mt-1.5 flex items-center justify-between">
                <span className="text-muted-foreground">Выручка</span>
                <span className="font-medium tabular-nums">{formatCurrency(revenueTotal)}</span>
              </div>
              {z.expensesTotalAll > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Расход</span>
                  <span className="font-medium tabular-nums text-destructive">−{formatCurrency(z.expensesTotalAll)}</span>
                </div>
              )}
              {z.withdrawals > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Изъятия</span>
                  <span className="font-medium tabular-nums text-destructive">−{formatCurrency(z.withdrawals)}</span>
                </div>
              )}
              {z.refundsCount > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Возвраты · {z.refundsCount} чек{z.refundsCount === 1 ? '' : z.refundsCount < 5 ? 'а' : 'ов'}</span>
                  <span className="font-medium tabular-nums text-destructive">−{formatCurrency(z.refundsTotal)}</span>
                </div>
              )}
              <div className="border-t border-border pt-1.5 mt-1.5 flex items-center justify-between font-semibold">
                <span>Итог</span>
                <span className="tabular-nums">{formatCurrency(revenueTotal - z.expensesTotalAll - z.withdrawals - z.refundsTotal)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Продажи по категориям */}
        <div className="bg-background rounded-lg p-3 border border-border">
          <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5"><Tag className="size-3.5 text-muted-foreground" />Продажи по категориям</h4>
          {z.salesByCategory.length === 0 ? (
            <p className="text-xs text-muted-foreground">Нет данных</p>
          ) : (
            <div className="space-y-1 text-sm">
              {z.salesByCategory.slice(0, 8).map(c => (
                <div key={c.name} className="flex items-center justify-between">
                  <span className="text-muted-foreground truncate pr-2">{c.name} <span className="text-[11px]">({c.qty} шт)</span></span>
                  <span className="font-medium text-foreground tabular-nums">{formatCurrency(c.total)}</span>
                </div>
              ))}
              {z.salesByCategory.length > 8 && <p className="text-[11px] text-muted-foreground italic pt-1">…и ещё {z.salesByCategory.length - 8}</p>}
            </div>
          )}
        </div>

        {/* Проданные блюда */}
        <div className="bg-background rounded-lg p-3 border border-border">
          <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5"><ShoppingBag className="size-3.5 text-muted-foreground" />Проданные блюда</h4>
          {z.salesByItem.length === 0 ? (
            <p className="text-xs text-muted-foreground">Нет данных</p>
          ) : (
            <div className="space-y-1 text-sm max-h-60 overflow-y-auto">
              {z.salesByItem.map(it => (
                <div key={it.name} className="flex items-center justify-between">
                  <span className="text-muted-foreground truncate pr-2">{it.name} <span className="text-[11px]">×{it.qty % 1 === 0 ? it.qty : it.qty.toFixed(2)}</span></span>
                  <span className="font-medium text-foreground tabular-nums">{formatCurrency(it.total)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* По типу заказа */}
        <div className="bg-background rounded-lg p-3 border border-border">
          <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5"><MapPin className="size-3.5 text-muted-foreground" />По типу заказа</h4>
          {z.salesByOrderType.length === 0 ? (
            <p className="text-xs text-muted-foreground">Нет данных</p>
          ) : (
            <div className="space-y-1 text-sm">
              {z.salesByOrderType.map(t => {
                const label = t.type === 'hall' ? 'В зале' : t.type === 'takeaway' ? 'С собой' : t.type === 'delivery' ? 'Доставка' : t.type
                return (
                  <div key={t.type} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{label} <span className="text-[11px]">({t.ordersCount})</span></span>
                    <span className="font-medium text-foreground tabular-nums">{formatCurrency(t.total)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Расходы */}
        <div className="bg-background rounded-lg p-3 border border-border">
          <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5"><Banknote className="size-3.5 text-muted-foreground" />Расходы</h4>
          {z.expensesByCategory.length === 0 ? (
            <p className="text-xs text-muted-foreground">Расходов нет</p>
          ) : (
            <div className="space-y-1 text-sm">
              {z.expensesByCategory.map(c => (
                <div key={c.category} className="flex items-center justify-between">
                  <span className="text-muted-foreground truncate pr-2">{c.category} <span className="text-[11px]">({c.count})</span></span>
                  <span className="font-medium text-destructive tabular-nums">{formatCurrency(c.amount)}</span>
                </div>
              ))}
              <div className="border-t border-border pt-1.5 mt-1.5 flex items-center justify-between font-semibold">
                <span>Итого расходов</span>
                <span className="tabular-nums text-destructive">{formatCurrency(z.expensesTotal)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Официанты */}
        <div className="bg-background rounded-lg p-3 border border-border">
          <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5"><Users className="size-3.5 text-muted-foreground" />Официанты</h4>
          {z.salesByWaiter.length === 0 ? (
            <p className="text-xs text-muted-foreground">Нет данных</p>
          ) : (
            <div className="space-y-1 text-sm">
              {z.salesByWaiter.map(w => (
                <div key={w.waiterId} className="flex items-center justify-between">
                  <span className="text-muted-foreground truncate pr-2">{w.name} <span className="text-[11px]">({w.ordersCount})</span></span>
                  <span className="font-medium text-foreground tabular-nums">{formatCurrency(w.total)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
