'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { fetchWorkedDays, setWorkedDays } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  startOfMonth, endOfMonth, eachDayOfInterval, format, getDay, isWeekend, addMonths,
} from 'date-fns'
import { ru } from 'date-fns/locale'

// Отметка отработанных дней для дневной оплаты (059). Календарь МЕСЯЦА со своей
// навигацией (◀ ▶) — независимой от периода-фильтра сверху: рабочие дни всегда
// отмечаются помесячно. Тык по дням ИЛИ быстрый ввод «N дней» / «Будни».
// Дни из табеля (реальные приходы) заблокированы — их снять нельзя.
export function WorkedDaysDialog({
  open, onOpenChange, employeeId, employeeName, dailyRate, initialDate, onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  employeeId: string
  employeeName: string
  dailyRate: number
  initialDate?: string // YYYY-MM-DD — какой месяц открыть первым (обычно конец периода)
  onSaved?: (count: number) => void
}) {
  const [month, setMonth] = useState<Date>(() =>
    startOfMonth(initialDate ? new Date(initialDate + 'T00:00:00') : new Date()),
  )
  const [shiftSet, setShiftSet] = useState<Set<string>>(new Set())
  const [manualSet, setManualSet] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [nDays, setNDays] = useState('')

  const monthStart = useMemo(() => format(startOfMonth(month), 'yyyy-MM-dd'), [month])
  const monthEnd = useMemo(() => format(endOfMonth(month), 'yyyy-MM-dd'), [month])
  const days = useMemo(
    () => eachDayOfInterval({ start: startOfMonth(month), end: endOfMonth(month) }),
    [month],
  )
  const leadPad = useMemo(() => (getDay(startOfMonth(month)) + 6) % 7, [month]) // Пн=0
  const periodDates = useMemo(() => days.map((d) => format(d, 'yyyy-MM-dd')), [days])

  // Перезагрузка при открытии И при смене месяца — набор дат помесячный.
  useEffect(() => {
    if (!open || !employeeId) return
    setLoading(true)
    fetchWorkedDays(employeeId, monthStart, monthEnd)
      .then((r) => {
        setShiftSet(new Set(r.shift_dates))
        setManualSet(new Set(r.manual_dates))
      })
      .catch(() => toast.error('Не удалось загрузить дни'))
      .finally(() => setLoading(false))
  }, [open, employeeId, monthStart, monthEnd])

  const totalDays = useMemo(() => {
    const u = new Set(shiftSet)
    manualSet.forEach((d) => u.add(d))
    return u.size
  }, [shiftSet, manualSet])

  function toggle(iso: string) {
    if (shiftSet.has(iso)) return // табель не трогаем
    setManualSet((prev) => {
      const next = new Set(prev)
      if (next.has(iso)) next.delete(iso)
      else next.add(iso)
      return next
    })
  }

  function markFirstN() {
    const n = parseInt(nDays, 10)
    if (!Number.isFinite(n) || n <= 0) return
    // Первые N дней месяца как ручные (дни табеля уже считаются — их не дублируем).
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
      if (shiftSet.has(iso) || isWeekend(d)) continue
      next.add(iso)
    }
    setManualSet(next)
  }

  async function save() {
    setSaving(true)
    try {
      const res = await setWorkedDays(employeeId, monthStart, monthEnd, [...manualSet])
      toast.success(`${format(month, 'LLLL', { locale: ru })}: отмечено дней ${res.count}`)
      onSaved?.(res.count)
      onOpenChange(false)
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка сохранения'))
    } finally {
      setSaving(false)
    }
  }

  const accrued = totalDays * (dailyRate || 0)
  const monthLabel = format(month, 'LLLL yyyy', { locale: ru })
  const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Отработанные дни — {employeeName}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Навигация по месяцам */}
          <div className="flex items-center justify-between">
            <button
              onClick={() => setMonth((m) => startOfMonth(addMonths(m, -1)))}
              className="size-8 rounded-md border border-border hover:bg-muted flex items-center justify-center transition-colors"
              aria-label="Предыдущий месяц"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="text-sm font-medium capitalize">{monthLabel}</span>
            <button
              onClick={() => setMonth((m) => startOfMonth(addMonths(m, 1)))}
              className="size-8 rounded-md border border-border hover:bg-muted flex items-center justify-center transition-colors"
              aria-label="Следующий месяц"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>

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
                  const isShift = shiftSet.has(iso)
                  const isManual = manualSet.has(iso)
                  const on = isShift || isManual
                  return (
                    <button
                      key={iso}
                      onClick={() => toggle(iso)}
                      disabled={isShift}
                      title={isShift ? 'Из табеля — снять нельзя' : undefined}
                      className={[
                        'aspect-square rounded-md text-sm flex items-center justify-center transition-colors tabular-nums',
                        isShift ? 'bg-primary/30 text-foreground font-semibold cursor-not-allowed ring-1 ring-primary/40' : '',
                        !isShift && isManual ? 'bg-primary text-primary-foreground font-semibold' : '',
                        !on ? 'bg-muted/50 text-foreground hover:bg-muted' : '',
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
