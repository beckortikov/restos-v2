'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency } from '@/lib/helpers'
import { ROLE_LABELS, type User, type FinancialAccount, type TimeEntry } from '@/lib/types'
import {
  fetchUsers, fetchFinancialAccounts, paySalaryFull, updateUser,
  fetchTimeEntries, fetchActiveClockIn, clockIn as apiClockIn, clockOut as apiClockOut,
  updateTimeEntry, deleteTimeEntry,
  fetchServiceAccrualByWaiter, fetchServicePayoutByWaiter, payServiceCharge,
} from '@/lib/queries'
import { Users, Wallet, CheckCircle, Banknote, CreditCard, X, Pencil, Search, Download, Clock, Play, Square, Trash2, Timer } from 'lucide-react'
import { exportToExcel } from '@/lib/export-excel'
import { toast } from 'sonner'

type PayAction = 'salary' | 'advance' | 'deduction' | 'edit_salary' | 'service'
type TabKey = 'salary' | 'timesheet'

function monthRange(): { from: string; to: string } {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString()
  return { from, to }
}

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
  const { user: currentUser, canDo, canAccessRoles } = useAuth()
  const [tab, setTab] = useState<TabKey>('salary')
  const [employees, setEmployees] = useState<User[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [loading, setLoading] = useState(true)

  // ─── Salary state ──────────────────────────────────────────────────────────
  const [payAction, setPayAction] = useState<PayAction | null>(null)
  const [selectedEmp, setSelectedEmp] = useState<User | null>(null)
  const [payAmount, setPayAmount] = useState(0)
  const [deductionReason, setDeductionReason] = useState('')
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [paying, setPaying] = useState(false)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'with_salary' | 'no_salary' | 'has_advance' | 'has_deduction'>('all')

  // ─── Service-charge state (period-scoped) ─────────────────────────────────
  const initialRange = monthRange()
  const [serviceFrom, setServiceFrom] = useState<string>(initialRange.from)
  const [serviceTo, setServiceTo] = useState<string>(initialRange.to)
  const [serviceAccrual, setServiceAccrual] = useState<Record<string, { accrued: number; ordersCount: number }>>({})
  const [servicePayout, setServicePayout] = useState<Record<string, number>>({})

  // ─── Timesheet state ───────────────────────────────────────────────────────
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([])
  const [myActiveEntry, setMyActiveEntry] = useState<TimeEntry | null>(null)
  const [timePeriod, setTimePeriod] = useState<'week' | 'month' | 'all'>('week')
  const [timeLoading, setTimeLoading] = useState(false)
  const [editingEntry, setEditingEntry] = useState<string | null>(null)
  const [editClockIn, setEditClockIn] = useState('')
  const [editClockOut, setEditClockOut] = useState('')
  const [editBreak, setEditBreak] = useState(0)
  const elapsed = useElapsed(myActiveEntry?.clockIn, !!myActiveEntry)

  const reload = async () => {
    const [users, accs, accrual, payout] = await Promise.all([
      fetchUsers(),
      fetchFinancialAccounts(),
      fetchServiceAccrualByWaiter(serviceFrom, serviceTo),
      fetchServicePayoutByWaiter(serviceFrom, serviceTo),
    ])
    setEmployees(users.filter(u => u.role !== 'owner' && u.role !== 'superadmin'))
    setAccounts(accs)
    if (accs.length > 0 && !selectedAccountId) setSelectedAccountId(accs[0].id)
    const accrualMap: Record<string, { accrued: number; ordersCount: number }> = {}
    for (const r of accrual) if (r.waiterId) accrualMap[r.waiterId] = { accrued: r.accrued, ordersCount: r.ordersCount }
    setServiceAccrual(accrualMap)
    setServicePayout(payout)
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
      toast.error(e instanceof Error ? e.message : 'Ошибка загрузки табеля')
    } finally {
      setTimeLoading(false)
    }
  }, [timePeriod, currentUser])

  useEffect(() => {
    reload().finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reload service data when period changes (already-loaded users/accounts are reused)
  useEffect(() => {
    if (loading) return
    Promise.all([
      fetchServiceAccrualByWaiter(serviceFrom, serviceTo),
      fetchServicePayoutByWaiter(serviceFrom, serviceTo),
    ]).then(([accrual, payout]) => {
      const accrualMap: Record<string, { accrued: number; ordersCount: number }> = {}
      for (const r of accrual) if (r.waiterId) accrualMap[r.waiterId] = { accrued: r.accrued, ordersCount: r.ordersCount }
      setServiceAccrual(accrualMap)
      setServicePayout(payout)
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceFrom, serviceTo])

  useEffect(() => {
    if (tab === 'timesheet') loadTimeEntries()
  }, [tab, loadTimeEntries])

  // ─── Salary helpers ────────────────────────────────────────────────────────

  const openDialog = (emp: User, action: PayAction) => {
    setSelectedEmp(emp)
    setPayAction(action)
    setDeductionReason('')
    if (action === 'advance') {
      setPayAmount(0)
    } else if (action === 'deduction') {
      setPayAmount(0)
    } else if (action === 'edit_salary') {
      setPayAmount(emp.salary ?? 0)
    } else if (action === 'service') {
      const accrued = serviceAccrual[emp.id]?.accrued ?? 0
      const paid = servicePayout[emp.id] ?? 0
      setPayAmount(Math.max(0, accrued - paid))
    } else {
      setPayAmount(Math.max(0, (emp.salary ?? 0) - (emp.advance ?? 0) - (emp.deductions ?? 0)))
    }
  }

  const closeDialog = () => { setPayAction(null); setSelectedEmp(null) }

  const handleSubmit = async () => {
    if (!selectedEmp || !payAction) return
    setPaying(true)
    try {
      if (payAction === 'edit_salary') {
        await updateUser(selectedEmp.id, { salary: payAmount })
        toast.success(`Оклад ${selectedEmp.name}: ${formatCurrency(payAmount)}`)
      } else if (payAction === 'advance') {
        if (payAmount <= 0) { setPaying(false); return }
        const account = accounts.find(a => a.id === selectedAccountId)
        // Create financial operation FIRST (cash payout), then update advance counter.
        // This way if updateUser fails (e.g. legacy schema), the payout is still recorded.
        await paySalaryFull(selectedEmp.id, payAmount, selectedAccountId, account?.name ?? '', `${selectedEmp.name} (аванс)`)
        const newAdvance = (selectedEmp.advance ?? 0) + payAmount
        try { await updateUser(selectedEmp.id, { advance: newAdvance }) } catch (e) { console.warn('advance counter update failed:', e) }
        toast.success(`Аванс ${formatCurrency(payAmount)}: ${selectedEmp.name}`)
      } else if (payAction === 'deduction') {
        if (payAmount <= 0) { setPaying(false); return }
        const newDeductions = (selectedEmp.deductions ?? 0) + payAmount
        await updateUser(selectedEmp.id, { deductions: newDeductions })
        toast.success(`Удержание ${formatCurrency(payAmount)}: ${selectedEmp.name}${deductionReason ? ' — ' + deductionReason : ''}`)
      } else if (payAction === 'service') {
        if (payAmount <= 0) { setPaying(false); return }
        const account = accounts.find(a => a.id === selectedAccountId)
        await payServiceCharge({
          waiterId: selectedEmp.id,
          waiterName: selectedEmp.name,
          amount: payAmount,
          accountId: selectedAccountId,
          accountName: account?.name ?? '',
          periodFrom: serviceFrom,
          periodTo: serviceTo,
        })
        toast.success(`Обслуживание ${formatCurrency(payAmount)}: ${selectedEmp.name}`)
      } else {
        if (payAmount <= 0) { setPaying(false); return }
        const account = accounts.find(a => a.id === selectedAccountId)
        await paySalaryFull(selectedEmp.id, payAmount, selectedAccountId, account?.name ?? '', selectedEmp.name)
        try { await updateUser(selectedEmp.id, { advance: 0, deductions: 0 }) } catch (e) { console.warn('reset counters failed:', e) }
        toast.success(`Зарплата ${formatCurrency(payAmount)}: ${selectedEmp.name}`)
      }
      closeDialog()
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally { setPaying(false) }
  }

  // ─── Timesheet helpers ─────────────────────────────────────────────────────

  const handleClockIn = async () => {
    if (!currentUser) return
    try {
      await apiClockIn(currentUser.id)
      toast.success('Смена начата')
      await loadTimeEntries()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    }
  }

  const handleClockOut = async () => {
    if (!myActiveEntry) return
    try {
      await apiClockOut(myActiveEntry.id)
      toast.success('Смена завершена')
      await loadTimeEntries()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
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
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    }
  }

  const handleDeleteEntry = async (id: string) => {
    try {
      await deleteTimeEntry(id)
      toast.success('Запись удалена')
      await loadTimeEntries()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    }
  }

  // ─── Loading ───────────────────────────────────────────────────────────────

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  // ─── Salary computed ───────────────────────────────────────────────────────

  const withSalary = employees.filter(e => (e.salary ?? 0) > 0)
  const totalSalary = withSalary.reduce((s, e) => s + (e.salary ?? 0), 0)
  const totalAdvance = withSalary.reduce((s, e) => s + (e.advance ?? 0), 0)
  const totalDeductions = withSalary.reduce((s, e) => s + (e.deductions ?? 0), 0)
  const totalToPay = totalSalary - totalAdvance - totalDeductions
  const totalServiceAccrued = Object.values(serviceAccrual).reduce((s, r) => s + r.accrued, 0)
  const totalServicePaid = Object.values(servicePayout).reduce((s, v) => s + v, 0)
  const totalServiceToPay = Math.max(0, totalServiceAccrued - totalServicePaid)

  const filtered = employees.filter(e => {
    if (roleFilter !== 'all' && e.role !== roleFilter) return false
    if (statusFilter === 'with_salary' && (e.salary ?? 0) === 0) return false
    if (statusFilter === 'no_salary' && (e.salary ?? 0) > 0) return false
    if (statusFilter === 'has_advance' && (e.advance ?? 0) === 0) return false
    if (statusFilter === 'has_deduction' && (e.deductions ?? 0) === 0) return false
    if (search.trim()) {
      const q = search.toLowerCase()
      return e.name.toLowerCase().includes(q) || (e.position || '').toLowerCase().includes(q) || e.username.toLowerCase().includes(q)
    }
    return true
  })

  const roleStats = employees.reduce<Record<string, number>>((acc, e) => { acc[e.role] = (acc[e.role] || 0) + 1; return acc }, {})

  const needsPayment = (action: PayAction): boolean => action === 'salary' || action === 'advance' || action === 'service'
  const dialogTitle: Record<PayAction, string> = {
    salary: 'Выплатить зарплату',
    advance: 'Выдать аванс',
    deduction: 'Внести удержание',
    edit_salary: 'Изменить оклад',
    service: 'Выплатить обслуживание',
  }
  const dialogColor: Record<PayAction, string> = {
    salary: 'bg-emerald-600 hover:bg-emerald-700',
    advance: 'bg-amber-600 hover:bg-amber-700',
    deduction: 'bg-destructive hover:bg-destructive/90',
    edit_salary: 'bg-primary hover:bg-primary/90',
    service: 'bg-blue-600 hover:bg-blue-700',
  }
  const dialogBtnText = (): string => {
    if (paying) return 'Обработка...'
    if (payAction === 'edit_salary') return `Сохранить оклад`
    if (payAction === 'deduction') return `Удержать ${payAmount > 0 ? formatCurrency(payAmount) : ''}`
    if (payAction === 'advance') return `Выдать аванс ${payAmount > 0 ? formatCurrency(payAmount) : ''}`
    if (payAction === 'service') return `Выплатить обсл. ${payAmount > 0 ? formatCurrency(payAmount) : ''}`
    return `Выплатить ${payAmount > 0 ? formatCurrency(payAmount) : ''}`
  }

  // ─── Timesheet computed ────────────────────────────────────────────────────

  const activeEntries = timeEntries.filter(e => e.status === 'active')

  // Visible entries: managers see all, others see their own
  const isManager = canDo('payroll.manage')
  const visibleEntries = isManager
    ? timeEntries
    : timeEntries.filter(e => e.userId === currentUser?.id)

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
      {/* Header + Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg">
            <button onClick={() => setTab('salary')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${tab === 'salary' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
              <Wallet className="size-3.5 inline mr-1.5 -mt-0.5" />
              Зарплата
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
            <p className="text-muted-foreground text-sm">{employees.length} сотрудников</p>
            <button
              onClick={() => {
                exportToExcel(
                  filtered.map(e => {
                    const accrued = serviceAccrual[e.id]?.accrued ?? 0
                    const paidSv = servicePayout[e.id] ?? 0
                    return {
                      name: e.name,
                      position: e.position || ROLE_LABELS[e.role],
                      salary: e.salary ?? 0,
                      advance: e.advance ?? 0,
                      deductions: e.deductions ?? 0,
                      toPay: (e.salary ?? 0) - (e.advance ?? 0) - (e.deductions ?? 0),
                      serviceAccrued: accrued,
                      servicePaid: paidSv,
                      serviceToPay: Math.max(0, accrued - paidSv),
                    }
                  }),
                  [
                    { key: 'name', header: 'Сотрудник' },
                    { key: 'position', header: 'Должность' },
                    { key: 'salary', header: 'Оклад' },
                    { key: 'advance', header: 'Аванс' },
                    { key: 'deductions', header: 'Удержания' },
                    { key: 'toPay', header: 'К выплате' },
                    { key: 'serviceAccrued', header: 'Обсл. начислено' },
                    { key: 'servicePaid', header: 'Обсл. выплачено' },
                    { key: 'serviceToPay', header: 'Обсл. к выплате' },
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
          {/* Service period filter */}
          <div className="flex flex-wrap items-end gap-3 bg-blue-50/40 border border-blue-100 rounded-xl p-3">
            <div>
              <label className="block text-[10px] font-semibold text-blue-700 uppercase mb-1">Период обслуживания</label>
              <div className="flex items-center gap-2">
                <input type="date" value={serviceFrom.slice(0, 10)}
                  onChange={e => setServiceFrom(new Date(e.target.value + 'T00:00:00').toISOString())}
                  className="px-2 py-1 text-xs bg-card border border-border rounded-md" />
                <span className="text-xs text-muted-foreground">—</span>
                <input type="date" value={serviceTo.slice(0, 10)}
                  onChange={e => setServiceTo(new Date(e.target.value + 'T23:59:59').toISOString())}
                  className="px-2 py-1 text-xs bg-card border border-border rounded-md" />
                <button onClick={() => { const r = monthRange(); setServiceFrom(r.from); setServiceTo(r.to) }}
                  className="px-2 py-1 text-[11px] font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100">
                  Этот месяц
                </button>
                <button onClick={() => {
                  const now = new Date()
                  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString()
                  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString()
                  setServiceFrom(from); setServiceTo(to)
                }} className="px-2 py-1 text-[11px] font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100">
                  Сегодня
                </button>
              </div>
            </div>
          </div>

          {/* KPI */}
          <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
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
              <p className="text-2xl font-bold text-emerald-600 mt-1">{formatCurrency(totalToPay)}</p>
            </div>
            <div className="bg-blue-50/60 rounded-xl border border-blue-200 p-4">
              <p className="text-xs text-blue-700">Обслуживание (к выплате)</p>
              <p className="text-2xl font-bold text-blue-700 mt-1">{formatCurrency(totalServiceToPay)}</p>
              <p className="text-[10px] text-blue-600/80 mt-0.5">начислено {formatCurrency(totalServiceAccrued)} · выпл. {formatCurrency(totalServicePaid)}</p>
            </div>
          </div>

          {/* Filters */}
          {employees.length > 5 && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg">
                {([
                  ['all', `Все (${employees.length})`],
                  ['with_salary', `С окладом (${withSalary.length})`],
                  ['no_salary', `Без оклада (${employees.length - withSalary.length})`],
                  ['has_advance', `С авансом (${employees.filter(e => (e.advance ?? 0) > 0).length})`],
                  ['has_deduction', `С удержанием (${employees.filter(e => (e.deductions ?? 0) > 0).length})`],
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
                  <span>{filtered.length} из {employees.length}</span>
                  <button onClick={() => { setRoleFilter('all'); setStatusFilter('all'); setSearch('') }} className="text-primary hover:underline">Сбросить</button>
                </div>
              )}
            </div>
          )}

          {/* Table */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[1100px]">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Сотрудник</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Должность</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">Оклад</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">Аванс</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">Удержания</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase">К выплате</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-blue-700 uppercase" title="Обслуживание начислено за выбранный период">Обсл. начисл.</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-blue-700 uppercase" title="Обслуживание выплачено за выбранный период">Обсл. выпл.</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-blue-700 uppercase" title="Остаток обслуживания к выплате">К выпл. (обсл.)</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-muted-foreground uppercase">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(emp => {
                    const salary = emp.salary ?? 0
                    const advance = emp.advance ?? 0
                    const deductions = emp.deductions ?? 0
                    const toPay = salary - advance - deductions
                    const accrued = serviceAccrual[emp.id]?.accrued ?? 0
                    const paidService = servicePayout[emp.id] ?? 0
                    const serviceToPay = Math.max(0, accrued - paidService)

                    return (
                      <tr key={emp.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <div className="size-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                              {emp.name.charAt(0)}
                            </div>
                            <div>
                              <span className="font-medium text-foreground text-sm">{emp.name}</span>
                              {emp.shiftNumber ? <span className="text-[10px] text-muted-foreground ml-1">{emp.shiftNumber} см.</span> : null}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">{emp.position || ROLE_LABELS[emp.role]}</span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button onClick={() => openDialog(emp, 'edit_salary')} className="group inline-flex items-center gap-1">
                            <span className={`font-medium ${salary > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                              {salary > 0 ? formatCurrency(salary) : 'Не указан'}
                            </span>
                            <Pencil className="size-3 text-muted-foreground/0 group-hover:text-primary transition-colors" />
                          </button>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {advance > 0 ? <span className="text-amber-600 font-medium">{formatCurrency(advance)}</span> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {deductions > 0 ? <span className="text-destructive font-medium">{formatCurrency(deductions)}</span> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className={`font-bold ${toPay > 0 ? 'text-foreground' : toPay < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                            {salary > 0 ? formatCurrency(toPay) : '—'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {accrued > 0 ? <span className="text-blue-700 font-medium">{formatCurrency(accrued)}</span> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {paidService > 0 ? <span className="text-blue-600">{formatCurrency(paidService)}</span> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {serviceToPay > 0 ? <span className="font-bold text-blue-700">{formatCurrency(serviceToPay)}</span> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          {canDo('payroll.manage') && salary > 0 && (
                            <div className="flex items-center justify-center gap-1">
                              <button onClick={() => openDialog(emp, 'advance')} title="Аванс"
                                className="px-2 py-1 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md hover:bg-amber-100 transition-colors">
                                Аванс
                              </button>
                              <button onClick={() => openDialog(emp, 'deduction')} title="Удержание"
                                className="px-2 py-1 text-[11px] font-medium text-destructive bg-red-50 border border-red-200 rounded-md hover:bg-red-100 transition-colors">
                                Удерж.
                              </button>
                              <button onClick={() => openDialog(emp, 'salary')} disabled={toPay <= 0} title="Выплатить"
                                className="px-2 py-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md hover:bg-emerald-100 transition-colors disabled:opacity-40">
                                Выплатить
                              </button>
                            </div>
                          )}
                          {canDo('payroll.manage') && salary === 0 && (
                            <button onClick={() => openDialog(emp, 'edit_salary')}
                              className="px-2 py-1 text-[11px] font-medium text-primary bg-primary/10 border border-primary/20 rounded-md hover:bg-primary/20 transition-colors">
                              Указать оклад
                            </button>
                          )}
                          {canDo('payroll.manage') && serviceToPay > 0 && (
                            <button onClick={() => openDialog(emp, 'service')} title="Выплатить обслуживание"
                              className="mt-1 px-2 py-1 text-[11px] font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition-colors">
                              Выпл. обсл.
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                {(withSalary.length > 0 || totalServiceAccrued > 0) && (
                  <tfoot>
                    <tr className="bg-muted/40 border-t border-border">
                      <td colSpan={2} className="px-4 py-3 text-xs font-bold text-muted-foreground uppercase">Итого ({withSalary.length} чел.)</td>
                      <td className="px-4 py-3 text-right font-bold text-foreground">{formatCurrency(totalSalary)}</td>
                      <td className="px-4 py-3 text-right font-bold text-amber-600">{formatCurrency(totalAdvance)}</td>
                      <td className="px-4 py-3 text-right font-bold text-destructive">{formatCurrency(totalDeductions)}</td>
                      <td className="px-4 py-3 text-right font-bold text-foreground">{formatCurrency(totalToPay)}</td>
                      <td className="px-4 py-3 text-right font-bold text-blue-700">{formatCurrency(totalServiceAccrued)}</td>
                      <td className="px-4 py-3 text-right font-bold text-blue-600">{formatCurrency(totalServicePaid)}</td>
                      <td className="px-4 py-3 text-right font-bold text-blue-700">{formatCurrency(totalServiceToPay)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
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

          {/* Period filter */}
          <div className="flex items-center gap-2">
            <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg">
              {([
                ['week', 'Неделя'],
                ['month', 'Месяц'],
                ['all', 'Все'],
              ] as const).map(([key, label]) => (
                <button key={key} onClick={() => setTimePeriod(key)}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${timePeriod === key ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
                  {label}
                </button>
              ))}
            </div>
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
      {payAction && selectedEmp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={closeDialog}>
          <div className="bg-card rounded-2xl border border-border shadow-xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-border">
              <h2 className="text-lg font-bold text-foreground">{dialogTitle[payAction]}</h2>
              <button onClick={closeDialog} className="p-1 text-muted-foreground hover:text-foreground"><X className="size-5" /></button>
            </div>

            <div className="p-5 space-y-4">
              <div className="bg-muted/30 rounded-xl p-4">
                <p className="font-semibold text-foreground">{selectedEmp.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{selectedEmp.position || ROLE_LABELS[selectedEmp.role]}</p>
                {payAction !== 'edit_salary' && (
                  <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
                    <div>
                      <p className="text-muted-foreground">Оклад</p>
                      <p className="font-bold text-foreground">{formatCurrency(selectedEmp.salary ?? 0)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Аванс</p>
                      <p className="font-bold text-amber-600">{formatCurrency(selectedEmp.advance ?? 0)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">К выплате</p>
                      <p className="font-bold text-emerald-600">
                        {formatCurrency((selectedEmp.salary ?? 0) - (selectedEmp.advance ?? 0) - (selectedEmp.deductions ?? 0))}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  {payAction === 'edit_salary' ? 'Новый оклад (TJS)' :
                   payAction === 'deduction' ? 'Сумма удержания (TJS)' :
                   payAction === 'advance' ? 'Сумма аванса (TJS)' : 'Сумма выплаты (TJS)'}
                </label>
                <input type="number" min={0} value={payAmount || ''} onChange={e => setPayAmount(Number(e.target.value))}
                  className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-lg font-bold text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" />
                {payAction === 'advance' && (selectedEmp.advance ?? 0) > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">Текущий аванс: {formatCurrency(selectedEmp.advance ?? 0)} + {formatCurrency(payAmount)} = {formatCurrency((selectedEmp.advance ?? 0) + payAmount)}</p>
                )}
                {payAction === 'deduction' && (selectedEmp.deductions ?? 0) > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">Текущие удержания: {formatCurrency(selectedEmp.deductions ?? 0)} + {formatCurrency(payAmount)} = {formatCurrency((selectedEmp.deductions ?? 0) + payAmount)}</p>
                )}
              </div>

              {payAction === 'deduction' && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Причина</label>
                  <input value={deductionReason} onChange={e => setDeductionReason(e.target.value)} placeholder="Штраф, порча, опоздание..."
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
                </div>
              )}

              {needsPayment(payAction) && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Со счёта</label>
                  <div className="space-y-1.5">
                    {accounts.map(acc => (
                      <button key={acc.id} onClick={() => setSelectedAccountId(acc.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border-2 text-left transition-all ${
                          selectedAccountId === acc.id ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/30'
                        }`}>
                        {acc.type === 'cash' ? <Banknote className="size-4 text-muted-foreground" /> : <CreditCard className="size-4 text-muted-foreground" />}
                        <div className="flex-1">
                          <p className="text-sm font-medium">{acc.name}</p>
                          <p className="text-xs text-muted-foreground">{formatCurrency(acc.balance)}</p>
                        </div>
                        {selectedAccountId === acc.id && <CheckCircle className="size-4 text-primary" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-2 p-5 border-t border-border">
              <button onClick={closeDialog} className="flex-1 px-4 py-2.5 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted">Отмена</button>
              <button onClick={handleSubmit}
                disabled={paying || payAmount <= 0 || (needsPayment(payAction) && !selectedAccountId)}
                className={`flex-1 px-4 py-2.5 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 ${dialogColor[payAction]}`}>
                {dialogBtnText()}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
