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

// parseLocalDate — разбирает и «2026-07-21», и полный ISO-таймстамп.
//
// Ключевой момент: голую дату `new Date('2026-07-21')` JS парсит как ПОЛНОЧЬ
// UTC, тогда как границы периода строятся в локальном времени. В ресторане на
// UTC+5 операция за сегодня превращалась в «сегодня 05:00 локального», и с
// полуночи до 5 утра фильтр «Сегодня» отдавал пустоту — при том что операции
// в базе были. Здесь голая дата разбирается как локальная полночь.
export function parseLocalDate(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return new Date(value)
}

// endOfDay — верхняя граница включительно.
function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
}

export function getDateRange(period: PeriodKey, customFrom?: string, customTo?: string): { from: Date | null; to: Date | null } {
  const now = new Date()
  // Верхняя граница — КОНЕЦ сегодняшнего дня, а не «сейчас». С `to = now`
  // операция, датированная сегодняшним числом (без времени), считалась
  // «позже, чем сейчас» и выпадала из выборки; операции с будущей датой
  // (диалог позволяет её выбрать) не показывались никогда.
  const to = endOfDay(now)

  switch (period) {
    case 'today': return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()), to }
    case 'week': return { from: new Date(now.getTime() - 7 * 86400000), to }
    case 'month': return { from: new Date(now.getTime() - 30 * 86400000), to }
    case 'quarter': return { from: new Date(now.getTime() - 90 * 86400000), to }
    case 'year': return { from: new Date(now.getTime() - 365 * 86400000), to }
    case 'all': return { from: null, to: null }
    case 'custom': return {
      from: customFrom ? parseLocalDate(customFrom) : null,
      to: customTo ? endOfDay(parseLocalDate(customTo)) : null,
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
    const d = parseLocalDate(dateStr)
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
                ? 'bg-primary text-primary-foreground shadow-sm'
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
