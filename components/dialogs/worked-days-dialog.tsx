'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { fetchWorkedDays, setWorkedDays, toggleDayMultiplier } from '@/lib/queries'
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
  const [multipliers, setMultipliers] = useState<Record<string, number>>({})
  const [togglingDate, setTogglingDate] = useState<string | null>(null)
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
        setMultipliers(r.multipliers)
      })
      .catch(() => toast.error('Не удалось загрузить дни'))
      .finally(() => setLoading(false))
  }, [open, employeeId, monthStart, monthEnd])

  const totalDays = useMemo(() => {
    const u = new Set(shiftSet)
    manualSet.forEach((d) => u.add(d))
    return u.size
  }, [shiftSet, manualSet])

  // Оплачиваемые единицы: обычный день = 1, день с ×2 (066) = 2. Именно от
  // этого числа считается начисление, а не от totalDays.
  const paidUnits = useMemo(() => {
    const u = new Set(shiftSet)
    manualSet.forEach((d) => u.add(d))
    let units = 0
    u.forEach((d) => { units += multipliers[d] ?? 1 })
    return units
  }, [shiftSet, manualSet, multipliers])

  // Единый тап по дню (весь квадрат — не крошечный угловой бейдж, который
  // физически промахивался на тач-экране в плотной сетке 7×6). Состояния:
  //   выключен            → тап → включён (×1)               — локально, до «Сохранить дни»
  //   включён, ×1         → тап → ×2                          — сразу на сервер
  //   включён, ×2         → тап → ×1                          — сразу на сервер
  // Дни из табеля всегда «включены» (то же самое, начиная со 2-й строки —
  // тап на них сразу переключает множитель, включать/выключать нечего).
  async function handleDayTap(iso: string) {
    const on = shiftSet.has(iso) || manualSet.has(iso)
    if (!on) {
      setManualSet((prev) => {
        const next = new Set(prev)
        next.add(iso)
        return next
      })
      return
    }
    // Множитель — не черновой набор дат, а самостоятельный факт «в этот день
    // было две смены»: пишется сразу, не ждёт «Сохранить дни».
    if (togglingDate) return
    setTogglingDate(iso)
    try {
      const res = await toggleDayMultiplier(employeeId, iso, monthStart, monthEnd)
      setMultipliers(res.multipliers)
      onSaved?.(res.count)
    } catch (err) {
      toast.error(humanizeError(err, 'Не удалось изменить множитель'))
    } finally {
      setTogglingDate(null)
    }
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

  const accrued = paidUnits * (dailyRate || 0)
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
                  const isDouble = (multipliers[iso] ?? 1) > 1
                  return (
                    <button
                      key={iso}
                      onClick={() => handleDayTap(iso)}
                      disabled={togglingDate === iso}
                      title={!on ? undefined : isDouble ? 'Тап — вернуть одну смену' : 'Тап — отметить две смены за день'}
                      className={[
                        'relative w-full aspect-square rounded-md text-sm flex items-center justify-center transition-colors tabular-nums',
                        isShift ? 'bg-primary/30 text-foreground font-semibold ring-1 ring-primary/40' : '',
                        !isShift && isManual ? 'bg-primary text-primary-foreground font-semibold' : '',
                        !on ? 'bg-muted/50 text-foreground hover:bg-muted' : '',
                      ].join(' ')}
                    >
                      {format(d, 'd')}
                      {/* Пометка «две смены» — чисто визуальная, не отдельная кликабельная
                          зона: переключает её тап по всему дню (handleDayTap). */}
                      {isDouble && (
                        <span className="pointer-events-none absolute -top-1 -right-1 h-3.5 min-w-3.5 px-0.5 rounded-full bg-amber-500 text-white text-[8px] font-bold flex items-center justify-center leading-none">
                          ×2
                        </span>
                      )}
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
                  {paidUnits !== totalDays && (
                    <> (<span className="text-amber-600 font-medium tabular-nums">{paidUnits}</span> опл. ед.)</>
                  )}
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
              <p className="text-[11px] text-muted-foreground">
                Тап по отмеченному дню — переключить <span className="inline-flex items-center justify-center size-3.5 rounded-full bg-amber-500 text-white text-[8px] font-bold align-middle">×2</span>, если сотрудник в этот день отработал две смены. Ещё тап — обратно на одну.
              </p>
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
