'use client'

import { AlertTriangle, Package, Users, UtensilsCrossed, ArrowRight } from 'lucide-react'
import { formatCurrency } from '@/lib/helpers'
import type { Insight, InsightCategory, InsightSeverity } from '@/lib/queries/analytics'

const CAT: Record<InsightCategory, { label: string; icon: typeof Package; color: string }> = {
  menu: { label: 'Меню', icon: UtensilsCrossed, color: 'text-amber-600 dark:text-amber-400' },
  leak: { label: 'Утечки', icon: AlertTriangle, color: 'text-red-600 dark:text-red-400' },
  stock: { label: 'Склад', icon: Package, color: 'text-blue-600 dark:text-blue-400' },
  staff: { label: 'Персонал', icon: Users, color: 'text-violet-600 dark:text-violet-400' },
}

const SEV_BORDER: Record<InsightSeverity, string> = {
  high: 'border-l-red-500',
  medium: 'border-l-amber-500',
  low: 'border-l-slate-300 dark:border-l-slate-700',
}

export function InsightCard({ insight, compact }: { insight: Insight; compact?: boolean }) {
  const c = CAT[insight.category] ?? CAT.menu
  const Icon = c.icon
  return (
    <div className={`rounded-lg border border-l-4 ${SEV_BORDER[insight.severity]} bg-card p-3 sm:p-4`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className={`h-4 w-4 ${c.color}`} />
          <span>{c.label}</span>
        </div>
        {insight.impact > 0 && (
          <div className="text-right">
            <div className="text-sm font-semibold tabular-nums">{formatCurrency(insight.impact)}</div>
            {insight.impact_label && !compact && (
              <div className="text-[10px] leading-tight text-muted-foreground">{insight.impact_label}</div>
            )}
          </div>
        )}
      </div>
      <div className="mt-2 font-medium leading-snug">{insight.title}</div>
      {insight.detail && !compact && (
        <div className="mt-1 text-sm text-muted-foreground">{insight.detail}</div>
      )}
      {insight.action && (
        <div className="mt-2 flex items-start gap-1.5 text-sm">
          <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span className={compact ? 'text-muted-foreground' : ''}>{insight.action}</span>
        </div>
      )}
    </div>
  )
}
