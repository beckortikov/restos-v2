'use client'

import { lazy, useState, useEffect, useMemo } from 'react'
import { formatCurrency } from '@/lib/helpers'
import type { ABCClass } from '@/lib/types'
import { fetchABCMenu, type ABCMenuReport, type EngineeringClass } from '@/lib/queries/analytics'
import { useAuth } from '@/lib/auth-store'
import { Download } from 'lucide-react'
import { exportToExcel } from '@/lib/export-excel'
import { DatePeriodFilter, getDateRange, type PeriodKey } from '@/components/date-period-filter'
import { InsightsRecommendations } from '@/components/insights-recommendations'
import { toast } from 'sonner'

const AbcMenuScatter = lazy(() => import('@/components/charts/abc-menu-scatter'))

const ABC_COLORS: Record<ABCClass, string> = {
  A: 'oklch(0.64 0.18 145)',
  B: 'var(--color-primary)',
  C: 'oklch(0.57 0.22 27)',
}

const ABC_BG: Record<ABCClass, string> = {
  A: 'bg-emerald-100 text-emerald-700',
  B: 'bg-primary/10 text-primary',
  C: 'bg-red-100 text-red-700',
}

const ABC_DESC: Record<ABCClass, string> = {
  A: 'Приоритет — дают 80% выручки',
  B: 'Резерв — следующие 15%',
  C: 'Слабые — нижние 5%',
}

interface UIItem {
  id: string
  name: string
  qty: number
  revenue: number
  cogs: number
  margin: number
  share: number
  abc: ABCClass
  me: EngineeringClass
}

const ME_LABEL: Record<Exclude<EngineeringClass, ''>, string> = {
  star: 'Звезда',
  workhorse: 'Рабочая лошадка',
  puzzle: 'Загадка',
  dog: 'Собака',
}

const ME_BADGE: Record<Exclude<EngineeringClass, ''>, string> = {
  star: 'bg-emerald-100 text-emerald-700',
  workhorse: 'bg-blue-100 text-blue-700',
  puzzle: 'bg-amber-100 text-amber-700',
  dog: 'bg-red-100 text-red-700',
}

const ME_EMOJI: Record<Exclude<EngineeringClass, ''>, string> = {
  star: '⭐',
  workhorse: '🐎',
  puzzle: '🧩',
  dog: '🐶',
}

const ME_DESC: Record<Exclude<EngineeringClass, ''>, string> = {
  star: 'Много продаж + высокая маржа',
  workhorse: 'Много продаж, низкая маржа',
  puzzle: 'Мало продаж, высокая маржа',
  dog: 'Мало продаж + низкая маржа',
}

// qty может быть дробным: у весовых блюд бэк нормализует к порциям (qty/unit_size),
// поэтому 2.5 порц. — валидно. Целые показываем без хвоста.
const fmtQty = (v: number) => (v % 1 === 0 ? String(v) : v.toFixed(1))

export default function AbcMenuPage() {
  const { canDo } = useAuth()
  const [report, setReport] = useState<ABCMenuReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  useEffect(() => {
    setLoading(true)
    const { from, to } = getDateRange(period, customFrom, customTo)
    fetchABCMenu({ from: from ?? undefined, to: to ?? undefined })
      .then(setReport)
      .catch(() => toast.error('Ошибка загрузки ABC-анализа'))
      .finally(() => setLoading(false))
  }, [period, customFrom, customTo])

  const items: UIItem[] = useMemo(() => {
    if (!report) return []
    return report.items.map(it => ({
      id: it.menu_item_id,
      name: it.name,
      qty: Number(it.qty),
      revenue: Number(it.revenue),
      cogs: Number(it.cogs),
      margin: Number(it.margin_percent),
      share: Number(it.share),
      abc: it.class,
      me: (it.engineering_class ?? '') as EngineeringClass,
    }))
  }, [report])

  const summaryKPIs = useMemo(() => {
    if (items.length === 0) return null
    const aItems = items.filter(i => i.abc === 'A')
    const bItems = items.filter(i => i.abc === 'B')
    const cItems = items.filter(i => i.abc === 'C')
    const totalRevenue = items.reduce((s, i) => s + i.revenue, 0)
    const totalCogs = items.reduce((s, i) => s + i.cogs, 0)
    const avgFoodCost = totalRevenue > 0 ? (totalCogs / totalRevenue) * 100 : 0
    const aRevenue = aItems.reduce((s, i) => s + i.revenue, 0)
    const aRevenueShare = totalRevenue > 0 ? (aRevenue / totalRevenue) * 100 : 0
    return {
      avgFoodCost,
      aCount: aItems.length,
      bCount: bItems.length,
      cCount: cItems.length,
      aRevenueShare,
    }
  }, [items])

  const recommendations = useMemo(() => {
    const recs: { type: 'warning' | 'tip' | 'opportunity'; text: string }[] = []
    for (const item of items) {
      if (item.abc === 'C' && item.margin < 30 && item.revenue > 0) {
        recs.push({
          type: 'warning',
          text: `⚠️ Рекомендуем убрать ${item.name} — ${item.share.toFixed(1)}% выручки, маржа ${item.margin.toFixed(1)}%`,
        })
      }
      if (item.abc === 'A' && item.margin < 25) {
        recs.push({
          type: 'tip',
          text: `💡 ${item.name} — лидер продаж, но маржа всего ${item.margin.toFixed(1)}%. Рассмотрите повышение цены`,
        })
      }
      if (item.abc === 'B' && item.margin > 60) {
        recs.push({
          type: 'opportunity',
          text: `📈 ${item.name} — высокая маржа ${item.margin.toFixed(1)}%. Продвигайте активнее`,
        })
      }
    }
    return recs
  }, [items])

  if (!canDo('analytics.view')) {
    return <div className="p-6 text-center text-muted-foreground">Нет доступа</div>
  }

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  const byClass = (cls: ABCClass) => items.filter((i) => i.abc === cls)

  const scatterData = items.map((item) => ({
    x: item.qty,
    y: item.margin,
    z: item.revenue,
    name: item.name,
    abc: item.abc,
  }))

  const totalRevenueAll = report ? Number(report.total_revenue) : 0
  const hasNoSales = totalRevenueAll === 0
  const recRange = getDateRange(period, customFrom, customTo)

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      {hasNoSales && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
          <span className="text-2xl shrink-0">📊</span>
          <div className="text-sm text-amber-900">
            <p className="font-semibold">Нет продаж за выбранный период</p>
            <p className="text-amber-700 mt-0.5">
              ABC-анализ нуждается в данных о реальных заказах. Выберите другой период или дождитесь первых продаж.
            </p>
          </div>
        </div>
      )}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">ABC-анализ меню</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Какие блюда дают 80% выручки</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              exportToExcel(
                items.map(i => ({ ...i })),
                [
                  { key: 'name', header: 'Блюдо' },
                  { key: 'qty', header: 'Продано (порц.)', format: (v) => Number(Number(v).toFixed(2)) },
                  { key: 'revenue', header: 'Выручка' },
                  { key: 'cogs', header: 'Себестоимость' },
                  { key: 'margin', header: 'Маржа %', format: (v) => Number(Number(v).toFixed(1)) },
                  { key: 'share', header: 'Доля %', format: (v) => Number(Number(v).toFixed(1)) },
                  { key: 'abc', header: 'ABC класс' },
                ],
                'ABC-анализ'
              )
            }}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors"
          >
            <Download className="size-3.5" />
            Excel
          </button>
          <DatePeriodFilter period={period} onPeriodChange={setPeriod} customFrom={customFrom} customTo={customTo} onCustomFromChange={setCustomFrom} onCustomToChange={setCustomTo} />
        </div>
      </div>

      {/* KPI-сводка — сразу под шапкой: владелец смотрит эти цифры первыми
          (раньше блок висел в самом низу под таблицей). */}
      {summaryKPIs && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-muted/30 rounded-lg p-4">
            <p className="text-xs text-muted-foreground mb-1">Средний Food Cost</p>
            <p className="text-2xl font-bold text-foreground">{(summaryKPIs.avgFoodCost || 0).toFixed(1)}%</p>
          </div>
          <div className="bg-muted/30 rounded-lg p-4">
            <p className="text-xs text-muted-foreground mb-1">Доля A-класса в выручке</p>
            <p className="text-2xl font-bold text-emerald-600">{(summaryKPIs.aRevenueShare || 0).toFixed(1)}%</p>
          </div>
          <div className="bg-muted/30 rounded-lg p-4">
            <p className="text-xs text-muted-foreground mb-1">Блюд по классам</p>
            <p className="text-2xl font-bold text-foreground">
              <span className="text-emerald-600">{summaryKPIs.aCount}A</span>
              {' / '}
              <span className="text-primary">{summaryKPIs.bCount}B</span>
              {' / '}
              <span className="text-red-600">{summaryKPIs.cCount}C</span>
            </p>
          </div>
        </div>
      )}

      {/* ABC group summary — доля класса в выручке + топ-блюда (без стены имён) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {(['A', 'B', 'C'] as ABCClass[]).map((cls) => {
          const group = byClass(cls) // items уже отсортированы по выручке desc
          const groupRevenue = group.reduce((s, i) => s + i.revenue, 0)
          const groupShare = totalRevenueAll > 0 ? (groupRevenue / totalRevenueAll) * 100 : 0
          const top = group.slice(0, 3)
          const rest = group.length - top.length
          return (
            <div key={cls} className="bg-card rounded-xl border border-border p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className={`size-8 rounded-lg flex items-center justify-center font-bold text-base ${ABC_BG[cls]}`}>{cls}</span>
                <div>
                  <p className="text-sm font-semibold text-foreground">{group.length} блюд</p>
                  <p className="text-xs text-muted-foreground">{ABC_DESC[cls]}</p>
                </div>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-xl font-bold text-foreground">{formatCurrency(groupRevenue)}</p>
                <p className="text-xs font-medium text-muted-foreground tabular-nums">{groupShare.toFixed(0)}% выручки</p>
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${Math.min(groupShare, 100)}%`, backgroundColor: ABC_COLORS[cls] }} />
              </div>
              {top.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {top.map((i) => (
                    <span key={i.id} className="max-w-[10rem] truncate rounded-md bg-muted px-2 py-0.5 text-xs text-foreground">{i.name}</span>
                  ))}
                  {rest > 0 && <span className="px-1 py-0.5 text-xs text-muted-foreground">+{rest} ещё</span>}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Menu Engineering quadrants */}
      {items.some(i => i.me !== '') && (
        <div className="bg-card rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold text-foreground mb-1">Menu Engineering (Boston Matrix)</h2>
          <p className="text-xs text-muted-foreground mb-4">Классификация по медианам объёма продаж и маржи</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(['star', 'workhorse', 'puzzle', 'dog'] as const).map(cls => {
              const list = items.filter(i => i.me === cls)
              return (
                <div key={cls} className={`rounded-lg p-4 border ${ME_BADGE[cls]} border-current/20`}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-2xl">{ME_EMOJI[cls]}</span>
                    <div>
                      <p className="text-sm font-bold">{ME_LABEL[cls]}</p>
                      <p className="text-[10px] opacity-80">{ME_DESC[cls]}</p>
                    </div>
                  </div>
                  <p className="text-2xl font-bold">{list.length}</p>
                  <p className="text-[10px] opacity-80 mt-0.5">блюд</p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Scatter chart: qty vs margin — Boston Matrix с медианными осями */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-1">Матрица: Объём продаж × Маржинальность</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Размер круга = выручка блюда. Пунктир — медианы продаж и маржи, они делят поле на 4 квадранта Menu Engineering.
        </p>
        <AbcMenuScatter data={scatterData} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-3 justify-center text-xs text-muted-foreground">
          {(['A', 'B', 'C'] as ABCClass[]).map((cls) => (
            <span key={cls} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full inline-block" style={{ backgroundColor: ABC_COLORS[cls] }} />
              Группа {cls}
            </span>
          ))}
          <span className="text-border">|</span>
          {(['star', 'workhorse', 'puzzle', 'dog'] as const).map((cls) => (
            <span key={cls} className="flex items-center gap-1">
              <span>{ME_EMOJI[cls]}</span>{ME_LABEL[cls]}
            </span>
          ))}
        </div>
      </div>

      {/* Full table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {['Класс', 'Блюдо', 'Продано', 'Выручка', 'Доля', 'Маржа', 'Класс ME'].map((h) => (
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
                <td className="px-4 py-3 text-foreground tabular-nums">{fmtQty(item.qty)} порц.</td>
                <td className="px-4 py-3 font-medium text-foreground">{formatCurrency(item.revenue)}</td>
                <td className="px-4 py-3 text-muted-foreground">{item.share.toFixed(1)}%</td>
                <td className="px-4 py-3">
                  <span className={`text-sm font-semibold ${item.margin >= 60 ? 'text-emerald-600' : item.margin >= 40 ? 'text-amber-600' : 'text-destructive'}`}>
                    {(item.margin || 0).toFixed(1)}%
                  </span>
                </td>
                <td className="px-4 py-3">
                  {item.me === '' ? (
                    <span className="text-muted-foreground text-xs">—</span>
                  ) : (
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${ME_BADGE[item.me]}`}>
                      <span>{ME_EMOJI[item.me]}</span>
                      {ME_LABEL[item.me]}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">Нет данных за выбранный период</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">Рекомендации</h2>
          <div className="space-y-3">
            {recommendations.map((rec, idx) => (
              <div
                key={idx}
                className={`rounded-lg p-4 text-sm font-medium ${
                  rec.type === 'warning'
                    ? 'bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800'
                    : rec.type === 'tip'
                    ? 'bg-blue-50 text-blue-800 border border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800'
                    : 'bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800'
                }`}
              >
                {rec.text}
              </div>
            ))}
          </div>
        </div>
      )}

      <InsightsRecommendations
        categories={['menu', 'leak', 'staff']}
        title="Аналитические инсайты"
        from={recRange.from ?? undefined}
        to={recRange.to ?? undefined}
      />
    </div>
  )
}
