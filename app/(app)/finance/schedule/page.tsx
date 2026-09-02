'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, ClipboardCheck, Images, LineChart, Loader2, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'

import { FinanceTabs } from '@/components/finance/finance-tabs'
import { JournalView } from '@/components/schedule/journal'
import { RollCallView } from '@/components/schedule/roll-call'
import { RulesPanel } from '@/components/schedule/rules'
import { WeekGrid } from '@/components/schedule/week-grid'
import { addDays, mondayOf, ymd } from '@/components/schedule/shared'
import { useBranchView } from '@/hooks/use-branch-view'
import { fetchUsers } from '@/lib/queries'
import { fetchRollCall, fetchSchedule, type PlannedShift, type RollCallReport } from '@/lib/queries/schedule'
import { humanizeError } from '@/lib/errors'
import type { User } from '@/lib/types'

/**
 * Учёт рабочего времени — внутренний дашборд раздела «Персонал».
 *
 * Разделов пять, и они не второй ряд вкладок поверх финансовых, а замена
 * прежнему переключателю «Неделя / Перекличка»: три ряда подряд начинали
 * съедать экран раньше, чем начиналось содержимое.
 *
 * Пункты «Отметки» и «Отчёты» появятся вместе со своим содержимым — пустая
 * вкладка хуже, чем её отсутствие.
 */
type Tab = 'overview' | 'timesheet' | 'journal' | 'rules'

const TABS: Array<{ key: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'overview', label: 'Обзор', icon: ClipboardCheck },
  { key: 'timesheet', label: 'Табель', icon: CalendarDays },
  { key: 'journal', label: 'Отметки', icon: Images },
  { key: 'rules', label: 'Правила', icon: SlidersHorizontal },
]

export default function TimeTrackingPage() {
  // Просмотр «как филиал» (ADR-003): читаем обычным GET под X-Branch-Id, а
  // пишем через employee-relay — central не пишет в чужую БД.
  const isBranchView = useBranchView()
  const [tab, setTab] = useState<Tab>('overview')

  // ─── Табель ──────────────────────────────────────────────────────────────
  const [employees, setEmployees] = useState<User[]>([])
  const [weekStart, setWeekStart] = useState(() => mondayOf(ymd(new Date())))
  const [plan, setPlan] = useState<PlannedShift[]>([])
  const [planLoading, setPlanLoading] = useState(true)

  // ─── Обзор ───────────────────────────────────────────────────────────────
  const [rollCallDate, setRollCallDate] = useState(() => ymd(new Date()))
  const [rollCall, setRollCall] = useState<RollCallReport | null>(null)
  const [rollCallLoading, setRollCallLoading] = useState(false)

  // ─── Отметки ─────────────────────────────────────────────────────────────
  const [journalDate, setJournalDate] = useState(() => ymd(new Date()))

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])

  const loadPlan = useCallback(async () => {
    setPlanLoading(true)
    try {
      const [users, rows] = await Promise.all([fetchUsers(), fetchSchedule(days[0], days[6])])
      // Уволенных бэк и так не отдаёт (role='deleted' фильтруется в
      // UsersService.List). Убираем терминал учёта времени — это устройство,
      // а не человек, которому ставят смены.
      setEmployees(users.filter((u) => u.role !== 'checkin'))
      setPlan(rows)
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setPlanLoading(false)
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

  // Грузим только то, что открыто: обзор и табель ходят в разные эндпоинты, и
  // тянуть оба при каждом переключении незачем.
  useEffect(() => {
    if (tab === 'timesheet') void loadPlan()
  }, [tab, loadPlan])
  useEffect(() => {
    if (tab === 'overview') void loadRollCall(rollCallDate)
  }, [tab, rollCallDate, loadRollCall])

  const planIndex = useMemo(() => {
    const m = new Map<string, PlannedShift>()
    plan.forEach((p) => m.set(`${p.userId}|${p.date}`, p))
    return m
  }, [plan])

  return (
    <div className="p-4 md:p-6 space-y-5 min-w-0">
      <FinanceTabs />

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg w-fit overflow-x-auto">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                tab === key ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'
              }`}
            >
              <Icon className="size-3.5 inline mr-1.5 -mt-0.5" />
              {label}
            </button>
          ))}
        </div>

        <p className="text-sm text-muted-foreground">
          {tab === 'overview' && 'Кто вышел, кто опоздал, кого нет'}
          {tab === 'timesheet' && 'План, с которым сравниваются отметки прихода'}
          {tab === 'journal' && 'Кто и когда отметился — со снимками'}
          {tab === 'rules' && 'Как считаются опоздания и штрафы'}
        </p>
      </div>

      {isBranchView && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Просмотр филиала: изменения уходят в очередь и применяются на его кассе в течение минуты.
        </div>
      )}

      {tab === 'overview' && (
        <RollCallView
          date={rollCallDate}
          onDate={setRollCallDate}
          report={rollCall}
          loading={rollCallLoading}
          // В режиме просмотра филиала штраф не выставляем: удержание пишется
          // в свою БД, а не в филиальскую — оно ушло бы не тому.
          canFine={!isBranchView}
          onReload={() => void loadRollCall(rollCallDate)}
        />
      )}

      {tab === 'timesheet' && (
        <WeekGrid
          days={days}
          employees={employees}
          planIndex={planIndex}
          loading={planLoading}
          weekStart={weekStart}
          viaRelay={isBranchView}
          onWeek={(delta) => setWeekStart((w) => addDays(w, delta * 7))}
          onToday={() => setWeekStart(mondayOf(ymd(new Date())))}
          onChanged={() => void loadPlan()}
        />
      )}

      {/* Дата у ленты своя: перекличка смотрит «день целиком», а журнал
          листают по дням, и общая дата заставляла бы их скакать вместе. */}
      {tab === 'journal' && <JournalView date={journalDate} onDate={setJournalDate} />}

      {tab === 'rules' && <RulesPanel />}
    </div>
  )
}
