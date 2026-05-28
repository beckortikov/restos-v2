'use client'

import { lazy, Suspense } from 'react'
import { useState, useEffect, useMemo } from 'react'
import { formatCurrency, calcLineCogs } from '@/lib/helpers'
import { dMul, dDiv, dSub } from '@/lib/decimal'
import { useAuth } from '@/lib/auth-store'
import { Download } from 'lucide-react'
import { exportToExcel } from '@/lib/export-excel'
import type { Order, MenuItem, Ingredient } from '@/lib/types'
import { fetchOrders, fetchMenuItems, fetchIngredients } from '@/lib/queries'

const FoodCostBarChart = lazy(() => import('@/components/charts/food-cost-bar-chart'))

const FoodCostTrendChart = lazy(() => import('@/components/charts/food-cost-trend-chart'))

const IngredientStockChart = lazy(() => import('@/components/charts/ingredient-stock-chart'))

type Period = 'month' | 'quarter' | 'all'

function filterByPeriod(orders: Order[], period: Period): Order[] {
  if (period === 'all') return orders
  const now = new Date()
  const cutoff = new Date()
  if (period === 'month') cutoff.setMonth(now.getMonth() - 1)
  else cutoff.setMonth(now.getMonth() - 3)
  return orders.filter((o) => new Date(o.createdAt) >= cutoff)
}

export default function FoodCostPage() {
  const { canDo } = useAuth()
  const [orders, setOrders] = useState<Order[]>([])
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('all')

  useEffect(() => {
    Promise.all([fetchOrders(), fetchMenuItems(), fetchIngredients()])
      .then(([o, m, i]) => {
        setOrders(o)
        setMenuItems(m)
        setIngredients(i)
      })
      .finally(() => setLoading(false))
  }, [])

  const closedOrders = useMemo(
    () => filterByPeriod(orders.filter((o) => o.status === 'done'), period),
    [orders, period]
  )

  // KPI calculations
  const kpis = useMemo(() => {
    const totalRevenue = closedOrders.reduce((s, o) => s + o.total, 0)
    const totalCogs = closedOrders.reduce(
      (s, o) => s + (o.items || []).reduce((is, item) => is + calcLineCogs(Number(item.cogs) || 0, Number(item.qty) || 0, item.unit, item.unitSize), 0),
      0
    )
    const avgFoodCostPct = totalRevenue > 0 ? dMul(dDiv(totalCogs, totalRevenue), 100) : 0

    const itemCosts = menuItems.map((m) => ({
      name: m.name,
      cogs: Number(m.cogs) || 0,
      price: Number(m.price) || 0,
      marginPct: m.price > 0 ? dMul(dDiv(dSub(m.price, m.cogs), m.price), 100) : 0,
      foodCostPct: m.price > 0 ? dMul(dDiv(m.cogs, m.price), 100) : 0,
    }))

    const mostExpensive = itemCosts.reduce(
      (max, i) => (i.cogs > max.cogs ? i : max),
      itemCosts[0] || { name: '-', cogs: 0, price: 0, marginPct: 0, foodCostPct: 0 }
    )

    const worstMargin = itemCosts
      .filter((i) => i.price > 0)
      .reduce(
        (worst, i) => (i.marginPct < worst.marginPct ? i : worst),
        itemCosts.filter((i) => i.price > 0)[0] || { name: '-', cogs: 0, price: 0, marginPct: 100, foodCostPct: 0 }
      )

    return { avgFoodCostPct, totalCogs, mostExpensive, worstMargin }
  }, [closedOrders, menuItems])

  // Food cost per dish bar chart
  const foodCostByDish = useMemo(() => {
    return menuItems
      .filter((m) => m.price > 0)
      .map((m) => ({
        name: m.name.length > 20 ? m.name.slice(0, 18) + '...' : m.name,
        foodCostPct: (m.cogs / m.price) * 100,
        price: m.price,
        cogs: m.cogs,
      }))
      .sort((a, b) => b.foodCostPct - a.foodCostPct)
  }, [menuItems])

  // Monthly food cost trend
  const monthlyTrend = useMemo(() => {
    const monthMap: Record<string, { revenue: number; cogs: number }> = {}
    closedOrders.forEach((o) => {
      const d = new Date(o.createdAt)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      if (!monthMap[key]) monthMap[key] = { revenue: 0, cogs: 0 }
      monthMap[key].revenue += o.total
      monthMap[key].cogs += o.items.reduce((s, item) => s + calcLineCogs(item.cogs, item.qty, item.unit, item.unitSize), 0)
    })
    return Object.entries(monthMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, { revenue, cogs }]) => ({
        month,
        foodCostPct: revenue > 0 ? (cogs / revenue) * 100 : 0,
      }))
  }, [closedOrders])

  // Top 10 ingredients by stock value
  const topIngredients = useMemo(() => {
    return ingredients
      .map((i) => ({
        name: i.name.length > 14 ? i.name.slice(0, 12) + '...' : i.name,
        fullName: i.name,
        value: i.qty * i.pricePerUnit,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
  }, [ingredients])

  // Recommendations
  const recommendations = useMemo(() => {
    const recs: { emoji: string; text: string; type: 'danger' | 'success' | 'warning' }[] = []

    menuItems.forEach((m) => {
      if (m.price <= 0) return
      const fc = (m.cogs / m.price) * 100
      if (fc > 40) {
        recs.push({
          emoji: '🔴',
          text: `${m.name} — food cost ${fc.toFixed(1)}%. Пересмотрите рецептуру или поставщика`,
          type: 'danger',
        })
      }
      if (fc < 15) {
        recs.push({
          emoji: '💰',
          text: `${m.name} — высокая маржа ${(100 - fc).toFixed(1)}%. Можно использовать для акций`,
          type: 'success',
        })
      }
    })

    const avgStockValue =
      ingredients.length > 0
        ? ingredients.reduce((s, i) => s + i.qty * i.pricePerUnit, 0) / ingredients.length
        : 0

    ingredients.forEach((i) => {
      const sv = i.qty * i.pricePerUnit
      if (sv > avgStockValue * 3 && avgStockValue > 0) {
        recs.push({
          emoji: '📦',
          text: `${i.name} — высокий запас ${formatCurrency(sv)}. Оптимизируйте закупки`,
          type: 'warning',
        })
      }
    })

    return recs
  }, [menuItems, ingredients])

  if (!canDo('analytics.view')) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <p className="text-muted-foreground">Нет доступа</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Анализ себестоимости</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Food cost и расходы на ингредиенты</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              exportToExcel(
                foodCostByDish.map(d => ({ ...d })),
                [
                  { key: 'name', header: 'Блюдо' },
                  { key: 'price', header: 'Цена' },
                  { key: 'cogs', header: 'Себестоимость' },
                  { key: 'foodCostPct', header: 'Food Cost %', format: (v) => Number(Number(v).toFixed(1)) },
                ],
                'Себестоимость'
              )
            }}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors"
          >
            <Download className="size-3.5" />
            Excel
          </button>
        <div className="flex gap-1 bg-muted/50 p-1 rounded-lg">
          {([['month', 'Месяц'], ['quarter', 'Квартал'], ['all', 'Все время']] as [Period, string][]).map(
            ([key, label]) => (
              <button
                key={key}
                onClick={() => setPeriod(key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  period === key
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
              </button>
            )
          )}
        </div>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-card rounded-xl border border-border p-5">
          <p className="text-xs text-muted-foreground font-medium">Средний Food Cost %</p>
          <p className="text-2xl font-bold text-foreground mt-1">{(kpis.avgFoodCostPct || 0).toFixed(1)}%</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-5">
          <p className="text-xs text-muted-foreground font-medium">Общая себестоимость</p>
          <p className="text-2xl font-bold text-foreground mt-1">{formatCurrency(kpis.totalCogs)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-5">
          <p className="text-xs text-muted-foreground font-medium">Самое дорогое блюдо</p>
          <p className="text-lg font-bold text-foreground mt-1">{kpis.mostExpensive.name}</p>
          <p className="text-xs text-muted-foreground">{formatCurrency(kpis.mostExpensive.cogs)} COGS</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-5">
          <p className="text-xs text-muted-foreground font-medium">Блюдо с худшей маржой</p>
          <p className="text-lg font-bold text-foreground mt-1">{kpis.worstMargin.name}</p>
          <p className="text-xs text-muted-foreground">Маржа: {(kpis.worstMargin.marginPct || 0).toFixed(1)}%</p>
        </div>
      </div>

      {/* Food cost by dish */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Food Cost по блюдам (%)</h2>
        <FoodCostBarChart data={foodCostByDish} />
      </div>

      {/* Monthly trend */}
      {monthlyTrend.length > 1 && (
        <div className="bg-card rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">Динамика Food Cost по месяцам</h2>
          <FoodCostTrendChart data={monthlyTrend} />
        </div>
      )}

      {/* Top ingredients by stock value */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Топ-10 ингредиентов по стоимости запасов</h2>
        <IngredientStockChart data={topIngredients} />
      </div>

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">Рекомендации</h2>
          <div className="space-y-2">
            {recommendations.map((rec, i) => (
              <div
                key={i}
                className={`px-4 py-3 rounded-lg text-sm ${
                  rec.type === 'danger'
                    ? 'bg-destructive/10 text-destructive'
                    : rec.type === 'success'
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400'
                      : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400'
                }`}
              >
                {rec.emoji} {rec.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
