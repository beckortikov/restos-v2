'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, Camera, ClipboardCheck, Clock, Loader2, RotateCcw, Users } from 'lucide-react'
import { toast } from 'sonner'

import { FinanceTabs } from '@/components/finance/finance-tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fetchUsers } from '@/lib/queries'
import {
  deleteScheduleDay, fetchAttendancePhoto, fetchRollCall, fetchSchedule, fetchScheduleTemplate,
  saveScheduleTemplate, setScheduleDay,
  type PlannedShift, type RollCallReport, type RollCallRow, type RollCallStatus,
} from '@/lib/queries/schedule'
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

// ─── Страница ──────────────────────────────────────────────────────────────

type Mode = 'grid' | 'rollcall'

export default function SchedulePage() {
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
    <div className="space-y-4">
      <FinanceTabs />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <CalendarDays className="w-5 h-5" /> График смен
          </h1>
          <p className="text-sm text-muted-foreground">
            План, с которым сравниваются отметки прихода. Без него «не пришёл» неотличим от выходного.
          </p>
        </div>
        <div className="flex gap-1 bg-muted/50 p-1 rounded-xl">
          <button
            onClick={() => setMode('grid')}
            className={`px-3.5 py-2 rounded-lg text-xs font-medium ${mode === 'grid' ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
          >
            Неделя
          </button>
          <button
            onClick={() => setMode('rollcall')}
            className={`px-3.5 py-2 rounded-lg text-xs font-medium ${mode === 'rollcall' ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
          >
            Перекличка
          </button>
        </div>
      </div>

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
        />
      )}

      {dayEdit && (
        <DayDialog
          user={dayEdit.user}
          date={dayEdit.date}
          current={dayEdit.current}
          onClose={() => setDayEdit(null)}
          onSaved={() => { setDayEdit(null); void loadPlan() }}
        />
      )}
      {templateFor && (
        <TemplateDialog
          user={templateFor}
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
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onWeek(-1)}>←</Button>
        <Button variant="outline" size="sm" onClick={onToday}>Текущая неделя</Button>
        <Button variant="outline" size="sm" onClick={() => onWeek(1)}>→</Button>
        <span className="text-sm text-muted-foreground ml-1">
          {shortDate(weekStart)} — {shortDate(days[6])}
        </span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Загружаем график…
        </div>
      ) : employees.length === 0 ? (
        <EmptyHint text="Нет сотрудников — заведите их в разделе «Настройки → Пользователи»." />
      ) : (
        // Таблица шире экрана на планшете — скроллим её саму, а не страницу.
        <div className="overflow-x-auto border rounded-xl">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="bg-muted/40">
                <th className="text-left font-medium px-3 py-2 w-56">Сотрудник</th>
                {days.map((d, i) => (
                  <th
                    key={d}
                    className={`px-2 py-2 font-medium text-center ${isToday(d) ? 'text-primary' : ''}`}
                  >
                    <div>{WEEKDAYS[i]}</div>
                    <div className="text-xs text-muted-foreground">{shortDate(d)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {employees.map((u) => (
                <tr key={u.id} className="border-t">
                  <td className="px-3 py-2">
                    <div className="font-medium truncate">{u.name || u.username}</div>
                    <button
                      onClick={() => onTemplate(u)}
                      className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    >
                      <Clock className="w-3 h-3" /> Неделя по умолчанию
                    </button>
                  </td>
                  {days.map((d) => {
                    const cell = planIndex.get(`${u.id}|${d}`)
                    return (
                      <td key={d} className="px-1.5 py-1.5 text-center">
                        <button
                          onClick={() => onCell(u, d)}
                          className={`w-full rounded-lg px-2 py-2 text-xs transition-colors ${cellClass(cell)}`}
                        >
                          {!cell ? '—' : cell.isOff ? 'Выходной' : `${cell.startsAt}–${cell.endsAt}`}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Ячейка с рамкой — правка на конкретную дату (подмена, отгул); без рамки — недельный шаблон.
      </p>
    </div>
  )
}

/** Правка на дату видна рамкой: менеджер должен различать, где он вмешался. */
function cellClass(cell?: PlannedShift): string {
  if (!cell) return 'text-muted-foreground hover:bg-muted/60'
  if (cell.isOff) return 'bg-muted text-muted-foreground border border-dashed border-border'
  return cell.source === 'override'
    ? 'bg-primary/10 text-primary border border-primary/40 font-medium'
    : 'bg-primary/5 text-foreground hover:bg-primary/10'
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
  on_time: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  late: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  absent: 'bg-red-500/10 text-red-600 dark:text-red-400',
  unplanned: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  off: 'bg-muted text-muted-foreground',
}

function RollCallView({
  date, onDate, report, loading,
}: {
  date: string
  onDate: (d: string) => void
  report: RollCallReport | null
  loading: boolean
}) {
  const [photoFor, setPhotoFor] = useState<RollCallRow | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="date"
          value={date}
          onChange={(e) => onDate(e.target.value)}
          className="w-44"
        />
        <Button variant="outline" size="sm" onClick={() => onDate(ymd(new Date()))}>Сегодня</Button>
        {report?.timezone && (
          <span className="text-xs text-muted-foreground">Часовой пояс: {report.timezone}</span>
        )}
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
            <div className="border rounded-xl divide-y">
              {report.rows.map((row) => (
                <div key={row.userId} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <SelfieThumb row={row} onOpen={() => setPhotoFor(row)} />
                  <div className="flex-1 min-w-40">
                    <div className="font-medium">{row.userName || '—'}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.plannedStart
                        ? `По графику ${row.plannedStart}–${row.plannedEnd}`
                        : 'Смена не запланирована'}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground w-32">
                    {row.clockIn ? `Пришёл ${timeOf(row.clockIn)}` : '—'}
                    {row.clockOut ? ` · ушёл ${timeOf(row.clockOut)}` : ''}
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-md font-medium ${STATUS_TONE[row.status]}`}>
                    {STATUS_LABEL[row.status]}
                    {row.status === 'late' && row.lateMinutes > 0 ? ` · ${row.lateMinutes} мин` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {photoFor && <SelfieDialog row={photoFor} onClose={() => setPhotoFor(null)} />}
    </div>
  )
}

/**
 * Миниатюра селфи прихода. Превью приходит вместе с перекличкой (~8 КБ), а
 * оригинал тянется только по клику — иначе список на 20 человек весил бы под
 * мегабайт ради картинок, на которые чаще всего не смотрят.
 */
function SelfieThumb({ row, onOpen }: { row: RollCallRow; onOpen: () => void }) {
  if (!row.photoThumb) {
    return (
      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0" title="Без снимка">
        <Camera className="w-4 h-4 text-muted-foreground/60" />
      </div>
    )
  }
  return (
    <button
      onClick={onOpen}
      className="w-10 h-10 rounded-full overflow-hidden shrink-0 ring-1 ring-border hover:ring-primary transition"
      title="Показать снимок"
    >
      <img
        src={`data:image/jpeg;base64,${row.photoThumb}`}
        alt={`Отметка: ${row.userName}`}
        className="w-full h-full object-cover"
      />
    </button>
  )
}

/** Оригинал снимка. Живёт на кассе филиала — если она выключена, останется превью. */
function SelfieDialog({ row, onClose }: { row: RollCallRow; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!row.entryId) return
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
  }, [row.entryId])

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {row.userName} · {row.clockIn ? timeOf(row.clockIn) : '—'}
          </DialogTitle>
        </DialogHeader>
        {error ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{error}</p>
            {row.photoThumb && (
              <img
                src={`data:image/jpeg;base64,${row.photoThumb}`}
                alt=""
                className="rounded-lg w-full max-w-[240px] mx-auto"
              />
            )}
          </div>
        ) : url ? (
          <img src={url} alt={`Отметка: ${row.userName}`} className="rounded-lg w-full" />
        ) : (
          <div className="flex justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function Stat({ label, value, tone, icon }: { label: string; value: number; tone?: string; icon?: React.ReactNode }) {
  return (
    <div className="border rounded-xl px-3 py-2.5">
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">{icon}{label}</div>
      <div className={`text-2xl font-semibold ${tone ?? ''}`}>{value}</div>
    </div>
  )
}

// ─── Диалог: день ──────────────────────────────────────────────────────────

function DayDialog({
  user, date, current, onClose, onSaved,
}: {
  user: User
  date: string
  current?: PlannedShift
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
      await setScheduleDay({ userId: user.id, date, kind, startsAt, endsAt })
      toast.success(kind === 'off' ? 'Отгул поставлен' : 'Смена сохранена')
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
      await deleteScheduleDay(user.id, date)
      toast.success('День вернулся к недельному шаблону')
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

function TemplateDialog({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: () => void }) {
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
      await saveScheduleTemplate(
        user.id,
        slots.flatMap((s, i) => (s.on ? [{ weekday: i + 1, startsAt: s.startsAt, endsAt: s.endsAt }] : [])),
      )
      toast.success('Недельный график сохранён')
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
