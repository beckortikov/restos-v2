'use client'

import { lazy, Suspense } from 'react'
import { useState, useEffect, useMemo } from 'react'
import { formatCurrency } from '@/lib/helpers'
import type { ABCClass, Ingredient, StockMovement } from '@/lib/types'
import { fetchIngredients, fetchStockMovements } from '@/lib/queries'
import { DatePeriodFilter, filterByDateRange, type PeriodKey } from '@/components/date-period-filter'

const AbcInventoryChart = lazy(() => import('@/components/charts/abc-inventory-chart'))

interface ABCItem extends Ingredient {
  consumption: number    // total consumed in period
  turnover: number       // consumption / current stock
  daysOfStock: number    // how many days stock will last
  value: number          // stock value (qty * price)
  abc: ABCClass
  recommendation: string
}

function computeInventoryABC(ingredients: Ingredient[], movements: StockMovement[]): ABCItem[] {
  // Sum consumption per ingredient (out/batch movements = negative qty)
  const consumptionMap: Record<string, number> = {}
  for (const m of movements) {
    if (['out', 'batch', 'semi'].includes(m.type) && m.ingredientId) {
      consumptionMap[m.ingredientId] = (consumptionMap[m.ingredientId] || 0) + Math.abs(m.qty)
    }
  }

  // Calculate turnover for each ingredient
  const items: ABCItem[] = ingredients.map(i => {
    const consumption = consumptionMap[i.id] || 0
    const turnover = i.qty > 0 ? consumption / i.qty : consumption > 0 ? 999 : 0
    const daysOfStock = consumption > 0 ? Math.round((i.qty / consumption) * 30) : i.qty > 0 ? 999 : 0
    const value = i.qty * i.pricePerUnit
    return { ...i, consumption, turnover, daysOfStock, value, abc: 'C' as ABCClass, recommendation: '' }
  })

  // Sort by consumption (highest first) and classify ABC
  items.sort((a, b) => b.consumption - a.consumption)
  const totalConsumption = items.reduce((s, i) => s + i.consumption, 0)

  let cumulative = 0
  for (const item of items) {
    cumulative += item.consumption
    const share = totalConsumption > 0 ? (cumulative / totalConsumption) * 100 : 0
    item.abc = share <= 80 ? 'A' : share <= 95 ? 'B' : 'C'

    // Recommendations
    if (item.abc === 'A') {
      item.recommendation = item.daysOfStock < 7 ? 'Срочно закупить' : 'Держать запас'
    } else if (item.abc === 'B') {
      item.recommendation = 'Стандартные закупки'
    } else {
      item.recommendation = item.consumption === 0 ? 'Нет расхода — пересмотреть' : 'Уменьшить закупки'
    }
  }

  return items
}

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

export default function AbcInventoryPage() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [movements, setMovements] = useState<StockMovement[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  useEffect(() => {
    Promise.all([fetchIngredients(), fetchStockMovements()])
      .then(([i, m]) => { setIngredients(i); setMovements(m) })
      .finally(() => setLoading(false))
  }, [])

  const filteredMovements = useMemo(() =>
    filterByDateRange(movements, m => m.timestamp, period, customFrom, customTo),
    [movements, period, customFrom, customTo]
  )

  const items = useMemo(() => computeInventoryABC(ingredients, filteredMovements), [ingredients, filteredMovements])
  const totalConsumption = items.reduce((s, i) => s + i.consumption, 0)

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  const byClass = (cls: ABCClass) => items.filter((i) => i.abc === cls)

  const chartData = items.filter(i => i.consumption > 0).map((item) => ({
    name: item.name.length > 14 ? item.name.slice(0, 12) + '...' : item.name,
    value: item.consumption,
    abc: item.abc,
  }))

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">ABC-анализ склада</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Категоризация ингредиентов по оборачиваемости</p>
        </div>
        <DatePeriodFilter period={period} onPeriodChange={setPeriod} customFrom={customFrom} customTo={customTo} onCustomFromChange={setCustomFrom} onCustomToChange={setCustomTo} />
      </div>

      {/* Group summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {(['A', 'B', 'C'] as ABCClass[]).map((cls) => {
          const group = byClass(cls)
          const groupConsumption = group.reduce((s, i) => s + i.consumption, 0)
          return (
            <div key={cls} className="bg-card rounded-xl border border-border p-5">
              <div className="flex items-center gap-2 mb-2">
                <span className={`size-8 rounded-lg flex items-center justify-center font-bold text-base ${ABC_BG[cls]}`}>{cls}</span>
                <span className="text-sm font-semibold text-foreground">{group.length} позиций</span>
              </div>
              <p className="text-xs text-muted-foreground mb-1">{ABC_LABELS[cls]}</p>
              <p className="text-lg font-bold text-foreground">Расход: {groupConsumption.toFixed(1)}</p>
              <p className="text-xs text-muted-foreground">{totalConsumption > 0 ? ((groupConsumption / totalConsumption) * 100).toFixed(1) : 0}% от общего расхода</p>
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
              {['Класс', 'Ингредиент', 'Категория', 'Остаток', 'Расход', 'Оборачиваемость', 'Дни запаса', 'Стоимость', 'Рекомендация'].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3">
                  <span className={`size-6 rounded font-bold text-xs flex items-center justify-center ${ABC_BG[item.abc]}`}>{item.abc}</span>
                </td>
                <td className="px-4 py-3 font-medium text-foreground">{item.name}</td>
                <td className="px-4 py-3">
                  <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">{item.category}</span>
                </td>
                <td className="px-4 py-3 text-foreground">{item.qty.toFixed(1)} {item.unit}</td>
                <td className="px-4 py-3 font-medium text-foreground">{item.consumption.toFixed(1)} {item.unit}</td>
                <td className="px-4 py-3 text-foreground">{item.turnover.toFixed(1)}×</td>
                <td className="px-4 py-3">
                  <span className={`font-medium ${item.daysOfStock < 7 ? 'text-destructive' : item.daysOfStock < 14 ? 'text-amber-600' : 'text-foreground'}`}>
                    {item.daysOfStock >= 999 ? '∞' : `${item.daysOfStock} дн.`}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{formatCurrency(item.value)}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs font-medium ${item.abc === 'A' ? 'text-emerald-600' : item.abc === 'C' ? 'text-red-600' : 'text-muted-foreground'}`}>
                    {item.recommendation}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}
