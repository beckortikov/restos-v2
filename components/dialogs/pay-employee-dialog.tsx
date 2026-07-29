'use client'

// PayEmployeeDialog — выплата ЗП/аванса/обслуживания, удержание, правка оклада.
// Извлечён из app/(app)/finance/payroll/page.tsx (ЗП-5), чтобы использовать и
// на странице списка, и на карточке сотрудника — без дублирования денежной
// логики (ЗП-4: честный кап + осознанная «свободная» выплата).
//
// Владелец состояния — компонент сам (не родитель): при смене employee/action
// сбрасывает форму и предзаполняет сумму, как раньше делал openDialog().

import { useState, useEffect } from 'react'
import { X, Banknote, CreditCard, CheckCircle } from 'lucide-react'
import { toast } from 'sonner'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { ROLE_LABELS, type User, type FinancialAccount } from '@/lib/types'
import { updateUser, paySalaryFull, payServiceCharge } from '@/lib/queries'
import { addSalaryDeduction, type SalaryAccrualRow } from '@/lib/queries/finance'

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
  onClose: () => void
  onSaved: () => void | Promise<void>
}

export function PayEmployeeDialog({
  employee, action, accounts, accrual, salaryPaidThisPeriod, serviceAccrued, servicePaidThisPeriod,
  serviceFrom, serviceTo, shiftId, onClose, onSaved,
}: PayEmployeeDialogProps) {
  const [payAmount, setPayAmount] = useState(0)
  const [deductionReason, setDeductionReason] = useState('')
  // ЗП-4: явный выбор между «По начислению» (сумма по формуле, сервер капает
  // как раньше) и «Свободная сумма» (любая сумма, но обязательная причина —
  // попадает в описание проводки, is_override=true в отчёте).
  const [payMode, setPayMode] = useState<'accrual' | 'override'>('accrual')
  const [overrideReason, setOverrideReason] = useState('')
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [formPayType, setFormPayType] = useState<'monthly' | 'daily'>('monthly')
  const [paying, setPaying] = useState(false)

  // Инициализация при каждом открытии (было в openDialog() до извлечения).
  useEffect(() => {
    if (!employee || !action) return
    setDeductionReason('')
    setPayMode('accrual')
    setOverrideReason('')
    setSelectedAccountId('')
    if (action === 'advance' || action === 'deduction') {
      setPayAmount(0)
    } else if (action === 'edit_salary') {
      const pt = employee.payType === 'daily' ? 'daily' : 'monthly'
      setFormPayType(pt)
      setPayAmount(pt === 'daily' ? (employee.dailyRate ?? 0) : (employee.salary ?? 0))
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
      setPayAmount(Math.max(0, acc - (employee.advance ?? 0) - (employee.deductions ?? 0) - paid))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee?.id, action])

  if (!employee || !action) return null

  const handleSubmit = async () => {
    setPaying(true)
    try {
      if (action === 'edit_salary') {
        // Пишем и тип, и соответствующую ему сумму. Второе поле обнуляем,
        // чтобы не осталось «оклад 3000 + ставка 120» — по такой карточке
        // непонятно, за что человеку платят.
        await updateUser(employee.id, formPayType === 'daily'
          ? { pay_type: 'daily', daily_rate: payAmount, salary: 0 }
          : { pay_type: 'monthly', salary: payAmount, daily_rate: 0 })
        toast.success(formPayType === 'daily'
          ? `${employee.name}: ${formatCurrency(payAmount)} за день`
          : `Оклад ${employee.name}: ${formatCurrency(payAmount)}`)
      } else if (action === 'advance') {
        if (payAmount <= 0) { setPaying(false); return }
        if (payMode === 'override' && !overrideReason.trim()) { toast.error('Укажите причину свободной выплаты'); setPaying(false); return }
        const acc = accounts.find(a => a.id === selectedAccountId)
        // Период — ТЕКУЩИЙ календарный месяц: сервер всегда датирует
        // созданную проводку сегодняшним днём (payout()), «уже выплачено»
        // ищет по этому же префиксу. Диапазон UI-фильтра («Квартал»/«Год»)
        // может начинаться в другом месяце — тогда period не совпал бы с
        // датой проводки, и кап молча переставал видеть прошлые выплаты.
        const payPeriod = new Date().toISOString().slice(0, 7)
        const opts = payMode === 'override' ? { override: true, overrideReason: overrideReason.trim() } : undefined
        // Проводка создаётся ПЕРВОЙ (деньги реально выданы), счётчик advance —
        // второй шаг: если он упадёт (легаси-схема), выплата всё равно записана.
        await paySalaryFull(employee.id, payAmount, selectedAccountId, acc?.name ?? '', employee.name, 'advance', payPeriod, opts)
        const newAdvance = (employee.advance ?? 0) + payAmount
        try { await updateUser(employee.id, { advance: newAdvance }) } catch (e) { console.warn('advance counter update failed:', e) }
        toast.success(`Аванс ${formatCurrency(payAmount)}: ${employee.name}`)
      } else if (action === 'deduction') {
        if (payAmount <= 0) { setPaying(false); return }
        if (!deductionReason.trim()) { toast.error('Укажите причину удержания'); setPaying(false); return }
        // ЗП-4: реальная запись (salary_deductions) вместо счётчика без
        // следа — причина раньше терялась в тосте сразу после ввода.
        await addSalaryDeduction(employee.id, payAmount, deductionReason.trim())
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
        const payPeriod = new Date().toISOString().slice(0, 7)
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
          description: 'Если это осознанно (бонус, доплата, коррекция) — переключитесь на «Свободная сумма».',
          action: { label: 'Свободная сумма', onClick: () => setPayMode('override') },
          duration: 8000,
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card rounded-2xl border border-border shadow-xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="text-lg font-bold text-foreground">{DIALOG_TITLE[action]}</h2>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground"><X className="size-5" /></button>
        </div>

        <div className="p-5 space-y-4">
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
                  <p className="font-bold text-amber-600">{formatCurrency(employee.advance ?? 0)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">К выплате</p>
                  <p className="font-bold text-emerald-600">
                    {formatCurrency((employee.salary ?? 0) - (employee.advance ?? 0) - (employee.deductions ?? 0))}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Тип оплаты труда (054). Переключатель только в «Оплата труда»:
              в выплатах/авансах менять его нельзя — это настройка карточки,
              а не свойство конкретной операции. */}
          {action === 'edit_salary' && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Как платим</label>
              <div className="flex rounded-lg border border-border overflow-hidden">
                {([
                  ['monthly', 'Оклад за месяц'],
                  ['daily', 'Ставка за день'],
                ] as const).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      setFormPayType(v)
                      setPayAmount(v === 'daily' ? (employee.dailyRate ?? 0) : (employee.salary ?? 0))
                    }}
                    className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
                      formPayType === v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
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
              {action === 'edit_salary' ? (formPayType === 'daily' ? 'Ставка за день (TJS)' : 'Оклад за месяц (TJS)') :
               action === 'deduction' ? 'Сумма удержания (TJS)' :
               action === 'advance' ? 'Сумма аванса (TJS)' : 'Сумма выплаты (TJS)'}
            </label>
            <input type="number" min={0} value={payAmount || ''} onChange={e => setPayAmount(Number(e.target.value))}
              className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-lg font-bold text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" />
            {action === 'advance' && (employee.advance ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground mt-1">Текущий аванс: {formatCurrency(employee.advance ?? 0)} + {formatCurrency(payAmount)} = {formatCurrency((employee.advance ?? 0) + payAmount)}</p>
            )}
            {action === 'deduction' && (employee.deductions ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground mt-1">Текущие удержания: {formatCurrency(employee.deductions ?? 0)} + {formatCurrency(payAmount)} = {formatCurrency((employee.deductions ?? 0) + payAmount)}</p>
            )}
          </div>

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

        <div className="flex gap-2 p-5 border-t border-border">
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
