'use client'

import { useState } from 'react'
import { CalendarDays } from 'lucide-react'
import type { DateRange } from 'react-day-picker'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { getPresetRange, type RangePreset } from '@/components/finance/date-range-presets'

// Красивый range-picker: кнопка с текущим диапазоном → popover с быстрыми
// пресетами слева и календарём (react-day-picker, mode=range) справа. Значения
// наружу — строки YYYY-MM-DD, как в остальном приложении.

function pad(n: number): string { return String(n).padStart(2, '0') }
function ymd(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function parseYmd(s: string): Date | undefined {
  if (!s) return undefined
  const [y, m, d] = s.split('-').map(Number)
  if (!y || !m || !d) return undefined
  return new Date(y, m - 1, d)
}
function fmtShort(s: string): string {
  const d = parseYmd(s)
  return d ? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : ''
}
function fmtLong(s: string): string {
  const d = parseYmd(s)
  return d ? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : ''
}

const QUICK: { key: RangePreset; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: 'week', label: 'Неделя' },
  { key: 'month', label: 'Месяц' },
  { key: 'quarter', label: 'Квартал' },
  { key: 'year', label: 'Год' },
]

interface Props {
  from: string
  to: string
  onChange: (range: { from: string; to: string }) => void
  /** Максимальная выбираемая дата (YYYY-MM-DD) — обычно сегодня. */
  maxDate?: string
}

export function DateRangePicker({ from, to, onChange, maxDate }: Props) {
  const [open, setOpen] = useState(false)

  const selected: DateRange | undefined = from
    ? { from: parseYmd(from), to: parseYmd(to) || parseYmd(from) }
    : undefined

  const label = from && from === to ? fmtLong(from) : `${fmtShort(from)} — ${fmtShort(to)}`
  const maxD = maxDate ? parseYmd(maxDate) : undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-muted transition-colors"
          aria-label="Период"
        >
          <CalendarDays className="size-4 text-muted-foreground" />
          <span className="capitalize whitespace-nowrap">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <div className="flex flex-col sm:flex-row">
          <div className="flex sm:flex-col gap-1 p-2 border-b sm:border-b-0 sm:border-r border-border overflow-x-auto">
            {QUICK.map(q => (
              <button
                key={q.key}
                type="button"
                onClick={() => { onChange(getPresetRange(q.key)); setOpen(false) }}
                className="px-3 py-1.5 text-xs font-medium text-left rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors whitespace-nowrap"
              >
                {q.label}
              </button>
            ))}
          </div>
          <div className="p-2">
            <Calendar
              mode="range"
              selected={selected}
              defaultMonth={selected?.from}
              disabled={maxD ? { after: maxD } : undefined}
              numberOfMonths={1}
              onSelect={(r?: DateRange) => {
                if (!r?.from) return
                const f = ymd(r.from)
                const t = r.to ? ymd(r.to) : f
                onChange({ from: f, to: t })
                if (r.to) setOpen(false)
              }}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
