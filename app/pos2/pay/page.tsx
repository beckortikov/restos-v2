'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, RefreshCw, Banknote, CreditCard, X, ArrowLeft, SquareSplitHorizontal, UtensilsCrossed, ShoppingBag, Printer } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import {
  fetchTables, fetchOrders, fetchActiveShift, fetchFinancialAccounts, closeOrderWithPayment, printPreBill,
} from '@/lib/queries'
import { formatCurrency, calcLineCogs } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { dMul, dDiv, dAdd, dSub, dRound } from '@/lib/decimal'
import type { Order, Table, FinancialAccount, OrderPayment } from '@/lib/types'

// Phase 2.4/2.5: оплата открытого заказа (замыкает dine-in цикл) + смешанная
// оплата (нал+безнал). Бэк строго проверяет sum(payments)==total_with_service
// (допуск 0.01), поэтому payable считаем как subtotal + сервис (для зала),
// а части бьём точной decimal-разницей (card = payable − cash).
export default function PosV2Pay() {
  const navigate = useNavigate()
  const { user, restaurant } = useAuth()

  const [orders, setOrders] = useState<Order[]>([])
  const [tables, setTables] = useState<Table[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [target, setTarget] = useState<Order | null>(null)
  const [mode, setMode] = useState<'pick' | 'mixed'>('pick')
  const [cashStr, setCashStr] = useState('')
  const [paying, setPaying] = useState(false)
  const payingRef = useRef(false)

  const cashAcc = useMemo(() => accounts.find(a => a.type === 'cash') ?? accounts[0], [accounts])
  const cardAcc = useMemo(() => accounts.find(a => a.type !== 'cash') ?? accounts[0], [accounts])
  const canMix = !!cashAcc && !!cardAcc && cashAcc.id !== cardAcc.id

  const tableNo = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tables) m.set(t.id, t.number)
    return m
  }, [tables])

  // Сумма к оплате = subtotal + сервис (только зал; бэк считает так же).
  const payableOf = useCallback((o: Order): number => {
    const base = o.subtotal ?? o.total
    const sp = o.type === 'hall' ? (restaurant?.servicePercent ?? 0) : 0
    return sp > 0 ? dRound(dAdd(base, dMul(base, dDiv(sp, 100)))) : base
  }, [restaurant])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const ts = await fetchTables().catch(() => [] as Table[])
      setTables(ts)
      const ids = ts.flatMap(t => t.currentOrderIds).filter(Boolean)
      if (ids.length === 0) { setOrders([]); return }
      const os = await fetchOrders({ ids, slim: false }).catch(() => [] as Order[])
      setOrders(os.filter(o => o.status !== 'done' && o.status !== 'cancelled'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    fetchFinancialAccounts().then(setAccounts).catch(() => {})
  }, [load])

  function open(o: Order) {
    setTarget(o)
    setMode('pick')
    setCashStr('')
  }

  function labelOf(o: Order): string {
    return o.type === 'hall' ? `Стол ${o.tableId ? (tableNo.get(o.tableId) ?? '—') : '—'}` : 'С собой'
  }
  function cogsOf(o: Order): number {
    return (o.items ?? []).reduce((s, i) => s + calcLineCogs(i.cogs || 0, i.qty, i.unit, i.unitSize), 0)
  }

  // Полная оплата одним методом (бэк сам пересчитывает суммы).
  async function payFull(o: Order, method: 'cash' | 'card') {
    if (payingRef.current) return
    payingRef.current = true; setPaying(true)
    try {
      const shift = await fetchActiveShift()
      if (!shift) { toast.error('Откройте кассовую смену перед оплатой'); return }
      const acc = method === 'cash' ? cashAcc : cardAcc
      const accId = (method === 'cash' && (shift as { accountId?: string }).accountId)
        ? (shift as { accountId?: string }).accountId : acc?.id
      const sp = o.type === 'hall' ? (restaurant?.servicePercent ?? 0) : 0
      await closeOrderWithPayment(o.id, method, o.tableId || null, o.subtotal ?? o.total, cogsOf(o), user?.id, accId, acc?.name, sp, 0, payableOf(o))
      toast.success(`Оплачено · ${formatCurrency(payableOf(o))} · ${method === 'cash' ? 'Наличные' : 'Безналичные'}`, { description: 'Чек отправлен на печать' })
      setTarget(null); await load()
    } catch (e) {
      toast.error(`Оплата не прошла: ${humanizeError(e)}`)
    } finally {
      payingRef.current = false; setPaying(false)
    }
  }

  // Смешанная: нал + безнал. sum обязан == total_with_service (допуск бэка 0.01).
  async function payMixed(o: Order, cash: number, card: number) {
    if (payingRef.current) return
    const parts: OrderPayment[] = []
    if (cash > 0) parts.push({ method: 'cash', amount: cash, accountId: cashAcc?.id ?? '', accountName: cashAcc?.name })
    if (card > 0) parts.push({ method: 'card', amount: card, accountId: cardAcc?.id ?? '', accountName: cardAcc?.name })
    if (parts.length === 0 || parts.some(p => !p.accountId)) { toast.error('Нет счетов для смешанной оплаты'); return }
    payingRef.current = true; setPaying(true)
    try {
      const shift = await fetchActiveShift()
      if (!shift) { toast.error('Откройте кассовую смену перед оплатой'); return }
      const sp = o.type === 'hall' ? (restaurant?.servicePercent ?? 0) : 0
      await closeOrderWithPayment(
        o.id, parts[0].method, o.tableId || null, o.subtotal ?? o.total, cogsOf(o), user?.id,
        undefined, undefined, sp, 0, payableOf(o), 0, undefined, undefined, undefined, undefined, parts,
      )
      toast.success(`Оплачено · ${formatCurrency(payableOf(o))}`, { description: `Наличные ${formatCurrency(cash)} + Безнал ${formatCurrency(card)} · чек на печать` })
      setTarget(null); await load()
    } catch (e) {
      toast.error(`Оплата не прошла: ${humanizeError(e)}`)
    } finally {
      payingRef.current = false; setPaying(false)
    }
  }

  const [printing, setPrinting] = useState(false)
  async function printPre(o: Order) {
    if (printing) return
    setPrinting(true)
    try {
      await printPreBill(o.id)
      toast.success('Пре-чек отправлен на печать')
    } catch (e) {
      toast.error(`Не удалось напечатать пре-чек: ${humanizeError(e)}`)
    } finally {
      setPrinting(false)
    }
  }

  const payable = target ? payableOf(target) : 0
  const cashNum = Math.max(0, Math.min(payable, parseFloat(cashStr.replace(',', '.').replace(/\s/g, '')) || 0))
  const cardNum = dSub(payable, cashNum)

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>Заказы к оплате</span>
        <div className="flex-1" />
        <button onClick={() => load()} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <RefreshCw style={{ width: 'clamp(1.05rem,1.3vw,1.3rem)', height: 'clamp(1.05rem,1.3vw,1.3rem)', color: 'var(--pv-text-2)' }} className={loading ? 'animate-spin' : ''} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Обновить</span>
        </button>
      </div>

      {/* Orders grid */}
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'var(--pv-gap) var(--pv-pad-x) var(--pv-pad-x)' }}>
        {loading ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Загрузка заказов…</div>
        ) : orders.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2" style={{ color: 'var(--pv-text-3)' }}>
            <UtensilsCrossed style={{ width: '2.5rem', height: '2.5rem', opacity: 0.5 }} />
            <span style={{ fontSize: 'var(--pv-ctl)' }}>Нет открытых заказов</span>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(12rem, 18vw, 16rem), 1fr))' }}>
            {orders.map(o => {
              const hall = o.type === 'hall'
              const Icon = hall ? UtensilsCrossed : ShoppingBag
              const n = (o.items ?? []).length
              return (
                <button key={o.id} onClick={() => open(o)} className="flex flex-col rounded-2xl text-left active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', boxShadow: '0 2px 10px rgba(0,0,0,0.05)', padding: 'clamp(1rem,1.5vw,1.4rem)', gap: 'clamp(0.5rem,0.9vw,0.8rem)' }}>
                  <div className="flex items-center gap-2">
                    <div className="rounded-xl flex items-center justify-center" style={{ background: 'var(--pv-brand-soft)', width: 'clamp(2.2rem,3vw,2.75rem)', height: 'clamp(2.2rem,3vw,2.75rem)' }}>
                      <Icon style={{ width: '55%', height: '55%', color: 'var(--pv-brand)' }} />
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold truncate" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.4vw,1.25rem)' }}>{labelOf(o)}</div>
                      <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{n} поз.</div>
                    </div>
                  </div>
                  <div className="font-bold mt-auto" style={{ color: 'var(--pv-brand)', fontSize: 'clamp(1.2rem,1.7vw,1.6rem)' }}>{formatCurrency(payableOf(o))}</div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Pay overlay */}
      {target && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => { if (!paying) setTarget(null) }}>
          <div className="rounded-3xl overflow-hidden" style={{ background: 'var(--pv-card)', width: 'clamp(22rem, 44vw, 36rem)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b" style={{ padding: 'clamp(1rem,1.6vw,1.4rem) clamp(1.2rem,1.8vw,1.6rem)', borderColor: 'var(--pv-border)' }}>
              <div className="flex items-center gap-2">
                {mode === 'mixed' && (
                  <button onClick={() => setMode('pick')} className="rounded-lg" style={{ padding: '0.3rem' }}><ArrowLeft style={{ color: 'var(--pv-text-2)' }} /></button>
                )}
                <span className="font-bold" style={{ fontSize: 'clamp(1.1rem,1.6vw,1.4rem)', color: 'var(--pv-text)' }}>
                  {mode === 'mixed' ? 'Смешанная' : 'Оплата'} · {labelOf(target)} · {formatCurrency(payable)}
                </span>
              </div>
              <button onClick={() => { if (!paying) setTarget(null) }} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>

            <div style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)' }}>
              {mode === 'pick' ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <button disabled={paying} onClick={() => payFull(target, 'cash')} className="flex flex-col items-center justify-center gap-2 rounded-2xl disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ padding: 'clamp(1.1rem,1.8vw,1.6rem)', background: 'var(--pv-free-soft)', color: 'var(--pv-free-text)' }}>
                      <Banknote style={{ width: '2rem', height: '2rem' }} />
                      <span className="font-bold" style={{ fontSize: 'clamp(1rem,1.3vw,1.15rem)' }}>Наличные</span>
                    </button>
                    <button disabled={paying} onClick={() => payFull(target, 'card')} className="flex flex-col items-center justify-center gap-2 rounded-2xl disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ padding: 'clamp(1.1rem,1.8vw,1.6rem)', background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)' }}>
                      <CreditCard style={{ width: '2rem', height: '2rem' }} />
                      <span className="font-bold" style={{ fontSize: 'clamp(1rem,1.3vw,1.15rem)' }}>Безналичные</span>
                    </button>
                  </div>
                  {canMix && (
                    <button disabled={paying} onClick={() => { setMode('mixed'); setCashStr('') }} className="w-full flex items-center justify-center gap-2 rounded-2xl border disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ marginTop: '0.75rem', padding: 'clamp(0.8rem,1.2vw,1rem)', borderColor: 'var(--pv-border)', color: 'var(--pv-text-2)' }}>
                      <SquareSplitHorizontal style={{ width: '1.25rem', height: '1.25rem' }} />
                      <span className="font-semibold" style={{ fontSize: 'var(--pv-ctl)' }}>Смешанная (нал + безнал)</span>
                    </button>
                  )}
                  <button disabled={printing} onClick={() => printPre(target)} className="w-full flex items-center justify-center gap-2 rounded-2xl disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ marginTop: '0.75rem', padding: 'clamp(0.7rem,1vw,0.9rem)', background: 'var(--pv-bg)', color: 'var(--pv-text-2)' }}>
                    <Printer style={{ width: '1.15rem', height: '1.15rem' }} />
                    <span className="font-semibold" style={{ fontSize: 'var(--pv-ctl)' }}>{printing ? 'Печать…' : 'Печать пре-чека'}</span>
                  </button>
                </>
              ) : (
                <div className="flex flex-col" style={{ gap: '0.9rem' }}>
                  <div>
                    <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.4rem' }}>Наличными</div>
                    <div className="flex items-center rounded-xl border" style={{ borderColor: 'var(--pv-brand)', borderWidth: '2px', padding: '0.7rem 1rem' }}>
                      <input autoFocus inputMode="decimal" value={cashStr} onChange={e => setCashStr(e.target.value)} placeholder="0" className="flex-1 min-w-0 bg-transparent outline-none font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.2rem,1.8vw,1.6rem)' }} />
                      <span className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>TJS</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.7rem 1rem' }}>
                    <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Безналичными (остаток)</span>
                    <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.05rem,1.5vw,1.3rem)' }}>{formatCurrency(cardNum)}</span>
                  </div>
                  <button disabled={paying} onClick={() => payMixed(target, cashNum, cardNum)} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-40 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                    Оплатить {formatCurrency(payable)}
                  </button>
                </div>
              )}
              {paying && <div className="text-center" style={{ marginTop: '1rem', color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>Проводим оплату…</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
