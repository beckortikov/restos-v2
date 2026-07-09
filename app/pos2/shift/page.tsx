'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, RefreshCw, Wallet, ArrowDownToLine, ArrowUpFromLine, ReceiptText, Lock, X, Printer, FileSpreadsheet, HandCoins, History, TrendingUp, TrendingDown, AlertTriangle, Ban, Check } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import {
  fetchActiveShift, fetchShiftRevenue, fetchShiftOperations, fetchFinancialAccounts,
  openShift, closeShift, addShiftOperation, createShiftExpense,
  printShiftX, printShiftZ, printShiftService, fetchShiftZReport, type ShiftZReport, fetchShifts,
  fetchOrders, cancelOrder, patchShiftAccount,
  fetchServiceAccrualByShift, fetchServicePayoutByShift, fetchUsers, payServiceCharge,
} from '@/lib/queries'
import { exportShiftToXlsx } from '@/lib/shift-export'
import { formatCurrency } from '@/lib/helpers'
import { deltaPct } from '@/lib/pos-v2/report'
import { PosModal } from '@/components/pos-v2/pos-modal'
import { PinSection } from '@/components/pos-v2/pin-section'
import { dSum, dAdd, dSub } from '@/lib/decimal'
import { humanizeError } from '@/lib/errors'
import { V4Error } from '@/lib/api'
import type { CashShift, CashShiftOperation, FinancialAccount, Order } from '@/lib/types'

const EXPENSE_CATS = ['Закупка продуктов', 'Зарплата', 'Ремонт', 'Транспорт', 'Хозтовары', 'Прочие расходы']
interface SvcRow { waiterId: string; waiterName: string; ordersCount: number; accrued: number; paid: number; toPay: number }
type Action = 'cash_in' | 'cash_out' | 'expense' | 'close'
const num = (s: string) => Math.max(0, parseFloat(s.replace(',', '.').replace(/\s/g, '')) || 0)

export default function PosV2Shift() {
  const navigate = useNavigate()
  const { user } = useAuth()
  // Владелец/superadmin — без ПИН; кассир открывает смену, но управление
  // активной сменой (KPI/закрытие/Z/история) — под ПИН владельца (см. PinSection).
  const isOwnerRole = user?.role === 'owner' || user?.role === 'superadmin'
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
  const [zr, setZr] = useState<ShiftZReport | null>(null)
  const [histOpen, setHistOpen] = useState(false)
  const [hist, setHist] = useState<CashShift[] | null>(null)
  // Обслуживание официантов — встроено в смену (по дизайну restos.pen).
  const [svcRows, setSvcRows] = useState<SvcRow[]>([])
  const [svcPayingId, setSvcPayingId] = useState<string | null>(null)
  const svcPayRef = useRef(false)
  const busyRef = useRef(false)

  const cashAccounts = useMemo(() => accounts.filter(a => a.type === 'cash'), [accounts])
  // Счёт смены при открытии — обязателен (иначе расход/выплата обслуживания падают).
  const [openAccountId, setOpenAccountId] = useState('')
  // Гард закрытия: бэк называет блокирующие заказы в details.order_ids.
  const [stuckOrders, setStuckOrders] = useState<Order[] | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  // Recovery: legacy-смена без счёта — привязываем cash-счёт без закрытия.
  const [attachId, setAttachId] = useState('')
  const [attaching, setAttaching] = useState(false)
  useEffect(() => { if (!openAccountId && cashAccounts.length) setOpenAccountId(cashAccounts[0].id) }, [cashAccounts, openAccountId])
  useEffect(() => { if (shift && !shift.accountId && !attachId && cashAccounts.length) setAttachId(cashAccounts[0].id) }, [shift, cashAccounts, attachId])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const active = await fetchActiveShift().catch(() => null)
      setShift(active)
      if (active) {
        const [r, o, z] = await Promise.all([
          fetchShiftRevenue(active.id).catch(() => rev),
          fetchShiftOperations(active.id).catch(() => [] as CashShiftOperation[]),
          fetchShiftZReport(active.id).catch(() => null),
        ])
        setRev(r); setOps(o); setZr(z)
        // Обслуживание официантов — начислено/выплачено/к выплате по смене.
        const [accrual, payout, users] = await Promise.all([
          fetchServiceAccrualByShift(active.id).catch(() => []),
          fetchServicePayoutByShift(active.id).catch(() => ({} as Record<string, number>)),
          fetchUsers().catch(() => []),
        ])
        const nameById = new Map(users.map(u => [u.id, u.name]))
        setSvcRows(accrual.filter(x => x.waiterId).map(x => {
          const wid = x.waiterId as string; const paid = payout[wid] ?? 0
          return { waiterId: wid, waiterName: nameById.get(wid) ?? 'Без имени', ordersCount: x.ordersCount, accrued: x.accrued, paid, toPay: Math.max(0, x.accrued - paid) }
        }).sort((a, b) => b.toPay - a.toPay))
      } else { setOps([]); setZr(null); setSvcRows([]) }
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

  const curRevenue = dAdd(rev.cashRevenue, rev.cardRevenue)
  const prev = zr?.previous ?? null
  const svcToPay = useMemo(() => dSum(svcRows.map(r => r.toPay)), [svcRows])
  const svcCashAcc = useMemo(() => accounts.find(a => a.type === 'cash') ?? accounts[0], [accounts])
  const svcInitials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('')
  async function payService(r: SvcRow) {
    if (svcPayRef.current || r.toPay <= 0 || !shift) return
    // Выплата — со СЧЁТА СМЕНЫ (иначе деньги уйдут не туда). Как в старом ПОС.
    const acc = shift.accountId ? { id: shift.accountId, name: shift.accountName } : svcCashAcc
    if (!acc?.id) { toast.error('У смены нет счёта — привяжите его выше'); return }
    svcPayRef.current = true; setSvcPayingId(r.waiterId)
    try {
      await payServiceCharge({ waiterId: r.waiterId, waiterName: r.waiterName, amount: r.toPay, accountId: acc.id, accountName: acc.name ?? '', periodFrom: shift.openedAt, periodTo: new Date().toISOString(), shiftId: shift.id })
      toast.success(`Выплачено · ${r.waiterName} · ${formatCurrency(r.toPay)}`)
      await load()
    } catch (e) { toast.error(`Не удалось выплатить: ${humanizeError(e)}`) }
    finally { svcPayRef.current = false; setSvcPayingId(null) }
  }

  async function openHistory() {
    setHistOpen(true)
    if (hist) return
    try { setHist(await fetchShifts(30)) } catch (e) { toast.error(humanizeError(e)); setHist([]) }
  }

  async function report(kind: 'x' | 'z' | 'service') {
    if (!shift) return
    try {
      if (kind === 'x') await printShiftX(shift.id)
      else if (kind === 'z') await printShiftZ(shift.id)
      else await printShiftService(shift.id)
      toast.success(kind === 'x' ? 'X-отчёт на печати' : kind === 'z' ? 'Z-отчёт на печати' : 'Служебный чек на печати')
    } catch (e) { toast.error(`Печать не удалась: ${humanizeError(e)}`) }
  }
  async function exportXlsx() {
    if (!shift) return
    try { await exportShiftToXlsx(shift); toast.success('Excel сформирован') }
    catch (e) { toast.error(`Экспорт не удался: ${humanizeError(e)}`) }
  }

  function breakdownCard(title: string, rows: [string, string][]) {
    return (
      <div key={title} className="rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1rem,1.5vw,1.4rem)' }}>
        <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.4vw,1.2rem)', marginBottom: '0.6rem' }}>{title}</div>
        {rows.length === 0 ? <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>—</div> : rows.map(([l, v], i) => (
          <div key={i} className="flex items-center justify-between" style={{ padding: '0.25rem 0' }}>
            <span className="truncate" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginRight: '0.5rem' }}>{l}</span>
            <span className="font-semibold shrink-0" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{v}</span>
          </div>
        ))}
      </div>
    )
  }

  async function doOpen() {
    if (busyRef.current) return
    // Хард-блок: смена без cash-счёта делает Расход и выплату обслуживания
    // невозможными (бэк требует счёт). Старый ПОС так же блокировал открытие.
    if (cashAccounts.length === 0) { toast.error('Нет счёта «Касса» — создайте его в Финансы → Счета'); return }
    if (!openAccountId) { toast.error('Выберите счёт смены — без него расход/выплаты не работают'); return }
    busyRef.current = true; setBusy(true)
    try {
      await openShift(user?.id ?? '', num(openBal), openAccountId)
      toast.success('Смена открыта'); setOpenBal('')
      // Кассир открыл смену → на лаунчер (управление активной сменой под ПИН
      // владельца). Владелец остаётся и видит управление.
      if (!isOwnerRole) { busyRef.current = false; setBusy(false); navigate('/pos2'); return }
      await load()
    } catch (e) { toast.error(`Не удалось открыть: ${humanizeError(e)}`) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function submitAction() {
    if (busyRef.current || !shift || !action) return
    if (action !== 'close' && num(amt) <= 0) { toast.error('Укажите сумму'); return }
    if (action === 'close') setStuckOrders(null)
    busyRef.current = true; setBusy(true)
    try {
      if (action === 'cash_in') await addShiftOperation(shift.id, 'cash_in', num(amt), desc)
      else if (action === 'cash_out') await addShiftOperation(shift.id, 'cash_out', num(amt), desc)
      else if (action === 'expense') await createShiftExpense(shift.id, num(amt), cat, desc)
      else if (action === 'close') { await closeShift(shift.id, user?.id ?? '', amt ? num(amt) : expected); toast.success('Смена закрыта'); setAction(null); await load(); return }
      toast.success(action === 'cash_in' ? 'Внесение проведено' : action === 'cash_out' ? 'Изъятие проведено' : 'Расход проведён')
      setAction(null); setAmt(''); setDesc(''); await load()
    } catch (e) {
      toast.error(`Ошибка: ${humanizeError(e)}`)
      // Закрытие заблокировано незакрытыми заказами: бэк называет их в
      // details.order_ids. Грузим по id (без scope по смене/дате) — «хвост» из
      // прошлой смены иначе не найти нигде. Даём отменить их прямо в модалке.
      if (action === 'close') {
        const ids = e instanceof V4Error ? (e.envelope()?.details?.order_ids as unknown) : undefined
        if (Array.isArray(ids) && ids.length > 0) {
          try { setStuckOrders(await fetchOrders({ ids: ids as string[], slim: true })) } catch { /* покажем только текст ошибки */ }
        }
      }
    }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function cancelStuck(orderId: string) {
    if (!window.confirm('Отменить этот заказ? Он мешает закрыть смену.')) return
    setCancellingId(orderId)
    try { await cancelOrder(orderId, 'Зависший заказ — отменён при закрытии смены'); setStuckOrders(prev => (prev ?? []).filter(o => o.id !== orderId)); toast.success('Заказ отменён') }
    catch (e) { toast.error(humanizeError(e)) }
    finally { setCancellingId(null) }
  }

  async function attachAccount() {
    if (!shift || !attachId) return
    setAttaching(true)
    try { await patchShiftAccount(shift.id, attachId); toast.success('Счёт привязан к смене'); setAttachId(''); await load() }
    catch (e) { toast.error(humanizeError(e)) }
    finally { setAttaching(false) }
  }

  function openAction(a: Action) {
    setAction(a); setDesc(''); setCat(EXPENSE_CATS[0]); setStuckOrders(null)
    setAmt(a === 'close' ? String(expected) : '')
  }

  const closeDiff = action === 'close' ? dSub(amt ? num(amt) : expected, expected) : 0

  return (
    // Управление активной сменой — под ПИН владельца; форма ОТКРЫТИЯ (нет
    // активной смены) доступна кассиру без ПИН.
    <PinSection label="Кассовая смена" gateWhen={!!shift}>
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Hero: назад + заголовок + статус · панель отчётов + «Закрыть смену» (дизайн restos.pen) */}
      <div className="flex items-center flex-wrap shrink-0" style={{ gap: 'clamp(0.4rem,0.7vw,0.65rem)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.1rem,1.7vw,1.5rem)' }}>Кассовая смена</span>
        {shift && (
          <div className="flex items-center gap-2 rounded-full shrink-0" style={{ background: 'var(--pv-free-soft)', padding: '0.35rem 0.8rem' }}>
            <span className="rounded-full" style={{ width: '0.55rem', height: '0.55rem', background: 'var(--pv-free-dot)' }} />
            <span className="font-semibold whitespace-nowrap" style={{ color: 'var(--pv-free-text)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Открыта · {duration}</span>
          </div>
        )}
        <div className="flex-1" style={{ minWidth: '0.5rem' }} />
        {shift && !loading && ([['X-отчёт', () => report('x'), Printer], ['Z-отчёт', () => report('z'), Printer], ['Обслуживание', () => report('service'), HandCoins], ['Excel', exportXlsx, FileSpreadsheet], ['История', openHistory, History]] as const).map(([l, fn, Icon]) => (
          <button key={l} onClick={fn} className="flex items-center gap-1.5 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.5rem,0.8vw,0.72rem) clamp(0.65rem,0.95vw,0.95rem)' }}>
            <Icon style={{ width: 'clamp(1rem,1.2vw,1.15rem)', height: 'clamp(1rem,1.2vw,1.15rem)', color: 'var(--pv-text-2)' }} />
            <span className="font-semibold whitespace-nowrap" style={{ color: 'var(--pv-text)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{l}</span>
          </button>
        ))}
        {shift && !loading && (
          <button onClick={() => openAction('close')} className="flex items-center gap-1.5 rounded-xl font-bold text-white shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-occ-dot)', padding: 'clamp(0.5rem,0.8vw,0.72rem) clamp(0.8rem,1.1vw,1.1rem)', boxShadow: '0 4px 12px rgba(210,59,46,0.32)' }}>
            <Lock style={{ width: 'clamp(1rem,1.2vw,1.15rem)', height: 'clamp(1rem,1.2vw,1.15rem)' }} /><span className="whitespace-nowrap">Закрыть смену</span>
          </button>
        )}
        <button onClick={() => load()} className="flex items-center justify-center rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.82rem)' }}>
          <RefreshCw style={{ width: 'clamp(1.05rem,1.3vw,1.3rem)', height: 'clamp(1.05rem,1.3vw,1.3rem)', color: 'var(--pv-text-2)' }} className={loading ? 'animate-spin' : ''} />
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
                  <input aria-label="0" autoFocus inputMode="decimal" value={openBal} onChange={e => setOpenBal(e.target.value)} placeholder="0" className="flex-1 min-w-0 bg-transparent outline-none font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.2rem,1.8vw,1.6rem)' }} />
                  <span className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>с.</span>
                </div>
              </div>
              {/* Счёт смены — обязателен (иначе расход/выплаты недоступны). */}
              <div className="w-full">
                <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.4rem' }}>Счёт смены</div>
                {cashAccounts.length === 0 ? (
                  <div className="rounded-xl" style={{ background: 'var(--pv-occ-soft)', color: 'var(--pv-occ-text)', padding: '0.7rem 1rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Нет счёта «Касса» — создайте его в Финансы → Счета. Без него расход и выплаты не работают.</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {cashAccounts.map(a => { const on = a.id === openAccountId; return (
                      <button key={a.id} onClick={() => setOpenAccountId(a.id)} className="rounded-xl font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.5rem 0.9rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{a.name}</button>
                    ) })}
                  </div>
                )}
              </div>
              <button disabled={busy || cashAccounts.length === 0 || !openAccountId} onClick={doOpen} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                {busy ? 'Открываем…' : 'Открыть смену'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col" style={{ gap: 'var(--pv-gap)' }}>
            {/* Recovery: смена без счёта → Расход и выплата обслуживания заблокированы. */}
            {!shift.accountId && (
              <div className="rounded-2xl flex flex-col gap-3" style={{ background: 'var(--pv-bill-soft)', border: '1px solid var(--pv-bill-dot)', padding: 'clamp(1rem,1.5vw,1.4rem)' }}>
                <div className="flex items-start gap-2">
                  <AlertTriangle style={{ width: '1.2rem', height: '1.2rem', color: 'var(--pv-bill-text)', flexShrink: 0, marginTop: '0.1rem' }} />
                  <div>
                    <div className="font-bold" style={{ color: 'var(--pv-bill-text)', fontSize: 'var(--pv-ctl)' }}>У смены не указан счёт</div>
                    <div style={{ color: 'var(--pv-bill-text)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)', opacity: 0.9 }}>Привяжите счёт, чтобы разблокировать Расход и выплату обслуживания официантам.</div>
                  </div>
                </div>
                {cashAccounts.length === 0 ? (
                  <div style={{ color: 'var(--pv-occ-text)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Нет cash-счетов. Создайте в Финансы → Счета.</div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    {cashAccounts.map(a => { const on = a.id === attachId; return (
                      <button key={a.id} onClick={() => setAttachId(a.id)} className="rounded-xl font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.45rem 0.85rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{a.name}</button>
                    ) })}
                    <button disabled={!attachId || attaching} onClick={attachAccount} className="rounded-xl font-bold text-white disabled:opacity-50" style={{ background: 'var(--pv-bill-text)', padding: '0.45rem 1rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{attaching ? '…' : 'Привязать'}</button>
                  </div>
                )}
              </div>
            )}
            {/* KPIs — 4 карточки (дизайн): Наличные в кассе / Выручка / Заказов / Ср.чек */}
            <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fit, minmax(clamp(11rem,16vw,15rem), 1fr))' }}>
              <div className="rounded-2xl" style={{ background: 'var(--pv-free-soft)', border: '1px solid var(--pv-free-border)', padding: 'clamp(0.9rem,1.4vw,1.4rem)' }}>
                <div style={{ color: 'var(--pv-free-text)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Наличные в кассе</div>
                <div className="font-bold" style={{ color: 'var(--pv-free-text)', fontSize: 'clamp(1.3rem,2vw,1.9rem)', margin: '0.15rem 0' }}>{formatCurrency(expected)}</div>
                <div className="truncate" style={{ color: 'var(--pv-free-text)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)', opacity: 0.8 }}>ожидается сейчас</div>
              </div>
              {([
                ['Выручка', formatCurrency(curRevenue), `Нал ${formatCurrency(rev.cashRevenue)} · Безнал ${formatCurrency(rev.cardRevenue)}`, deltaPct(curRevenue, prev?.revenue ?? 0)],
                ['Заказов', String(rev.ordersCount), 'закрыто', deltaPct(rev.ordersCount, prev?.ordersCount ?? 0)],
                ['Средний чек', formatCurrency(rev.avgCheck), 'на заказ', deltaPct(rev.avgCheck, prev?.avgCheck ?? 0)],
              ] as [string, string, string, number | null][]).map(([l, v, s, d]) => (
                <div key={l} className="rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.9rem,1.4vw,1.4rem)' }}>
                  <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{l}</div>
                  <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.3rem,2vw,1.9rem)', margin: '0.15rem 0' }}>{v}</div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{s}</span>
                    {d != null && (
                      <span className="flex items-center gap-0.5 rounded-full shrink-0 font-semibold" style={{ background: d >= 0 ? 'var(--pv-free-soft)' : 'var(--pv-occ-soft)', color: d >= 0 ? 'var(--pv-free-text)' : 'var(--pv-occ-text)', padding: '0.1rem 0.45rem', fontSize: 'calc(var(--pv-ctl) - 0.2rem)' }}>
                        {d >= 0 ? <TrendingUp style={{ width: '0.75rem', height: '0.75rem' }} /> : <TrendingDown style={{ width: '0.75rem', height: '0.75rem' }} />}{Math.abs(d).toFixed(0)}%
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {prev && (
              <div className="rounded-xl flex items-center flex-wrap" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: '0.6rem 1rem', gap: '0.3rem 1.2rem', color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>
                <span>Прошлая смена{prev.closedAt ? ` (${new Date(prev.closedAt).toLocaleDateString('ru', { day: '2-digit', month: 'short' })})` : ''}:</span>
                <span>Выручка <b style={{ color: 'var(--pv-text-2)' }}>{formatCurrency(prev.revenue)}</b></span>
                <span>Заказов <b style={{ color: 'var(--pv-text-2)' }}>{prev.ordersCount}</b></span>
                <span>Ср. чек <b style={{ color: 'var(--pv-text-2)' }}>{formatCurrency(prev.avgCheck)}</b></span>
              </div>
            )}

            {/* Тело: слева разбивки, справа касса + действия (дизайн — 2 колонки) */}
            <div className="flex flex-wrap" style={{ gap: 'var(--pv-gap)', alignItems: 'flex-start' }}>
              <div className="flex-1 grid content-start" style={{ minWidth: 'clamp(15rem,38vw,28rem)', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fit, minmax(clamp(13rem,17vw,17rem), 1fr))' }}>
                {zr ? (
                  <>
                    {breakdownCard('Выручка по способам', zr.revenueByMethod.map(r => [r.accountName || (r.paymentMethod === 'cash' ? 'Наличные' : 'Безнал'), formatCurrency(r.total)] as [string, string]))}
                    {breakdownCard('Официанты', zr.salesByWaiter.map(w => [`${w.name} (${w.ordersCount})`, formatCurrency(w.total)] as [string, string]))}
                    {breakdownCard('По типу заказа', zr.salesByOrderType.map(r => [r.type === 'hall' ? 'В зале' : r.type === 'takeaway' ? 'С собой' : r.type === 'delivery' ? 'Доставка' : r.type, formatCurrency(r.total)] as [string, string]))}
                    {breakdownCard('Продажи по категориям', zr.salesByCategory.slice(0, 8).map(r => [`${r.name} (${r.qty})`, formatCurrency(r.total)] as [string, string]))}
                    {breakdownCard('Проданные блюда', zr.salesByItem.slice(0, 10).map(r => [`${r.name} ×${r.qty}`, formatCurrency(r.total)] as [string, string]))}
                  </>
                ) : (
                  <div className="rounded-2xl flex items-center justify-center text-center" style={{ background: 'var(--pv-card)', border: '1px dashed var(--pv-border)', padding: '2rem', color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)', minHeight: '10rem', gridColumn: '1 / -1' }}>Разбивки (способы оплаты, официанты, категории, блюда) появятся после продаж.</div>
                )}
              </div>
              <div className="shrink-0 flex flex-col" style={{ width: 'clamp(19rem,29vw,25rem)', gap: 'var(--pv-gap)' }}>
                {/* Движение по кассе */}
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
                {/* Действия */}
                <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.6rem' }}>
                  {([['cash_in', 'Внести', ArrowDownToLine, '#17a45e'], ['cash_out', 'Изъять', ArrowUpFromLine, '#e8890c'], ['expense', 'Расход', ReceiptText, '#e0245a']] as const).map(([a, l, Icon, color]) => (
                    <button key={a} onClick={() => openAction(a)} className="flex flex-col items-center justify-center gap-1.5 rounded-2xl font-bold text-white active:scale-[0.98] transition-transform" style={{ background: color, padding: 'clamp(0.85rem,1.3vw,1.15rem) 0.4rem', fontSize: 'calc(var(--pv-ctl) - 0.02rem)' }}>
                      <Icon style={{ width: '1.5em', height: '1.5em' }} />{l}
                    </button>
                  ))}
                </div>
                {/* Обслуживание официантов — выплаты (дизайн: в правой колонке смены) */}
                <div className="rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1rem,1.6vw,1.4rem)' }}>
                  <div className="flex items-center justify-between" style={{ marginBottom: '0.7rem' }}>
                    <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.05rem,1.5vw,1.35rem)' }}>Обслуживание</span>
                    {svcToPay > 0 && <span className="rounded-full font-bold" style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', padding: '0.2rem 0.7rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>к выплате {formatCurrency(svcToPay)}</span>}
                  </div>
                  {svcRows.length === 0 ? (
                    <div className="text-center" style={{ color: 'var(--pv-text-3)', padding: '0.6rem 0', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Нет начислений в этой смене</div>
                  ) : (
                    <div className="flex flex-col" style={{ gap: '0.5rem' }}>
                      {svcRows.map(r => (
                        <div key={r.waiterId} className="flex items-center gap-2.5 rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.55rem 0.7rem' }}>
                          <div className="rounded-full flex items-center justify-center font-bold shrink-0" style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', width: '2.2rem', height: '2.2rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{svcInitials(r.waiterName)}</div>
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{r.waiterName}</div>
                            <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>нач. {formatCurrency(r.accrued)} · вып. {formatCurrency(r.paid)}</div>
                          </div>
                          {r.toPay > 0 ? (
                            <button disabled={svcPayingId === r.waiterId} onClick={() => payService(r)} className="flex items-center gap-1.5 rounded-lg font-bold text-white shrink-0 disabled:opacity-50 active:scale-95 transition-transform" style={{ background: 'var(--pv-brand)', padding: '0.45rem 0.7rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>
                              <HandCoins style={{ width: '0.95rem', height: '0.95rem' }} />{svcPayingId === r.waiterId ? '…' : formatCurrency(r.toPay)}
                            </button>
                          ) : (
                            <span className="flex items-center gap-1 rounded-lg shrink-0" style={{ background: 'var(--pv-free-soft)', color: 'var(--pv-free-text)', padding: '0.4rem 0.6rem', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}><Check style={{ width: '0.9rem', height: '0.9rem' }} />Выплачено</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Action modal */}
      {action && shift && (
        <PosModal open onClose={() => { if (!busy) { setAction(null); setStuckOrders(null) } }} dismissable={!busy} width="clamp(22rem, 44vw, 34rem)"
          title={action === 'cash_in' ? 'Внесение' : action === 'cash_out' ? 'Изъятие' : action === 'expense' ? 'Расход из кассы' : 'Закрытие смены'}>
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
                  <input aria-label="0" autoFocus inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} placeholder="0" className="flex-1 min-w-0 bg-transparent outline-none font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.2rem,1.8vw,1.6rem)' }} />
                  <span className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>с.</span>
                </div>
              </div>
              {action === 'close' && amt !== '' && (
                <div className="flex items-center justify-between rounded-xl" style={{ background: closeDiff === 0 ? 'var(--pv-free-soft)' : 'var(--pv-occ-soft)', padding: '0.6rem 1rem' }}>
                  <span className="font-medium" style={{ color: closeDiff === 0 ? 'var(--pv-free-text)' : 'var(--pv-occ-text)', fontSize: 'var(--pv-ctl)' }}>Расхождение</span>
                  <span className="font-bold" style={{ color: closeDiff === 0 ? 'var(--pv-free-text)' : 'var(--pv-occ-text)', fontSize: 'var(--pv-ctl)' }}>{closeDiff > 0 ? '+' : ''}{formatCurrency(closeDiff)}</span>
                </div>
              )}
              {action !== 'close' && (
                <input aria-label="Комментарий (необязательно)" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Комментарий (необязательно)" className="rounded-xl border bg-transparent outline-none" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.6rem 1rem' }} />
              )}
              {/* Гард закрытия: незакрытые заказы (в т.ч. «хвост» прошлой смены). */}
              {action === 'close' && stuckOrders && stuckOrders.length > 0 && (
                <div className="rounded-xl flex flex-col gap-2" style={{ background: 'var(--pv-bill-soft)', border: '1px solid var(--pv-bill-dot)', padding: '0.8rem 1rem' }}>
                  <div className="flex items-center gap-1.5 font-bold" style={{ color: 'var(--pv-bill-text)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}><AlertTriangle style={{ width: '1rem', height: '1rem' }} />Смена не закрывается — есть незакрытые заказы</div>
                  <div style={{ color: 'var(--pv-bill-text)', fontSize: 'calc(var(--pv-ctl) - 0.15rem)', opacity: 0.9 }}>Отмените их (или закройте с оплатой из заказа), затем нажмите «Закрыть смену» ещё раз.</div>
                  <div className="flex flex-col gap-1.5">
                    {stuckOrders.map(o => { const label = o.type === 'takeaway' ? 'С собой' : 'Зал'; return (
                      <div key={o.id} className="flex items-center justify-between rounded-lg" style={{ background: 'var(--pv-card)', padding: '0.5rem 0.7rem' }}>
                        <span style={{ color: 'var(--pv-text)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{label} №{o.orderNumber ?? '—'} <span style={{ color: 'var(--pv-text-3)' }}>{formatCurrency(o.total ?? 0)}</span></span>
                        <button disabled={cancellingId === o.id} onClick={() => cancelStuck(o.id)} className="flex items-center gap-1 rounded-md font-semibold disabled:opacity-50" style={{ background: 'var(--pv-occ-soft)', color: 'var(--pv-occ-text)', padding: '0.35rem 0.6rem', fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}><Ban style={{ width: '0.85rem', height: '0.85rem' }} />{cancellingId === o.id ? 'Отмена…' : 'Отменить'}</button>
                      </div>
                    ) })}
                  </div>
                </div>
              )}
              <button disabled={busy} onClick={submitAction} className="w-full flex items-center justify-center rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: action === 'close' ? 'var(--pv-occ-dot)' : 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                {busy ? 'Проводим…' : action === 'close' ? 'Закрыть смену' : 'Подтвердить'}
              </button>
            </div>
        </PosModal>
      )}

      {/* Shift history modal */}
      {histOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => setHistOpen(false)}>
          <div className="rounded-3xl overflow-hidden flex flex-col" style={{ background: 'var(--pv-card)', width: 'clamp(24rem,60vw,48rem)', maxHeight: '86vh', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b shrink-0" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.35rem)', color: 'var(--pv-text)' }}>История смен</span>
              <button onClick={() => setHistOpen(false)} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'clamp(0.8rem,1.4vw,1.2rem)' }}>
              {hist === null ? (
                <div className="text-center" style={{ color: 'var(--pv-text-3)', padding: '2rem' }}>Загрузка…</div>
              ) : hist.length === 0 ? (
                <div className="text-center" style={{ color: 'var(--pv-text-3)', padding: '2rem' }}>Смен пока нет</div>
              ) : (
                <div className="flex flex-col" style={{ gap: '0.5rem' }}>
                  {hist.map(s => {
                    const revenue = dAdd(s.cashRevenue, s.cardRevenue)
                    const disc = (s.closingBalance != null && s.expectedCash != null) ? dSub(s.closingBalance, s.expectedCash) : null
                    const isOpen = s.status !== 'closed'
                    return (
                      <div key={s.id} className="rounded-2xl" style={{ background: 'var(--pv-bg)', padding: 'clamp(0.7rem,1.1vw,1rem)' }}>
                        <div className="flex items-center justify-between" style={{ gap: '0.5rem' }}>
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{new Date(s.openedAt).toLocaleString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}{s.closedAt ? ` — ${new Date(s.closedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
                            {isOpen && <span className="rounded-full shrink-0 font-semibold" style={{ background: 'var(--pv-free-soft)', color: 'var(--pv-free-text)', padding: '0.1rem 0.5rem', fontSize: 'calc(var(--pv-ctl) - 0.2rem)' }}>Открыта</span>}
                          </div>
                          <span className="font-bold shrink-0" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(revenue)}</span>
                        </div>
                        <div className="flex items-center flex-wrap" style={{ gap: '0.2rem 1rem', marginTop: '0.35rem', color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>
                          <span>{s.openedByName ?? '—'}</span>
                          <span>Заказов {s.ordersCount}</span>
                          <span>Ср. чек {formatCurrency(s.avgCheck)}</span>
                          {disc != null && <span style={{ color: disc === 0 ? 'var(--pv-text-3)' : 'var(--pv-occ-text)' }}>Расхождение {disc > 0 ? '+' : ''}{formatCurrency(disc)}</span>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
    </PinSection>
  )
}
