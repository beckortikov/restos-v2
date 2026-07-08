'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, RefreshCw, Wallet, ArrowDownToLine, ArrowUpFromLine, ReceiptText, Lock, X, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import {
  fetchActiveShift, fetchShiftRevenue, fetchShiftOperations, fetchFinancialAccounts,
  openShift, closeShift, addShiftOperation, createShiftExpense,
} from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { dSum, dAdd, dSub } from '@/lib/decimal'
import { humanizeError } from '@/lib/errors'
import type { CashShift, CashShiftOperation, FinancialAccount } from '@/lib/types'

const EXPENSE_CATS = ['Закупка продуктов', 'Зарплата', 'Ремонт', 'Транспорт', 'Хозтовары', 'Прочие расходы']
type Action = 'cash_in' | 'cash_out' | 'expense' | 'close'
const num = (s: string) => Math.max(0, parseFloat(s.replace(',', '.').replace(/\s/g, '')) || 0)

export default function PosV2Shift() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [shift, setShift] = useState<CashShift | null>(null)
  const [rev, setRev] = useState({ cashRevenue: 0, cardRevenue: 0, ordersCount: 0, avgCheck: 0 })
  const [ops, setOps] = useState<CashShiftOperation[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [openBal, setOpenBal] = useState('')
  const [action, setAction] = useState<Action | null>(null)
  const [amt, setAmt] = useState('')
  const [cat, setCat] = useState(EXPENSE_CATS[0])
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const cashAcc = useMemo(() => accounts.find(a => a.type === 'cash') ?? accounts[0], [accounts])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const active = await fetchActiveShift().catch(() => null)
      setShift(active)
      if (active) {
        const [r, o] = await Promise.all([
          fetchShiftRevenue(active.id).catch(() => rev),
          fetchShiftOperations(active.id).catch(() => [] as CashShiftOperation[]),
        ])
        setRev(r); setOps(o)
      } else { setOps([]) }
    } finally { setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    load()
    fetchFinancialAccounts().then(setAccounts).catch(() => {})
  }, [load])

  const cashIn = useMemo(() => dSum(ops.filter(o => o.type === 'cash_in').map(o => Number(o.amount))), [ops])
  const withdraw = useMemo(() => dSum(ops.filter(o => o.type === 'cash_out' && !o.category).map(o => Number(o.amount))), [ops])
  const expenses = useMemo(() => dSum(ops.filter(o => o.type === 'cash_out' && !!o.category).map(o => Number(o.amount))), [ops])
  const openingBalance = shift?.openingBalance ?? 0
  const expected = useMemo(
    () => dSub(dSub(dAdd(dAdd(openingBalance, rev.cashRevenue), cashIn), withdraw), expenses),
    [openingBalance, rev.cashRevenue, cashIn, withdraw, expenses],
  )

  const duration = useMemo(() => {
    if (!shift?.openedAt) return ''
    const ms = Date.now() - new Date(shift.openedAt).getTime()
    const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000)
    return `${h}ч ${m}м`
  }, [shift])

  async function doOpen() {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    try {
      await openShift(user?.id ?? '', num(openBal), cashAcc?.id)
      toast.success('Смена открыта'); setOpenBal(''); await load()
    } catch (e) { toast.error(`Не удалось открыть: ${humanizeError(e)}`) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function submitAction() {
    if (busyRef.current || !shift || !action) return
    if (action !== 'close' && num(amt) <= 0) { toast.error('Укажите сумму'); return }
    busyRef.current = true; setBusy(true)
    try {
      if (action === 'cash_in') await addShiftOperation(shift.id, 'cash_in', num(amt), desc)
      else if (action === 'cash_out') await addShiftOperation(shift.id, 'cash_out', num(amt), desc)
      else if (action === 'expense') await createShiftExpense(shift.id, num(amt), cat, desc)
      else if (action === 'close') { await closeShift(shift.id, user?.id ?? '', amt ? num(amt) : expected); toast.success('Смена закрыта'); setAction(null); await load(); return }
      toast.success(action === 'cash_in' ? 'Внесение проведено' : action === 'cash_out' ? 'Изъятие проведено' : 'Расход проведён')
      setAction(null); setAmt(''); setDesc(''); await load()
    } catch (e) { toast.error(`Ошибка: ${humanizeError(e)}`) }
    finally { busyRef.current = false; setBusy(false) }
  }

  function openAction(a: Action) {
    setAction(a); setDesc(''); setCat(EXPENSE_CATS[0])
    setAmt(a === 'close' ? String(expected) : '')
  }

  const closeDiff = action === 'close' ? dSub(amt ? num(amt) : expected, expected) : 0

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>Кассовая смена</span>
        {shift && (
          <div className="flex items-center gap-2 rounded-full" style={{ background: 'var(--pv-free-soft)', padding: '0.35rem 0.8rem' }}>
            <span className="rounded-full" style={{ width: '0.55rem', height: '0.55rem', background: 'var(--pv-free-dot)' }} />
            <span className="font-semibold" style={{ color: 'var(--pv-free-text)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Открыта</span>
            <Clock style={{ width: '0.9rem', height: '0.9rem', color: 'var(--pv-free-text)' }} />
            <span className="font-medium" style={{ color: 'var(--pv-free-text)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{duration}</span>
          </div>
        )}
        <div className="flex-1" />
        <button onClick={() => load()} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <RefreshCw style={{ width: 'clamp(1.05rem,1.3vw,1.3rem)', height: 'clamp(1.05rem,1.3vw,1.3rem)', color: 'var(--pv-text-2)' }} className={loading ? 'animate-spin' : ''} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Обновить</span>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'var(--pv-gap) var(--pv-pad-x) var(--pv-pad-x)' }}>
        {loading ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Загрузка…</div>
        ) : !shift ? (
          // Смена не открыта
          <div className="h-full flex items-center justify-center">
            <div className="rounded-3xl flex flex-col items-center" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1.5rem,3vw,2.5rem)', gap: '1.2rem', width: 'clamp(20rem,40vw,28rem)' }}>
              <Wallet style={{ width: '3rem', height: '3rem', color: 'var(--pv-brand)' }} />
              <div className="font-bold text-center" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.2rem,1.8vw,1.6rem)' }}>Смена не открыта</div>
              <div className="w-full">
                <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.4rem' }}>Начальный размен в кассе</div>
                <div className="flex items-center rounded-xl border" style={{ borderColor: 'var(--pv-brand)', borderWidth: '2px', padding: '0.7rem 1rem' }}>
                  <input autoFocus inputMode="decimal" value={openBal} onChange={e => setOpenBal(e.target.value)} placeholder="0" className="flex-1 min-w-0 bg-transparent outline-none font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.2rem,1.8vw,1.6rem)' }} />
                  <span className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>TJS</span>
                </div>
              </div>
              <button disabled={busy} onClick={doOpen} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                {busy ? 'Открываем…' : 'Открыть смену'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col" style={{ gap: 'var(--pv-gap)' }}>
            {/* KPIs */}
            <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fit, minmax(clamp(11rem,16vw,15rem), 1fr))' }}>
              {([['Выручка', formatCurrency(dAdd(rev.cashRevenue, rev.cardRevenue)), `Нал ${formatCurrency(rev.cashRevenue)} · Безнал ${formatCurrency(rev.cardRevenue)}`], ['Заказов', String(rev.ordersCount), 'закрыто'], ['Средний чек', formatCurrency(rev.avgCheck), 'на заказ']] as const).map(([l, v, s]) => (
                <div key={l} className="rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.9rem,1.4vw,1.4rem)' }}>
                  <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{l}</div>
                  <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.3rem,2vw,1.9rem)', margin: '0.15rem 0' }}>{v}</div>
                  <div className="truncate" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{s}</div>
                </div>
              ))}
            </div>

            {/* Cash panel */}
            <div className="rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1rem,1.6vw,1.5rem)' }}>
              <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.05rem,1.5vw,1.35rem)', marginBottom: '0.8rem' }}>Движение по кассе</div>
              {([['Начальный размен', openingBalance, ''], ['Наличная выручка', rev.cashRevenue, '+'], ['Внесения', cashIn, '+'], ['Изъятия', withdraw, '−'], ['Расходы', expenses, '−']] as const).map(([l, v, sign]) => (
                <div key={l} className="flex items-center justify-between" style={{ padding: '0.4rem 0' }}>
                  <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>{l}</span>
                  <span className="font-semibold" style={{ color: sign === '−' ? 'var(--pv-occ-text)' : sign === '+' ? 'var(--pv-free-text)' : 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{sign}{formatCurrency(v)}</span>
                </div>
              ))}
              <div style={{ height: '1px', background: 'var(--pv-border)', margin: '0.6rem 0' }} />
              <div className="flex items-center justify-between rounded-xl" style={{ background: 'var(--pv-brand-soft)', padding: '0.7rem 1rem' }}>
                <span className="font-bold" style={{ color: 'var(--pv-brand)', fontSize: 'var(--pv-ctl)' }}>Ожидается в кассе</span>
                <span className="font-bold" style={{ color: 'var(--pv-brand)', fontSize: 'clamp(1.2rem,1.7vw,1.6rem)' }}>{formatCurrency(expected)}</span>
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fit, minmax(clamp(10rem,15vw,14rem), 1fr))' }}>
              {([['cash_in', 'Внесение', ArrowDownToLine, '#17a45e'], ['cash_out', 'Изъятие', ArrowUpFromLine, '#e8890c'], ['expense', 'Расход', ReceiptText, '#e0245a']] as const).map(([a, l, Icon, color]) => (
                <button key={a} onClick={() => openAction(a)} className="flex items-center justify-center gap-2 rounded-2xl font-bold text-white active:scale-[0.98] transition-transform" style={{ background: color, padding: 'clamp(0.9rem,1.4vw,1.3rem)', fontSize: 'clamp(1rem,1.3vw,1.15rem)' }}>
                  <Icon style={{ width: '1.4em', height: '1.4em' }} />{l}
                </button>
              ))}
            </div>
            <button onClick={() => openAction('close')} className="flex items-center justify-center gap-2 rounded-2xl font-bold active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-card)', border: '2px solid var(--pv-occ-dot)', color: 'var(--pv-occ-text)', padding: 'clamp(0.9rem,1.4vw,1.3rem)', fontSize: 'clamp(1rem,1.3vw,1.15rem)' }}>
              <Lock style={{ width: '1.35em', height: '1.35em' }} />Закрыть смену
            </button>
          </div>
        )}
      </div>

      {/* Action modal */}
      {action && shift && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => { if (!busy) setAction(null) }}>
          <div className="rounded-3xl overflow-hidden" style={{ background: 'var(--pv-card)', width: 'clamp(22rem, 44vw, 34rem)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b" style={{ padding: 'clamp(1rem,1.6vw,1.4rem) clamp(1.2rem,1.8vw,1.6rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold" style={{ fontSize: 'clamp(1.1rem,1.6vw,1.4rem)', color: 'var(--pv-text)' }}>
                {action === 'cash_in' ? 'Внесение' : action === 'cash_out' ? 'Изъятие' : action === 'expense' ? 'Расход из кассы' : 'Закрытие смены'}
              </span>
              <button onClick={() => { if (!busy) setAction(null) }} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.9rem' }}>
              {action === 'close' && (
                <div className="flex items-center justify-between rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.7rem 1rem' }}>
                  <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Ожидается в кассе</span>
                  <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.05rem,1.5vw,1.3rem)' }}>{formatCurrency(expected)}</span>
                </div>
              )}
              {action === 'expense' && (
                <div>
                  <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.45rem' }}>Категория</div>
                  <div className="flex flex-wrap gap-2">
                    {EXPENSE_CATS.map(c => {
                      const on = c === cat
                      return <button key={c} onClick={() => setCat(c)} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.35rem 0.8rem', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{c}</button>
                    })}
                  </div>
                </div>
              )}
              <div>
                <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.45rem' }}>{action === 'close' ? 'Фактически в кассе' : 'Сумма'}</div>
                <div className="flex items-center rounded-xl border" style={{ borderColor: 'var(--pv-brand)', borderWidth: '2px', padding: '0.7rem 1rem' }}>
                  <input autoFocus inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} placeholder="0" className="flex-1 min-w-0 bg-transparent outline-none font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.2rem,1.8vw,1.6rem)' }} />
                  <span className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>TJS</span>
                </div>
              </div>
              {action === 'close' && amt !== '' && (
                <div className="flex items-center justify-between rounded-xl" style={{ background: closeDiff === 0 ? 'var(--pv-free-soft)' : 'var(--pv-occ-soft)', padding: '0.6rem 1rem' }}>
                  <span className="font-medium" style={{ color: closeDiff === 0 ? 'var(--pv-free-text)' : 'var(--pv-occ-text)', fontSize: 'var(--pv-ctl)' }}>Расхождение</span>
                  <span className="font-bold" style={{ color: closeDiff === 0 ? 'var(--pv-free-text)' : 'var(--pv-occ-text)', fontSize: 'var(--pv-ctl)' }}>{closeDiff > 0 ? '+' : ''}{formatCurrency(closeDiff)}</span>
                </div>
              )}
              {action !== 'close' && (
                <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Комментарий (необязательно)" className="rounded-xl border bg-transparent outline-none" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.6rem 1rem' }} />
              )}
              <button disabled={busy} onClick={submitAction} className="w-full flex items-center justify-center rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: action === 'close' ? 'var(--pv-occ-dot)' : 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                {busy ? 'Проводим…' : action === 'close' ? 'Закрыть смену' : 'Подтвердить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
