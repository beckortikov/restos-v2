'use client'

import { getPresetRange, type RangePreset } from '@/components/finance/date-range-presets'

// Компактный фильтр по датам для складских списков (Списания, История).
// Пресет-чипы в тон остальным фильтрам этих экранов — без календаря, тач-
// дружелюбно. «Всё время» = null (без ограничения по дате). Наружу — диапазон
// YYYY-MM-DD либо null.

export type DateFilterValue = { from: string; to: string } | null

const CHIPS: { key: RangePreset | 'all'; label: string }[] = [
  { key: 'all', label: 'Всё время' },
  { key: 'today', label: 'Сегодня' },
  { key: 'week', label: 'Неделя' },
  { key: 'month', label: 'Месяц' },
  { key: 'quarter', label: 'Квартал' },
]

// Локальная YYYY-MM-DD из ISO-строки записи — сравниваем в том же поясе, что и
// пресеты (getPresetRange считает от локального «сегодня»).
export function localYmd(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function inRange(iso: string, range: DateFilterValue): boolean {
  if (!range) return true
  const day = localYmd(iso)
  return !!day && day >= range.from && day <= range.to
}

export function DateFilter({ value, onChange }: {
  value: DateFilterValue
  onChange: (v: DateFilterValue) => void
}) {
  const isActive = (key: RangePreset | 'all') => {
    if (key === 'all') return value === null
    if (!value) return false
    const r = getPresetRange(key as RangePreset)
    return r.from === value.from && r.to === value.to
  }

  return (
    <div className="flex flex-wrap gap-2">
      {CHIPS.map((c) => {
        const active = isActive(c.key)
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onChange(c.key === 'all' ? null : getPresetRange(c.key as RangePreset))}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              active
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card border-border text-foreground hover:bg-muted'
            }`}
          >
            {c.label}
          </button>
        )
      })}
    </div>
  )
}
