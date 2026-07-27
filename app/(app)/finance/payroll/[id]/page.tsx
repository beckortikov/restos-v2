'use client'

// Карточка сотрудника (ЗП-5) — по образцу warehouse/suppliers/[id]: текущие
// цифры, тренд по месяцам, полная лента выплат/удержаний с причинами,
// выплата прямо отсюда через тот же PayEmployeeDialog, что и список.

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Pencil, TrendingUp, History } from 'lucide-react'
import { toast } from 'sonner'
import { formatCurrency } from '@/lib/helpers'
import { ROLE_LABELS, type User, type FinancialAccount } from '@/lib/types'
import {
  fetchUsers, fetchFinancialAccounts, fetchFinancialOperations,
  fetchSalaryAccrual, type SalaryAccrualRow,
  fetchSalaryReport, type SalaryPayoutRow,
  fetchServiceAccrualByWaiter, fetchServicePayoutByWaiter, type ServiceAccrualByWaiter,
} from '@/lib/queries'
import { selectableAccounts, fetchSalaryDeductions, type SalaryDeductionRow } from '@/lib/queries/finance'
import { PayEmployeeDialog, PAYOUT_KIND_LABELS, PAYOUT_KIND_TONE, type PayAction } from '@/components/dialogs/pay-employee-dialog'

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
function pad(n: number): string { return String(n).padStart(2, '0') }
function monthKey(dateStr: string): string {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}
function monthLabel(key: string): string {
  const [y, m] = key.split('-')
  return `${MONTHS_SHORT[Number(m) - 1] ?? m} ${y}`
}

// Тренд смотрит ФАКТИЧЕСКИ ВЫПЛАЧЕННОЕ по месяцам (реальные проводки с
// реальными датами), а не «начислено»: для оклада (monthly) начисление —
// это просто текущая ставка карточки без истории её изменений — показать
// «сколько было начислено в марте» нечем, если с тех пор оклад меняли.
// Выплаты, наоборот, воспроизводимы из истории один в один.
const TREND_MONTHS = 6

type Row = { key: string; label: string; salary: number; advance: number; service: number }

export default function EmployeeDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [employee, setEmployee] = useState<User | null>(null)
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [loading, setLoading] = useState(true)

  const [payAction, setPayAction] = useState<PayAction | null>(null)

  // Текущий месяц — та же формула, что и серверный кап (ЗП-4): период для
  // выплаты всегда «сейчас», иначе капы и это отображение разойдутся.
  const [accrual, setAccrual] = useState<SalaryAccrualRow | undefined>(undefined)
  const [salaryOnlyPaidMonth, setSalaryOnlyPaidMonth] = useState(0)
  const [salaryPaidMonthCombined, setSalaryPaidMonthCombined] = useState(0)
  const [serviceAccrued, setServiceAccrued] = useState(0)
  const [servicePaid, setServicePaid] = useState(0)

  // История — окно TREND_MONTHS для тренда, а ленту показываем целиком.
  const [payouts, setPayouts] = useState<SalaryPayoutRow[]>([])
  const [deductions, setDeductions] = useState<SalaryDeductionRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!id) return
    const now = new Date()
    const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
    const today = now.toISOString().slice(0, 10)
    const trendStart = new Date(now.getFullYear(), now.getMonth() - (TREND_MONTHS - 1), 1)
    const trendFrom = `${trendStart.getFullYear()}-${pad(trendStart.getMonth() + 1)}-01`

    const [users, accs, accrualRows, ops, report, dedRows] = await Promise.all([
      fetchUsers(),
      fetchFinancialAccounts().then(selectableAccounts),
      fetchSalaryAccrual(monthStart, today).catch(() => []),
      fetchFinancialOperations(),
      fetchSalaryReport(trendFrom, today).catch(() => null),
      fetchSalaryDeductions(id).catch(() => []),
    ])

    const emp = users.find(u => u.id === id)
    if (!emp) {
      toast.error('Сотрудник не найден')
      navigate('/finance/payroll')
      return
    }
    setEmployee(emp)
    setAccounts(accs)
    setAccrual(accrualRows.find(r => r.userId === id))

    // «Выплачено в этом месяце» — тот же принцип, что и в списке (ЗП-4/фикс
    // v3.16.209): combined («Зарплата»+«Аванс») для отображения, salaryOnly
    // для расчёта остатка — аванс уже вычитается через emp.advance, вычесть
    // его ещё раз через combined значило бы вычесть дважды.
    let combined = 0
    let salaryOnly = 0
    for (const op of ops) {
      if (op.sourceRef !== id) continue
      if ((op.category !== 'Зарплата' && op.category !== 'Аванс')) continue
      const d = (op.date || '').slice(0, 10)
      if (d && (d < monthStart || d > today)) continue
      combined += op.amount
      if (op.category === 'Зарплата') salaryOnly += op.amount
    }
    setSalaryPaidMonthCombined(combined)
    setSalaryOnlyPaidMonth(salaryOnly)

    const [svcAccrual, svcPayout] = await Promise.all([
      fetchServiceAccrualByWaiter(monthStart, today).catch((): ServiceAccrualByWaiter[] => []),
      fetchServicePayoutByWaiter(monthStart, today).catch((): Record<string, number> => ({})),
    ])
    setServiceAccrued(svcAccrual.find(r => r.waiterId === id)?.accrued ?? 0)
    setServicePaid(svcPayout[id] ?? 0)

    if (report) setPayouts(report.payouts.filter(p => p.userId === id))
    setDeductions(dedRows)
    setHistoryLoading(false)
  }, [id, navigate])

  useEffect(() => {
    setLoading(true)
    reload().finally(() => setLoading(false))
  }, [reload])

  // ─── Тренд по месяцам — стек «Зарплата / Аванс / Обслуживание» ────────────
  const trendRows = useMemo<Row[]>(() => {
    const now = new Date()
    const keys: string[] = []
    for (let i = TREND_MONTHS - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      keys.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`)
    }
    const byKey = new Map<string, Row>(keys.map(k => [k, { key: k, label: monthLabel(k), salary: 0, advance: 0, service: 0 }]))
    for (const p of payouts) {
      const k = monthKey(p.date)
      const row = byKey.get(k)
      if (!row) continue
      if (p.kind === 'salary') row.salary += p.amount
      else if (p.kind === 'advance') row.advance += p.amount
      else if (p.kind === 'service') row.service += p.amount
    }
    return keys.map(k => byKey.get(k)!)
  }, [payouts])

  const trendMax = Math.max(1, ...trendRows.map(r => r.salary + r.advance + r.service))

  // ─── Лента: выплаты + удержания одним списком, новые сверху ────────────────
  type TimelineItem =
    | { type: 'payout'; date: string; data: SalaryPayoutRow }
    | { type: 'deduction'; date: string; data: SalaryDeductionRow }

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...payouts.map(p => ({ type: 'payout' as const, date: p.date, data: p })),
      ...deductions.map(d => ({ type: 'deduction' as const, date: d.createdAt.slice(0, 10), data: d })),
    ]
    return items.sort((a, b) => b.date.localeCompare(a.date))
  }, [payouts, deductions])

  if (loading || !employee) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  const remaining = Math.max(0, (accrual?.accrued ?? employee.salary ?? 0) - (employee.advance ?? 0) - (employee.deductions ?? 0) - salaryOnlyPaidMonth)
  const serviceRemaining = Math.max(0, serviceAccrued - servicePaid)

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background border-b border-border">
        <div className="flex items-center gap-3 px-4 md:px-6 py-3">
          <button
            type="button"
            onClick={() => navigate('/finance/payroll')}
            className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:bg-muted px-2.5 py-1.5 rounded-lg transition-colors"
          >
            <ArrowLeft className="size-4" />
            <span>Назад</span>
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-base md:text-lg font-bold text-primary truncate">{employee.name}</h1>
            <p className="text-xs text-muted-foreground">{employee.position || ROLE_LABELS[employee.role]}</p>
          </div>
          <button
            type="button"
            onClick={() => setPayAction('edit_salary')}
            className="flex items-center gap-2 bg-card border border-border text-foreground px-3 py-2 rounded-lg text-sm font-medium hover:bg-muted transition-colors"
          >
            <Pencil className="size-4" />
            Оклад
          </button>
        </div>
      </div>

      <div className="flex-1 p-4 md:p-6 max-w-5xl mx-auto w-full space-y-6">
        {/* KPI текущего месяца */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground">Начислено (месяц)</p>
            <p className="text-xl font-bold text-foreground mt-1">{formatCurrency(accrual?.accrued ?? employee.salary ?? 0)}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground">Выплачено (месяц)</p>
            <p className="text-xl font-bold text-emerald-600 mt-1">{formatCurrency(salaryPaidMonthCombined)}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground">Аванс / удержания</p>
            <p className="text-xl font-bold text-amber-600 mt-1">{formatCurrency(employee.advance ?? 0)} <span className="text-destructive text-sm">/ {formatCurrency(employee.deductions ?? 0)}</span></p>
          </div>
          <div className="bg-primary/5 border border-primary/20 rounded-xl p-4">
            <p className="text-xs text-muted-foreground">Остаток к выплате</p>
            <p className="text-xl font-bold text-primary mt-1">{formatCurrency(remaining)}</p>
          </div>
        </div>

        {/* Действия */}
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setPayAction('salary')} className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors">Выплатить зарплату</button>
          <button onClick={() => setPayAction('advance')} className="px-4 py-2 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-700 transition-colors">Выдать аванс</button>
          <button onClick={() => setPayAction('deduction')} className="px-4 py-2 rounded-lg text-sm font-medium bg-card border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors">Удержание</button>
          {serviceRemaining > 0.005 && (
            <button onClick={() => setPayAction('service')} className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors">
              Обслуживание {formatCurrency(serviceRemaining)}
            </button>
          )}
        </div>

        {/* Тренд по месяцам */}
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 pb-3 border-b border-border/60 mb-4">
            <TrendingUp className="size-4.5 text-primary" />
            <h2 className="text-sm font-bold text-foreground">Выплаты по месяцам</h2>
          </div>
          <div className="space-y-2.5">
            {trendRows.map(r => {
              const total = r.salary + r.advance + r.service
              return (
                <div key={r.key} className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground w-16 shrink-0">{r.label}</span>
                  <div className="flex-1 h-5 rounded-md bg-muted/40 overflow-hidden flex">
                    {r.salary > 0 && <div className="h-full bg-emerald-500" style={{ width: `${(r.salary / trendMax) * 100}%` }} title={`Зарплата: ${formatCurrency(r.salary)}`} />}
                    {r.advance > 0 && <div className="h-full bg-amber-500" style={{ width: `${(r.advance / trendMax) * 100}%` }} title={`Аванс: ${formatCurrency(r.advance)}`} />}
                    {r.service > 0 && <div className="h-full bg-blue-500" style={{ width: `${(r.service / trendMax) * 100}%` }} title={`Обслуживание: ${formatCurrency(r.service)}`} />}
                  </div>
                  <span className="text-xs font-semibold text-foreground tabular-nums w-24 text-right shrink-0">{total > 0 ? formatCurrency(total) : '—'}</span>
                </div>
              )
            })}
          </div>
          <div className="flex items-center gap-4 mt-4 pt-3 border-t border-border/60 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-emerald-500" />Зарплата</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-amber-500" />Аванс</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-blue-500" />Обслуживание</span>
          </div>
        </div>

        {/* Лента выплат и удержаний */}
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 pb-3 border-b border-border/60 mb-3">
            <History className="size-4.5 text-primary" />
            <h2 className="text-sm font-bold text-foreground">История</h2>
          </div>
          {historyLoading ? (
            <div className="py-10 flex items-center justify-center">
              <div className="size-6 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
          ) : timeline.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Пока нет выплат за последние {TREND_MONTHS} мес.</div>
          ) : (
            <div className="divide-y divide-border/60">
              {timeline.map((item, i) => (
                <div key={item.type === 'payout' ? item.data.id : item.data.id ?? i} className="flex items-start gap-3 py-2.5">
                  <span className="text-xs text-muted-foreground tabular-nums w-20 shrink-0 pt-0.5">{item.date || '—'}</span>
                  <div className="flex-1 min-w-0">
                    {item.type === 'payout' ? (
                      <>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium ${PAYOUT_KIND_TONE[item.data.kind]}`}>
                            {PAYOUT_KIND_LABELS[item.data.kind]}
                          </span>
                          {item.data.isOverride && (
                            <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
                              Ручная
                            </span>
                          )}
                          {item.data.accountName && <span className="text-[11px] text-muted-foreground">со счёта «{item.data.accountName}»</span>}
                        </div>
                        {item.data.description && <p className="text-xs text-muted-foreground mt-1 truncate">{item.data.description}</p>}
                      </>
                    ) : (
                      <>
                        <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-medium bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400">
                          Удержание
                        </span>
                        <p className="text-xs text-muted-foreground mt-1">{item.data.reason}</p>
                      </>
                    )}
                  </div>
                  <span className={`text-sm font-bold tabular-nums shrink-0 ${item.type === 'deduction' ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                    {item.type === 'deduction' ? '−' : ''}{formatCurrency(item.data.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <PayEmployeeDialog
        employee={employee}
        action={payAction}
        accounts={accounts}
        accrual={accrual}
        salaryPaidThisPeriod={salaryOnlyPaidMonth}
        serviceAccrued={serviceAccrued}
        servicePaidThisPeriod={servicePaid}
        serviceFrom={`${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-01T00:00:00.000Z`}
        serviceTo={new Date().toISOString()}
        onClose={() => setPayAction(null)}
        onSaved={reload}
      />
    </div>
  )
}
