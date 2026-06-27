'use client'

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lightbulb, ChevronRight } from 'lucide-react'

import { fetchInsights, type Insight } from '@/lib/queries/analytics'
import { InsightCard } from '@/components/insight-card'

/** Топ-3 инсайта на дашборде. Скрывается, если находок нет. */
export function InsightsWidget() {
  const navigate = useNavigate()
  const [top, setTop] = useState<Insight[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    const to = new Date()
    const from = new Date()
    from.setDate(to.getDate() - 30)
    fetchInsights({ from: from.toISOString(), to: to.toISOString() })
      .then(r => { if (alive) setTop(r.insights.slice(0, 3)) })
      .catch(() => {})
      .finally(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [])

  if (!loaded || top.length === 0) return null

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold">
          <Lightbulb className="size-4 text-primary" /> Инсайты
        </div>
        <button
          onClick={() => navigate('/analytics/insights')}
          className="flex items-center gap-0.5 text-sm text-primary hover:underline"
        >
          Все <ChevronRight className="size-4" />
        </button>
      </div>
      <div className="space-y-2">
        {top.map(i => <InsightCard key={i.id} insight={i} compact />)}
      </div>
    </div>
  )
}
