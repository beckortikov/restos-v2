'use client'

// Отчёты по рабочему времени: часы, дисциплина, ФОТ.
//
// Числа берутся из тех же отметок, что и табель — отдельного хранилища
// агрегатов нет намеренно: иначе правка отметки задним числом расходилась бы
// с отчётом, и объяснить разницу было бы нечем.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, Loader2, TrendingDown, TrendingUp, Users } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { fetchTimeReport, type TimeReport } from '@/lib/queries/schedule'
import { humanizeError } from '@/lib/errors'
import { formatCurrency } from '@/lib/helpers'
import { EmptyHint, WEEKDAYS, addDays, initials, plural, ymd } from './shared'

type Preset = 'week' | 'month' | 'quarter'

const PRESETS: Array<{ key: Preset; label: string; days: number }> = [
  { key: 'week', label: 'Неделя', days: 7 },
  { key: 'month', label: 'Месяц', days: 30 },
  // 92 — потолок диапазона на сервере: план разворачивается по дням, и год на
  // сорок человек — это десятки тысяч строк в одном ответе.
  { key: 'quarter', label: 'Квартал', days: 92 },
]

export function ReportsView() {
  const [preset, setPreset] = useState<Preset>('month')
  const [report, setReport] = useState<TimeReport | null>(null)
  const [loading, setLoading] = useState(true)

  const range = useMemo(() => {
    const days = PRESETS.find((p) => p.key === preset)!.days
    const to = ymd(new Date())
    return { from: addDays(to, -(days - 1)), to }
  }, [preset])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setReport(await fetchTimeReport(range.from, range.to))
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setLoading(false)
    }
  }, [range])

  useEffect(() => { void load() }, [load])

  const delta = useMemo(() => {
    if (!report || report.prevTotalHours <= 0) return null
    return Math.round(((report.totalHours - report.prevTotalHours) / report.prevTotalHours) * 100)
  }, [report])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg">
          {PRESETS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setPreset(key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                preset === key ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{range.from} — {range.to}</span>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>Обновить</Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Считаем отчёт…
        </div>
      ) : !report ? null : report.shifts === 0 && report.plannedCount === 0 ? (
        <EmptyHint text="За этот период нет ни закрытых смен, ни плановых выходов." />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi
              label="Отработано часов"
              value={`${report.totalHours} ч`}
              hint={
                delta === null
                  ? `${plural(report.shifts, 'смена', 'смены', 'смен')}`
                  : `${delta >= 0 ? '+' : ''}${delta}% к прошлому периоду`
              }
              trend={delta === null ? undefined : delta >= 0 ? 'up' : 'down'}
              icon={<Clock className="w-4 h-4" />}
            />
            <Kpi
              label={report.absentCount > 0 ? 'Не вышли' : 'Средняя смена'}
              value={report.absentCount > 0 ? String(report.absentCount) : `${report.avgShiftHours} ч`}
              // Прогулы важнее средней смены: если они есть, смотрят на них.
              hint={
                report.absentCount > 0
                  ? `плановых выходов без отметки · смена ${report.avgShiftHours} ч`
                  : plural(report.shifts, 'смена', 'смены', 'смен')
              }
              tone={report.absentCount > 0 ? 'text-red-600 dark:text-red-400' : undefined}
              icon={report.absentCount > 0 ? <Users className="w-4 h-4" /> : undefined}
            />
            <Kpi
              label="Пунктуальность"
              // Знаменатель — те, кто пришёл: считать «вовремя» от плана
              // значило бы смешивать опоздания с прогулами.
              value={report.onTimeCount + report.lateCount > 0 ? `${report.punctuality}%` : '—'}
              // Уточняем знаменатель прямо в подписи: «100%» при двух
              // десятках прогулов иначе читается как «всё хорошо».
              hint={
                report.onTimeCount + report.lateCount > 0
                  ? `${report.onTimeCount} из ${report.onTimeCount + report.lateCount} пришедших вовремя`
                  : 'нет плановых выходов'
              }
              tone={report.punctuality >= 90 ? 'text-emerald-600 dark:text-emerald-400' : report.punctuality >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}
            />
            <Kpi
              label="Фонд оплаты"
              value={formatCurrency(report.payrollAccrued)}
              hint="начислено за период"
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-[1fr_360px]">
            <WeekdayChart hours={report.hoursByWeekday} />
            <DisciplinePanel report={report} />
          </div>

          <TopPanel top={report.top} />
        </>
      )}
    </div>
  )
}

function Kpi({
  label, value, hint, tone, icon, trend,
}: {
  label: string
  value: string
  hint?: string
  tone?: string
  icon?: React.ReactNode
  trend?: 'up' | 'down'
}) {
  return (
    <div className="border rounded-xl px-4 py-3 bg-card">
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">{icon}{label}</div>
      <div className={`text-2xl font-semibold mt-0.5 ${tone ?? ''}`}>{value}</div>
      {hint && (
        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
          {trend === 'up' && <TrendingUp className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />}
          {trend === 'down' && <TrendingDown className="w-3 h-3 text-red-600 dark:text-red-400" />}
          {hint}
        </div>
      )}
    </div>
  )
}

/**
 * Часы по дням недели. Столбцы рисуем сами, без библиотеки графиков: семь
 * значений — это не тот случай, ради которого стоит тянуть в бандл recharts.
 */
function WeekdayChart({ hours }: { hours: number[] }) {
  const max = Math.max(...hours, 1)
  const todayIdx = (new Date().getDay() + 6) % 7
  return (
    <div className="border rounded-xl bg-card p-4">
      <div className="text-sm font-medium mb-3">Часы по дням недели</div>
      <div className="flex gap-2 h-44">
        {hours.map((h, i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-1.5 min-w-0">
            <div className="text-xs font-medium tabular-nums h-4">{h > 0 ? h : ''}</div>
            {/* Столбцу нужна СВОЯ дорожка фиксированной высоты: проценты от
                колонки, высота которой определяется содержимым, дают ноль —
                график получался пустым. */}
            <div className="flex-1 w-full flex items-end">
              <div
                className={`w-full rounded-t transition-all ${i === todayIdx ? 'bg-primary' : 'bg-primary/25'}`}
                style={{ height: `${h > 0 ? Math.max(4, (h / max) * 100) : 2}%` }}
              />
            </div>
            <div className={`text-xs ${i === todayIdx ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
              {WEEKDAYS[i]}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function DisciplinePanel({ report }: { report: TimeReport }) {
  const came = report.onTimeCount + report.lateCount
  const rows = [
    { label: 'Вовремя', value: report.onTimeCount, tone: 'bg-emerald-500' },
    { label: 'С опозданием', value: report.lateCount, tone: 'bg-amber-500' },
    { label: 'Не вышли', value: report.absentCount, tone: 'bg-red-500' },
  ]
  const total = came + report.absentCount
  return (
    <div className="border rounded-xl bg-card p-4">
      <div className="text-sm font-medium mb-3">Дисциплина</div>
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">
          Пока не с чем сравнивать: за период нет плановых выходов. Заполните график в разделе «Табель».
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.label}>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">{r.label}</span>
                <span className="font-medium tabular-nums">{r.value}</span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div className={`h-full ${r.tone}`} style={{ width: `${(r.value / total) * 100}%` }} />
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground pt-1">
            Считается от плановых выходов: без графика знаменателя нет.
          </p>
        </div>
      )}
    </div>
  )
}

function TopPanel({ top }: { top: TimeReport['top'] }) {
  if (top.length === 0) return null
  return (
    <div className="border rounded-xl bg-card overflow-hidden">
      <div className="px-4 py-3 border-b text-sm font-medium">Больше всех часов</div>
      <div className="divide-y">
        {top.map((t, i) => (
          <div key={t.userId} className="flex items-center gap-3 px-4 py-2.5">
            <span className="w-5 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
            <span className="size-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold text-muted-foreground shrink-0">
              {initials(t.userName)}
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{t.userName || '—'}</div>
              {t.position && <div className="text-xs text-muted-foreground truncate">{t.position}</div>}
            </div>
            <span className="text-sm font-medium tabular-nums">{t.hours} ч</span>
          </div>
        ))}
      </div>
    </div>
  )
}
