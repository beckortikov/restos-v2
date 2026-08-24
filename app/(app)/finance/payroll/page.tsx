'use client'

import { FinanceTabs } from '@/components/finance/finance-tabs'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency } from '@/lib/helpers'
import { ROLE_LABELS, type User, type FinancialAccount, type TimeEntry } from '@/lib/types'
import {
  fetchUsers, fetchFinancialAccounts,
  fetchTimeEntries, fetchActiveClockIn, clockIn as apiClockIn, clockOut as apiClockOut,
  updateTimeEntry, deleteTimeEntry,
  fetchSalaryReport, type SalaryReport, type SalaryPayoutRow,
  fetchSalaryAccrual, type SalaryAccrualRow,
} from '@/lib/queries'
import { selectableAccounts } from '@/lib/queries/finance'
import { fetchNetworkStaff, payBranchSalary, type NetworkStaff, type NetworkStaffMember } from '@/lib/queries/transfers'
import { DecimalInput } from '@/components/ui/decimal-input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Users, Pencil, Search, Download, Clock, Play, Square, Trash2, Timer, FileText, ClipboardList, ChevronRight, MoreVertical, CalendarDays, TrendingUp, TrendingDown, Store, Wallet } from 'lucide-react'
import { PayEmployeeDialog, PAYOUT_KIND_LABELS, PAYOUT_KIND_TONE, type PayAction } from '@/components/dialogs/pay-employee-dialog'
import { WorkedDaysDialog } from '@/components/dialogs/worked-days-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PayrollVedomost, type VedomostRow } from '@/components/finance/payroll-vedomost'
import { exportToExcel } from '@/lib/export-excel'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'
import { DateRangePresets, getPresetRange, readStoredPreset, type RangePreset } from '@/components/finance/date-range-presets'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'

// isoFromYmd — YYYY-MM-DD (пресет/пикер, локальный календарный день) → ISO-
// границы для запроса. Date.UTC (не локальный конструктор Date) — иначе в
// часовых поясах восточнее UTC (Asia/Dushanbe UTC+5 и весь регион, где
// работает продукт) «1 августа 00:00 местного» конвертируется в
// «31 июля 19:00 UTC», и .slice(0,10) на бэкенде читает это как 31 июля —
// пресет «Месяц» (август) молча захватывал последний день ИЮЛЯ. Для
// зарплаты это не косметика: paidByUser/advDedByUser округляют период до
// МЕСЯЦА (monthPrefix), так что один просочившийся день от TZ-сдвига
// протаскивал в фильтр «выплачено за август» весь предыдущий месяц целиком —
// ровно та путаница, которую 082 (structural salary_period) должен был убрать.
function isoFromYmd(fromYmd: string, toYmd: string): { from: string; to: string } {
  const [fy, fm, fd] = fromYmd.split('-').map(Number)
  const [ty, tm, td] = toYmd.split('-').map(Number)
  const start = new Date(Date.UTC(fy, (fm || 1) - 1, fd || 1, 0, 0, 0, 0))
  const end = new Date(Date.UTC(ty, (tm || 1) - 1, td || 1, 23, 59, 59, 999))
  return { from: start.toISOString(), to: end.toISOString() }
}

// Подпись периода для ведомости: один месяц → «июль 2026», иначе — диапазон дат.
const PERIOD_MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
function periodLabelFromIso(fromIso: string, toIso: string): string {
  const f = new Date(fromIso), t = new Date(toIso)
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return ''
  if (f.getFullYear() === t.getFullYear() && f.getMonth() === t.getMonth()) {
    return `${PERIOD_MONTHS_NOM[f.getMonth()]} ${f.getFullYear()}`
  }
  const d = (x: Date) => x.toLocaleDateString('ru-RU')
  return `${d(f)} — ${d(t)}`
}

// Тренд ФОТ по месяцам (ЗП-7) — та же связка monthKey/monthLabel, что и в
// карточке сотрудника (payroll/[id]), но по факту выплаченного ВСЕЙ команде.
const TREND_MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
function trendMonthKey(dateStr: string): string {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function trendMonthLabel(key: string): string {
  const [y, m] = key.split('-')
  return `${TREND_MONTHS_SHORT[Number(m) - 1] ?? m} ${y}`
}
/** Подпись значения в тултипе: сумма + доля от итога месяца (как в Расходах). */
function trendTooltipValue(value: number, sum: number): string {
  const pct = sum > 0 ? (value / sum) * 100 : 0
  return `${formatCurrency(value)} · ${pct.toFixed(1)}%`
}
const TREND_MAX_MONTHS = 12
type TrendRow = { key: string; label: string; salary: number; advance: number; service: number; total: number }

type TabKey = 'salary' | 'report' | 'vedomost' | 'timesheet'

// ─── Elapsed timer hook ──────────────────────────────────────────────────────

function useElapsed(since: string | undefined, active: boolean) {
  const [elapsed, setElapsed] = useState('')
  useEffect(() => {
    if (!since || !active) { setElapsed(''); return }
    const tick = () => {
      const diff = Date.now() - new Date(since).getTime()
      const h = Math.floor(diff / 3600000)
      const m = Math.floor((diff % 3600000) / 60000)
      const s = Math.floor((diff % 60000) / 1000)
      setElapsed(`${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [since, active])
  return elapsed
}

// ─── Small elapsed display component ─────────────────────────────────────────

function ElapsedBadge({ since }: { since: string }) {
  const elapsed = useElapsed(since, true)
  return <span className="font-mono text-xs text-emerald-700">{elapsed}</span>
}

export default function PayrollPage() {
  const navigate = useNavigate()
  const { user: currentUser, canDo, canAccessRoles, restaurantId } = useAuth()
  const [tab, setTab] = useState<TabKey>('salary')
  const [employees, setEmployees] = useState<User[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [loading, setLoading] = useState(true)

  // ─── Salary state ──────────────────────────────────────────────────────────
  const [payAction, setPayAction] = useState<PayAction | null>(null)
  const [selectedEmp, setSelectedEmp] = useState<User | null>(null)
  // ─── Единый персонал сети (по просьбе владельца, 2026-08-24) ─────────────
  // На ЦЕНТРАЛЬНОМ узле этот экран показывает и сотрудников филиалов: в
  // центре штата почти нет (узел для управления и отчётов), а зарплату всей
  // сети платят отсюда. Отдельная страница «Персонал сети» упразднена.
  // networkStaff != null означает «я central и в сети» — на филиалах и вне
  // сети экран остаётся строго локальным.
  const [networkStaff, setNetworkStaff] = useState<NetworkStaff | null>(null)
  const [branchFilter, setBranchFilter] = useState('all')
  // Выплата сотруднику филиала — свой мини-диалог поверх payBranchSalary
  // (Ф-Р): деньги списываются со счёта ЦЕНТРА, зеркало едет в филиал; кап
  // «не выплатить дважды» сервер считает глазами филиала. PayEmployeeDialog
  // сюда не годится: он работает через локальные зарплатные API узла.
  const [branchPayFor, setBranchPayFor] = useState<(User & { branchId?: string; branchName?: string }) | null>(null)
  const [branchPayAmount, setBranchPayAmount] = useState(0)
  const [branchPayAccountId, setBranchPayAccountId] = useState('')
  const [branchPayPeriod, setBranchPayPeriod] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [branchPaying, setBranchPaying] = useState(false)
  // Отметка отработанных дней (дневная оплата) — из «⋯»-меню строки.
  const [workedDaysEmp, setWorkedDaysEmp] = useState<User | null>(null)
  // Отметка явки за другого сотрудника (054).
  const [attendanceEmpId, setAttendanceEmpId] = useState('')
  const [markingAttendance, setMarkingAttendance] = useState(false)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'with_salary' | 'no_salary' | 'has_advance' | 'has_deduction'>('all')

  // ─── Service-charge state (period-scoped) ─────────────────────────────────
  const [servicePreset, setServicePreset] = useState<RangePreset>(() => readStoredPreset('payroll:service-preset', 'month'))
  const _initR = servicePreset === 'custom' ? getPresetRange('month') : getPresetRange(servicePreset)
  const _initIso = isoFromYmd(_initR.from, _initR.to)
  const [serviceFrom, setServiceFrom] = useState<string>(_initIso.from)
  const [serviceTo, setServiceTo] = useState<string>(_initIso.to)
  const [serviceCustomFrom, setServiceCustomFrom] = useState<string>(getPresetRange('month').from)
  const [serviceCustomTo, setServiceCustomTo] = useState<string>(getPresetRange('month').to)
  // ─── Accrual state (054) ───────────────────────────────────────────────────
  // Начислено за период: для оклада — сумма из карточки, для дневной оплаты —
  // ставка × дни с отметкой в табеле. Считает сервер: дни живут в time_entries.
  const [accrualByUser, setAccrualByUser] = useState<Record<string, SalaryAccrualRow>>({})

  // ─── Report state ──────────────────────────────────────────────────────────
  // Отчёт считает сервер (агрегация financial_operations), а не браузер: раньше
  // «Выплачено» тянуло на клиент всю историю операций и фильтровало её в цикле.
  const [report, setReport] = useState<SalaryReport | null>(null)
  const [reportLoading, setReportLoading] = useState(false)
  // «История» — свой диапазон, НЕ период начисления вкладки «Сотрудники» (тот =
  // текущий месяц, для «К выплате»). Владелец хочет видеть всю историю выплат
  // целиком, поэтому по умолчанию «Всё время».
  const [historyScope, setHistoryScope] = useState<'month' | 'quarter' | 'year' | 'all'>('all')

  // ─── Trend state (ЗП-7) ─────────────────────────────────────────────────────
  // Тренд по месяцам — НЕЗАВИСИМ от выбора периода выше (тот может быть
  // «Сегодня»): всегда тянем последние TREND_MAX_MONTHS, а 3/6/12 переключают
  // только то, сколько из уже загруженного показываем (без перезапроса).
  const [trendPayouts, setTrendPayouts] = useState<SalaryPayoutRow[]>([])
  const [trendLoading, setTrendLoading] = useState(false)
  const [trendMonths, setTrendMonths] = useState<3 | 6 | 12>(6)

  // ─── Timesheet state ───────────────────────────────────────────────────────
  // Табель — лента приходов/уходов, а не сумма за период: свой скользящий
  // фильтр («последние 7/30 дней от сейчас»), НЕ общий календарный период
  // выше (Сегодня/Неделя/Месяц/…, привязанный к serviceFrom/serviceTo для
  // Зарплаты/Обслуживания/Отчёта). Объединять их не стоит — «Квартал»/«Год»
  // вернули бы тысячи записей табеля без пагинации ради виртуального
  // единообразия (ЗП-8). Ярлыки ниже — «7 дней»/«30 дней», НЕ «Неделя»/
  // «Месяц»: те же слова у общего фильтра означают календарный период, а
  // здесь — скользящее окно, путать пользователя одинаковыми подписями
  // с разным смыслом ни к чему.
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([])
  const [myActiveEntry, setMyActiveEntry] = useState<TimeEntry | null>(null)
  const [timePeriod, setTimePeriod] = useState<'week' | 'month' | 'all'>('week')
  // Фильтр по сотруднику (Фаза 3) — «» = все. Отдельно от statusFilter/roleFilter
  // вкладки «Сотрудники»: тот работает над accrual за общий период страницы, этот
  // — над лентой табеля за скользящее окно timePeriod.
  const [timesheetEmpFilter, setTimesheetEmpFilter] = useState('')
  const [timeLoading, setTimeLoading] = useState(false)
  const [editingEntry, setEditingEntry] = useState<string | null>(null)
  const [editClockIn, setEditClockIn] = useState('')
  const [editClockOut, setEditClockOut] = useState('')
  const [editBreak, setEditBreak] = useState(0)
  const elapsed = useElapsed(myActiveEntry?.clockIn, !!myActiveEntry)

  // loadAccrual — начисления за период, включая «выплачено за период»
  // (paidSalary/paidCombined — structural salary_period на сервере, см.
  // salary_accrual.go). Раньше «выплачено» тянулось отдельным запросом на
  // клиенте и фильтровалось по ДАТЕ проводки в окне периода — выплата «за
  // июль», проведённая в августе (обычное дело), задваивалась в августе и
  // «К выплате» уходило в минус. Один источник истины вместо двух разных.
  const loadAccrual = useCallback(async (): Promise<Record<string, SalaryAccrualRow>> => {
    const rows = await fetchSalaryAccrual(serviceFrom.slice(0, 10), serviceTo.slice(0, 10)).catch(() => [])
    return Object.fromEntries(rows.map(r => [r.userId, r]))
  }, [serviceFrom, serviceTo])

  // Сетевой персонал: только когда Я — центральный склад своей сети. На
  // филиале/вне сети network/staff либо не отдаётся, либо отдаётся, но
  // вливать чужой штат в локальный экран филиала не нужно — платить за
  // других может только центр (requireCentralOwner на PayBranchSalary).
  const loadNetworkStaff = async (): Promise<NetworkStaff | null> => {
    try {
      const ns = await fetchNetworkStaff()
      const meCentral = ns.branches.some(b => b.id === restaurantId && b.kind === 'central_warehouse')
      return meCentral ? ns : null
    } catch {
      return null // не в сети / нет права — экран остаётся локальным
    }
  }

  const reload = async () => {
    const [users, accs, accrualRows, ns] = await Promise.all([
      fetchUsers(),
      fetchFinancialAccounts().then(selectableAccounts),
      loadAccrual(),
      loadNetworkStaff(),
    ])
    setNetworkStaff(ns)
    // Начисления филиалов — глазами каждого филиала (X-Branch-Id, Ф5б):
    // все нужные таблицы реплицированы, расчёт на центре даёт тот же ответ.
    // Ошибки филиала не валят общий экран — его строки просто без начислений.
    if (ns) {
      const branchIds = ns.branches.filter(b => b.id !== restaurantId).map(b => b.id)
      const perBranch = await Promise.all(branchIds.map(bid =>
        fetchSalaryAccrual(serviceFrom.slice(0, 10), serviceTo.slice(0, 10), bid).catch(() => []),
      ))
      for (const rows of perBranch) {
        for (const r of rows) accrualRows[r.userId] = r
      }
    }
    setEmployees(users.filter(u => u.role !== 'owner' && u.role !== 'superadmin'))
    setAccounts(accs)
    // Счёт НЕ преднастраиваем. Раньше здесь подставлялся accs[0], а
    // selectedAccountId не сбрасывался между модалками — форма не спрашивала,
    // с какого счёта платить, а угадывала, и следующая выплата молча уходила
    // с того же счёта, что и прошлая. Деньги уходили не оттуда, откуда думал
    // кассир. Теперь выбор обязателен и делается заново на каждую выплату
    // (сброс — в openDialog).
    setAccrualByUser(accrualRows)
  }

  const loadTimeEntries = useCallback(async () => {
    setTimeLoading(true)
    try {
      const now = new Date()
      let dateFrom: string | undefined
      if (timePeriod === 'week') {
        const d = new Date(now)
        d.setDate(d.getDate() - 7)
        dateFrom = d.toISOString().slice(0, 10)
      } else if (timePeriod === 'month') {
        const d = new Date(now)
        d.setDate(d.getDate() - 30)
        dateFrom = d.toISOString().slice(0, 10)
      }
      const entries = await fetchTimeEntries(dateFrom)
      setTimeEntries(entries)

      if (currentUser) {
        const active = await fetchActiveClockIn(currentUser.id)
        setMyActiveEntry(active)
      }
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка загрузки табеля'))
    } finally {
      setTimeLoading(false)
    }
  }, [timePeriod, currentUser])

  useEffect(() => {
    reload().finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Перезапрашиваем зарплатные данные при смене периода (users/accounts уже загружены).
  useEffect(() => {
    if (loading) return
    ;(async () => {
      const rows = await loadAccrual().catch(() => ({} as Record<string, SalaryAccrualRow>))
      if (networkStaff) {
        const branchIds = networkStaff.branches.filter(b => b.id !== restaurantId).map(b => b.id)
        const perBranch = await Promise.all(branchIds.map(bid =>
          fetchSalaryAccrual(serviceFrom.slice(0, 10), serviceTo.slice(0, 10), bid).catch(() => []),
        ))
        for (const brRows of perBranch) {
          for (const r of brRows) rows[r.userId] = r
        }
      }
      setAccrualByUser(rows)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceFrom, serviceTo])

  useEffect(() => {
    if (tab === 'timesheet') loadTimeEntries()
  }, [tab, loadTimeEntries])

  // Отчёт грузим только на своей вкладке и перезапрашиваем при смене периода —
  // он использует тот же селектор дат, что и обслуживание выше.
  const loadReport = useCallback(async () => {
    setReportLoading(true)
    try {
      const now = new Date()
      const to = now.toISOString().slice(0, 10)
      const pad2 = (n: number) => String(n).padStart(2, '0')
      let from = '2000-01-01' // 'all' — всё время
      if (historyScope === 'month') from = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`
      else if (historyScope === 'quarter') from = `${now.getFullYear()}-${pad2(Math.floor(now.getMonth() / 3) * 3 + 1)}-01`
      else if (historyScope === 'year') from = `${now.getFullYear()}-01-01`
      setReport(await fetchSalaryReport(from, to))
    } catch (e) {
      toast.error(humanizeError(e, 'Не удалось загрузить историю'))
    } finally {
      setReportLoading(false)
    }
  }, [historyScope])

  useEffect(() => {
    if (tab === 'report') loadReport()
  }, [tab, loadReport])

  // Тренд — своя независимая загрузка (последние TREND_MAX_MONTHS), не
  // привязанная к выбору периода выше: тренд показывает динамику, а не
  // «остаток на сейчас», поэтому «Сегодня»/«Неделя» не должны его резать.
  const loadTrend = useCallback(async () => {
    setTrendLoading(true)
    try {
      const now = new Date()
      const from = new Date(now.getFullYear(), now.getMonth() - (TREND_MAX_MONTHS - 1), 1)
      const rep = await fetchSalaryReport(
        `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-01`,
        now.toISOString().slice(0, 10),
      )
      setTrendPayouts(rep.payouts)
    } catch (e) {
      toast.error(humanizeError(e, 'Не удалось загрузить тренд'))
    } finally {
      setTrendLoading(false)
    }
  }, [])

  useEffect(() => {
    if (tab === 'report') loadTrend()
  }, [tab, loadTrend])

  const trendRows = useMemo<TrendRow[]>(() => {
    const now = new Date()
    const keys: string[] = []
    for (let i = trendMonths - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    }
    const byKey = new Map<string, TrendRow>(
      keys.map(k => [k, { key: k, label: trendMonthLabel(k), salary: 0, advance: 0, service: 0, total: 0 }])
    )
    for (const p of trendPayouts) {
      const k = trendMonthKey(p.date)
      const row = byKey.get(k)
      if (!row) continue
      if (p.kind === 'salary') row.salary += p.amount
      else if (p.kind === 'advance') row.advance += p.amount
      else if (p.kind === 'service') row.service += p.amount
      row.total += p.amount
    }
    return keys.map(k => byKey.get(k)!)
  }, [trendPayouts, trendMonths])

  // Δ последнего полного месяца к предыдущему — быстрый индикатор роста ФОТ.
  const trendDelta = useMemo(() => {
    if (trendRows.length < 2) return null
    const last = trendRows[trendRows.length - 1]
    const prev = trendRows[trendRows.length - 2]
    if (prev.total <= 0) return null
    return ((last.total - prev.total) / prev.total) * 100
  }, [trendRows])

  const exportReport = () => {
    if (!report) return
    exportToExcel(
      report.payouts.map(p => ({
        date: p.date,
        employee: p.userName,
        kind: PAYOUT_KIND_LABELS[p.kind],
        account: p.accountName ?? '',
        amount: p.amount,
      })),
      [
        { key: 'date', header: 'Дата' },
        { key: 'employee', header: 'Сотрудник' },
        { key: 'kind', header: 'Вид выплаты' },
        { key: 'account', header: 'Со счёта' },
        { key: 'amount', header: 'Сумма' },
      ],
      `Зарплата ${report.from} — ${report.to}`,
    )
  }

  // ─── Salary helpers ────────────────────────────────────────────────────────

  // Логика выплаты/удержания/правки оклада — в PayEmployeeDialog (ЗП-5,
  // извлечена для переиспользования на карточке сотрудника). Здесь только
  // «какой диалог открыт для кого» — сама форма ничего не знает про список.
  const openDialog = (emp: User, action: PayAction) => {
    setSelectedEmp(emp)
    setPayAction(action)
  }

  const closeDialog = () => { setPayAction(null); setSelectedEmp(null) }

  // Выплата сотруднику филиала со счёта центра (Ф-Р, payBranchSalary).
  const onBranchPay = async () => {
    if (!branchPayFor?.branchId || !branchPayAccountId || branchPayAmount <= 0) return
    setBranchPaying(true)
    try {
      await payBranchSalary({
        branchId: branchPayFor.branchId,
        userId: branchPayFor.id,
        amount: branchPayAmount,
        accountId: branchPayAccountId,
        period: branchPayPeriod,
      })
      toast.success(`Выплачено: ${branchPayFor.name}`)
      setBranchPayFor(null)
      await reload()
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setBranchPaying(false)
    }
  }

  // ─── Timesheet helpers ─────────────────────────────────────────────────────

  // handleMarkAttendance — менеджер отмечает выход сотрудника на смену.
  // Тот же clockIn, что и «Начать смену», только за другого: бэкенд принимает
  // произвольный user_id. Начисление дневной оплаты считает именно эти дни,
  // поэтому после отметки перезагружаем начисления.
  const handleMarkAttendance = async () => {
    if (!attendanceEmpId || markingAttendance) return
    const emp = employees.find(e => e.id === attendanceEmpId)
    setMarkingAttendance(true)
    try {
      await apiClockIn(attendanceEmpId)
      toast.success(`${emp?.name ?? 'Сотрудник'}: явка отмечена`)
      setAttendanceEmpId('')
      await loadTimeEntries()
      setAccrualByUser(await loadAccrual())
    } catch (e) {
      toast.error(humanizeError(e, 'Не удалось отметить явку'))
    } finally {
      setMarkingAttendance(false)
    }
  }

  const handleClockIn = async () => {
    if (!currentUser) return
    try {
      await apiClockIn(currentUser.id)
      toast.success('Смена начата')
      await loadTimeEntries()
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка'))
    }
  }

  const handleClockOut = async () => {
    if (!myActiveEntry) return
    try {
      await apiClockOut(myActiveEntry.id)
      toast.success('Смена завершена')
      await loadTimeEntries()
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка'))
    }
  }

  const startEdit = (entry: TimeEntry) => {
    setEditingEntry(entry.id)
    setEditClockIn(entry.clockIn.slice(0, 16))
    setEditClockOut(entry.clockOut?.slice(0, 16) ?? '')
    setEditBreak(entry.breakMinutes)
  }

  const saveEdit = async (id: string) => {
    try {
      await updateTimeEntry(id, {
        clockIn: new Date(editClockIn).toISOString(),
        clockOut: editClockOut ? new Date(editClockOut).toISOString() : undefined,
        breakMinutes: editBreak,
      })
      setEditingEntry(null)
      toast.success('Запись обновлена')
      await loadTimeEntries()
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка'))
    }
  }

  const handleDeleteEntry = async (id: string) => {
    try {
      await deleteTimeEntry(id)
      toast.success('Запись удалена')
      await loadTimeEntries()
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка'))
    }
  }

  // ─── Loading ───────────────────────────────────────────────────────────────

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  // ─── Salary computed ───────────────────────────────────────────────────────

  // ─── Единый персонал: свои + филиальные ────────────────────────────────
  // Филиальный сотрудник мапится в ту же форму строки User + метка филиала:
  // одна таблица, одни фильтры, один поиск. У чужих строк нет username/
  // permissions — в таблице они и не нужны.
  type RowU = User & { branchId?: string; branchName?: string }
  const branchRows: RowU[] = networkStaff
    ? networkStaff.staff
        .filter(u => u.branchId && u.branchId !== restaurantId && u.role !== 'superadmin')
        .map(u => ({
          id: u.id,
          name: u.name,
          username: '',
          role: u.role as User['role'],
          roleDisplay: (ROLE_LABELS as Record<string, string>)[u.role] ?? u.role,
          restaurantId: u.branchId!,
          position: u.position ?? undefined,
          salary: u.salary,
          dailyRate: u.dailyRate,
          payType: u.payType,
          branchId: u.branchId!,
          branchName: u.branchName,
        } as RowU))
    : []
  const mergedEmployees: RowU[] = [...employees, ...branchRows]
  const branchNameOf = (e: RowU) => e.branchName
  // Счётчики для фильтра по филиалам (свои — под именем узла-центра).
  const myBranchMeta = networkStaff?.branches.find(b => b.id === restaurantId)

  // ФОТ считаем по НАЧИСЛЕННОМУ: у дневников оклад нулевой, и старый подсчёт
  // по e.salary просто не видел бы их в фонде оплаты труда.
  const accruedOf = (e: User) => accrualByUser[e.id]?.accrued ?? (e.salary ?? 0)
  // Аванс/удержания — period-scoped (из accrual за выбранный период), а НЕ
  // глобальный счётчик e.advance/deductions: аванс за прошлый месяц не должен
  // резать остаток текущего (баг владельца, backend-фикс period-scoped).
  const advOf = (e: User) => accrualByUser[e.id]?.advance ?? 0
  const dedOf = (e: User) => accrualByUser[e.id]?.deductions ?? 0
  // Выплачено за период — из accrual (server-side, structural salary_period),
  // НЕ из отдельного клиентского запроса по дате проводки (см. историю бага
  // в комментарии loadAccrual). paidOf — только «Зарплата», для остатка;
  // paidCombinedOf — «Зарплата»+«Аванс», только для display «Выплачено (ЗП)».
  const paidOf = (e: User) => accrualByUser[e.id]?.paidSalary ?? 0
  const paidCombinedOf = (e: User) => accrualByUser[e.id]?.paidCombined ?? 0
  const withSalary = mergedEmployees.filter(e => accruedOf(e) > 0)
  const totalSalary = withSalary.reduce((s, e) => s + accruedOf(e), 0)
  const totalAdvance = withSalary.reduce((s, e) => s + advOf(e), 0)
  const totalDeductions = withSalary.reduce((s, e) => s + dedOf(e), 0)
  const totalSalaryPaid = withSalary.reduce((s, e) => s + paidCombinedOf(e), 0)
  const totalSalaryOnlyPaid = withSalary.reduce((s, e) => s + paidOf(e), 0)
  // «К выплате» считаем ТОЧНО как сервер (accrued − advance − deductions −
  // paid[категория «Зарплата» СТРОГО]) — иначе получаем один из двух багов:
  // без вычитания paid вообще — после полной выплаты оклада всё ещё
  // показывало бы его целиком; с вычитанием combined (Зарплата+Аванс) —
  // аванс, выданный внутри периода, срезался бы дважды (он уже вычтен через
  // totalAdvance = Σ emp.advance). totalSalaryPaid (combined) — только для
  // display «Выплачено (ЗП)», в этой формуле участвовать не должен.
  const totalToPay = totalSalary - totalAdvance - totalDeductions - totalSalaryOnlyPaid
  // Фаза 2: сводка «К выплате» — Σ только положительных остатков (реально
  // причитается), а не чистое нетто totalToPay (тот остаётся для футера
  // таблицы, где строки должны арифметически суммироваться в то, что видно
  // построчно). Иначе переплата одному сотруднику молча гасит недоплату
  // другому в headline-цифре — оба случая требуют внимания владельца, а не
  // взаимного сокращения в одну неприметную сумму.
  const perEmployeeToPay = withSalary.map(e => ({
    employee: e,
    toPay: accruedOf(e) - advOf(e) - dedOf(e) - paidOf(e),
  }))
  const totalToPayPositive = perEmployeeToPay.reduce((s, r) => s + Math.max(0, r.toPay), 0)
  const overpaidRows = perEmployeeToPay.filter(r => r.toPay < -0.005)
  const totalOverpaid = overpaidRows.reduce((s, r) => s + Math.abs(r.toPay), 0)

  // Ведомость (#3): роспись «начислено/аванс/удержания/к выплате» за период,
  // те же period-scoped цифры, что в списке. Кто получает — с начислением > 0.
  // payType/daysWorked/extraShiftUnits — для колонки «Дней»: у дневника
  // оплаченные единицы, у оклада — доп. смены, если реально были отмечены.
  const vedomostPeriodLabel = periodLabelFromIso(serviceFrom, serviceTo)
  const vedomostRows: VedomostRow[] = withSalary.map(e => ({
    id: e.id,
    name: e.name,
    position: e.position || ROLE_LABELS[e.role],
    accrued: accruedOf(e),
    advance: advOf(e),
    deductions: dedOf(e),
    toPay: accruedOf(e) - advOf(e) - dedOf(e) - paidOf(e),
    payType: accrualByUser[e.id]?.payType ?? 'monthly',
    daysWorked: accrualByUser[e.id]?.paidUnits ?? 0,
    extraShiftUnits: accrualByUser[e.id]?.extraShiftUnits ?? 0,
  }))

  const filtered = mergedEmployees.filter(e => {
    if (branchFilter !== 'all') {
      const home = e.branchId ?? restaurantId ?? ''
      if (home !== branchFilter) return false
    }
    if (roleFilter !== 'all' && e.role !== roleFilter) return false
    if (statusFilter === 'with_salary' && (e.salary ?? 0) === 0) return false
    if (statusFilter === 'no_salary' && (e.salary ?? 0) > 0) return false
    if (statusFilter === 'has_advance' && advOf(e) === 0) return false
    if (statusFilter === 'has_deduction' && dedOf(e) === 0) return false
    if (search.trim()) {
      const q = search.toLowerCase()
      return e.name.toLowerCase().includes(q) || (e.position || '').toLowerCase().includes(q) || e.username.toLowerCase().includes(q)
    }
    return true
  })

  const roleStats = mergedEmployees.reduce<Record<string, number>>((acc, e) => { acc[e.role] = (acc[e.role] || 0) + 1; return acc }, {})

  // ─── Timesheet computed ────────────────────────────────────────────────────

  const activeEntries = timeEntries.filter(e => e.status === 'active')

  // Visible entries: managers see all (опционально сузить фильтром по
  // сотруднику — Фаза 3), остальные видят только свои записи.
  const isManager = canDo('payroll.manage')
  const visibleEntries = (isManager
    ? timeEntries
    : timeEntries.filter(e => e.userId === currentUser?.id)
  ).filter(e => !timesheetEmpFilter || e.userId === timesheetEmpFilter)

  // Summary: hours per employee
  const hoursSummary = visibleEntries.reduce<Record<string, { name: string; hours: number; count: number }>>((acc, e) => {
    const key = e.userId
    if (!acc[key]) acc[key] = { name: e.userName || 'Неизвестно', hours: 0, count: 0 }
    acc[key].hours += e.totalHours ?? 0
    acc[key].count += 1
    return acc
  }, {})

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
  }

  const formatTime = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 md:p-6 space-y-5">
      <FinanceTabs />
      {/* Header + Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg">
            <button onClick={() => setTab('salary')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${tab === 'salary' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
              <Users className="size-3.5 inline mr-1.5 -mt-0.5" />
              Сотрудники
            </button>
            <button onClick={() => setTab('report')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${tab === 'report' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
              <FileText className="size-3.5 inline mr-1.5 -mt-0.5" />
              История
            </button>
            <button onClick={() => setTab('vedomost')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${tab === 'vedomost' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
              <ClipboardList className="size-3.5 inline mr-1.5 -mt-0.5" />
              Ведомость
            </button>
            <button onClick={() => setTab('timesheet')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${tab === 'timesheet' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
              <Clock className="size-3.5 inline mr-1.5 -mt-0.5" />
              Табель
            </button>
          </div>
        </div>
        {tab === 'salary' && (
          <div className="flex items-center gap-2">
            <p className="text-muted-foreground text-sm">{mergedEmployees.length} сотрудников</p>
            <button
              onClick={() => {
                exportToExcel(
                  filtered.map(e => ({
                    name: e.name,
                    position: e.position || ROLE_LABELS[e.role],
                    salary: accruedOf(e),
                    advance: advOf(e),
                    deductions: dedOf(e),
                    salaryPaidPeriod: paidCombinedOf(e),
                    // period-scoped: accrued/advance/deductions из accrual, paidOf
                    // (не paidCombinedOf) — иначе аванс внутри периода вычтется дважды.
                    toPay: accruedOf(e) - advOf(e) - dedOf(e) - paidOf(e),
                  })),
                  [
                    { key: 'name', header: 'Сотрудник' },
                    { key: 'position', header: 'Должность' },
                    { key: 'salary', header: 'Оклад' },
                    { key: 'advance', header: 'Аванс' },
                    { key: 'deductions', header: 'Удержания' },
                    { key: 'salaryPaidPeriod', header: 'Выплачено (ЗП)' },
                    { key: 'toPay', header: 'К выплате' },
                  ],
                  'Зарплата'
                )
              }}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors"
            >
              <Download className="size-3.5" />
              Excel
            </button>
          </div>
        )}
      </div>

      {/* ═══════════════════════════ SALARY TAB ═══════════════════════════════ */}
      {tab === 'salary' && (
        <>
          {/* Период — управляет всей таблицей (начисления, выплаты, обслуживание),
              не только обслуживанием: подпись и цвет нейтральные, иначе читалось
              как «фильтр только для сервиса». */}
          <div className="flex flex-wrap items-center gap-3 bg-muted/30 border border-border rounded-xl p-3">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase">Период</label>
            <DateRangePresets
              value={servicePreset}
              onChange={(p, r) => {
                setServicePreset(p)
                if (p === 'custom') {
                  setServiceCustomFrom(r.from); setServiceCustomTo(r.to)
                  if (r.from && r.to) { const iso = isoFromYmd(r.from, r.to); setServiceFrom(iso.from); setServiceTo(iso.to) }
                } else {
                  const iso = isoFromYmd(r.from, r.to); setServiceFrom(iso.from); setServiceTo(iso.to)
                }
              }}
              customFrom={serviceCustomFrom}
              customTo={serviceCustomTo}
              onCustomFromChange={(v) => { setServicePreset('custom'); setServiceCustomFrom(v); if (v && serviceCustomTo) { const iso = isoFromYmd(v, serviceCustomTo); setServiceFrom(iso.from); setServiceTo(iso.to) } }}
              onCustomToChange={(v) => { setServicePreset('custom'); setServiceCustomTo(v); if (serviceCustomFrom && v) { const iso = isoFromYmd(serviceCustomFrom, v); setServiceFrom(iso.from); setServiceTo(iso.to) } }}
              storageKey="payroll:service-preset"
            />
          </div>

          {/* KPI — только оклад/аванс/удержания. Обслуживание — на своей
              вкладке (/finance/service-report), эти же цифры показывались
              бы второй раз (ЗП-6). */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <div className="bg-card rounded-xl border border-border p-4">
              <p className="text-xs text-muted-foreground">ФОТ (оклады)</p>
              <p className="text-2xl font-bold text-foreground mt-1">{formatCurrency(totalSalary)}</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-4">
              <p className="text-xs text-muted-foreground">Выдано авансов</p>
              <p className="text-2xl font-bold text-amber-600 mt-1">{formatCurrency(totalAdvance)}</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-4">
              <p className="text-xs text-muted-foreground">Удержания</p>
              <p className="text-2xl font-bold text-destructive mt-1">{formatCurrency(totalDeductions)}</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-4">
              <p className="text-xs text-muted-foreground">К выплате (оклад)</p>
              <p className="text-2xl font-bold text-emerald-600 mt-1">{formatCurrency(totalToPayPositive)}</p>
              {overpaidRows.length > 0 && (
                <p className="text-[11px] text-amber-600 font-medium mt-1">
                  Переплаты: {formatCurrency(totalOverpaid)} у {overpaidRows.length} чел.
                </p>
              )}
            </div>
          </div>

          {/* Филиалы: единый персонал сети — фильтр по узлам (центр + филиалы).
              Виден только на центральном узле сети; сотрудники филиалов в общем
              списке помечены бейджем филиала. */}
          {networkStaff && branchRows.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg">
                <button onClick={() => setBranchFilter('all')}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${branchFilter === 'all' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
                  Вся сеть ({mergedEmployees.length})
                </button>
                {restaurantId && (
                  <button onClick={() => setBranchFilter(restaurantId)}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${branchFilter === restaurantId ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
                    {myBranchMeta?.name ?? 'Центр'} ({employees.length})
                  </button>
                )}
                {networkStaff.branches.filter(b => b.id !== restaurantId).map(b => (
                  <button key={b.id} onClick={() => setBranchFilter(branchFilter === b.id ? 'all' : b.id)}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors inline-flex items-center gap-1 ${branchFilter === b.id ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
                    <Store className="size-3" /> {b.name} ({branchRows.filter(r => r.branchId === b.id).length})
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Filters */}
          {mergedEmployees.length > 5 && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg">
                {([
                  ['all', `Все (${mergedEmployees.length})`],
                  ['with_salary', `С окладом (${withSalary.length})`],
                  ['no_salary', `Без оклада (${mergedEmployees.length - withSalary.length})`],
                  ['has_advance', `С авансом (${mergedEmployees.filter(e => advOf(e) > 0).length})`],
                  ['has_deduction', `С удержанием (${mergedEmployees.filter(e => dedOf(e) > 0).length})`],
                ] as const).map(([key, label]) => (
                  <button key={key} onClick={() => setStatusFilter(key)}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${statusFilter === key ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
                    {label}
                  </button>
                ))}
              </div>

              {Object.keys(roleStats).length > 1 && (
                <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg">
                  <button onClick={() => setRoleFilter('all')}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${roleFilter === 'all' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
                    Все роли
                  </button>
                  {Object.entries(roleStats).sort((a, b) => b[1] - a[1]).map(([role, count]) => (
                    <button key={role} onClick={() => setRoleFilter(roleFilter === role ? 'all' : role)}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${roleFilter === role ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
                      {ROLE_LABELS[role as keyof typeof ROLE_LABELS] || role} {count}
                    </button>
                  ))}
                </div>
              )}

              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск..."
                  className="w-full pl-8 pr-3 py-1.5 bg-card border border-border rounded-lg text-xs" />
              </div>

              {(roleFilter !== 'all' || statusFilter !== 'all' || search) && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{filtered.length} из {mergedEmployees.length}</span>
                  <button onClick={() => { setRoleFilter('all'); setStatusFilter('all'); setSearch('') }} className="text-primary hover:underline">Сбросить</button>
                </div>
              )}
            </div>
          )}

          {/* Table */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[820px]">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Сотрудник</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Должность</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">Начислено</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">Аванс</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">Удержания</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-emerald-600 uppercase" title="Выплачено зарплаты/аванса из кассы за выбранный период">Выплачено (ЗП)</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">К выплате</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">Выплата</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(emp => {
                    const salary = emp.salary ?? 0
                    // Начислено/аванс/удержания — period-scoped из accrual (за
                    // выбранный период), а НЕ глобальный счётчик emp.advance:
                    // аванс за прошлый месяц не режет остаток текущего.
                    const acc = accrualByUser[emp.id]
                    const advance = acc?.advance ?? 0
                    const deductions = acc?.deductions ?? 0
                    // paidCombined (Зарплата+Аванс) — для колонки «Выплачено (ЗП)».
                    const paidSalary = acc?.paidCombined ?? 0
                    // paidSalary (только «Зарплата») — для «К выплате»: аванс уже
                    // вычтен через advance, вычитать его ещё раз через paidCombined
                    // значило бы вычесть дважды.
                    const paidSalaryOnly = acc?.paidSalary ?? 0
                    // Пока начисления не загрузились — откатываемся на оклад,
                    // чтобы таблица не мигала нулями.
                    const isDaily = acc?.payType === 'daily' || emp.payType === 'daily'
                    const accruedPay = acc ? acc.accrued : salary
                    const toPay = accruedPay - advance - deductions - paidSalaryOnly
                    // Филиальный сотрудник: карточка/правка оклада/табель —
                    // авторитет его филиала; с центра — только выплата (Ф-Р).
                    const isBranch = !!emp.branchId

                    return (
                      <tr key={emp.id} onClick={() => { if (!isBranch) navigate('/finance/payroll/' + emp.id) }}
                        className={`border-b border-border last:border-0 hover:bg-muted/30 transition-colors ${isBranch ? '' : 'cursor-pointer'}`}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <div className="size-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                              {emp.name.charAt(0)}
                            </div>
                            <div>
                              <span className="font-medium text-foreground text-sm">{emp.name}</span>
                              {emp.shiftNumber ? <span className="text-[10px] text-muted-foreground ml-1">{emp.shiftNumber} см.</span> : null}
                              {isBranch && (
                                <span className="block text-[10px] text-muted-foreground inline-flex items-center gap-1 mt-0.5">
                                  <Store className="size-3" /> {branchNameOf(emp)}
                                </span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">{emp.position || ROLE_LABELS[emp.role]}</span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            disabled={isBranch}
                            title={isBranch ? 'Оклад/ставку меняет сам филиал' : undefined}
                            onClick={(e) => { e.stopPropagation(); if (!isBranch) openDialog(emp, 'edit_salary') }}
                            className={`group inline-flex flex-col items-end gap-0.5 ${isBranch ? 'cursor-default' : ''}`}>
                            <span className="inline-flex items-center gap-1">
                              {accruedPay > 0 ? (
                                <>
                                  <span className="font-medium text-foreground">{formatCurrency(accruedPay)}</span>
                                  <Pencil className="size-3 text-muted-foreground/0 group-hover:text-primary transition-colors" />
                                </>
                              ) : isBranch ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                // Нет оклада/ставки — явный призыв, а не тихий «Не указан».
                                <span className="inline-flex items-center gap-1 text-primary font-medium">
                                  <Pencil className="size-3" />Указать ставку
                                </span>
                              )}
                            </span>
                            {/* Расшифровка дневной оплаты / доп. смен оклада: без
                                неё сумма выглядит необъяснимым числом и её нельзя
                                проверить. У гибрида показываем только если доп.
                                смены реально были — иначе для 99% окладников без
                                них это был бы шум («+ 0 доп.смен» у всех подряд). */}
                            {isDaily ? (
                              <span className="text-[10px] text-muted-foreground">
                                {formatCurrency(acc?.dailyRate ?? emp.dailyRate ?? 0)} × {acc?.paidUnits ?? acc?.daysWorked ?? 0} дн.
                                {acc && acc.paidUnits !== acc.daysWorked && (
                                  <span className="text-amber-600"> (есть дни ×2)</span>
                                )}
                              </span>
                            ) : (acc?.extraShiftUnits ?? 0) > 0 && (
                              <span className="text-[10px] text-muted-foreground">
                                + {acc?.extraShiftUnits} доп.смен × {formatCurrency(acc?.dailyRate ?? emp.dailyRate ?? 0)}
                              </span>
                            )}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {advance > 0 ? <span className="text-amber-600 font-medium">{formatCurrency(advance)}</span> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {deductions > 0 ? <span className="text-destructive font-medium">{formatCurrency(deductions)}</span> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {paidSalary > 0 ? <span className="text-emerald-600 font-medium">{formatCurrency(paidSalary)}</span> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {/* Фаза 2: отрицательный «К выплате» — это не долг, а
                              переплата (выдали больше начисленного за период).
                              Красный минус читался как ошибка/проблема; бейдж
                              «Переплата N» называет вещь тем, чем она является. */}
                          {accruedPay > 0 ? (
                            toPay < -0.005 ? (
                              <span className="font-bold text-amber-600" title="Выплачено больше начисленного за этот период">
                                Переплата {formatCurrency(Math.abs(toPay))}
                              </span>
                            ) : (
                              <span className={`font-bold ${toPay > 0.005 ? 'text-foreground' : 'text-muted-foreground'}`}>
                                {formatCurrency(toPay)}
                              </span>
                            )
                          ) : '—'}
                        </td>
                        <td className="px-4 py-3">
                          {/* Строка — не панель из 4 кнопок: одна primary
                              «Выплатить» (самое частое) + «⋯» с остальными
                              деньгами одним тапом (аванс/удержание/дни), без ухода
                              в карточку. Клик по строке (или шеврон) открывает
                              карточку со всей историей. «Выплатить» доступно
                              ВСЕГДА: есть начисление → сервер капит, нет
                              оклада/ставки → свободная выплата любой суммы. */}
                          <div className="flex items-center justify-end gap-1.5">
                            {canDo('payroll.manage') && isBranch && (
                              // Сотрудник филиала: выплата через сеть (Ф-Р) —
                              // деньги со счёта ЦЕНТРА, зеркало едет в филиал,
                              // кап «не выплатить дважды» сервер считает
                              // глазами филиала. Аванс/удержания/дни — в самом
                              // филиале, поэтому «⋯»-меню здесь нет.
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setBranchPayFor(emp)
                                  setBranchPayAmount(Math.max(0, toPay > 0.005 ? Math.round(toPay * 100) / 100 : (emp.payType !== 'daily' ? (emp.salary ?? 0) : 0)))
                                  setBranchPayAccountId('')
                                  const d = new Date(serviceTo)
                                  setBranchPayPeriod(Number.isNaN(d.getTime())
                                    ? `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
                                    : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
                                }}
                                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors shrink-0 inline-flex items-center gap-1.5">
                                <Wallet className="size-3.5" /> Выплатить
                              </button>
                            )}
                            {canDo('payroll.manage') && !isBranch && (
                              <>
                                <button onClick={(e) => { e.stopPropagation(); openDialog(emp, 'salary') }} title={accruedPay > 0 ? 'Выплатить' : 'Свободная выплата'}
                                  className="px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors shrink-0">
                                  Выплатить
                                </button>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    {/* stopPropagation — иначе клик по «⋯» ещё и уводит в карточку (onClick строки) */}
                                    <button onClick={(e) => e.stopPropagation()} title="Ещё действия"
                                      className="size-8 inline-flex items-center justify-center text-muted-foreground border border-border rounded-lg hover:bg-muted transition-colors shrink-0">
                                      <MoreVertical className="size-4" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-48">
                                    <DropdownMenuItem onClick={() => openDialog(emp, 'advance')} className="text-sm cursor-pointer">
                                      Выдать аванс
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => openDialog(emp, 'deduction')} className="text-sm cursor-pointer">
                                      Внести удержание
                                    </DropdownMenuItem>
                                    {/* Дневная оплата — отметка отработанных дней (от них
                                        считается начисление). Оклад — доп. смены (гибрид):
                                        не заменяют оклад, добавляются сверху. Показываем
                                        всегда, не только когда ставка уже задана — иначе
                                        владельцу негде включить функцию впервые. */}
                                    <DropdownMenuItem onClick={() => setWorkedDaysEmp(emp)} className="text-sm cursor-pointer">
                                      <CalendarDays className="size-3.5 mr-2" /> {isDaily ? 'Отметить дни' : 'Доп. смены'}
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </>
                            )}
                            {!isBranch && <ChevronRight className="size-4 text-muted-foreground/40 shrink-0" />}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                {withSalary.length > 0 && (
                  <tfoot>
                    <tr className="bg-muted/40 border-t border-border">
                      <td colSpan={2} className="px-4 py-3 text-xs font-bold text-muted-foreground uppercase">Итого ({withSalary.length} чел.)</td>
                      <td className="px-4 py-3 text-right font-bold text-foreground">{formatCurrency(totalSalary)}</td>
                      <td className="px-4 py-3 text-right font-bold text-amber-600">{formatCurrency(totalAdvance)}</td>
                      <td className="px-4 py-3 text-right font-bold text-destructive">{formatCurrency(totalDeductions)}</td>
                      <td className="px-4 py-3 text-right font-bold text-emerald-600">{formatCurrency(totalSalaryPaid)}</td>
                      <td className="px-4 py-3 text-right font-bold text-foreground">{formatCurrency(totalToPay)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </>
      )}

      {/* ═══════════════════════════ HISTORY TAB ══════════════════════════════ */}
      {tab === 'report' && (
        <>
          {/* Диапазон истории — независим от периода начисления («Сотрудники»).
              По умолчанию «Всё время»: владелец хочет видеть все выплаты целиком. */}
          <div className="flex flex-wrap items-center gap-3 bg-muted/30 border border-border rounded-xl p-3">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase">Показать</label>
            <div className="flex flex-wrap gap-1 bg-muted/50 p-1 rounded-lg">
              {([
                ['all', 'Всё время'],
                ['year', 'Год'],
                ['quarter', 'Квартал'],
                ['month', 'Месяц'],
              ] as const).map(([key, label]) => (
                <button key={key} type="button" onClick={() => setHistoryScope(key)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${historyScope === key ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-card'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Тренд ФОТ по месяцам (ЗП-7) — независим от периода выше, всегда
              последние 3/6/12 месяцев по всей команде. */}
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-foreground">Тренд ФОТ по месяцам</h2>
                {trendDelta != null && (
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${
                    trendDelta > 0 ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                  }`}>
                    {trendDelta > 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                    {trendDelta > 0 ? '+' : ''}{trendDelta.toFixed(1)}% к прошлому мес.
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {([3, 6, 12] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setTrendMonths(m)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      trendMonths === m ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'
                    }`}
                  >
                    {m} мес.
                  </button>
                ))}
              </div>
            </div>
            {trendLoading ? (
              <p className="py-16 text-center text-sm text-muted-foreground">Загружаем…</p>
            ) : trendRows.every(r => r.total === 0) ? (
              <div className="py-16 text-center">
                <TrendingUp className="size-10 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">За последние {trendMonths} мес. выплат не было</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={trendRows} margin={{ top: 5, right: 5, bottom: 5, left: 10 }} barCategoryGap="25%" maxBarSize={64}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={70} />
                  <Tooltip
                    formatter={(v: number, n: string, item: { payload?: TrendRow }) => [trendTooltipValue(v, item?.payload?.total ?? 0), n]}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11 }}
                    formatter={(v: string) => (v === 'salary' ? 'Зарплата' : v === 'advance' ? 'Аванс' : 'Обслуживание')}
                  />
                  {/* isAnimationActive=false — как в Расходах: иначе на переключении
                      3/6/12 recharts иногда рисует пустые bar-rectangle без path. */}
                  <Bar dataKey="salary" name="salary" stackId="fot" fill="#059669" isAnimationActive={false} />
                  <Bar dataKey="advance" name="advance" stackId="fot" fill="#d97706" isAnimationActive={false} />
                  <Bar dataKey="service" name="service" stackId="fot" fill="#2563eb" isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Итоги периода */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: 'Зарплата', value: report?.totals.salaryPaid ?? 0, tone: 'text-emerald-600' },
              { label: 'Авансы', value: report?.totals.advancePaid ?? 0, tone: 'text-amber-600' },
              { label: 'Обслуживание', value: report?.totals.servicePaid ?? 0, tone: 'text-blue-600' },
              { label: 'Всего выдано', value: report?.totals.total ?? 0, tone: 'text-foreground' },
            ].map(k => (
              <div key={k.label} className="bg-card rounded-xl border border-border p-4">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{k.label}</p>
                <p className={`text-xl font-bold mt-1 ${k.tone}`}>{formatCurrency(k.value)}</p>
              </div>
            ))}
          </div>

          {/* Сводка по сотрудникам */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground">
                По сотрудникам
                {report && <span className="text-muted-foreground font-normal"> · {report.totals.employees}</span>}
              </h2>
              <button
                onClick={exportReport}
                disabled={!report || report.payouts.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-muted rounded-lg hover:bg-muted/70 disabled:opacity-40">
                <Download className="size-3.5" />Excel
              </button>
            </div>
            {reportLoading ? (
              <p className="p-6 text-center text-sm text-muted-foreground">Загружаем…</p>
            ) : !report || report.rows.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">За период выплат не было</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Сотрудник</th>
                      <th className="px-4 py-2 font-medium text-right">Зарплата</th>
                      <th className="px-4 py-2 font-medium text-right">Авансы</th>
                      <th className="px-4 py-2 font-medium text-right">Обслуж.</th>
                      <th className="px-4 py-2 font-medium text-right">Всего</th>
                      <th className="px-4 py-2 font-medium text-right">Выплат</th>
                      <th className="px-4 py-2 font-medium">Последняя</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {report.rows.map(r => (
                      <tr key={r.userId || r.userName} className="hover:bg-muted/20">
                        <td className="px-4 py-2.5">
                          <p className="font-medium text-foreground">{r.userName || '—'}</p>
                          {(r.position || r.role) && (
                            <p className="text-[11px] text-muted-foreground">
                              {r.position || ROLE_LABELS[r.role as keyof typeof ROLE_LABELS] || r.role}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{r.salaryPaid ? formatCurrency(r.salaryPaid) : '—'}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-amber-700">{r.advancePaid ? formatCurrency(r.advancePaid) : '—'}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{r.servicePaid ? formatCurrency(r.servicePaid) : '—'}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{formatCurrency(r.total)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{r.payoutsCount}</td>
                        <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{r.lastPayoutAt || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Хронология выплат — «кому, сколько, когда и с какого счёта» */}
          {report && report.payouts.length > 0 && (
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <h2 className="text-sm font-semibold text-foreground">
                  Все выплаты <span className="text-muted-foreground font-normal">· {report.totals.payouts}</span>
                </h2>
              </div>
              <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 sticky top-0">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Дата</th>
                      <th className="px-4 py-2 font-medium">Сотрудник</th>
                      <th className="px-4 py-2 font-medium">Вид</th>
                      <th className="px-4 py-2 font-medium">Со счёта</th>
                      <th className="px-4 py-2 font-medium text-right">Сумма</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {report.payouts.map(p => (
                      <tr key={p.id} className="hover:bg-muted/20">
                        <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">{p.date || '—'}</td>
                        <td className="px-4 py-2 font-medium text-foreground">{p.userName || '—'}</td>
                        <td className="px-4 py-2">
                          <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium ${PAYOUT_KIND_TONE[p.kind]}`}>
                            {PAYOUT_KIND_LABELS[p.kind]}
                          </span>
                          {/* Выплата выше расчётного остатка, проведённая осознанно (ЗП-4) —
                              отличает ручное решение от обычного расчёта по формуле. */}
                          {p.isOverride && (
                            <span
                              title={p.description || 'Свободная выплата'}
                              className="ml-1 inline-flex px-2 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
                            >
                              Ручная
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{p.accountName || '—'}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold">{formatCurrency(p.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ═══════════════════════════ VEDOMOST TAB ═════════════════════════════ */}
      {tab === 'vedomost' && (
        <>
          <div className="flex flex-wrap items-center gap-3 bg-muted/30 border border-border rounded-xl p-3">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase">Период</label>
            <DateRangePresets
              value={servicePreset}
              onChange={(p, r) => {
                setServicePreset(p)
                if (p === 'custom') {
                  setServiceCustomFrom(r.from); setServiceCustomTo(r.to)
                  if (r.from && r.to) { const iso = isoFromYmd(r.from, r.to); setServiceFrom(iso.from); setServiceTo(iso.to) }
                } else {
                  const iso = isoFromYmd(r.from, r.to); setServiceFrom(iso.from); setServiceTo(iso.to)
                }
              }}
              customFrom={serviceCustomFrom}
              customTo={serviceCustomTo}
              onCustomFromChange={(v) => { setServicePreset('custom'); setServiceCustomFrom(v); if (v && serviceCustomTo) { const iso = isoFromYmd(v, serviceCustomTo); setServiceFrom(iso.from); setServiceTo(iso.to) } }}
              onCustomToChange={(v) => { setServicePreset('custom'); setServiceCustomTo(v); if (serviceCustomFrom && v) { const iso = isoFromYmd(serviceCustomFrom, v); setServiceFrom(iso.from); setServiceTo(iso.to) } }}
              storageKey="payroll:service-preset"
            />
          </div>
          <PayrollVedomost rows={vedomostRows} periodLabel={vedomostPeriodLabel} />
        </>
      )}

      {/* ═══════════════════════════ TIMESHEET TAB ════════════════════════════ */}
      {tab === 'timesheet' && (
        <>
          {/* Clock in/out section */}
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Моя смена</h2>
                {myActiveEntry ? (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    На смене с {formatTime(myActiveEntry.clockIn)} ({elapsed})
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-0.5">Вы сейчас не на смене</p>
                )}
              </div>
              {myActiveEntry ? (
                <button onClick={handleClockOut}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors">
                  <Square className="size-4" />
                  Завершить смену
                  <span className="font-mono text-xs bg-red-700/50 px-1.5 py-0.5 rounded">{elapsed}</span>
                </button>
              ) : (
                <button onClick={handleClockIn}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors">
                  <Play className="size-4" />
                  Начать смену
                </button>
              )}
            </div>
          </div>

          {/* Отметить явку за сотрудника (054).
              Без этого дневная оплата не работает: повар или посудомойщик сам
              себя в системе не отмечает — терминал стоит у кассы. Начисление
              «ставка × дни» считает именно эти отметки. */}
          {isManager && (
            <div className="bg-card rounded-xl border border-border p-4">
              <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                <div className="flex-1 min-w-0">
                  <label htmlFor="attendance-emp" className="text-sm font-semibold text-foreground block">
                    Отметить явку
                  </label>
                  <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
                    Для тех, кто не отмечается сам. Влияет на начисление при дневной оплате.
                  </p>
                  <select
                    id="attendance-emp"
                    value={attendanceEmpId}
                    onChange={e => setAttendanceEmpId(e.target.value)}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                  >
                    <option value="">— Выберите сотрудника —</option>
                    {employees.map(e => {
                      const onShift = activeEntries.some(a => a.userId === e.id)
                      const daily = e.payType === 'daily'
                      return (
                        <option key={e.id} value={e.id} disabled={onShift}>
                          {e.name}
                          {daily ? ' · дневная' : ''}
                          {onShift ? ' — уже на смене' : ''}
                        </option>
                      )
                    })}
                  </select>
                </div>
                <button
                  onClick={handleMarkAttendance}
                  disabled={!attendanceEmpId || markingAttendance}
                  className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors disabled:opacity-40 shrink-0"
                >
                  <Play className="size-4" />
                  {markingAttendance ? 'Отмечаем…' : 'Отметить день'}
                </button>
              </div>
            </div>
          )}

          {/* Active employees */}
          {activeEntries.length > 0 && (
            <div className="bg-emerald-50 dark:bg-emerald-950/30 rounded-xl border border-emerald-200 dark:border-emerald-800 p-4">
              <h3 className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 mb-2">
                Кто на смене ({activeEntries.length})
              </h3>
              <div className="flex flex-wrap gap-2">
                {activeEntries.map(entry => (
                  <div key={entry.id} className="flex items-center gap-2 bg-white dark:bg-emerald-900/50 rounded-lg px-3 py-1.5 border border-emerald-200 dark:border-emerald-700">
                    <div className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-xs font-medium text-foreground">{entry.userName}</span>
                    <ElapsedBadge since={entry.clockIn} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Period + сотрудник (Фаза 3) — фильтр по сотруднику только для
              менеджера (остальные и так видят только себя). «Доп. смены» —
              тот же WorkedDaysDialog, что и в списке «Сотрудники», чтобы не
              уходить со вкладки Табель для отметки дня. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg">
              {([
                ['week', '7 дней'],
                ['month', '30 дней'],
                ['all', 'Все'],
              ] as const).map(([key, label]) => (
                <button key={key} onClick={() => setTimePeriod(key)} title="Скользящее окно от сегодня — не общий период страницы"
                  className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${timePeriod === key ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
                  {label}
                </button>
              ))}
            </div>
            {isManager && (
              <select
                value={timesheetEmpFilter}
                onChange={e => setTimesheetEmpFilter(e.target.value)}
                className="px-2.5 py-1.5 text-xs bg-card border border-border rounded-lg"
              >
                <option value="">Все сотрудники</option>
                {employees.map(e => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            )}
            {isManager && timesheetEmpFilter && (
              <button
                onClick={() => {
                  const emp = employees.find(e => e.id === timesheetEmpFilter)
                  if (emp) setWorkedDaysEmp(emp)
                }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors"
              >
                <CalendarDays className="size-3.5" />
                {employees.find(e => e.id === timesheetEmpFilter)?.payType === 'daily' ? 'Отметить дни' : 'Доп. смены'}
              </button>
            )}
            {timeLoading && <div className="size-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />}
          </div>

          {/* Summary cards */}
          {Object.keys(hoursSummary).length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
              {Object.values(hoursSummary).sort((a, b) => b.hours - a.hours).map(s => (
                <div key={s.name} className="bg-card rounded-xl border border-border p-3">
                  <p className="text-xs text-muted-foreground truncate">{s.name}</p>
                  <p className="text-lg font-bold text-foreground mt-0.5">{s.hours.toFixed(1)} ч</p>
                  <p className="text-[10px] text-muted-foreground">{s.count} смен</p>
                </div>
              ))}
            </div>
          )}

          {/* Time entries table */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[700px]">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Сотрудник</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Дата</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Приход</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Уход</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">Перерыв</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">Часов</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-muted-foreground uppercase">Статус</th>
                    {isManager && (
                      <th className="px-4 py-3 text-center text-xs font-semibold text-muted-foreground uppercase">Действия</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {visibleEntries.length === 0 && (
                    <tr>
                      <td colSpan={isManager ? 8 : 7} className="px-4 py-8 text-center text-muted-foreground text-sm">
                        Нет записей за выбранный период
                      </td>
                    </tr>
                  )}
                  {visibleEntries.map(entry => {
                    const isEditing = editingEntry === entry.id
                    return (
                      <tr key={entry.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="size-7 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                              {(entry.userName || '?').charAt(0)}
                            </div>
                            <span className="text-sm font-medium text-foreground">{entry.userName || 'Неизвестно'}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-foreground">{formatDate(entry.clockIn)}</td>
                        <td className="px-4 py-3">
                          {isEditing ? (
                            <input type="datetime-local" value={editClockIn} onChange={e => setEditClockIn(e.target.value)}
                              className="px-2 py-1 bg-background border border-border rounded text-xs w-40" />
                          ) : (
                            <span className="text-xs text-foreground">{formatTime(entry.clockIn)}</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {isEditing ? (
                            <input type="datetime-local" value={editClockOut} onChange={e => setEditClockOut(e.target.value)}
                              className="px-2 py-1 bg-background border border-border rounded text-xs w-40" />
                          ) : entry.clockOut ? (
                            <span className="text-xs text-foreground">{formatTime(entry.clockOut)}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {isEditing ? (
                            <input type="number" min={0} value={editBreak} onChange={e => setEditBreak(Number(e.target.value))}
                              className="px-2 py-1 bg-background border border-border rounded text-xs w-16 text-right" />
                          ) : (
                            <span className="text-xs text-foreground">{entry.breakMinutes} мин</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {entry.status === 'active' ? (
                            <ElapsedBadge since={entry.clockIn} />
                          ) : (
                            <span className="text-xs font-medium text-foreground">{entry.totalHours?.toFixed(2) ?? '—'}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {entry.status === 'active' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400 rounded-full">
                              <div className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                              На смене
                            </span>
                          ) : entry.status === 'edited' ? (
                            <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400 rounded-full">
                              Изменено
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground rounded-full">
                              Завершено
                            </span>
                          )}
                        </td>
                        {isManager && (
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-center gap-1">
                              {isEditing ? (
                                <>
                                  <button onClick={() => saveEdit(entry.id)}
                                    className="px-2 py-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md hover:bg-emerald-100 transition-colors">
                                    Сохранить
                                  </button>
                                  <button onClick={() => setEditingEntry(null)}
                                    className="px-2 py-1 text-[11px] font-medium text-muted-foreground bg-muted border border-border rounded-md hover:bg-muted/80 transition-colors">
                                    Отмена
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button onClick={() => startEdit(entry)} title="Редактировать"
                                    className="p-1.5 text-muted-foreground hover:text-primary transition-colors rounded-md hover:bg-muted">
                                    <Pencil className="size-3.5" />
                                  </button>
                                  <button onClick={() => handleDeleteEntry(entry.id)} title="Удалить"
                                    className="p-1.5 text-muted-foreground hover:text-destructive transition-colors rounded-md hover:bg-muted">
                                    <Trash2 className="size-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ═══ Salary Dialog ═══ */}
      {/* salaryPaidThisPeriod — accrual.paidSalary, не paidCombined:
          иначе аванс, выданный внутри периода, вычтется из «К выплате»
          дважды — он уже вычтен через accrual.advance (period-scoped). */}
      <PayEmployeeDialog
        employee={selectedEmp}
        action={payAction}
        accounts={accounts}
        accrual={selectedEmp ? accrualByUser[selectedEmp.id] : undefined}
        salaryPaidThisPeriod={selectedEmp ? accrualByUser[selectedEmp.id]?.paidSalary : undefined}
        serviceFrom={serviceFrom}
        serviceTo={serviceTo}
        onClose={closeDialog}
        onSaved={reload}
      />

      {/* ═══ Выплата сотруднику ФИЛИАЛА (единый персонал сети) ═══ */}
      <Dialog open={!!branchPayFor} onOpenChange={(v) => { if (!v) setBranchPayFor(null) }}>
        <DialogContent className="sm:max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle>Выплата сотруднику филиала</DialogTitle>
          </DialogHeader>
          {branchPayFor && (
            <div className="space-y-3 py-1">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{branchPayFor.name}</span> · {branchPayFor.branchName}
                {branchPayFor.payType !== 'daily' && (branchPayFor.salary ?? 0) > 0 && <> · оклад {formatCurrency(branchPayFor.salary ?? 0)}</>}
              </p>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-muted-foreground">Период (месяц начисления)</label>
                <input
                  type="month"
                  value={branchPayPeriod}
                  onChange={e => setBranchPayPeriod(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-muted-foreground">С какого счёта</label>
                <select
                  value={branchPayAccountId}
                  onChange={e => setBranchPayAccountId(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">— выберите счёт —</option>
                  {accounts.map(a => (
                    <option key={a.id} value={a.id}>{a.name} — {formatCurrency(a.balance)}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-muted-foreground">Сумма</label>
                <DecimalInput
                  min={0}
                  value={branchPayAmount}
                  onChange={setBranchPayAmount}
                  placeholder="0"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Деньги спишутся с вашего счёта, а в отчётах филиала выплата отразится как его
                расход на зарплату — и его касса больше не предложит выплатить это второй раз.
              </p>
            </div>
          )}
          <DialogFooter className="sm:justify-between gap-2">
            <button
              type="button"
              onClick={() => setBranchPayFor(null)}
              className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={onBranchPay}
              disabled={branchPaying || !branchPayAccountId || branchPayAmount <= 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:opacity-90 disabled:opacity-50"
            >
              <Wallet className="size-4" /> Выплатить
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Отметка отработанных дней (дневная оплата) ИЛИ доп. смен (гибрид
          «оклад + доп.смены») — из «⋯»-меню строки. */}
      {workedDaysEmp && (
        <WorkedDaysDialog
          open={!!workedDaysEmp}
          onOpenChange={(v) => { if (!v) setWorkedDaysEmp(null) }}
          employeeId={workedDaysEmp.id}
          employeeName={workedDaysEmp.name}
          dailyRate={accrualByUser[workedDaysEmp.id]?.dailyRate ?? workedDaysEmp.dailyRate ?? 0}
          mode={(accrualByUser[workedDaysEmp.id]?.payType ?? workedDaysEmp.payType) === 'daily' ? 'daily' : 'extra'}
          initialDate={serviceTo.slice(0, 10)}
          onSaved={() => { reload() }}
        />
      )}
    </div>
  )
}
