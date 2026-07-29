'use client'

/**
 * OrderPaymentPanel — секция оплаты заказа: пре-чек, скидка, обслуживание,
 * выбор счёта, mixed payments. Извлечён из OrderActionsBody.
 *
 * State владелец — родитель; компонент пробрасывает callbacks обратно.
 */

import { useMemo } from 'react'
import { dRound, dDiv, dMul } from '@/lib/decimal'
import { formatCurrency } from '@/lib/helpers'
import { useAuth } from '@/lib/auth-store'
import { selectableAccounts } from '@/lib/queries/finance'
import type { OrderPayment, FinancialAccount } from '@/lib/types'
import {
  Banknote,
  CreditCard,
  Wallet,
  Building2,
  CheckCircle2,
  FileText,
  Tag,
  Trash2,
  AlertTriangle,
  ArrowRightLeft,
} from 'lucide-react'

type PaymentType = 'cash' | 'noncash'

const PAYMENT_OPTIONS: { value: PaymentType; label: string; icon: React.ReactNode }[] = [
  { value: 'cash', label: 'Наличные', icon: <Banknote className="size-4" /> },
  { value: 'noncash', label: 'Безналичные', icon: <CreditCard className="size-4" /> },
]

interface OrderPaymentPanelProps {
  isHall: boolean
  subtotal: number
  totalWithService: number
  serviceAmount: number
  remainingAmount: number

  // Discount
  discountType: 'percent' | 'fixed' | null
  setDiscountType: (t: 'percent' | 'fixed' | null) => void
  discountValue: number
  setDiscountValue: (v: number) => void
  discountAmount: number
  setDiscountAmount: (a: number) => void
  discountReason: string
  setDiscountReason: (r: string) => void
  showDiscountForm: boolean
  setShowDiscountForm: (s: boolean) => void

  // Service
  includeService: boolean
  setIncludeService: (s: boolean) => void
  servicePercent: number
  setServicePercent: (p: number) => void

  // Accounts / payment selection
  accounts: FinancialAccount[]
  paymentType: PaymentType
  setPaymentType: (t: PaymentType) => void
  selectedAccountId: string
  setSelectedAccountId: (id: string) => void

  // Mixed payments
  payments: OrderPayment[]
  setPayments: React.Dispatch<React.SetStateAction<OrderPayment[]>>
  showAddPayment: boolean
  setShowAddPayment: (v: boolean) => void
  addPaymentMethod: PaymentType
  setAddPaymentMethod: (t: PaymentType) => void
  addPaymentAccountId: string
  setAddPaymentAccountId: (id: string) => void
  addPaymentAmount: string
  setAddPaymentAmount: (v: string) => void

  onPreCheck: () => void
}

export function OrderPaymentPanel(props: OrderPaymentPanelProps) {
  const {
    isHall,
    subtotal,
    totalWithService,
    serviceAmount,
    remainingAmount,
    discountType,
    setDiscountType,
    discountValue,
    setDiscountValue,
    discountAmount,
    setDiscountAmount,
    discountReason,
    setDiscountReason,
    showDiscountForm,
    setShowDiscountForm,
    includeService,
    setIncludeService,
    servicePercent,
    setServicePercent,
    accounts: allAccounts,
    paymentType,
    setPaymentType,
    selectedAccountId,
    setSelectedAccountId,
    payments,
    setPayments,
    showAddPayment,
    setShowAddPayment,
    addPaymentMethod,
    setAddPaymentMethod,
    addPaymentAccountId,
    setAddPaymentAccountId,
    addPaymentAmount,
    setAddPaymentAmount,
    onPreCheck,
  } = props

  // Отключённый счёт (миграция 063) не предлагаем к оплате — сервер такую
  // проводку всё равно отклонит с 409. Дальше по файлу `accounts` — уже
  // отфильтрованный список, отдельных проверок в пикерах не нужно.
  const accounts = useMemo(() => selectableAccounts(allAccounts), [allAccounts])

  // Порог одобрения скидки — настройка ресторана (default 10). Скидку ВЫШЕ него
  // бэк не проведёт без approved_by менеджера/владельца (orders_close.go).
  const { restaurant } = useAuth()
  const approvalThreshold = restaurant?.discountApprovalThreshold ?? 10

  return (
    <div className="space-y-3">
      {/* Pre-check + Discount */}
      <div className="space-y-2">
        {discountAmount > 0 && !showDiscountForm ? null : showDiscountForm ? null : (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onPreCheck}
              className="inline-flex items-center justify-center gap-2 rounded-xl border-2 border-border px-3 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              <FileText className="size-4" />
              Пре-чек
            </button>
            <button
              onClick={() => {
                setShowDiscountForm(true)
                setDiscountType('percent')
              }}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-border px-3 py-2.5 text-sm font-medium text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground transition-colors"
            >
              <Tag className="size-4" />
              Скидка
            </button>
          </div>
        )}

        {discountAmount > 0 && !showDiscountForm ? (
          <div className="flex items-center justify-between rounded-xl border border-border p-3">
            <div className="text-sm">
              <span className="font-medium text-red-600">
                Скидка: -{formatCurrency(discountAmount)}
              </span>
              {discountType === 'percent' && (
                <span className="text-muted-foreground ml-1">({discountValue}%)</span>
              )}
              {discountReason && (
                <span className="text-xs text-muted-foreground block">{discountReason}</span>
              )}
            </div>
            <button
              onClick={() => {
                setDiscountType(null)
                setDiscountValue(0)
                setDiscountAmount(0)
                setDiscountReason('')
              }}
              className="p-1 rounded-lg text-muted-foreground hover:bg-muted hover:text-red-500 transition-colors"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ) : showDiscountForm ? (
          <div className="rounded-xl border border-border p-3 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  setDiscountType('percent')
                  setDiscountValue(0)
                  setDiscountAmount(0)
                }}
                className={`py-2 rounded-lg text-sm font-medium border-2 transition-all ${
                  discountType === 'percent' ? 'border-primary bg-primary/5 text-primary' : 'border-border hover:border-muted-foreground/30'
                }`}
              >
                %
              </button>
              <button
                onClick={() => {
                  setDiscountType('fixed')
                  setDiscountValue(0)
                  setDiscountAmount(0)
                }}
                className={`py-2 rounded-lg text-sm font-medium border-2 transition-all ${
                  discountType === 'fixed' ? 'border-primary bg-primary/5 text-primary' : 'border-border hover:border-muted-foreground/30'
                }`}
              >
                TJS
              </button>
            </div>

            <input
              type="number"
              placeholder={discountType === 'percent' ? 'Процент (0-100)' : 'Сумма скидки'}
              value={discountValue || ''}
              onChange={e => {
                const v = Math.max(0, Number(e.target.value))
                if (discountType === 'percent') {
                  const clamped = Math.min(100, v)
                  setDiscountValue(clamped)
                  setDiscountAmount(dRound(dDiv(dMul(subtotal, clamped), 100)))
                } else {
                  const clamped = Math.min(subtotal, v)
                  setDiscountValue(clamped)
                  setDiscountAmount(clamped)
                }
              }}
              className="w-full py-2 px-3 rounded-lg border-2 border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />

            <input
              type="text"
              placeholder="Причина (необязательно)"
              value={discountReason}
              onChange={e => setDiscountReason(e.target.value)}
              className="w-full py-2 px-3 rounded-lg border-2 border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />

            {discountType === 'percent' && discountValue > approvalThreshold && (
              <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                <AlertTriangle className="size-3.5 shrink-0" />
                Скидка выше {approvalThreshold}% — требует одобрения менеджера
              </div>
            )}
            {discountType === 'fixed' && subtotal > 0 && (discountValue / subtotal) * 100 > approvalThreshold && (
              <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                <AlertTriangle className="size-3.5 shrink-0" />
                Скидка выше {approvalThreshold}% — требует одобрения менеджера
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => setShowDiscountForm(false)}
                className="flex-1 py-2 rounded-lg border-2 border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={() => {
                  if (discountValue > 0 && discountType) {
                    setShowDiscountForm(false)
                  }
                }}
                disabled={!discountValue || !discountType}
                className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                Применить
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Service-charge UI исключён из sidebar'а — % обслуживания берётся из
          настроек ресторана и применяется автоматически. Итоговая сумма
          (включая обслуживание) показана в OrderTotalsBlock выше; «К оплате»
          дублировал её, поэтому удалён. CTA «Закрыть и оплатить · сумма»
          в footer'е тоже показывает total. */}

      {/* Mixed payment section */}
      <div className="space-y-3">
        <h4 className="text-sm font-semibold">Оплата</h4>

        {payments.length > 0 && (
          <div className="space-y-1.5">
            {payments.map((p, idx) => (
              <div key={idx} className="flex items-center justify-between rounded-xl border border-border px-3 py-2.5">
                <div className="flex items-center gap-2 text-sm">
                  {p.method === 'cash' ? <Banknote className="size-4 text-muted-foreground" /> : <CreditCard className="size-4 text-muted-foreground" />}
                  <span className="font-medium">{p.method === 'cash' ? 'Наличные' : 'Безналичные'}</span>
                  {p.accountName && <span className="text-xs text-muted-foreground">({p.accountName})</span>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold">{formatCurrency(p.amount)}</span>
                  <button
                    onClick={() => setPayments(payments.filter((_, i) => i !== idx))}
                    className="p-1 rounded text-muted-foreground hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            ))}
            {remainingAmount > 0 && (
              <div className="text-sm text-amber-600 font-medium px-1">
                Оставшаяся сумма: {formatCurrency(remainingAmount)}
              </div>
            )}
            {remainingAmount <= 0 && (
              <div className="text-sm text-emerald-600 font-medium px-1">
                Оплата покрыта полностью
              </div>
            )}
          </div>
        )}

        {showAddPayment ? (
          <div className="rounded-xl border border-border p-3 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {PAYMENT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    setAddPaymentMethod(opt.value)
                    const targetType = opt.value === 'cash' ? 'cash' : 'bank'
                    const filtered = accounts.filter(a => a.type === targetType)
                    if (filtered.length > 0) setAddPaymentAccountId(filtered[0].id)
                  }}
                  className={`flex items-center justify-center gap-2 rounded-xl border-2 p-2.5 transition-all ${
                    addPaymentMethod === opt.value
                      ? 'border-primary bg-primary/5 text-primary'
                      : 'border-border hover:border-muted-foreground/30'
                  }`}
                >
                  {opt.icon}
                  <span className="text-xs font-medium">{opt.label}</span>
                </button>
              ))}
            </div>

            {(() => {
              const targetType = addPaymentMethod === 'cash' ? 'cash' : 'bank'
              const filtered = accounts.filter(a => a.type === targetType)
              if (filtered.length <= 1) {
                return filtered.length === 1 ? (
                  <div className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm">
                    {targetType === 'cash' ? <Wallet className="size-4 text-muted-foreground" /> : <Building2 className="size-4 text-muted-foreground" />}
                    <span className="font-medium">{filtered[0].name}</span>
                    <CheckCircle2 className="size-4 text-primary ml-auto" />
                  </div>
                ) : null
              }
              return (
                <div className="space-y-1.5">
                  {filtered.map((acc) => (
                    <button
                      key={acc.id}
                      onClick={() => setAddPaymentAccountId(acc.id)}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl border-2 transition-all text-left text-sm ${
                        addPaymentAccountId === acc.id
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-muted-foreground/30'
                      }`}
                    >
                      {acc.type === 'cash' ? <Wallet className="size-3.5 text-muted-foreground" /> : <Building2 className="size-3.5 text-muted-foreground" />}
                      <span className="font-medium truncate">{acc.name}</span>
                      {addPaymentAccountId === acc.id && <CheckCircle2 className="size-3.5 text-primary ml-auto" />}
                    </button>
                  ))}
                </div>
              )
            })()}

            <input
              type="number"
              placeholder={`Сумма (макс. ${formatCurrency(remainingAmount)})`}
              value={addPaymentAmount}
              onChange={e => setAddPaymentAmount(e.target.value)}
              className="w-full py-2 px-3 rounded-lg border-2 border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setShowAddPayment(false)
                  setAddPaymentAmount('')
                }}
                className="flex-1 py-2 rounded-lg border-2 border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={() => {
                  const amt = addPaymentAmount ? Number(addPaymentAmount) : remainingAmount
                  if (amt <= 0) return
                  const accId = addPaymentAccountId || (() => {
                    const targetType = addPaymentMethod === 'cash' ? 'cash' : 'bank'
                    const filtered = accounts.filter(a => a.type === targetType)
                    return filtered[0]?.id ?? ''
                  })()
                  const acc = accounts.find(a => a.id === accId)
                  const pm: 'cash' | 'card' = addPaymentMethod === 'cash' ? 'cash' : 'card'
                  setPayments([...payments, { method: pm, amount: amt, accountId: accId, accountName: acc?.name }])
                  setShowAddPayment(false)
                  setAddPaymentAmount('')
                }}
                disabled={!addPaymentAccountId && accounts.filter(a => a.type === (addPaymentMethod === 'cash' ? 'cash' : 'bank')).length === 0}
                className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                Добавить
              </button>
            </div>
          </div>
        ) : (
          payments.length === 0 ? (
            <>
              {/* Высота как у «Пре-чек / Скидка» сверху (py-2.5 + border) —
                  раньше было p-3.5 + border-2 (~50px), теперь ~36px. */}
              <div className="grid grid-cols-2 gap-2">
                {PAYMENT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setPaymentType(opt.value)}
                    className={`flex items-center justify-center gap-2 rounded-xl border-2 px-3 py-2.5 transition-all ${
                      paymentType === opt.value
                        ? 'border-primary bg-primary/5 text-primary'
                        : 'border-border hover:border-muted-foreground/30'
                    }`}
                  >
                    {opt.icon}
                    <span className="text-sm font-medium">{opt.label}</span>
                  </button>
                ))}
              </div>

              {(() => {
                const targetType = paymentType === 'cash' ? 'cash' : 'bank'
                const filtered = accounts.filter(a => a.type === targetType)
                if (filtered.length === 1 && selectedAccountId !== filtered[0].id) {
                  setTimeout(() => setSelectedAccountId(filtered[0].id), 0)
                }
                if (filtered.length <= 1) {
                  return filtered.length === 1 ? (
                    <div className="flex items-center gap-2 rounded-xl border border-border px-3 py-2.5 text-sm">
                      {targetType === 'cash' ? <Wallet className="size-4 text-muted-foreground" /> : <Building2 className="size-4 text-muted-foreground" />}
                      <span className="font-medium">{filtered[0].name}</span>
                      <CheckCircle2 className="size-4 text-primary ml-auto" />
                    </div>
                  ) : null
                }
                return (
                  <div className="space-y-3">
                    <h4 className="text-sm font-semibold">
                      {paymentType === 'cash' ? 'Касса' : 'Банковский счёт'}
                    </h4>
                    <div className="space-y-1.5">
                      {filtered.map((acc) => (
                        <button
                          key={acc.id}
                          onClick={() => setSelectedAccountId(acc.id)}
                          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border-2 transition-all text-left ${
                            selectedAccountId === acc.id
                              ? 'border-primary bg-primary/5'
                              : 'border-border hover:border-muted-foreground/30'
                          }`}
                        >
                          {acc.type === 'cash' ? (
                            <Wallet className="size-4 text-muted-foreground shrink-0" />
                          ) : (
                            <Building2 className="size-4 text-muted-foreground shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{acc.name}</p>
                          </div>
                          {selectedAccountId === acc.id && (
                            <CheckCircle2 className="size-4 text-primary shrink-0" />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })()}

              <button
                onClick={() => {
                  setShowAddPayment(true)
                  setAddPaymentMethod('cash')
                  const cashAcc = accounts.find(a => a.type === 'cash')
                  if (cashAcc) setAddPaymentAccountId(cashAcc.id)
                  setAddPaymentAmount(String(totalWithService))
                }}
                className="w-full py-2 rounded-xl border-2 border-dashed border-border text-xs font-medium text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground transition-colors flex items-center justify-center gap-1.5"
              >
                <ArrowRightLeft className="size-3.5" />
                Смешанная оплата (нал + безнал)
              </button>
            </>
          ) : (
            <button
              onClick={() => {
                setShowAddPayment(true)
                setAddPaymentMethod('cash')
                const cashAcc = accounts.find(a => a.type === 'cash')
                if (cashAcc) setAddPaymentAccountId(cashAcc.id)
                setAddPaymentAmount(String(remainingAmount))
              }}
              className="w-full py-2.5 rounded-xl border-2 border-dashed border-border text-sm font-medium text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground transition-colors"
            >
              + Добавить оплату
            </button>
          )
        )}
      </div>
    </div>
  )
}
