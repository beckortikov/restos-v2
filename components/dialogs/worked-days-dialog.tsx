'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { fetchWorkedDays, setWorkedDays } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'
import {
  startOfMonth, endOfMonth, eachDayOfInterval, format, getDay, isWeekend,
} from 'date-fns'
import { ru } from 'date-fns/locale'

// Отметка отработанных дней для дневной оплаты (059). Календарь месяца +
// быстрый ввод: тык по дням ИЛИ «отметить N дней» / «будни». Дни из табеля
// (реальные приходы) показаны заблокированными — их снять нельзя.
export function WorkedDaysDialog({
  open, onOpenChange, employeeId, employeeName, dailyRate, from, to, onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  employeeId: string
  employeeName: string
  dailyRate: number
  from: string // YYYY-MM-DD
  to: string   // YYYY-MM-DD
  onSaved?: (count: number) => void
}) {
  const [shiftSet, setShiftSet] = useState<Set<string>>(new Set())
  const [manualSet, setManualSet] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [nDays, setNDays] = useState('')

  // Месяц календаря — по началу периода (обычно период = месяц).
  const monthAnchor = useMemo(() => (from ? new Date(from + 'T00:00:00') : new Date()), [from])
  const days = useMemo(() => {
    const s = startOfMonth(monthAnchor)
    const e = endOfMonth(monthAnchor)
    return eachDayOfInterval({ start: s, end: e })
  }, [monthAnchor])
  const leadPad = useMemo(() => (getDay(startOfMonth(monthAnchor)) + 6) % 7, [monthAnchor]) // Пн=0

  const inPeriod = useCallback((iso: string) => iso >= from && iso <= to, [from, to])

  useEffect(() => {
    if (!open || !employeeId) return
    setLoading(true)
    fetchWorkedDays(employeeId, from, to)
      .then((r) => {
        setShiftSet(new Set(r.shift_dates))
        setManualSet(new Set(r.manual_dates))
      })
      .catch(() => toast.error('Не удалось загрузить дни'))
      .finally(() => setLoading(false))
  }, [open, employeeId, from, to])

  const totalDays = useMemo(() => {
    const u = new Set(shiftSet)
    manualSet.forEach((d) => u.add(d))
    return u.size
  }, [shiftSet, manualSet])

  function toggle(iso: string) {
    if (shiftSet.has(iso) || !inPeriod(iso)) return // табель не трогаем
    setManualSet((prev) => {
      const next = new Set(prev)
      if (next.has(iso)) next.delete(iso)
      else next.add(iso)
      return next
    })
  }

  // Периодные даты в порядке возрастания (для быстрого «N дней»).
  const periodDates = useMemo(
    () => days.map((d) => format(d, 'yyyy-MM-dd')).filter(inPeriod),
    [days, inPeriod],
  )

  function markFirstN() {
    const n = parseInt(nDays, 10)
    if (!Number.isFinite(n) || n <= 0) return
    // Первые N дней периода как ручные (дни табеля уже считаются, их не дублируем).
    const next = new Set<string>()
    let added = 0
    for (const iso of periodDates) {
      if (added >= n) break
      if (shiftSet.has(iso)) continue
      next.add(iso)
      added++
    }
    setManualSet(next)
  }

  function markWeekdays() {
    const next = new Set<string>()
    for (const d of days) {
      const iso = format(d, 'yyyy-MM-dd')
      if (!inPeriod(iso) || shiftSet.has(iso) || isWeekend(d)) continue
      next.add(iso)
    }
    setManualSet(next)
  }

  async function save() {
    setSaving(true)
    try {
      const res = await setWorkedDays(employeeId, from, to, [...manualSet])
      toast.success(`Отмечено дней: ${res.count}`)
      onSaved?.(res.count)
      onOpenChange(false)
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка сохранения'))
    } finally {
      setSaving(false)
    }
  }

  const accrued = totalDays * (dailyRate || 0)
  const monthLabel = format(monthAnchor, 'LLLL yyyy', { locale: ru })
  const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Отработанные дни — {employeeName}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-xs text-muted-foreground capitalize">{monthLabel}</p>

          {loading ? (
            <div className="h-56 flex items-center justify-center">
              <div className="size-6 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* Календарь */}
              <div className="grid grid-cols-7 gap-1">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="text-center text-[10px] font-medium text-muted-foreground py-1">{w}</div>
                ))}
                {Array.from({ length: leadPad }).map((_, i) => <div key={`pad-${i}`} />)}
                {days.map((d) => {
                  const iso = format(d, 'yyyy-MM-dd')
                  const outside = !inPeriod(iso)
                  const isShift = shiftSet.has(iso)
                  const isManual = manualSet.has(iso)
                  const on = isShift || isManual
                  return (
                    <button
                      key={iso}
                      onClick={() => toggle(iso)}
                      disabled={outside || isShift}
                      title={isShift ? 'Из табеля — снять нельзя' : undefined}
                      className={[
                        'aspect-square rounded-md text-sm flex items-center justify-center transition-colors tabular-nums',
                        outside ? 'text-muted-foreground/30 cursor-default' : '',
                        isShift ? 'bg-primary/30 text-foreground font-semibold cursor-not-allowed ring-1 ring-primary/40' : '',
                        !isShift && isManual ? 'bg-primary text-primary-foreground font-semibold' : '',
                        !on && !outside ? 'bg-muted/50 text-foreground hover:bg-muted' : '',
                      ].join(' ')}
                    >
                      {format(d, 'd')}
                    </button>
                  )
                })}
              </div>

              {/* Быстрый ввод */}
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="number"
                  min={1}
                  value={nDays}
                  onChange={(e) => setNDays(e.target.value)}
                  placeholder="N"
                  className="w-16 px-2 py-1.5 text-sm rounded-md border border-border bg-background tabular-nums"
                />
                <button onClick={markFirstN} className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-muted transition-colors">
                  Отметить N дней
                </button>
                <button onClick={markWeekdays} className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-muted transition-colors">
                  Будни
                </button>
                <button onClick={() => setManualSet(new Set())} className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-muted transition-colors text-muted-foreground">
                  Очистить
                </button>
              </div>

              {/* Итог */}
              <div className="flex items-center justify-between rounded-lg bg-muted/40 border border-border px-3 py-2.5">
                <span className="text-sm text-muted-foreground">
                  Дней: <b className="text-foreground tabular-nums">{totalDays}</b>
                  {dailyRate > 0 && <> × {formatCurrency(dailyRate)}</>}
                </span>
                {dailyRate > 0 && (
                  <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(accrued)}</span>
                )}
              </div>
              {shiftSet.size > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Дни из табеля ({shiftSet.size}) отмечены заранее и снять их нельзя — они посчитаны по приходам.
                </p>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-muted/50 transition-colors disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            onClick={save}
            disabled={saving || loading}
            className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? 'Сохраняю…' : 'Сохранить дни'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
