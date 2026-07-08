'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Banknote, CreditCard, SquareSplitHorizontal, Printer, ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { closeOrderWithPayment, printPreBill, fetchActiveShift } from '@/lib/queries'
import { V4Error } from '@/lib/api'
import { formatCurrency, calcLineCogs } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { dSub } from '@/lib/decimal'
import { discountAmount, payable as calcPayable, type DiscountType } from '@/lib/pos-v2/pay'
import type { Order, FinancialAccount, OrderPayment } from '@/lib/types'

// Единая панель оплаты заказа (сайдбар зала + /pos2/pay). Нал / Безнал с выбором
// счёта-кошелька / Смешанная (нал+безнал по счетам) / скидка / обслуживание /
// пре-чек. Бэк пересчитывает суммы; клиент шлёт метод, account_id, servicePercent,
// discountType/Value. payable = (subtotal − скидка) + сервис (зал).
export function PaymentPanel({ order, servicePercent, accounts, userId, onPaid }: {
  order: Order
  servicePercent: number
  accounts: FinancialAccount[]
  userId?: string
  onPaid: () => void
}) {
  const [serviceOn, setServiceOn] = useState(order.type === 'hall')
  const [discType, setDiscType] = useState<DiscountType>('none')
  const [discVal, setDiscVal] = useState('')
  const [mode, setMode] = useState<'pick' | 'mixed'>('pick')
  const [cashStr, setCashStr] = useState('')
  const [paying, setPaying] = useState(false)
  const [printing, setPrinting] = useState(false)
  const payingRef = useRef(false)

  const cashAcc = useMemo(() => accounts.find(a => a.type === 'cash') ?? accounts[0], [accounts])
  const nonCash = useMemo(() => accounts.filter(a => a.type !== 'cash'), [accounts])
  const [cardAccId, setCardAccId] = useState('')
  useEffect(() => { if (!cardAccId && nonCash.length) setCardAccId(nonCash[0].id) }, [nonCash, cardAccId])
  const cardAcc = useMemo(() => nonCash.find(a => a.id === cardAccId) ?? nonCash[0], [nonCash, cardAccId])
  const canMix = !!cashAcc && !!cardAcc && cashAcc.id !== cardAcc.id

  // База = order.total (сумма позиций С модификаторами). НЕ order.subtotal:
  // subtotal (computeSubtotal на бэке) исключает модификаторы, а бэк при
  // закрытии считает скидку/сервис именно от order.Total (orders_close.go).
  // Иначе одиночная оплата занижается, а смешанная падает на sum(payments)≠total.
  const base = order.total
  const discValNum = Math.max(0, parseFloat(discVal.replace(',', '.').replace(/\s/g, '')) || 0)
  const discAmt = useMemo(() => discountAmount(base, discType, discValNum), [base, discType, discValNum])
  const sp = (order.type === 'hall' && serviceOn) ? servicePercent : 0
  const payable = calcPayable(base, discAmt, sp)
  const cashNum = Math.max(0, Math.min(payable, parseFloat(cashStr.replace(',', '.').replace(/\s/g, '')) || 0))
  const cardNum = dSub(payable, cashNum)

  function cogsOf(o: Order): number {
    return (o.items ?? []).reduce((s, i) => s + calcLineCogs(i.cogs || 0, i.qty, i.unit, i.unitSize), 0)
  }
  const discArgs = () => [
    discType !== 'none' && discAmt > 0 ? discAmt : undefined,
    discType !== 'none' && discAmt > 0 ? discType : undefined,
    discType !== 'none' && discAmt > 0 ? discValNum : undefined,
  ] as const

  function handleErr(e: unknown) {
    const code = e instanceof V4Error ? (e.envelope() as { code?: string } | null)?.code : undefined
    if (code === 'DISCOUNT_REQUIRES_APPROVAL') {
      toast.error('Скидка ≥10% требует одобрения менеджера', { description: 'Уменьшите скидку или проведите через менеджера.', duration: 6000 })
      return
    }
    toast.error(`Оплата не прошла: ${humanizeError(e)}`)
  }

  // Наличные зачисляем на cash-счёт смены (если задан), иначе первый cash-счёт.
  function cashAccount(shift: unknown): { id?: string; name?: string } {
    const s = shift as { accountId?: string; accountName?: string }
    return s.accountId ? { id: s.accountId, name: s.accountName } : { id: cashAcc?.id, name: cashAcc?.name }
  }

  async function payFull(method: 'cash' | 'card') {
    if (payingRef.current) return
    if (method === 'card' && !cardAcc) { toast.error('Нет безналичного счёта — заведите его в настройках'); return }
    payingRef.current = true; setPaying(true)
    try {
      const shift = await fetchActiveShift()
      if (!shift) { toast.error('Откройте кассовую смену перед оплатой'); return }
      const acc = method === 'cash' ? cashAccount(shift) : { id: cardAcc?.id, name: cardAcc?.name }
      const [dA, dT, dV] = discArgs()
      await closeOrderWithPayment(order.id, method, order.tableId || null, base, cogsOf(order), userId, acc.id, acc.name, sp, 0, payable, 0, dA, dT, dV)
      toast.success(`Оплачено · ${formatCurrency(payable)} · ${method === 'cash' ? 'Наличные' : 'Безналичные'}`, { description: 'Чек отправлен на печать' })
      onPaid()
    } catch (e) { handleErr(e) }
    finally { payingRef.current = false; setPaying(false) }
  }

  async function payMixed() {
    if (payingRef.current) return
    payingRef.current = true; setPaying(true)
    try {
      const shift = await fetchActiveShift()
      if (!shift) { toast.error('Откройте кассовую смену перед оплатой'); return }
      const cash = cashAccount(shift)
      const parts: OrderPayment[] = []
      if (cashNum > 0) parts.push({ method: 'cash', amount: cashNum, accountId: cash.id ?? '', accountName: cash.name })
      if (cardNum > 0) parts.push({ method: 'card', amount: cardNum, accountId: cardAcc?.id ?? '', accountName: cardAcc?.name })
      if (parts.length === 0 || parts.some(p => !p.accountId)) { toast.error('Нет счетов для смешанной оплаты'); return }
      const [dA, dT, dV] = discArgs()
      await closeOrderWithPayment(order.id, parts[0].method, order.tableId || null, base, cogsOf(order), userId, undefined, undefined, sp, 0, payable, 0, dA, dT, dV, undefined, parts)
      toast.success(`Оплачено · ${formatCurrency(payable)}`, { description: `Наличные ${formatCurrency(cashNum)} + Безнал ${formatCurrency(cardNum)}` })
      onPaid()
    } catch (e) { handleErr(e) }
    finally { payingRef.current = false; setPaying(false) }
  }

  async function preBill() {
    if (printing) return
    setPrinting(true)
    try { await printPreBill(order.id); toast.success('Пре-чек отправлен на печать') }
    catch (e) { toast.error(`Не удалось: ${humanizeError(e)}`) }
    finally { setPrinting(false) }
  }

  return (
    <div style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)' }}>
      {mode === 'mixed' ? (
        <div className="flex flex-col" style={{ gap: '0.9rem' }}>
          <button onClick={() => setMode('pick')} className="flex items-center gap-1.5 font-semibold" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}><ArrowLeft style={{ width: '1.1rem', height: '1.1rem' }} />Назад</button>
          <div>
            <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.4rem' }}>Наличными</div>
            <div className="flex items-center rounded-xl border" style={{ borderColor: 'var(--pv-brand)', borderWidth: '2px', padding: '0.7rem 1rem' }}>
              <input autoFocus inputMode="decimal" value={cashStr} onChange={e => setCashStr(e.target.value)} placeholder="0" className="flex-1 min-w-0 bg-transparent outline-none font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.2rem,1.8vw,1.6rem)' }} />
              <span className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>TJS</span>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.7rem 1rem' }}>
            <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Безналичными{cardAcc ? ` · ${cardAcc.name}` : ''}</span>
            <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.05rem,1.5vw,1.3rem)' }}>{formatCurrency(cardNum)}</span>
          </div>
          <button disabled={paying} onClick={payMixed} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-40 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
            Оплатить {formatCurrency(payable)}
          </button>
        </div>
      ) : (
        <>
          {/* Обслуживание */}
          {order.type === 'hall' && servicePercent > 0 && (
            <div className="flex items-center justify-between" style={{ marginBottom: '0.9rem' }}>
              <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Обслуживание {servicePercent}%</span>
              <button onClick={() => setServiceOn(v => !v)} className="rounded-full transition-colors" style={{ width: '3.2rem', height: '1.9rem', background: serviceOn ? 'var(--pv-brand)' : '#d8d3ca', padding: '3px', display: 'flex', justifyContent: serviceOn ? 'flex-end' : 'flex-start', alignItems: 'center' }}>
                <span className="rounded-full" style={{ width: '1.4rem', height: '1.4rem', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.25)' }} />
              </button>
            </div>
          )}
          {/* Скидка */}
          <div style={{ marginBottom: '0.9rem' }}>
            <div className="flex items-center gap-2" style={{ marginBottom: discType !== 'none' ? '0.5rem' : 0 }}>
              <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Скидка</span>
              <div className="flex rounded-lg border" style={{ borderColor: 'var(--pv-border)', padding: '2px', gap: '2px', marginLeft: 'auto' }}>
                {(['none', 'percent', 'fixed'] as const).map(v => { const on = discType === v; const l = v === 'none' ? 'Нет' : v === 'percent' ? '%' : 'TJS'; return (
                  <button key={v} onClick={() => { setDiscType(v); if (v === 'none') setDiscVal('') }} className="rounded-md font-semibold" style={{ background: on ? 'var(--pv-brand)' : 'transparent', color: on ? '#fff' : 'var(--pv-text-2)', padding: '0.35rem 0.7rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{l}</button>
                ) })}
              </div>
            </div>
            {discType !== 'none' && (
              <div className="flex items-center gap-2">
                <div className="flex items-center rounded-xl border flex-1 min-w-0" style={{ borderColor: 'var(--pv-border)', padding: '0.5rem 0.8rem' }}>
                  <input inputMode="decimal" value={discVal} onChange={e => setDiscVal(e.target.value)} placeholder="0" className="flex-1 min-w-0 bg-transparent outline-none font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }} />
                  <span style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{discType === 'percent' ? '%' : 'TJS'}</span>
                </div>
                {discAmt > 0 && <span className="font-semibold whitespace-nowrap" style={{ color: 'var(--pv-occ-text)', fontSize: 'var(--pv-ctl)' }}>−{formatCurrency(discAmt)}</span>}
              </div>
            )}
          </div>
          {/* Итог */}
          <div className="flex items-center justify-between rounded-xl" style={{ background: 'var(--pv-brand-soft)', padding: '0.6rem 1rem', marginBottom: '0.9rem' }}>
            <span className="font-bold" style={{ color: 'var(--pv-brand)', fontSize: 'var(--pv-ctl)' }}>К оплате</span>
            <span className="font-bold" style={{ color: 'var(--pv-brand)', fontSize: 'clamp(1.2rem,1.7vw,1.6rem)' }}>{formatCurrency(payable)}</span>
          </div>
          {/* Выбор кошелька */}
          {nonCash.length > 1 && (
            <div style={{ marginBottom: '0.9rem' }}>
              <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.45rem' }}>Счёт для безнала</div>
              <div className="flex flex-wrap gap-2">
                {nonCash.map(a => { const on = a.id === cardAccId; return (
                  <button key={a.id} onClick={() => setCardAccId(a.id)} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.35rem 0.85rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{a.name}</button>
                ) })}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <button disabled={paying} onClick={() => payFull('cash')} className="flex flex-col items-center justify-center gap-2 rounded-2xl disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ padding: 'clamp(1rem,1.6vw,1.5rem)', background: 'var(--pv-free-soft)', color: 'var(--pv-free-text)' }}>
              <Banknote style={{ width: '1.9rem', height: '1.9rem' }} /><span className="font-bold" style={{ fontSize: 'clamp(1rem,1.3vw,1.15rem)' }}>Наличные</span>
            </button>
            <button disabled={paying} onClick={() => payFull('card')} className="flex flex-col items-center justify-center gap-2 rounded-2xl disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ padding: 'clamp(1rem,1.6vw,1.5rem)', background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)' }}>
              <CreditCard style={{ width: '1.9rem', height: '1.9rem' }} /><span className="font-bold" style={{ fontSize: 'clamp(1rem,1.3vw,1.15rem)' }}>Безналичные</span>
            </button>
          </div>
          {canMix && (
            <button disabled={paying} onClick={() => { setMode('mixed'); setCashStr('') }} className="w-full flex items-center justify-center gap-2 rounded-2xl border disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ marginTop: '0.75rem', padding: 'clamp(0.8rem,1.2vw,1rem)', borderColor: 'var(--pv-border)', color: 'var(--pv-text-2)' }}>
              <SquareSplitHorizontal style={{ width: '1.25rem', height: '1.25rem' }} /><span className="font-semibold" style={{ fontSize: 'var(--pv-ctl)' }}>Смешанная (нал + безнал)</span>
            </button>
          )}
          <button disabled={printing} onClick={preBill} className="w-full flex items-center justify-center gap-2 rounded-2xl disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ marginTop: '0.75rem', padding: 'clamp(0.7rem,1vw,0.9rem)', background: 'var(--pv-bg)', color: 'var(--pv-text-2)' }}>
            <Printer style={{ width: '1.15rem', height: '1.15rem' }} /><span className="font-semibold" style={{ fontSize: 'var(--pv-ctl)' }}>{printing ? 'Печать…' : 'Печать пре-чека'}</span>
          </button>
        </>
      )}
      {paying && <div className="text-center" style={{ marginTop: '1rem', color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>Проводим оплату…</div>}
    </div>
  )
}
