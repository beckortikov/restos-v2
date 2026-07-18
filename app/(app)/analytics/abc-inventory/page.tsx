'use client'

import { lazy, Suspense, useState, useEffect, useMemo } from 'react'
import { formatCurrency } from '@/lib/helpers'
import { toast } from 'sonner'
import type { ABCClass } from '@/lib/types'
import { fetchABCInventory, type ABCInventoryReport, type ABCInventoryRow } from '@/lib/queries/analytics'
import { DatePeriodFilter, getDateRange, type PeriodKey } from '@/components/date-period-filter'
import { InsightsRecommendations } from '@/components/insights-recommendations'

const AbcInventoryChart = lazy(() => import('@/components/charts/abc-inventory-chart'))

const ABC_BG: Record<ABCClass, string> = {
  A: 'bg-emerald-100 text-emerald-700',
  B: 'bg-primary/10 text-primary',
  C: 'bg-red-100 text-red-700',
}

const ABC_LABELS: Record<ABCClass, string> = {
  A: 'Высокая оборачиваемость — закупать регулярно',
  B: 'Средняя оборачиваемость — стандартные закупки',
  C: 'Низкая оборачиваемость — уменьшить закупки',
}

interface UIRow {
  raw: ABCInventoryRow
  qty: number
  consumption: number
  consumptionValue: number
  turnover: number
  daysOfStock: number
  value: number
  abc: ABCClass
}

export default function AbcInventoryPage() {
  const [report, setReport] = useState<ABCInventoryReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  useEffect(() => {
    setLoading(true)
    const { from, to } = getDateRange(period, customFrom, customTo)
    fetchABCInventory({ from: from ?? undefined, to: to ?? undefined })
      .then(setReport)
      .catch(() => toast.error('Ошибка загрузки ABC-анализа склада'))
      .finally(() => setLoading(false))
  }, [period, customFrom, customTo])

  const items: UIRow[] = useMemo(() => {
    if (!report) return []
    return report.items.map(it => ({
      raw: it,
      qty: Number(it.qty),
      consumption: Number(it.consumption),
      // Н24: стоимость расхода = qty × цена. Складывать qty в разных единицах
      // (кг+шт+л) в «общий расход» нельзя — суммируем деньги (аддитивны).
      consumptionValue: Number(it.consumption) * Number(it.price_per_unit),
      turnover: Number(it.turnover),
      daysOfStock: it.days_of_stock,
      value: Number(it.stock_value),
      abc: it.class as ABCClass,
    }))
  }, [report])

  const totalConsumptionValue = items.reduce((s, i) => s + i.consumptionValue, 0)
  const byClass = (cls: ABCClass) => items.filter(i => i.abc === cls)

  const chartData = useMemo(
    () =>
      items
        .filter(i => i.consumptionValue > 0)
        .map(item => ({
          name: item.raw.name.length > 14 ? item.raw.name.slice(0, 12) + '...' : item.raw.name,
          value: item.consumptionValue,
          abc: item.abc,
        })),
    [items]
  )

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  const recRange = getDateRange(period, customFrom, customTo)

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">ABC-анализ склада</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Категоризация ингредиентов по оборачиваемости</p>
        </div>
        <DatePeriodFilter
          period={period}
          onPeriodChange={setPeriod}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
        />
      </div>

      {items.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center">
          <p className="text-muted-foreground text-sm">Нет данных за выбранный период</p>
        </div>
      ) : (
        <>
          {/* Group summary */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {(['A', 'B', 'C'] as ABCClass[]).map(cls => {
              const group = byClass(cls)
              const groupValue = group.reduce((s, i) => s + i.consumptionValue, 0)
              return (
                <div key={cls} className="bg-card rounded-xl border border-border p-5">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`size-8 rounded-lg flex items-center justify-center font-bold text-base ${ABC_BG[cls]}`}>{cls}</span>
                    <span className="text-sm font-semibold text-foreground">{group.length} позиций</span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-1">{ABC_LABELS[cls]}</p>
                  <p className="text-lg font-bold text-foreground">Расход: {formatCurrency(groupValue)}</p>
                  <p className="text-xs text-muted-foreground">
                    {totalConsumptionValue > 0 ? ((groupValue / totalConsumptionValue) * 100).toFixed(1) : 0}% от общего расхода
                  </p>
                </div>
              )
            })}
          </div>

          {/* Bar chart — consumption */}
          {chartData.length > 0 && (
            <div className="bg-card rounded-xl border border-border p-5">
              <h2 className="text-sm font-semibold text-foreground mb-4">Расход за период</h2>
              <Suspense fallback={null}>
                <AbcInventoryChart data={chartData} />
              </Suspense>
            </div>
          )}

          {/* Table */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    {['Класс', 'Ингредиент', 'Категория', 'Остаток', 'Расход', 'Оборачиваемость', 'Дни запаса', 'Стоимость', 'Рекомендация'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => (
                    <tr key={item.raw.ingredient_id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3">
                        <span className={`size-6 rounded font-bold text-xs flex items-center justify-center ${ABC_BG[item.abc]}`}>
                          {item.abc}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-medium text-foreground">{item.raw.name}</td>
                      <td className="px-4 py-3">
                        {item.raw.category && (
                          <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">{item.raw.category}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-foreground">
                        {item.qty.toFixed(1)} {item.raw.unit ?? ''}
                      </td>
                      <td className="px-4 py-3 font-medium text-foreground">
                        {item.consumption.toFixed(1)} {item.raw.unit ?? ''}
                      </td>
                      <td className="px-4 py-3 text-foreground">{item.turnover.toFixed(1)}×</td>
                      <td className="px-4 py-3">
                        <span
                          className={`font-medium ${
                            item.daysOfStock < 7
                              ? 'text-destructive'
                              : item.daysOfStock <= 14
                                ? 'text-amber-600'
                                : 'text-emerald-600'
                          }`}
                        >
                          {item.daysOfStock >= 999 ? '∞' : `${item.daysOfStock} дн.`}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{formatCurrency(item.value)}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`text-xs font-medium ${
                            item.abc === 'A' ? 'text-emerald-600' : item.abc === 'C' ? 'text-red-600' : 'text-muted-foreground'
                          }`}
                        >
                          {item.raw.recommendation}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <InsightsRecommendations
        categories={['stock']}
        title="Аналитические инсайты"
        from={recRange.from ?? undefined}
        to={recRange.to ?? undefined}
      />
    </div>
  )
}
