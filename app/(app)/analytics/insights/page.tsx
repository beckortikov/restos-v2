'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Lightbulb } from 'lucide-react'

import { formatCurrency } from '@/lib/helpers'
import { fetchInsights, type Insight, type InsightCategory } from '@/lib/queries/analytics'
import { InsightCard } from '@/components/insight-card'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

type RangeKey = '7d' | '30d' | '90d' | '365d'
const RANGES: { key: RangeKey; label: string; days: number }[] = [
  { key: '7d', label: '7 дней', days: 7 },
  { key: '30d', label: '30 дней', days: 30 },
  { key: '90d', label: '90 дней', days: 90 },
  { key: '365d', label: 'Год', days: 365 },
]
const CATS: { key: InsightCategory | 'all'; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'menu', label: 'Меню' },
  { key: 'leak', label: 'Утечки' },
  { key: 'stock', label: 'Склад' },
  { key: 'staff', label: 'Персонал' },
]

function rangeDates(days: number) {
  const to = new Date()
  const from = new Date()
  from.setDate(to.getDate() - days)
  return { from: from.toISOString(), to: to.toISOString() }
}

export default function InsightsPage() {
  const [range, setRange] = useState<RangeKey>('30d')
  const [cat, setCat] = useState<InsightCategory | 'all'>('all')
  const [insights, setInsights] = useState<Insight[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    const days = RANGES.find(r => r.key === range)!.days
    fetchInsights(rangeDates(days))
      .then(r => { if (alive) setInsights(r.insights) })
      .catch(e => { if (alive) toast.error('Не удалось загрузить инсайты: ' + (e?.message ?? e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [range])

  const filtered = useMemo(
    () => cat === 'all' ? insights : insights.filter(i => i.category === cat),
    [insights, cat],
  )
  const totalImpact = useMemo(() => filtered.reduce((s, i) => s + (i.impact > 0 ? i.impact : 0), 0), [filtered])

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
          <Lightbulb className="size-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Инсайты</h1>
          <p className="text-sm text-muted-foreground">Что улучшить прямо сейчас — по убыванию эффекта в деньгах</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border bg-card p-0.5">
          {RANGES.map(r => (
            <Button key={r.key} size="sm" variant={range === r.key ? 'default' : 'ghost'} className="h-8" onClick={() => setRange(r.key)}>
              {r.label}
            </Button>
          ))}
        </div>
        <div className="inline-flex flex-wrap rounded-lg border bg-card p-0.5">
          {CATS.map(c => (
            <Button key={c.key} size="sm" variant={cat === c.key ? 'default' : 'ghost'} className="h-8" onClick={() => setCat(c.key)}>
              {c.label}
            </Button>
          ))}
        </div>
      </div>

      {totalImpact > 0 && (
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <span className="text-sm text-muted-foreground">Суммарный потенциал/потери по найденному</span>
            <span className="text-xl font-bold tabular-nums">{formatCurrency(totalImpact)}</span>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex h-60 items-center justify-center text-muted-foreground">Анализ данных…</div>
      ) : filtered.length === 0 ? (
        <div className="flex h-60 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Lightbulb className="size-8 opacity-40" />
          <span>Пока всё ровно — критичных находок нет.</span>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(i => <InsightCard key={i.id} insight={i} />)}
        </div>
      )}
    </div>
  )
}
