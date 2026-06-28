'use client'

import { useEffect, useState } from 'react'
import { Lightbulb } from 'lucide-react'

import { fetchInsights, type Insight, type InsightCategory } from '@/lib/queries/analytics'
import { InsightCard } from '@/components/insight-card'

/**
 * Блок «Рекомендации» — инсайты, отфильтрованные по категориям, внизу
 * аналитической страницы. Сам грузит данные, скрывается, если находок нет.
 */
export function InsightsRecommendations({
  categories,
  from,
  to,
  title = 'Рекомендации',
}: {
  categories: InsightCategory[]
  from?: Date | string
  to?: Date | string
  title?: string
}) {
  const [items, setItems] = useState<Insight[]>([])
  const [loaded, setLoaded] = useState(false)
  const catKey = categories.join(',')
  const fromKey = from instanceof Date ? from.toISOString() : (from ?? '')
  const toKey = to instanceof Date ? to.toISOString() : (to ?? '')

  useEffect(() => {
    let alive = true
    fetchInsights({ from, to })
      .then(r => { if (alive) setItems(r.insights.filter(i => categories.includes(i.category))) })
      .catch(() => {})
      .finally(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromKey, toKey, catKey])

  if (!loaded || items.length === 0) return null

  return (
    <div className="mt-5 space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Lightbulb className="size-4 text-primary" /> {title}
      </div>
      <div className="space-y-2">
        {items.map(i => <InsightCard key={i.id} insight={i} />)}
      </div>
    </div>
  )
}
