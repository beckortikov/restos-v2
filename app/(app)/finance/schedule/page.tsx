'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, Camera, Check, ChevronLeft, ChevronRight, ClipboardCheck, Clock, Coins, Loader2, Plus, RotateCcw, Users } from 'lucide-react'
import { toast } from 'sonner'

import { FinanceTabs } from '@/components/finance/finance-tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fetchUsers } from '@/lib/queries'
import { useAuth } from '@/lib/auth-store'
import { requestSetScheduleDayRelay, requestSetScheduleRelay } from '@/lib/queries/employee-relay'
import { useBranchView } from '@/hooks/use-branch-view'
import {
  deleteScheduleDay, fetchAttendancePhoto, fetchRollCall, fetchSchedule, fetchScheduleTemplate,
  fineLate, saveScheduleTemplate, setScheduleDay,
  type PlannedShift, type RollCallReport, type RollCallRow, type RollCallStatus,
} from '@/lib/queries/schedule'
import { fetchRestaurantById, updateRestaurant } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import type { User } from '@/lib/types'

// ─── Даты ──────────────────────────────────────────────────────────────────
//
// Все даты здесь — календарные строки YYYY-MM-DD и НИКОГДА не Date в ISO:
// график живёт в локальных сутках ресторана, и любой перевод через
// toISOString() сдвигал бы день назад в UTC+5 — та же ловушка, что уже
// стоила ошибок в зарплате (см. isoFromYmd в payroll/page.tsx).

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

/** Понедельник недели, в которую попадает дата. */
function mondayOf(s: string): string {
  const d = parseYmd(s)
  const shift = (d.getDay() + 6) % 7 // вс=0 → 6
  d.setDate(d.getDate() - shift)
  return ymd(d)
}

function addDays(s: string, n: number): string {
  const d = parseYmd(s)
  d.setDate(d.getDate() + n)
  return ymd(d)
}

function shortDate(s: string): string {
  const d = parseYmd(s)
  return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`
}

function isToday(s: string): boolean {
  return s === ymd(new Date())
}

/** «1 смена / 2 смены / 5 смен» — русские окончания, без них счётчик читается как машинный. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`
  return `${n} ${many}`
}

// ─── Страница ──────────────────────────────────────────────────────────────

type Mode = 'grid' | 'rollcall'

export default function SchedulePage() {
  // Просмотр «как филиал» (ADR-003): читаем обычным GET под X-Branch-Id, а
  // пишем через employee-relay — central не пишет в чужую БД.
  const isBranchView = useBranchView()
  const [mode, setMode] = useState<Mode>('grid')
  const [employees, setEmployees] = useState<User[]>([])
  const [weekStart, setWeekStart] = useState(() => mondayOf(ymd(new Date())))
  const [plan, setPlan] = useState<PlannedShift[]>([])
  const [loading, setLoading] = useState(true)

  const [rollCallDate, setRollCallDate] = useState(() => ymd(new Date()))
  const [rollCall, setRollCall] = useState<RollCallReport | null>(null)
  const [rollCallLoading, setRollCallLoading] = useState(false)

  const [dayEdit, setDayEdit] = useState<{ user: User; date: string; current?: PlannedShift } | null>(null)
  const [templateFor, setTemplateFor] = useState<User | null>(null)

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])

  const loadPlan = useCallback(async () => {
    setLoading(true)
    try {
      const [users, rows] = await Promise.all([
        fetchUsers(),
        fetchSchedule(days[0], days[6]),
      ])
      // Уволенных бэк и так не отдаёт (role='deleted' фильтруется в
      // UsersService.List). Убираем терминал учёта времени — это устройство,
      // а не человек, которому ставят смены.
      setEmployees(users.filter((u) => u.role !== 'checkin'))
      setPlan(rows)
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setLoading(false)
    }
  }, [days])

  const loadRollCall = useCallback(async (date: string) => {
    setRollCallLoading(true)
    try {
      setRollCall(await fetchRollCall(date))
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setRollCallLoading(false)
    }
  }, [])

  useEffect(() => { void loadPlan() }, [loadPlan])
  useEffect(() => {
    if (mode === 'rollcall') void loadRollCall(rollCallDate)
  }, [mode, rollCallDate, loadRollCall])

  const planIndex = useMemo(() => {
    const m = new Map<string, PlannedShift>()
    plan.forEach((p) => m.set(`${p.userId}|${p.date}`, p))
    return m
  }, [plan])

  return (
    // Те же отступы и ритм, что на «Зарплате» (p-4 md:p-6 space-y-5): без них
    // страница прилипала к краям и на фоне соседних вкладок выглядела
    // «съехавшей». min-w-0 не даёт широкой таблице растянуть весь макет и
    // выдавить сайдбар за экран.
    <div className="p-4 md:p-6 space-y-5 min-w-0">
      <FinanceTabs />

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        {/* Переключатель режимов — тот же сегмент-контрол, что вкладки
            «Сотрудники / История / Ведомость» на зарплате. */}
        <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg w-fit">
          <button
            onClick={() => setMode('grid')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'grid' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}
          >
            <CalendarDays className="size-3.5 inline mr-1.5 -mt-0.5" />
            Неделя
          </button>
          <button
            onClick={() => setMode('rollcall')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'rollcall' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}
          >
            <ClipboardCheck className="size-3.5 inline mr-1.5 -mt-0.5" />
            Перекличка
          </button>
        </div>

        <p className="text-sm text-muted-foreground">
          {mode === 'grid'
            ? 'План, с которым сравниваются отметки прихода'
            : 'Кто вышел, кто опоздал, кого нет'}
        </p>
      </div>

      {isBranchView && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Просмотр филиала: изменения уходят в очередь и применяются на его кассе в течение минуты.
        </div>
      )}

      {mode === 'grid' ? (
        <WeekGrid
          days={days}
          employees={employees}
          planIndex={planIndex}
          loading={loading}
          weekStart={weekStart}
          onWeek={(delta) => setWeekStart((w) => addDays(w, delta * 7))}
          onToday={() => setWeekStart(mondayOf(ymd(new Date())))}
          onCell={(user, date) => setDayEdit({ user, date, current: planIndex.get(`${user.id}|${date}`) })}
          onTemplate={(user) => setTemplateFor(user)}
        />
      ) : (
        <RollCallView
          date={rollCallDate}
          onDate={setRollCallDate}
          report={rollCall}
          loading={rollCallLoading}
          canFine={!isBranchView}
          onReload={() => void loadRollCall(rollCallDate)}
        />
      )}

      {dayEdit && (
        <DayDialog
          user={dayEdit.user}
          date={dayEdit.date}
          current={dayEdit.current}
          viaRelay={isBranchView}
          onClose={() => setDayEdit(null)}
          onSaved={() => { setDayEdit(null); void loadPlan() }}
        />
      )}
      {templateFor && (
        <TemplateDialog
          user={templateFor}
          viaRelay={isBranchView}
          onClose={() => setTemplateFor(null)}
          onSaved={() => { setTemplateFor(null); void loadPlan() }}
        />
      )}
    </div>
  )
}

// ─── Сетка недели ──────────────────────────────────────────────────────────

function WeekGrid({
  days, employees, planIndex, loading, weekStart, onWeek, onToday, onCell, onTemplate,
}: {
  days: string[]
  employees: User[]
  planIndex: Map<string, PlannedShift>
  loading: boolean
  weekStart: string
  onWeek: (delta: number) => void
  onToday: () => void
  onCell: (user: User, date: string) => void
  onTemplate: (user: User) => void
}) {
  // Итоги недели считаем один раз: «сколько всего смен закрыто» — первое, что
  // проверяет владелец, и складывать это глазами по сетке неудобно.
  const totals = useMemo(() => {
    let shifts = 0
    let offs = 0
    let overrides = 0
    planIndex.forEach((cell) => {
      if (cell.isOff) offs++
      else shifts++
      if (cell.source === 'override') overrides++
    })
    return { shifts, offs, overrides }
  }, [planIndex])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="size-8" onClick={() => onWeek(-1)} aria-label="Предыдущая неделя">
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={onToday}>Текущая неделя</Button>
          <Button variant="outline" size="icon" className="size-8" onClick={() => onWeek(1)} aria-label="Следующая неделя">
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <span className="text-sm font-medium">{shortDate(weekStart)} — {shortDate(days[6])}</span>
        <div className="flex-1" />
        {!loading && employees.length > 0 && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span><b className="text-foreground">{totals.shifts}</b> смен</span>
            {totals.offs > 0 && <span>{totals.offs} выходных</span>}
            {totals.overrides > 0 && <span>{totals.overrides} правок</span>}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Загружаем график…
        </div>
      ) : employees.length === 0 ? (
        <EmptyHint text="Нет сотрудников — заведите их в разделе «Настройки → Пользователи»." />
      ) : (
        // Таблица шире экрана на планшете — скроллим её саму, а не страницу:
        // иначе уезжает весь макет вместе с меню.
        <div className="border rounded-xl overflow-hidden bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[860px] border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="text-left font-medium px-4 py-3 w-64 bg-muted/40 border-b sticky left-0 z-10">
                    Сотрудник
                  </th>
                  {days.map((d, i) => (
                    <th
                      key={d}
                      className={`px-2 py-3 font-medium text-center border-b ${isToday(d) ? 'bg-primary/5' : 'bg-muted/40'}`}
                    >
                      <div className={isToday(d) ? 'text-primary' : ''}>{WEEKDAYS[i]}</div>
                      <div className={`text-xs font-normal ${isToday(d) ? 'text-primary/70' : 'text-muted-foreground'}`}>
                        {shortDate(d)}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {employees.map((u) => {
                  const shiftsCount = days.filter((d) => {
                    const c = planIndex.get(`${u.id}|${d}`)
                    return c && !c.isOff
                  }).length
                  return (
                    <tr key={u.id} className="group/row">
                      <td className="px-4 py-2.5 border-b bg-card sticky left-0 z-10">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className="size-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold text-muted-foreground shrink-0">
                            {initials(u.name || u.username)}
                          </span>
                          <span className="min-w-0">
                            <span className="font-medium truncate block">{u.name || u.username}</span>
                            <button
                              onClick={() => onTemplate(u)}
                              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 whitespace-nowrap"
                            >
                              <Clock className="w-3 h-3" />
                              {shiftsCount > 0 ? plural(shiftsCount, 'смена', 'смены', 'смен') : 'нет смен'}
                              <span className="opacity-60">· шаблон</span>
                            </button>
                          </span>
                        </div>
                      </td>
                      {days.map((d) => {
                        const cell = planIndex.get(`${u.id}|${d}`)
                        return (
                          <td key={d} className={`px-1.5 py-1.5 border-b text-center ${isToday(d) ? 'bg-primary/5' : ''}`}>
                            <button
                              onClick={() => onCell(u, d)}
                              className={`w-full rounded-lg px-2 py-2.5 text-xs transition-all ${cellClass(cell)}`}
                            >
                              {!cell ? (
                                // Пустой день — не «выходной», а «не назначено»:
                                // плюс сразу говорит, что сюда можно нажать.
                                <Plus className="size-3.5 mx-auto opacity-0 group-hover/row:opacity-40 transition-opacity" />
                              ) : cell.isOff ? (
                                'Выходной'
                              ) : (
                                <span className="font-medium tabular-nums">{cell.startsAt}–{cell.endsAt}</span>
                              )}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-2.5 bg-muted/20 border-t text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-3 rounded bg-primary/10 border border-primary/40 inline-block" />
              правка на дату
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-3 rounded bg-primary/5 border border-transparent inline-block" />
              недельный шаблон
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-3 rounded bg-muted border border-dashed border-border inline-block" />
              выходной
            </span>
            <span>Клик по ячейке — смена или отгул на этот день. Клик по «шаблон» — вся неделя сразу.</span>
          </div>
        </div>
      )}
    </div>
  )
}

/** «ЩЮ» из имени — аватар-заглушка, чтобы строки различались взглядом. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

/**
 * Вид ячейки. Правка на конкретную дату видна рамкой — менеджер должен
 * различать, где он вмешался руками, а где действует недельный шаблон:
 * иначе непонятно, что изменится, если шаблон переписать.
 */
function cellClass(cell?: PlannedShift): string {
  if (!cell) return 'text-muted-foreground hover:bg-muted/60 border border-transparent'
  if (cell.isOff) return 'bg-muted text-muted-foreground border border-dashed border-border hover:bg-muted/80'
  return cell.source === 'override'
    ? 'bg-primary/10 text-primary border border-primary/40 hover:bg-primary/15'
    : 'bg-primary/5 text-foreground border border-transparent hover:bg-primary/10'
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="border rounded-xl py-10 text-center text-sm text-muted-foreground">{text}</div>
  )
}

// ─── Перекличка ────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<RollCallStatus, string> = {
  on_time: 'Вовремя',
  late: 'Опоздал',
  absent: 'Не пришёл',
  unplanned: 'Без графика',
  off: 'Выходной',
}

const STATUS_TONE: Record<RollCallStatus, string> = {
  on_time: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  late: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  absent: 'bg-red-500/10 text-red-700 dark:text-red-400',
  unplanned: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  off: 'bg-muted text-muted-foreground',
}

// Строки-исключения подсвечиваем целиком, а не одним бейджем: смысл экрана —
// с одного взгляда увидеть, где не так, не вчитываясь в каждую строку.
const ROW_TONE: Record<RollCallStatus, string> = {
  on_time: '',
  late: 'bg-amber-500/[0.06]',
  absent: 'bg-red-500/[0.06]',
  unplanned: 'bg-sky-500/[0.05]',
  off: '',
}

// Цветная полоса слева — тот же сигнал для тех, кто различает не оттенки, а
// форму, и для печати в ч/б.
const ROW_ACCENT: Record<RollCallStatus, string> = {
  on_time: 'bg-emerald-500/70',
  late: 'bg-amber-500',
  absent: 'bg-red-500',
  unplanned: 'bg-sky-500',
  off: 'bg-transparent',
}

function RollCallView({
  date, onDate, report, loading, canFine, onReload,
}: {
  date: string
  onDate: (d: string) => void
  report: RollCallReport | null
  loading: boolean
  /** В режиме просмотра филиала штраф не выставляем: удержание пишется в
   *  свою БД, а не в филиальскую — оно ушло бы не тому. */
  canFine: boolean
  onReload: () => void
}) {
  const [photoFor, setPhotoFor] = useState<RollCallRow | null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [finingId, setFiningId] = useState<string | null>(null)

  const applyFine = async (row: RollCallRow) => {
    setFiningId(row.userId)
    try {
      await fineLate(row.userId, date)
      toast.success(`Удержано ${row.suggestedFine} · ${row.userName}`)
      onReload()
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setFiningId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onDate(addDays(date, -1))} aria-label="Предыдущий день">←</Button>
        <Input
          type="date"
          value={date}
          onChange={(e) => onDate(e.target.value)}
          className="w-44"
        />
        <Button variant="outline" size="sm" onClick={() => onDate(addDays(date, 1))} aria-label="Следующий день">→</Button>
        <Button variant="outline" size="sm" onClick={() => onDate(ymd(new Date()))}>Сегодня</Button>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => setRulesOpen(true)}>
          <Coins className="w-4 h-4 mr-1.5" /> Правила опозданий
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Считаем перекличку…
        </div>
      ) : !report ? null : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <Stat label="По графику" value={report.planned} icon={<Users className="w-4 h-4" />} />
            <Stat label="Пришли" value={report.present} tone="text-emerald-600 dark:text-emerald-400" />
            <Stat label="Опоздали" value={report.late} tone="text-amber-600 dark:text-amber-400" />
            <Stat label="Не пришли" value={report.absent} tone="text-red-600 dark:text-red-400" />
            <Stat label="Без графика" value={report.unplanned} tone="text-sky-600 dark:text-sky-400" />
          </div>

          {report.rows.length === 0 ? (
            <EmptyHint text="На этот день нет ни плановых смен, ни отметок." />
          ) : (
            <div className="border rounded-xl overflow-hidden bg-card">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[720px]">
                  <thead>
                    <tr className="bg-muted/40 text-muted-foreground">
                      <th className="text-left font-medium px-3 py-2.5 w-[34%]">Сотрудник</th>
                      <th className="text-left font-medium px-3 py-2.5">По графику</th>
                      <th className="text-left font-medium px-3 py-2.5">Пришёл / ушёл</th>
                      <th className="text-left font-medium px-3 py-2.5">Статус</th>
                      <th className="text-right font-medium px-3 py-2.5 w-44">Штраф</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <tr
                        key={row.userId}
                        className={`border-t transition-colors hover:bg-muted/40 ${ROW_TONE[row.status]}`}
                      >
                        <td className="px-0 py-2.5">
                          <div className="flex items-center gap-3">
                            <span className={`w-1 h-10 rounded-r ${ROW_ACCENT[row.status]}`} />
                            {/* Клик по сотруднику — открыть снимок отметки.
                                Кликается вся ячейка с именем, а не только
                                миниатюра: попасть в кружок 40px мышью на
                                ходу неудобно, а искать «где нажать» никто
                                не станет. */}
                            <button
                              onClick={() => setPhotoFor(row)}
                              className="flex items-center gap-3 text-left flex-1 min-w-0 group"
                              title={row.photoThumb ? 'Показать снимок отметки' : 'Снимка нет'}
                            >
                              <SelfieThumb row={row} />
                              <span className="min-w-0">
                                <span className="font-medium block truncate group-hover:underline">
                                  {row.userName || '—'}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {row.photoThumb ? 'Есть фото отметки' : 'Без снимка'}
                                </span>
                              </span>
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          {row.plannedStart
                            ? <span>{row.plannedStart}–{row.plannedEnd}</span>
                            : <span className="text-muted-foreground">не запланирована</span>}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          {row.clockIn ? (
                            <span>
                              {timeOf(row.clockIn)}
                              <span className="text-muted-foreground"> → {row.clockOut ? timeOf(row.clockOut) : 'на смене'}</span>
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className={`text-xs px-2 py-1 rounded-md font-medium ${STATUS_TONE[row.status]}`}>
                            {STATUS_LABEL[row.status]}
                            {row.status === 'late' && row.lateMinutes > 0 ? ` · ${row.lateMinutes} мин` : ''}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <FineCell
                            row={row}
                            canFine={canFine}
                            finesConfigured={report.finesConfigured}
                            busy={finingId === row.userId}
                            onFine={() => void applyFine(row)}
                            onOpenRules={() => setRulesOpen(true)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="px-3 py-2 border-t bg-muted/20 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                <span>Опоздание считается от планового начала смены, допуск {report.graceMinutes} мин.</span>
                {report.finesConfigured
                  ? <span>Штраф удерживается только по нажатию — сумма считается по правилам.</span>
                  : <span>Штрафы не настроены — суммы не предлагаются.</span>}
                {report.timezone && <span>Часовой пояс: {report.timezone}</span>}
              </div>
            </div>
          )}
        </>
      )}

      {photoFor && <SelfieDialog row={photoFor} onClose={() => setPhotoFor(null)} />}
      {rulesOpen && <LateRulesDialog onClose={() => setRulesOpen(false)} onSaved={() => { setRulesOpen(false); onReload() }} />}
    </div>
  )
}

/** Колонка штрафа: сумма к удержанию, уже удержано, или почему кнопки нет. */
function FineCell({
  row, canFine, finesConfigured, busy, onFine, onOpenRules,
}: {
  row: RollCallRow
  canFine: boolean
  finesConfigured: boolean
  busy: boolean
  onFine: () => void
  onOpenRules: () => void
}) {
  if (row.status !== 'late') return <span className="text-muted-foreground">—</span>
  if (row.fined) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> Удержано
      </span>
    )
  }
  if (!finesConfigured) {
    // Не молчим: без правил кнопки нет, и человек должен понимать почему.
    return (
      <button onClick={onOpenRules} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
        задать правила
      </button>
    )
  }
  if (!canFine) {
    return <span className="text-xs text-muted-foreground">{formatCurrency(Number(row.suggestedFine ?? 0))}</span>
  }
  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={onFine}>
      {busy
        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
        : <>Удержать {formatCurrency(Number(row.suggestedFine ?? 0))}</>}
    </Button>
  )
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function Stat({ label, value, tone, icon }: { label: string; value: number; tone?: string; icon?: React.ReactNode }) {
  return (
    <div className="border rounded-xl px-4 py-3 bg-card">
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">{icon}{label}</div>
      <div className={`text-2xl font-semibold mt-0.5 ${tone ?? ''}`}>{value}</div>
    </div>
  )
}

/**
 * Миниатюра селфи прихода. Превью приходит вместе с перекличкой (~8 КБ), а
 * оригинал тянется только по клику — иначе список на 20 человек весил бы под
 * мегабайт ради картинок, на которые чаще всего не смотрят.
 */
function SelfieThumb({ row }: { row: RollCallRow }) {
  if (!row.photoThumb) {
    return (
      <span className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
        <Camera className="w-4 h-4 text-muted-foreground/60" />
      </span>
    )
  }
  return (
    <span className="w-10 h-10 rounded-full overflow-hidden shrink-0 ring-1 ring-border group-hover:ring-primary transition block">
      <img
        src={`data:image/jpeg;base64,${row.photoThumb}`}
        alt={`Отметка: ${row.userName}`}
        className="w-full h-full object-cover"
      />
    </span>
  )
}

/**
 * Снимок отметки. Оригинал живёт на кассе филиала — если она выключена,
 * показываем превью, которое приехало вместе с перекличкой.
 */
function SelfieDialog({ row, onClose }: { row: RollCallRow; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!row.entryId || !row.photoThumb) return
    let objectUrl: string | null = null
    let alive = true
    void (async () => {
      try {
        const u = await fetchAttendancePhoto(row.entryId!, 'in')
        objectUrl = u
        if (alive) setUrl(u)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Снимок недоступен')
      }
    })()
    // Отзываем object URL: без этого каждый просмотр оставлял бы блоб
    // висеть в памяти вкладки до перезагрузки.
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [row.entryId, row.photoThumb])

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {row.userName} · {row.clockIn ? timeOf(row.clockIn) : 'без отметки'}
          </DialogTitle>
        </DialogHeader>

        {!row.photoThumb ? (
          // Частый случай, и он не ошибка: терминала может не быть вовсе, а
          // отметку мог поставить менеджер руками в табеле.
          <div className="text-center py-8 space-y-2">
            <Camera className="w-8 h-8 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              Снимка нет: отметку поставили без терминала (вручную в табеле) либо у терминала не было камеры.
            </p>
          </div>
        ) : error ? (
          <div className="space-y-3">
            <img
              src={`data:image/jpeg;base64,${row.photoThumb}`}
              alt=""
              className="rounded-lg w-full max-w-[240px] mx-auto"
            />
            <p className="text-xs text-muted-foreground text-center">
              {error}. Показано превью — оригинал хранится на кассе, где сделан снимок.
            </p>
          </div>
        ) : url ? (
          <img src={url} alt={`Отметка: ${row.userName}`} className="rounded-lg w-full" />
        ) : (
          <div className="flex justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          {row.plannedStart ? `По графику ${row.plannedStart}–${row.plannedEnd}` : 'Смена не запланирована'}
          {row.status === 'late' && row.lateMinutes > 0 ? ` · опоздание ${row.lateMinutes} мин` : ''}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Диалог: день ──────────────────────────────────────────────────────────

function DayDialog({
  user, date, current, viaRelay, onClose, onSaved,
}: {
  user: User
  date: string
  current?: PlannedShift
  viaRelay: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [kind, setKind] = useState<'work' | 'off'>(current?.isOff ? 'off' : 'work')
  const [startsAt, setStartsAt] = useState(current?.startsAt || '09:00')
  const [endsAt, setEndsAt] = useState(current?.endsAt || '18:00')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      if (viaRelay) {
        await requestSetScheduleDayRelay({ userId: user.id, date, action: kind, startsAt, endsAt })
        toast.success('Отправлено на кассу филиала')
      } else {
        await setScheduleDay({ userId: user.id, date, kind, startsAt, endsAt })
        toast.success(kind === 'off' ? 'Отгул поставлен' : 'Смена сохранена')
      }
      onSaved()
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    setSaving(true)
    try {
      if (viaRelay) {
        await requestSetScheduleDayRelay({ userId: user.id, date, action: 'reset' })
        toast.success('Отправлено на кассу филиала')
      } else {
        await deleteScheduleDay(user.id, date)
        toast.success('День вернулся к недельному шаблону')
      }
      onSaved()
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{user.name || user.username} · {shortDate(date)}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-1 bg-muted/50 p-1 rounded-xl w-fit">
            <button
              onClick={() => setKind('work')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${kind === 'work' ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
            >
              Рабочий день
            </button>
            <button
              onClick={() => setKind('off')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${kind === 'off' ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
            >
              Выходной
            </button>
          </div>

          {kind === 'work' ? (
            <div className="flex items-center gap-2">
              <Input type="time" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="w-32" />
              <span className="text-muted-foreground">—</span>
              <Input type="time" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="w-32" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Явный выходной вопреки недельному графику. Отметка в этот день попадёт в перекличку как «без графика».
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {current?.source === 'override' ? (
            <Button variant="ghost" onClick={reset} disabled={saving} className="text-muted-foreground">
              <RotateCcw className="w-4 h-4 mr-1.5" /> К шаблону
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>Отмена</Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Сохранить'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Диалог: недельный шаблон ──────────────────────────────────────────────

interface SlotDraft { on: boolean; startsAt: string; endsAt: string }

function TemplateDialog({ user, viaRelay, onClose, onSaved }: { user: User; viaRelay: boolean; onClose: () => void; onSaved: () => void }) {
  const [slots, setSlots] = useState<SlotDraft[]>(
    () => Array.from({ length: 7 }, () => ({ on: false, startsAt: '09:00', endsAt: '18:00' })),
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const rows = await fetchScheduleTemplate(user.id)
        if (!alive) return
        setSlots((prev) => {
          const next = prev.map((s) => ({ ...s }))
          rows.forEach((r) => {
            // weekday в ISO (1=пн), массив 0-based — сдвиг ровно здесь и нигде
            // больше, чтобы не размазывать его по коду.
            const idx = r.weekday - 1
            if (idx >= 0 && idx < 7) next[idx] = { on: true, startsAt: r.startsAt, endsAt: r.endsAt }
          })
          return next
        })
      } catch (e) {
        toast.error(humanizeError(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [user.id])

  const save = async () => {
    setSaving(true)
    try {
      const payload = slots.flatMap((s, i) => (s.on ? [{ weekday: i + 1, startsAt: s.startsAt, endsAt: s.endsAt }] : []))
      if (viaRelay) {
        await requestSetScheduleRelay(user.id, payload)
        toast.success('Отправлено на кассу филиала')
      } else {
        await saveScheduleTemplate(user.id, payload)
        toast.success('Недельный график сохранён')
      }
      onSaved()
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Неделя по умолчанию · {user.name || user.username}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Загружаем…
          </div>
        ) : (
          <div className="space-y-2">
            {slots.map((slot, i) => (
              <div key={i} className="flex items-center gap-3">
                <label className="flex items-center gap-2 w-20 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={slot.on}
                    onChange={(e) => setSlots((p) => p.map((s, j) => (j === i ? { ...s, on: e.target.checked } : s)))}
                    className="accent-primary w-4 h-4"
                  />
                  <span className="text-sm font-medium">{WEEKDAYS[i]}</span>
                </label>
                <Input
                  type="time" value={slot.startsAt} disabled={!slot.on} className="w-32"
                  onChange={(e) => setSlots((p) => p.map((s, j) => (j === i ? { ...s, startsAt: e.target.value } : s)))}
                />
                <span className="text-muted-foreground">—</span>
                <Input
                  type="time" value={slot.endsAt} disabled={!slot.on} className="w-32"
                  onChange={(e) => setSlots((p) => p.map((s, j) => (j === i ? { ...s, endsAt: e.target.value } : s)))}
                />
              </div>
            ))}
            <p className="text-xs text-muted-foreground pt-2 flex items-start gap-1.5">
              <ClipboardCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              Снятый день исчезает из графика целиком. Разовые изменения — подмена, отгул — ставятся кликом по ячейке в сетке недели.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Отмена</Button>
          <Button onClick={save} disabled={saving || loading}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Диалог: правила опозданий ─────────────────────────────────────────────

/**
 * Правила опозданий (105). Формула показана явно и пересчитывается на живом
 * примере: «10 + 2 × 23 = 56 с.» понятнее любого описания, а без примера
 * человек не видит, во что превращается ставка за минуту на реальном
 * опоздании.
 */
function LateRulesDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { restaurantId } = useAuth()
  const [grace, setGrace] = useState('5')
  const [fixed, setFixed] = useState('0')
  const [perMinute, setPerMinute] = useState('0')
  const [max, setMax] = useState('0')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = restaurantId ? await fetchRestaurantById(restaurantId) : null
        if (!alive || !r) return
        setGrace(String(r.lateGraceMinutes ?? 5))
        setFixed(String(r.lateFineFixed ?? 0))
        setPerMinute(String(r.lateFinePerMinute ?? 0))
        setMax(String(r.lateFineMax ?? 0))
      } catch (e) {
        toast.error(humanizeError(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [restaurantId])

  // Пример на опоздании в 30 минут — типичное «проспал», а не крайний случай.
  const example = useMemo(() => {
    const g = Number(grace) || 0
    const f = Number(fixed) || 0
    const pm = Number(perMinute) || 0
    const cap = Number(max) || 0
    const late = 30
    const over = Math.max(0, late - g)
    let sum = over > 0 ? f + pm * over : 0
    const capped = cap > 0 && sum > cap
    if (capped) sum = cap
    return { late, over, sum, capped, configured: f > 0 || pm > 0 }
  }, [grace, fixed, perMinute, max])

  const save = async () => {
    if (!restaurantId) return
    setSaving(true)
    try {
      await updateRestaurant(restaurantId, {
        lateGraceMinutes: Number(grace) || 0,
        lateFineFixed: fixed,
        lateFinePerMinute: perMinute,
        lateFineMax: max,
      })
      toast.success('Правила сохранены')
      onSaved()
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Правила опозданий</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
              Штраф = <b className="text-foreground">фиксированно</b> + <b className="text-foreground">за минуту</b> × (минуты опоздания − допуск),
              но не больше потолка.
            </div>

            <div className="space-y-3">
              <RuleField
                label="Допуск"
                hint="Опоздание в пределах допуска не считается опозданием"
                suffix="мин"
                value={grace}
                onChange={setGrace}
              />
              <RuleField
                label="Фиксированно за опоздание"
                hint="Разово, за сам факт"
                suffix="с."
                value={fixed}
                onChange={setFixed}
              />
              <RuleField
                label="За каждую минуту сверх допуска"
                suffix="с."
                value={perMinute}
                onChange={setPerMinute}
              />
              <RuleField
                label="Потолок штрафа"
                hint="0 — без потолка"
                suffix="с."
                value={max}
                onChange={setMax}
              />
            </div>

            <div className="rounded-lg border px-3 py-2.5 text-sm">
              <div className="text-xs text-muted-foreground mb-1">Например, опоздание на {example.late} мин</div>
              {example.configured ? (
                <div className="flex items-baseline gap-2">
                  <span className="text-lg font-semibold">{formatCurrency(example.sum)}</span>
                  <span className="text-xs text-muted-foreground">
                    {example.over > 0
                      ? <>{fixed || 0} + {perMinute || 0} × {example.over} мин{example.capped ? ' → потолок' : ''}</>
                      : 'в пределах допуска — без штрафа'}
                  </span>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  Суммы не заданы — перекличка будет показывать опоздания, но штрафовать не предложит.
                </div>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              Штраф не списывается сам: система считает сумму, а удерживает её кнопкой человек — время на планшете
              может сбиться, а уход накануне остаться неотмеченным.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Отмена</Button>
          <Button onClick={save} disabled={saving || loading}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Поле правила: подпись слева, число справа, единица прямо в поле. */
function RuleField({
  label, hint, suffix, value, onChange,
}: {
  label: string
  hint?: string
  suffix: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="relative shrink-0">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          className="w-32 pr-9 text-right"
        />
        {/* Единица внутри поля, а не подписью рядом: иначе непонятно, вводить
            сомони или проценты, и в узком диалоге подпись уезжает на строку ниже. */}
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
          {suffix}
        </span>
      </div>
    </div>
  )
}
