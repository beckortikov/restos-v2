'use client'

// Табель: недельная сетка плановых смен + правки на конкретные даты.

import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Check, ClipboardCheck, Clock, Loader2, Plus, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  deleteScheduleDay, fetchScheduleTemplate, saveScheduleTemplate, setScheduleDay,
  type PlannedShift,
} from '@/lib/queries/schedule'
import { requestSetScheduleDayRelay, requestSetScheduleRelay } from '@/lib/queries/employee-relay'
import { humanizeError } from '@/lib/errors'
import type { User } from '@/lib/types'
import {
  EmptyHint, WEEKDAYS, initials, isToday, plural, shortDate,
} from './shared'

// ─── Сетка недели ──────────────────────────────────────────────────────────

export function WeekGrid({
  days, employees, planIndex, loading, weekStart, onWeek, onToday, viaRelay, onChanged,
}: {
  days: string[]
  employees: User[]
  planIndex: Map<string, PlannedShift>
  loading: boolean
  weekStart: string
  onWeek: (delta: number) => void
  onToday: () => void
  /** Пишем через relay, когда смотрим «как филиал». */
  viaRelay: boolean
  onChanged: () => void
}) {
  // Диалоги живут здесь, а не на странице: они относятся только к табелю, и
  // тащить их состояние через оболочку значило бы связать вкладки между собой.
  const [dayEdit, setDayEdit] = useState<{ user: User; date: string; current?: PlannedShift } | null>(null)
  const [templateFor, setTemplateFor] = useState<User | null>(null)
  const onCell = (user: User, date: string) =>
    setDayEdit({ user, date, current: planIndex.get(`${user.id}|${date}`) })
  const onTemplate = (user: User) => setTemplateFor(user)
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
                  {/* Липкой колонке нужен НЕПРОЗРАЧНЫй фон: с bg-muted/40
                      сквозь неё просвечивали заголовки дней, наезжая на имя
                      при горизонтальном скролле. */}
                  <th className="text-left font-medium px-4 py-3 w-64 bg-muted border-b sticky left-0 z-20">
                    Сотрудник
                  </th>
                  {days.map((d, i) => (
                    <th
                      key={d}
                      className={`px-2 py-3 font-medium text-center border-b ${isToday(d) ? 'bg-primary/10' : 'bg-muted'}`}
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
                      {/* Тот же приём в теле: сплошной bg-card + рамка
                          справа, чтобы граница прокрутки читалась. */}
                      <td className="px-4 py-2.5 border-b border-r bg-card sticky left-0 z-10">
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

      {dayEdit && (
        <DayDialog
          user={dayEdit.user}
          date={dayEdit.date}
          current={dayEdit.current}
          viaRelay={viaRelay}
          onClose={() => setDayEdit(null)}
          onSaved={() => { setDayEdit(null); onChanged() }}
        />
      )}
      {templateFor && (
        <TemplateDialog
          user={templateFor}
          users={employees}
          viaRelay={viaRelay}
          onClose={() => setTemplateFor(null)}
          onSaved={() => { setTemplateFor(null); onChanged() }}
        />
      )}
    </div>
  )
}

/**
 * Типовые графики. Владельцу почти никогда не нужна произвольная неделя — у
 * него два-три уклада на весь штат, и ставить их семью галочками и
 * четырнадцатью полями времени на каждого человека незачем.
 */
const SHIFT_PRESETS: Array<{ label: string; hint: string; days: number[]; from: string; to: string }> = [
  { label: 'Пн–Пт', hint: '09:00–18:00', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' },
  { label: 'Пн–Сб', hint: '09:00–18:00', days: [1, 2, 3, 4, 5, 6], from: '09:00', to: '18:00' },
  { label: 'Вся неделя', hint: '10:00–22:00', days: [1, 2, 3, 4, 5, 6, 7], from: '10:00', to: '22:00' },
  { label: 'Выходные', hint: '12:00–23:00', days: [6, 7], from: '12:00', to: '23:00' },
]


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

function TemplateDialog({
  user, users, viaRelay, onClose, onSaved,
}: {
  /** Чей шаблон открыли (его текущая неделя и подставляется). */
  user: User
  /** Все сотрудники — для «применить ещё и им». */
  users: User[]
  viaRelay: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [slots, setSlots] = useState<SlotDraft[]>(
    () => Array.from({ length: 7 }, () => ({ on: false, startsAt: '09:00', endsAt: '18:00' })),
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  // Кому ещё применить ту же неделю. Владелец ставит один уклад сразу
  // нескольким — открывать диалог по разу на каждого это и есть та рутина,
  // из-за которой график не заполняют вовсе.
  const [alsoFor, setAlsoFor] = useState<Set<string>>(new Set())

  const others = useMemo(() => users.filter((u) => u.id !== user.id), [users, user.id])

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

  const applyPreset = (preset: typeof SHIFT_PRESETS[number]) => {
    setSlots(Array.from({ length: 7 }, (_, i) => ({
      on: preset.days.includes(i + 1),
      startsAt: preset.from,
      endsAt: preset.to,
    })))
  }

  const save = async () => {
    setSaving(true)
    try {
      const payload = slots.flatMap((s, i) => (s.on ? [{ weekday: i + 1, startsAt: s.startsAt, endsAt: s.endsAt }] : []))
      const targets = [user.id, ...alsoFor]
      // Последовательно, а не Promise.all: каждый вызов идёт со своим
      // Idempotency-Key и пишет в одну таблицу — параллельный залп на два
      // десятка человек ничего не ускорит, зато осложнит разбор, если один
      // из них упадёт.
      for (const id of targets) {
        if (viaRelay) await requestSetScheduleRelay(id, payload)
        else await saveScheduleTemplate(id, payload)
      }
      const suffix = targets.length > 1 ? ` · ${plural(targets.length, 'сотрудник', 'сотрудника', 'сотрудников')}` : ''
      toast.success(viaRelay ? `Отправлено на кассу филиала${suffix}` : `Недельный график сохранён${suffix}`)
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
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {SHIFT_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => applyPreset(preset)}
                  className="px-2.5 py-1.5 rounded-lg border text-xs hover:bg-muted transition-colors text-left"
                >
                  <span className="font-medium">{preset.label}</span>
                  <span className="text-muted-foreground ml-1.5">{preset.hint}</span>
                </button>
              ))}
            </div>

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
            {others.length > 0 && (
              <div className="pt-1">
                <div className="text-xs text-muted-foreground mb-1.5">Применить ещё и им</div>
                <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                  {others.map((o) => {
                    const on = alsoFor.has(o.id)
                    return (
                      <button
                        key={o.id}
                        onClick={() => setAlsoFor((prev) => {
                          const next = new Set(prev)
                          if (on) next.delete(o.id); else next.add(o.id)
                          return next
                        })}
                        className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                          on ? 'bg-primary/10 border-primary/40 text-primary font-medium' : 'border-border text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {on && <Check className="size-3 inline mr-1 -mt-0.5" />}
                        {o.name || o.username}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <p className="text-xs text-muted-foreground pt-1 flex items-start gap-1.5">
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
