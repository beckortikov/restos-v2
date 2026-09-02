'use client'

// PayEmployeeDialog — выплата ЗП/аванса/обслуживания, удержание, правка оклада.
// Извлечён из app/(app)/finance/payroll/page.tsx (ЗП-5), чтобы использовать и
// на странице списка, и на карточке сотрудника — без дублирования денежной
// логики (ЗП-4: честный кап + осознанная «свободная» выплата).
//
// Владелец состояния — компонент сам (не родитель): при смене employee/action
// сбрасывает форму и предзаполняет сумму, как раньше делал openDialog().

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, Banknote, CreditCard, CheckCircle, ChevronLeft, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { ROLE_LABELS, type User, type FinancialAccount } from '@/lib/types'
import { updateUser, paySalaryFull, payServiceCharge } from '@/lib/queries'
import { addSalaryDeduction, giveSalaryAdvance, fetchSalaryAccrual, type SalaryAccrualRow } from '@/lib/queries/finance'
import { requestUpdateEmployeePay } from '@/lib/queries/employee-relay'

const PERIOD_MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
function currentPeriod(): string { return new Date().toISOString().slice(0, 7) }
function periodToDate(p: string): Date {
  const [y, m] = p.split('-').map(Number)
  return new Date(y || new Date().getFullYear(), (m || 1) - 1, 1)
}
function dateToPeriod(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function shiftPeriod(p: string, delta: number): string {
  const d = periodToDate(p)
  return dateToPeriod(new Date(d.getFullYear(), d.getMonth() + delta, 1))
}
function periodLabel(p: string): string {
  const d = periodToDate(p)
  return `${PERIOD_MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

export type PayAction = 'salary' | 'advance' | 'deduction' | 'edit_salary' | 'service'

export const PAYOUT_KIND_LABELS: Record<'salary' | 'advance' | 'service', string> = {
  salary: 'Зарплата',
  advance: 'Аванс',
  service: 'Обслуживание',
}

export const PAYOUT_KIND_TONE: Record<'salary' | 'advance' | 'service', string> = {
  salary: 'bg-emerald-100 text-emerald-700',
  advance: 'bg-amber-100 text-amber-700',
  service: 'bg-blue-100 text-blue-700',
}

export function needsPayment(action: PayAction | null): boolean {
  return action === 'salary' || action === 'advance' || action === 'service'
}

const DIALOG_TITLE: Record<PayAction, string> = {
  salary: 'Выплатить зарплату',
  advance: 'Выдать аванс',
  deduction: 'Внести удержание',
  edit_salary: 'Оплата труда',
  service: 'Выплатить обслуживание',
}
const DIALOG_COLOR: Record<PayAction, string> = {
  salary: 'bg-emerald-600 hover:bg-emerald-700',
  advance: 'bg-amber-600 hover:bg-amber-700',
  deduction: 'bg-destructive hover:bg-destructive/90',
  edit_salary: 'bg-primary hover:bg-primary/90',
  service: 'bg-blue-600 hover:bg-blue-700',
}

export interface PayEmployeeDialogProps {
  employee: User | null
  action: PayAction | null
  accounts: FinancialAccount[]
  /** Начислено за период (054): оклад или ставка×дни — для предзаполнения суммы. */
  accrual?: SalaryAccrualRow
  /** Уже выплачено зарплаты/аванса за период (из financial_operations). */
  salaryPaidThisPeriod?: number
  serviceAccrued?: number
  servicePaidThisPeriod?: number
  serviceFrom: string
  serviceTo: string
  /** Смена, если оплата привязана к конкретной (Обслуживание, фильтр «Смена»)
   * — иначе выплата не попадёт в отчёт по этой смене, а честный кап (ЗП-4)
   * посчитает остаток по periodFrom/periodTo вместо фактической смены. */
  shiftId?: string
  /** Фаза 4: сотрудник ДРУГОГО филиала сети (central) — только для
   *  action='edit_salary'. Правка идёт очередью (097), не сразу: central
   *  не пишет в БД филиала напрямую. Остальные action (аванс/удержание/
   *  выплата) для филиальных сотрудников не открываются — свой отдельный
   *  поток (payBranchSalary, см. finance/payroll branchPayFor). */
  relayTargetBranchId?: string
  onClose: () => void
  onSaved: () => void | Promise<void>
}

export function PayEmployeeDialog({
  employee, action, accounts, accrual, salaryPaidThisPeriod, serviceAccrued, servicePaidThisPeriod,
  serviceFrom, serviceTo, shiftId, relayTargetBranchId, onClose, onSaved,
}: PayEmployeeDialogProps) {
  const navigate = useNavigate()
  const [payAmount, setPayAmount] = useState(0)
  const [deductionReason, setDeductionReason] = useState('')
  // ЗП-4: явный выбор между «По начислению» (сумма по формуле, сервер капает
  // как раньше) и «Свободная сумма» (любая сумма, но обязательная причина —
  // попадает в описание проводки, is_override=true в отчёте).
  const [payMode, setPayMode] = useState<'accrual' | 'override'>('accrual')
  const [overrideReason, setOverrideReason] = useState('')
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [formPayType, setFormPayType] = useState<'monthly' | 'daily' | 'hourly'>('monthly')
  // extraShiftRate — гибрид «оклад + доп. смены»: ставка доп. смены (то же
  // поле daily_rate, что у дневной оплаты, но для formPayType='monthly' не
  // заменяет оклад, а добавляется к нему за отмеченные в календаре дни).
  const [extraShiftRate, setExtraShiftRate] = useState(0)
  const [paying, setPaying] = useState(false)
  // Долг за предыдущий период (Фаза 2): владелец мог забыть переключить
  // период выплаты с текущего месяца на прошлый — пикер по умолчанию всегда
  // «сейчас». Проверяем ровно ОДИН месяц назад (не открытую историю) —
  // самый частый случай, не отдельный экран.
  const [prevPeriodDebt, setPrevPeriodDebt] = useState<{ period: string; amount: number } | null>(null)
  // Период выплаты (070) — раньше жёстко «сейчас»: выплатить за прошлый
  // месяц было невозможно. Зарплата/аванс/удержание теперь дают выбрать
  // любой месяц; «Обслуживание» период не меняет — им управляет фильтр
  // страницы (serviceFrom/serviceTo).
  const [payPeriod, setPayPeriod] = useState(currentPeriod)
  const showPeriodPicker = action === 'salary' || action === 'advance' || action === 'deduction'

  // Инициализация при каждом открытии (было в openDialog() до извлечения).
  useEffect(() => {
    if (!employee || !action) return
    setDeductionReason('')
    setPayMode('accrual')
    setOverrideReason('')
    setSelectedAccountId('')
    setPayPeriod(currentPeriod())
    if (action === 'advance' || action === 'deduction') {
      setPayAmount(0)
    } else if (action === 'edit_salary') {
      const pt = employee.payType === 'daily' ? 'daily' : employee.payType === 'hourly' ? 'hourly' : 'monthly'
      setFormPayType(pt)
      setPayAmount(
        pt === 'daily' ? (employee.dailyRate ?? 0)
          : pt === 'hourly' ? (employee.hourlyRate ?? 0)
            : (employee.salary ?? 0),
      )
      // daily_rate осмыслен как «ставка доп. смены» только если сотрудник
      // УЖЕ оклад — если он был на дневной, его daily_rate это ставка ЗА
      // ДЕНЬ, переносить её в доп.смены при смене типа было бы совпадением,
      // а не осознанным значением.
      setExtraShiftRate(pt === 'monthly' ? (employee.dailyRate ?? 0) : 0)
    } else if (action === 'service') {
      const acc = serviceAccrued ?? 0
      const paid = servicePaidThisPeriod ?? 0
      setPayAmount(Math.max(0, acc - paid))
    } else {
      // Остаток к выплате — от начисленного за период, а не от оклада: у
      // сотрудника на дневной оплате оклад нулевой. Вычитаем и уже
      // выплаченное за период — иначе после полной выплаты подсказка всё
      // равно предлагала бы весь оклад заново.
      const acc = accrual?.accrued ?? (employee.salary ?? 0)
      const paid = salaryPaidThisPeriod ?? 0
      // period-scoped аванс/удержания (из accrual за период), не глобальный emp.advance.
      setPayAmount(Math.max(0, acc - (accrual?.advance ?? 0) - (accrual?.deductions ?? 0) - paid))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee?.id, action])

  // Долг за прошлый месяц — только для «Выплатить зарплату» (у аванса/
  // удержания и «доп.смен» такого паттерна нет). Один доп. запрос за один
  // конкретный месяц, не открытая история — дёшево и решает реальный случай
  // («забыл переключить период»), не открытый.
  useEffect(() => {
    if (!employee || action !== 'salary') { setPrevPeriodDebt(null); return }
    const prev = shiftPeriod(currentPeriod(), -1)
    const [py, pm] = prev.split('-').map(Number)
    const from = `${prev}-01`
    const to = new Date(py, pm, 0).toISOString().slice(0, 10)
    let cancelled = false
    fetchSalaryAccrual(from, to).then((rows) => {
      if (cancelled) return
      const row = rows.find((r) => r.userId === employee.id)
      if (!row) { setPrevPeriodDebt(null); return }
      const debt = row.accrued - row.advance - row.deductions - row.paidSalary
      setPrevPeriodDebt(debt > 0.5 ? { period: prev, amount: debt } : null)
    }).catch(() => setPrevPeriodDebt(null))
    return () => { cancelled = true }
  }, [employee?.id, action])

  if (!employee || !action) return null

  const handleSubmit = async () => {
    setPaying(true)
    try {
      if (action === 'edit_salary') {
        // Дневная оплата — daily_rate = ставка за день, salary обнуляем (не
        // осталось «оклад 3000 + ставка 120», по карточке непонятно, за что
        // платят). Оклад — daily_rate теперь НЕ обнуляется: это гибрид
        // «оклад + доп. смены» (extraShiftRate, 0 если не задано владельцем).
        if (relayTargetBranchId) {
          // Очередь (097) — филиал применит с задержкой ~30 сек: central не
          // пишет в БД филиала напрямую (см. requestUpdateEmployeePay).
          await requestUpdateEmployeePay(employee.id, formPayType === 'daily'
            ? { payType: 'daily', dailyRate: String(payAmount), salary: '0' }
            : formPayType === 'hourly'
              // Оклад обнуляем, как и у дневной: «оклад 3000 + 20 за час» по
              // карточке не читается, за что человеку платят.
              ? { payType: 'hourly', hourlyRate: String(payAmount), salary: '0' }
              : { payType: 'monthly', salary: String(payAmount), dailyRate: String(extraShiftRate) })
          toast.success(`Отправлено филиалу — оплата труда ${employee.name} применится в течение ~30 секунд`)
        } else {
          await updateUser(employee.id, formPayType === 'daily'
            ? { pay_type: 'daily', daily_rate: payAmount, salary: 0 }
            : formPayType === 'hourly'
              ? { pay_type: 'hourly', hourly_rate: payAmount, salary: 0 }
              : { pay_type: 'monthly', salary: payAmount, daily_rate: extraShiftRate })
          toast.success(
            formPayType === 'daily' ? `${employee.name}: ${formatCurrency(payAmount)} за день`
              : formPayType === 'hourly' ? `${employee.name}: ${formatCurrency(payAmount)} за час`
                : `Оклад ${employee.name}: ${formatCurrency(payAmount)}${extraShiftRate > 0 ? ` + доп.смена ${formatCurrency(extraShiftRate)}` : ''}`,
          )
        }
      } else if (action === 'advance') {
        if (payAmount <= 0) { setPaying(false); return }
        if (payMode === 'override' && !overrideReason.trim()) { toast.error('Укажите причину свободной выплаты'); setPaying(false); return }
        const opts = payMode === 'override' ? { override: true, overrideReason: overrideReason.trim() } : undefined
        // 070: одна атомарная транзакция на бэке (счёт + проводка + строка +
        // users.advance) — раньше это были два независимых запроса подряд
        // (payout + отдельный PATCH), и падение второго теряло синхронизацию.
        await giveSalaryAdvance(employee.id, payAmount, selectedAccountId, payPeriod, undefined, opts)
        toast.success(`Аванс ${formatCurrency(payAmount)}: ${employee.name}`)
      } else if (action === 'deduction') {
        if (payAmount <= 0) { setPaying(false); return }
        if (!deductionReason.trim()) { toast.error('Укажите причину удержания'); setPaying(false); return }
        // ЗП-4: реальная запись (salary_deductions) вместо счётчика без
        // следа — причина раньше терялась в тосте сразу после ввода.
        await addSalaryDeduction(employee.id, payAmount, deductionReason.trim(), payPeriod)
        toast.success(`Удержание ${formatCurrency(payAmount)}: ${employee.name} — ${deductionReason.trim()}`)
      } else if (action === 'service') {
        if (payAmount <= 0) { setPaying(false); return }
        if (payMode === 'override' && !overrideReason.trim()) { toast.error('Укажите причину свободной выплаты'); setPaying(false); return }
        const acc = accounts.find(a => a.id === selectedAccountId)
        await payServiceCharge({
          waiterId: employee.id,
          waiterName: employee.name,
          amount: payAmount,
          accountId: selectedAccountId,
          accountName: acc?.name ?? '',
          periodFrom: serviceFrom,
          periodTo: serviceTo,
          shiftId,
          ...(payMode === 'override' ? { override: true, overrideReason: overrideReason.trim() } : {}),
        })
        toast.success(`Обслуживание ${formatCurrency(payAmount)}: ${employee.name}`)
      } else {
        if (payAmount <= 0) { setPaying(false); return }
        if (payMode === 'override' && !overrideReason.trim()) { toast.error('Укажите причину свободной выплаты'); setPaying(false); return }
        const acc = accounts.find(a => a.id === selectedAccountId)
        const opts = payMode === 'override' ? { override: true, overrideReason: overrideReason.trim() } : undefined
        await paySalaryFull(employee.id, payAmount, selectedAccountId, acc?.name ?? '', employee.name, 'salary', payPeriod, opts)
        try { await updateUser(employee.id, { advance: 0, deductions: 0 }) } catch (e) { console.warn('reset counters failed:', e) }
        toast.success(`Зарплата ${formatCurrency(payAmount)}: ${employee.name}`)
      }
      onClose()
      await onSaved()
    } catch (e) {
      const msg = humanizeError(e, 'Ошибка')
      // Кап сработал в режиме «По начислению» — подсказываем явный выход,
      // а не просто показываем отказ: ровно то, чего не хватало (ЗП-4).
      if (payMode === 'accrual' && /превышает остаток/.test(msg) && needsPayment(action)) {
        toast.error(msg, {
          description: 'Если это осознанно (бонус, доплата, коррекция) — переключитесь на «Свободная сумма», или откройте историю сотрудника, чтобы проверить и при необходимости отменить прошлый аванс/удержание.',
          action: { label: 'Свободная сумма', onClick: () => setPayMode('override') },
          cancel: { label: 'Смотреть историю →', onClick: () => { onClose(); navigate(`/finance/payroll/${employee.id}`) } },
          duration: 10000,
        })
      } else {
        toast.error(msg)
      }
    } finally { setPaying(false) }
  }

  const dialogBtnText = (): string => {
    if (paying) return 'Обработка...'
    if (action === 'edit_salary') return 'Сохранить'
    if (action === 'deduction') return `Удержать ${payAmount > 0 ? formatCurrency(payAmount) : ''}`
    if (action === 'advance') return `Выдать аванс ${payAmount > 0 ? formatCurrency(payAmount) : ''}`
    if (action === 'service') return `Выплатить обсл. ${payAmount > 0 ? formatCurrency(payAmount) : ''}`
    return `Выплатить ${payAmount > 0 ? formatCurrency(payAmount) : ''}`
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      {/* Много счетов (список аккаунтов ниже) раздувал диалог за пределы
          экрана и прятал кнопку «Выплатить» — теперь высота ограничена,
          заголовок/футер закреплены, а прокручивается только середина. */}
      <div className="bg-card rounded-2xl border border-border shadow-xl w-full max-w-md max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-border shrink-0">
          <h2 className="text-lg font-bold text-foreground">{DIALOG_TITLE[action]}</h2>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground"><X className="size-5" /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1 min-h-0">
          <div className="bg-muted/30 rounded-xl p-4">
            <p className="font-semibold text-foreground">{employee.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{employee.position || ROLE_LABELS[employee.role]}</p>
            {action !== 'edit_salary' && (
              <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
                <div>
                  <p className="text-muted-foreground">Оклад</p>
                  <p className="font-bold text-foreground">{formatCurrency(employee.salary ?? 0)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Аванс</p>
                  <p className="font-bold text-amber-600">{formatCurrency(accrual?.advance ?? 0)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">К выплате</p>
                  <p className="font-bold text-emerald-600">
                    {formatCurrency((accrual?.accrued ?? employee.salary ?? 0) - (accrual?.advance ?? 0) - (accrual?.deductions ?? 0) - (salaryPaidThisPeriod ?? 0))}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* 070: период выплаты — раньше жёстко «сейчас», выплатить за
              прошлый месяц было невозможно. Своя навигация (◀ ▶), как в
              WorkedDaysDialog, независимая от фильтра страницы. */}
          {showPeriodPicker && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Период</label>
              <div className="flex items-center justify-between rounded-lg border border-border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setPayPeriod(p => shiftPeriod(p, -1))}
                  className="size-9 flex items-center justify-center hover:bg-muted transition-colors"
                  aria-label="Предыдущий месяц"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <span className="text-sm font-medium capitalize">{periodLabel(payPeriod)}</span>
                <button
                  type="button"
                  onClick={() => setPayPeriod(p => shiftPeriod(p, 1))}
                  className="size-9 flex items-center justify-center hover:bg-muted transition-colors"
                  aria-label="Следующий месяц"
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>
            </div>
          )}

          {/* Фаза 2: за прошлый месяц не выплачено — пикер выше по умолчанию
              всегда «сейчас», легко забыть переключить и выплатить не за тот
              период. Показываем, только пока выбран НЕ этот прошлый месяц —
              переключились сами, подсказка не нужна. */}
          {prevPeriodDebt && payPeriod !== prevPeriodDebt.period && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 px-3 py-2">
              <span className="text-xs text-amber-800 dark:text-amber-400">
                За {periodLabel(prevPeriodDebt.period)} не выплачено {formatCurrency(prevPeriodDebt.amount)}
              </span>
              <button
                type="button"
                onClick={() => { setPayPeriod(prevPeriodDebt.period); setPayAmount(prevPeriodDebt.amount) }}
                className="shrink-0 text-xs font-medium text-amber-800 dark:text-amber-400 underline hover:no-underline"
              >
                Выплатить за {periodLabel(prevPeriodDebt.period).split(' ')[0]}
              </button>
            </div>
          )}

          {/* Тип оплаты труда (054). Переключатель только в «Оплата труда»:
              в выплатах/авансах менять его нельзя — это настройка карточки,
              а не свойство конкретной операции. */}
          {action === 'edit_salary' && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Как платим</label>
              <div className="flex rounded-lg border border-border overflow-hidden">
                {([
                  ['monthly', 'Оклад за месяц'],
                  ['daily', 'За день'],
                  ['hourly', 'За час'],
                ] as const).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      setFormPayType(v)
                      setPayAmount(
                        v === 'daily' ? (employee.dailyRate ?? 0)
                          : v === 'hourly' ? (employee.hourlyRate ?? 0)
                            : (employee.salary ?? 0),
                      )
                      setExtraShiftRate(v === 'monthly' && employee.payType !== 'daily' ? (employee.dailyRate ?? 0) : 0)
                    }}
                    className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
                      formPayType === v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {formPayType === 'hourly' && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Начисление считается автоматически: ставка × часы ЗАКРЫТЫХ смен. Открытая смена
                  в сумму не входит — у неё нет ухода.
                  {(() => {
                    const h = accrual?.hoursWorked ?? 0
                    return h > 0 ? ` За выбранный период ${h} ч.` : ' За выбранный период закрытых смен пока нет.'
                  })()}
                </p>
              )}
              {formPayType === 'daily' && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Начисление считается автоматически: ставка × дни с отметкой в табеле.
                  {(() => {
                    const d = accrual?.daysWorked ?? 0
                    return d > 0 ? ` За выбранный период отмечено ${d} дн.` : ' За выбранный период отметок пока нет.'
                  })()}
                </p>
              )}
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {action === 'edit_salary'
              ? (formPayType === 'daily' ? 'Ставка за день (TJS)'
                : formPayType === 'hourly' ? 'Ставка за час (TJS)'
                  : 'Оклад за месяц (TJS)') :
               action === 'deduction' ? 'Сумма удержания (TJS)' :
               action === 'advance' ? 'Сумма аванса (TJS)' : 'Сумма выплаты (TJS)'}
            </label>
            <input type="number" min={0} value={payAmount || ''} onChange={e => setPayAmount(Number(e.target.value))}
              className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-lg font-bold text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" />
            {action === 'advance' && (accrual?.advance ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground mt-1">Аванс за период: {formatCurrency(accrual?.advance ?? 0)} + {formatCurrency(payAmount)} = {formatCurrency((accrual?.advance ?? 0) + payAmount)}</p>
            )}
            {action === 'deduction' && (accrual?.deductions ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground mt-1">Удержания за период: {formatCurrency(accrual?.deductions ?? 0)} + {formatCurrency(payAmount)} = {formatCurrency((accrual?.deductions ?? 0) + payAmount)}</p>
            )}
          </div>

          {/* Гибрид «оклад + доп. смены»: та же ставка, что у дневной оплаты
              (daily_rate), но сверх оклада — за дни, отмеченные отдельно в
              календаре «⋯ → Доп. смены». Необязательно: 0 = обычный оклад
              без доп. смен, как раньше. */}
          {action === 'edit_salary' && formPayType === 'monthly' && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Ставка доп. смены (необязательно, TJS)
              </label>
              <input type="number" min={0} value={extraShiftRate || ''} onChange={e => setExtraShiftRate(Number(e.target.value))}
                placeholder="0"
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" />
              <p className="text-[11px] text-muted-foreground mt-1">
                Если сотрудник иногда выходит доп. сменой сверх оклада — отметьте дни в календаре
                («⋯» → Доп. смены на строке сотрудника), они добавятся к начислению автоматически.
              </p>
            </div>
          )}

          {action === 'deduction' && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Причина <span className="text-destructive">*</span>
              </label>
              <input value={deductionReason} onChange={e => setDeductionReason(e.target.value)} placeholder="Штраф, порча, опоздание..."
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
            </div>
          )}

          {/* ЗП-4: явный выбор между суммой по формуле (сервер капает как
              раньше) и свободной суммой (любая, но с обязательной причиной).
              Раньше выбора не было — превышение либо блокировалось намертво
              (оклад настроен), либо проходило случайно без предупреждения
              (аванс/обслуживание — баг). */}
          {needsPayment(action) && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Режим выплаты</label>
              <div className="flex rounded-lg border border-border overflow-hidden">
                {([
                  ['accrual', 'По начислению'],
                  ['override', 'Свободная сумма'],
                ] as const).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setPayMode(v)}
                    className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
                      payMode === v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {payMode === 'override' ? (
                <div className="mt-2">
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">
                    Причина свободной выплаты <span className="text-destructive">*</span>
                  </label>
                  <input value={overrideReason} onChange={e => setOverrideReason(e.target.value)} placeholder="Бонус, доплата, коррекция..."
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Сумма любая — сервер не проверяет остаток. Причина попадёт в описание проводки и в отчёт.
                  </p>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Сервер не даст выплатить больше расчётного остатка.
                </p>
              )}
            </div>
          )}

          {needsPayment(action) && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Со счёта {!selectedAccountId && <span className="text-destructive">— выберите</span>}
              </label>
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

        <div className="flex gap-2 p-5 border-t border-border shrink-0">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted">Отмена</button>
          <button onClick={handleSubmit}
            disabled={
              paying || payAmount <= 0 ||
              (needsPayment(action) && !selectedAccountId) ||
              (needsPayment(action) && payMode === 'override' && !overrideReason.trim()) ||
              (action === 'deduction' && !deductionReason.trim())
            }
            className={`flex-1 px-4 py-2.5 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 ${DIALOG_COLOR[action]}`}>
            {dialogBtnText()}
          </button>
        </div>
      </div>
    </div>
  )
}
