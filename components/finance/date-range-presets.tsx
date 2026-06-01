'use client'

import { useEffect } from 'react'

export type RangePreset = 'today' | 'yesterday' | 'week' | 'month' | 'quarter' | 'year' | 'custom'

const PRESET_LABELS: Record<RangePreset, string> = {
  today: 'Сегодня',
  yesterday: 'Вчера',
  week: 'Неделя',
  month: 'Месяц',
  quarter: 'Квартал',
  year: 'Год',
  custom: 'Произвольно',
}

function pad(n: number): string { return String(n).padStart(2, '0') }
function ymd(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

export function getPresetRange(preset: RangePreset, customFrom = '', customTo = ''): { from: string; to: string } {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayStr = ymd(today)
  switch (preset) {
    case 'today':
      return { from: todayStr, to: todayStr }
    case 'yesterday': {
      const y = new Date(today); y.setDate(y.getDate() - 1)
      const s = ymd(y)
      return { from: s, to: s }
    }
    case 'week': {
      const s = new Date(today); s.setDate(s.getDate() - 6)
      return { from: ymd(s), to: todayStr }
    }
    case 'month': {
      const s = new Date(today.getFullYear(), today.getMonth(), 1)
      return { from: ymd(s), to: todayStr }
    }
    case 'quarter': {
      const q = Math.floor(today.getMonth() / 3)
      const s = new Date(today.getFullYear(), q * 3, 1)
      return { from: ymd(s), to: todayStr }
    }
    case 'year': {
      const s = new Date(today.getFullYear(), 0, 1)
      return { from: ymd(s), to: todayStr }
    }
    case 'custom':
      return { from: customFrom, to: customTo }
  }
}

const ORDER: RangePreset[] = ['today', 'yesterday', 'week', 'month', 'quarter', 'year', 'custom']

interface Props {
  value: RangePreset
  onChange: (preset: RangePreset, range: { from: string; to: string }) => void
  customFrom: string
  customTo: string
  onCustomFromChange: (v: string) => void
  onCustomToChange: (v: string) => void
  storageKey?: string
  presets?: RangePreset[]
}

export function DateRangePresets({
  value, onChange,
  customFrom, customTo,
  onCustomFromChange, onCustomToChange,
  storageKey,
  presets,
}: Props) {
  const list = presets ?? ORDER

  // Persist last preset
  useEffect(() => {
    if (!storageKey) return
    if (value !== 'custom') {
      try { localStorage.setItem(storageKey, value) } catch {}
    }
  }, [value, storageKey])

  const handleClick = (p: RangePreset) => {
    const r = p === 'custom' ? { from: customFrom, to: customTo } : getPresetRange(p)
    onChange(p, r)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1 bg-muted/50 p-1 rounded-lg">
        {list.map(p => (
          <button
            key={p}
            type="button"
            onClick={() => handleClick(p)}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              value === p
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-card'
            }`}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>
      {value === 'custom' && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={customFrom}
            onChange={e => onCustomFromChange(e.target.value)}
            className="px-2 py-1 text-xs bg-card border border-border rounded-md"
          />
          <span className="text-xs text-muted-foreground">—</span>
          <input
            type="date"
            value={customTo}
            onChange={e => onCustomToChange(e.target.value)}
            className="px-2 py-1 text-xs bg-card border border-border rounded-md"
          />
        </div>
      )}
    </div>
  )
}

export function readStoredPreset(storageKey: string, fallback: RangePreset = 'month'): RangePreset {
  try {
    const v = localStorage.getItem(storageKey) as RangePreset | null
    if (v && ORDER.includes(v)) return v
  } catch {}
  return fallback
}
