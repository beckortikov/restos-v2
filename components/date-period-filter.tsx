'use client'

import { useState } from 'react'
import { Calendar } from 'lucide-react'

export type PeriodKey = 'today' | 'week' | 'month' | 'quarter' | 'year' | 'all' | 'custom'

const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: 'today', label: 'Сегодня' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: 'quarter', label: 'Квартал' },
  { value: 'year', label: 'Год' },
  { value: 'all', label: 'Всё время' },
  { value: 'custom', label: 'Свой' },
]

export function getDateRange(period: PeriodKey, customFrom?: string, customTo?: string): { from: Date | null; to: Date | null } {
  const now = new Date()
  const to = now

  switch (period) {
    case 'today': return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()), to }
    case 'week': return { from: new Date(now.getTime() - 7 * 86400000), to }
    case 'month': return { from: new Date(now.getTime() - 30 * 86400000), to }
    case 'quarter': return { from: new Date(now.getTime() - 90 * 86400000), to }
    case 'year': return { from: new Date(now.getTime() - 365 * 86400000), to }
    case 'all': return { from: null, to: null }
    case 'custom': return {
      from: customFrom ? new Date(customFrom) : null,
      to: customTo ? new Date(customTo + 'T23:59:59') : null,
    }
    default: return { from: null, to: null }
  }
}

export function filterByDateRange<T>(items: T[], getDate: (item: T) => string | undefined, period: PeriodKey, customFrom?: string, customTo?: string): T[] {
  if (period === 'all') return items
  const { from, to } = getDateRange(period, customFrom, customTo)
  return items.filter(item => {
    const dateStr = getDate(item)
    if (!dateStr) return false
    const d = new Date(dateStr)
    if (from && d < from) return false
    if (to && d > to) return false
    return true
  })
}

interface DatePeriodFilterProps {
  period: PeriodKey
  onPeriodChange: (period: PeriodKey) => void
  customFrom?: string
  customTo?: string
  onCustomFromChange?: (v: string) => void
  onCustomToChange?: (v: string) => void
  compact?: boolean
  periods?: PeriodKey[] // subset of periods to show
}

export function DatePeriodFilter({
  period, onPeriodChange,
  customFrom, customTo, onCustomFromChange, onCustomToChange,
  compact = false,
  periods,
}: DatePeriodFilterProps) {
  const options = periods
    ? PERIOD_OPTIONS.filter(o => periods.includes(o.value))
    : PERIOD_OPTIONS

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex gap-1 bg-muted/50 p-1 rounded-xl">
        {options.map(opt => (
          <button
            key={opt.value}
            onClick={() => onPeriodChange(opt.value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
              period === opt.value
                ? 'bg-card shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {period === 'custom' && (
        <div className="flex items-center gap-1.5">
          <Calendar className="size-3.5 text-muted-foreground" />
          <input
            type="date"
            value={customFrom || ''}
            onChange={e => onCustomFromChange?.(e.target.value)}
            className={`px-2 py-1.5 bg-card border border-border rounded-lg text-xs ${compact ? 'w-28' : 'w-32'}`}
          />
          <span className="text-xs text-muted-foreground">—</span>
          <input
            type="date"
            value={customTo || ''}
            onChange={e => onCustomToChange?.(e.target.value)}
            className={`px-2 py-1.5 bg-card border border-border rounded-lg text-xs ${compact ? 'w-28' : 'w-32'}`}
          />
        </div>
      )}
    </div>
  )
}
