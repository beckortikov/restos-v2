'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, RefreshCw, Wallet, ArrowDownToLine, ArrowUpFromLine, ReceiptText, Lock, X, Printer, FileSpreadsheet, HandCoins, History, TrendingUp, AlertTriangle, Ban, Check, Calculator, Users, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import {
  fetchActiveShift, fetchShiftRevenue, fetchShiftOperations, fetchFinancialAccounts,
  openShift, closeShift, addShiftOperation, createShiftExpense,
  printShiftX, printShiftZ, printShiftService, fetchShiftZReport, type ShiftZReport, fetchShifts,
  fetchOrders, cancelOrder, patchShiftAccount,
  fetchServiceAccrualByShift, fetchServicePayoutByShift, fetchUsers, payServiceCharge,
  deleteShiftExpense,
} from '@/lib/queries'
import { exportShiftToXlsx } from '@/lib/shift-export'
import { formatCurrency } from '@/lib/helpers'
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
  // Разбивка прошлой смены (Z-отчёт по тапу в истории).
  const [histZShift, setHistZShift] = useState<CashShift | null>(null)
  const [histZ, setHistZ] = useState<ShiftZReport | null>(null)
  const [histZLoading, setHistZLoading] = useState(false)
  // Обслуживание официантов — встроено в смену (по дизайну restos.pen).
  const [svcRows, setSvcRows] = useState<SvcRow[]>([])
  const [svcPayingId, setSvcPayingId] = useState<string | null>(null)
  const svcPayRef = useRef(false)
  // Вкладки левой колонки (дизайн restos.pen): Сводка / Официанты / Обслуживание / Операции.
  const [tab, setTab] = useState<'summary' | 'waiters' | 'service' | 'ops'>('summary')
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
  async function deleteExpense(opId: string) {
    if (busyRef.current) return
    if (typeof window !== 'undefined' && !window.confirm('Удалить этот расход? Баланс счёта смены откорректируется.')) return
    busyRef.current = true; setBusy(true)
    try { await deleteShiftExpense(opId); toast.success('Расход удалён'); await load() }
    catch (e) { toast.error(humanizeError(e)) }
    finally { busyRef.current = false; setBusy(false) }
  }
  const guests = zr?.guestsCount ?? 0
  const perGuest = guests > 0 ? curRevenue / guests : 0
  const expenseOps = ops.filter(o => o.type === 'cash_out' && !!o.category)

  async function openHistory() {
    setHistOpen(true)
    if (hist) return
    try { setHist(await fetchShifts(30)) } catch (e) { toast.error(humanizeError(e)); setHist([]) }
  }
  // Полная разбивка прошлой смены (тот же zreport-эндпоинт, что и у текущей).
  async function openHistZ(s: CashShift) {
    setHistZShift(s); setHistZ(null); setHistZLoading(true)
    try { setHistZ(await fetchShiftZReport(s.id)) } catch (e) { toast.error(humanizeError(e)) }
    finally { setHistZLoading(false) }
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
            {/* KPIs — 4 карточки (дизайн): Выручка / Средний чек / Заказов / Гостей */}
            <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fit, minmax(clamp(11rem,16vw,15rem), 1fr))' }}>
              {([
                ['Выручка', formatCurrency(curRevenue), `Нал ${formatCurrency(rev.cashRevenue)} · Безнал ${formatCurrency(rev.cardRevenue)}`, TrendingUp, '#D85A30', '#FBEBE4'],
                ['Средний чек', formatCurrency(rev.avgCheck), prev ? `Пред. смена ${formatCurrency(prev.avgCheck)}` : '— к прошлой смене', Calculator, '#8A5E18', '#FBF0DA'],
                ['Заказов', String(rev.ordersCount), prev ? `Пред. смена ${prev.ordersCount}` : '— к прошлой смене', ReceiptText, '#1F6B3E', '#EAF7EF'],
                ['Гостей', String(guests), guests > 0 ? `Ср. ${formatCurrency(perGuest)} / гость` : 'нет данных', Users, '#2F4E9E', '#E9EFFB'],
              ] as [string, string, string, React.ElementType, string, string][]).map(([l, v, s, Icon, ic, bg]) => (
                <div key={l} className="rounded-2xl flex flex-col" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.9rem,1.4vw,1.4rem)', gap: '0.45rem', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
                  <div className="flex items-center justify-between">
                    <span className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{l}</span>
                    <span className="rounded-xl flex items-center justify-center shrink-0" style={{ background: bg, width: '2.2rem', height: '2.2rem' }}><Icon style={{ width: '1.1rem', height: '1.1rem', color: ic }} /></span>
                  </div>
                  <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.35rem,2vw,1.9rem)' }}>{v}</div>
                  <div className="truncate" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{s}</div>
                </div>
              ))}
            </div>
            {/* Тело: слева вкладки-аналитика, справа касса + действия + расходы */}
            <div className="flex flex-wrap" style={{ gap: 'var(--pv-gap)', alignItems: 'flex-start' }}>
              <div className="flex-1 flex flex-col" style={{ minWidth: 'clamp(15rem,40vw,30rem)', gap: 'var(--pv-gap)' }}>
                {/* Вкладки */}
                <div className="flex items-center flex-wrap rounded-2xl" style={{ background: 'var(--pv-bg)', padding: '5px', gap: '4px' }}>
                  {([['summary', 'Сводка', null], ['waiters', 'Официанты', zr?.salesByWaiter.length || null], ['service', 'Обслуживание', svcRows.filter(r => r.toPay > 0).length || null], ['ops', 'Операции', ops.length || null]] as const).map(([t, l, badge]) => { const on = tab === t; return (
                    <button key={t} onClick={() => setTab(t)} className="flex items-center gap-2 rounded-xl font-semibold" style={{ background: on ? 'var(--pv-card)' : 'transparent', color: on ? 'var(--pv-brand)' : 'var(--pv-text-2)', boxShadow: on ? '0 2px 6px rgba(0,0,0,0.08)' : 'none', padding: 'clamp(0.5rem,0.8vw,0.7rem) clamp(0.8rem,1.2vw,1.1rem)', fontSize: 'calc(var(--pv-ctl) - 0.02rem)' }}>
                      {l}{badge ? <span className="rounded-md font-bold" style={{ background: on ? 'var(--pv-brand-soft)' : 'var(--pv-card)', color: on ? 'var(--pv-brand)' : 'var(--pv-text-3)', padding: '0.05rem 0.4rem', fontSize: '0.65rem' }}>{badge}</span> : null}
                    </button>
                  ) })}
                </div>
                {!zr ? (
                  <div className="rounded-2xl flex items-center justify-center text-center" style={{ background: 'var(--pv-card)', border: '1px dashed var(--pv-border)', padding: '2.5rem', color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>Аналитика появится после продаж.</div>
                ) : tab === 'summary' ? (
                  <>
                    {/* Оплата по способам */}
                    <div className="rounded-2xl flex flex-col" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1rem,1.5vw,1.4rem)', gap: '0.9rem' }}>
                      <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.35vw,1.15rem)' }}>Оплата по способам</div>
                      {zr.revenueByMethod.length === 0 ? <span style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>Нет продаж</span> : zr.revenueByMethod.map((r, i) => { const pct = curRevenue > 0 ? Math.round(r.total / curRevenue * 100) : 0; const cash = r.paymentMethod === 'cash'; return (
                        <div key={i} className="flex flex-col" style={{ gap: '0.35rem' }}>
                          <div className="flex items-center justify-between">
                            <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'calc(var(--pv-ctl) - 0.02rem)' }}>{r.accountName || (cash ? 'Наличные' : 'Безналичные')} · {pct}%</span>
                            <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(r.total)}</span>
                          </div>
                          <div className="rounded-full overflow-hidden" style={{ background: 'var(--pv-bg)', height: '0.5rem' }}><div style={{ width: `${pct}%`, height: '100%', background: cash ? 'var(--pv-free-dot)' : 'var(--pv-brand)' }} /></div>
                        </div>
                      ) })}
                      <div style={{ height: '1px', background: 'var(--pv-border)' }} />
                      <div className="flex items-center justify-between"><span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Выручка</span><span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(curRevenue)}</span></div>
                      <div className="flex items-center justify-between"><span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Расход</span><span className="font-semibold" style={{ color: 'var(--pv-occ-text)', fontSize: 'var(--pv-ctl)' }}>−{formatCurrency(zr.expensesTotal)}</span></div>
                      {zr.withdrawals > 0 && <div className="flex items-center justify-between"><span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Изъятия</span><span className="font-semibold" style={{ color: 'var(--pv-occ-text)', fontSize: 'var(--pv-ctl)' }}>−{formatCurrency(zr.withdrawals)}</span></div>}
                      {zr.refundsCount > 0 && <div className="flex items-center justify-between"><span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Возвраты · {zr.refundsCount} чек{zr.refundsCount === 1 ? '' : zr.refundsCount < 5 ? 'а' : 'ов'}</span><span className="font-semibold" style={{ color: 'var(--pv-occ-text)', fontSize: 'var(--pv-ctl)' }}>−{formatCurrency(zr.refundsTotal)}</span></div>}
                      <div className="flex items-center justify-between"><span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.3vw,1.1rem)' }}>Итог</span><span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.05rem,1.4vw,1.25rem)' }}>{formatCurrency(curRevenue - zr.expensesTotal - zr.withdrawals - zr.refundsTotal)}</span></div>
                    </div>
                    {/* Категории + блюда */}
                    <div className="flex flex-wrap" style={{ gap: 'var(--pv-gap)' }}>
                      <div className="flex-1 rounded-2xl flex flex-col" style={{ minWidth: '13rem', background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1rem,1.5vw,1.4rem)', gap: '0.65rem' }}>
                        <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.35vw,1.15rem)' }}>Продажи по категориям</div>
                        {zr.salesByCategory.length === 0 ? <span style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>—</span> : zr.salesByCategory.slice(0, 8).map((r, i) => (
                          <div key={i} className="flex items-center justify-between gap-2"><span className="truncate" style={{ color: 'var(--pv-text-2)', fontSize: 'calc(var(--pv-ctl) - 0.02rem)' }}>{r.name} · {r.qty}</span><span className="font-semibold shrink-0" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(r.total)}</span></div>
                        ))}
                      </div>
                      <div className="flex-1 rounded-2xl flex flex-col" style={{ minWidth: '13rem', background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1rem,1.5vw,1.4rem)', gap: '0.65rem' }}>
                        <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.35vw,1.15rem)' }}>Проданные блюда</div>
                        {zr.salesByItem.length === 0 ? <span style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>—</span> : zr.salesByItem.slice(0, 8).map((r, i) => (
                          <div key={i} className="flex items-center justify-between gap-2"><span className="truncate" style={{ color: 'var(--pv-text-2)', fontSize: 'calc(var(--pv-ctl) - 0.02rem)' }}>{r.name} ×{r.qty}</span><span className="font-semibold shrink-0" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(r.total)}</span></div>
                        ))}
                      </div>
                    </div>
                    {/* По типу заказа */}
                    <div className="rounded-2xl flex flex-col" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1rem,1.5vw,1.4rem)', gap: '0.6rem' }}>
                      <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.35vw,1.15rem)' }}>По типу заказа</div>
                      {zr.salesByOrderType.map((r, i) => (
                        <div key={i} className="flex items-center justify-between"><span style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>{r.type === 'hall' ? 'В зале' : r.type === 'takeaway' ? 'С собой' : r.type === 'delivery' ? 'Доставка' : r.type} · {r.ordersCount}</span><span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(r.total)}</span></div>
                      ))}
                    </div>
                  </>
                ) : tab === 'waiters' ? (
                  <div className="rounded-2xl flex flex-col" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1rem,1.5vw,1.4rem)', gap: '0.6rem' }}>
                    <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.35vw,1.15rem)' }}>Продажи по официантам</div>
                    {zr.salesByWaiter.length === 0 ? <span style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>Нет данных</span> : zr.salesByWaiter.map((w, i) => (
                      <div key={i} className="flex items-center gap-3 rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.6rem 0.8rem' }}>
                        <div className="rounded-full flex items-center justify-center font-bold shrink-0" style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', width: '2.3rem', height: '2.3rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{svcInitials(w.name)}</div>
                        <div className="flex-1 min-w-0"><div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{w.name}</div><div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>{w.ordersCount} зак. · ср. {formatCurrency(w.avgCheck)}</div></div>
                        <span className="font-bold shrink-0" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(w.total)}</span>
                      </div>
                    ))}
                  </div>
                ) : tab === 'service' ? (
                  <div className="rounded-2xl flex flex-col" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1rem,1.5vw,1.4rem)', gap: '0.6rem' }}>
                    <div className="flex items-center justify-between"><span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.35vw,1.15rem)' }}>Обслуживание официантов</span>{svcToPay > 0 && <span className="rounded-full font-bold" style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', padding: '0.2rem 0.7rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>к выплате {formatCurrency(svcToPay)}</span>}</div>
                    {svcRows.length === 0 ? <span style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>Нет начислений в этой смене</span> : svcRows.map(r => (
                      <div key={r.waiterId} className="flex items-center gap-3 rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.6rem 0.8rem' }}>
                        <div className="rounded-full flex items-center justify-center font-bold shrink-0" style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', width: '2.4rem', height: '2.4rem', fontSize: 'var(--pv-ctl)' }}>{svcInitials(r.waiterName)}</div>
                        <div className="flex-1 min-w-0"><div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{r.waiterName}</div><div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>{r.ordersCount} зак. · нач. {formatCurrency(r.accrued)} · вып. {formatCurrency(r.paid)}</div></div>
                        {r.toPay > 0 ? (
                          <button disabled={svcPayingId === r.waiterId} onClick={() => payService(r)} className="flex items-center gap-1.5 rounded-xl font-bold text-white shrink-0 disabled:opacity-50 active:scale-95 transition-transform" style={{ background: 'var(--pv-brand)', padding: '0.5rem 0.9rem', fontSize: 'calc(var(--pv-ctl) - 0.02rem)' }}><HandCoins style={{ width: '1rem', height: '1rem' }} />{svcPayingId === r.waiterId ? 'Выплата…' : `Выплатить ${formatCurrency(r.toPay)}`}</button>
                        ) : (
                          <span className="flex items-center gap-1 rounded-xl shrink-0" style={{ background: 'var(--pv-free-soft)', color: 'var(--pv-free-text)', padding: '0.45rem 0.7rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}><Check style={{ width: '1rem', height: '1rem' }} />Выплачено</span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-2xl flex flex-col" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1rem,1.5vw,1.4rem)', gap: '0.5rem' }}>
                    <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.35vw,1.15rem)' }}>Операции смены</div>
                    {ops.length === 0 ? <span style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>Операций пока нет</span> : ops.map(o => { const out = o.type === 'cash_out'; const label = o.type === 'cash_in' ? 'Внесение' : o.category ? `Расход · ${o.category}` : 'Изъятие'; return (
                      <div key={o.id} className="flex items-center gap-3 rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.55rem 0.8rem' }}>
                        <div className="flex-1 min-w-0"><div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{label}</div>{o.description && <div className="truncate" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>{o.description}</div>}</div>
                        <span className="font-bold shrink-0" style={{ color: out ? 'var(--pv-occ-text)' : 'var(--pv-free-text)', fontSize: 'var(--pv-ctl)' }}>{out ? '−' : '+'}{formatCurrency(Number(o.amount))}</span>
                      </div>
                    ) })}
                  </div>
                )}
              </div>
              <div className="shrink-0 flex flex-col" style={{ width: 'clamp(19rem,29vw,25rem)', gap: 'var(--pv-gap)' }}>
                {/* Касса — 2×2 движение + Ожидается */}
                <div className="rounded-2xl flex flex-col" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1rem,1.6vw,1.4rem)', gap: '0.85rem' }}>
                  <div className="flex items-center gap-2"><Wallet style={{ width: '1.2rem', height: '1.2rem', color: 'var(--pv-brand)' }} /><span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.05rem,1.4vw,1.25rem)' }}>Касса</span></div>
                  <div className="grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.6rem' }}>
                    {([['Нач. остаток', openingBalance, 'var(--pv-text)', ''], ['Внесения', cashIn, 'var(--pv-free-text)', '+'], ['Изъятия', withdraw, '#e8890c', '−'], ['Расходы', expenses, 'var(--pv-occ-text)', '−']] as const).map(([l, v, color, sign]) => (
                      <div key={l} className="rounded-xl flex flex-col" style={{ background: 'var(--pv-bg)', padding: '0.65rem 0.75rem', gap: '0.2rem' }}>
                        <span style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>{l}</span>
                        <span className="font-bold" style={{ color, fontSize: 'clamp(0.95rem,1.35vw,1.15rem)' }}>{sign}{formatCurrency(v)}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ height: '1px', background: 'var(--pv-border)' }} />
                  <div className="flex items-center justify-between rounded-xl" style={{ background: 'var(--pv-brand-soft)', padding: '0.8rem 1rem' }}>
                    <span className="font-semibold" style={{ color: 'var(--pv-brand)', fontSize: 'var(--pv-ctl)' }}>Ожидается в кассе</span>
                    <span className="font-bold" style={{ color: 'var(--pv-brand)', fontSize: 'clamp(1.25rem,1.8vw,1.7rem)' }}>{formatCurrency(expected)}</span>
                  </div>
                </div>
                {/* Действия — высокие вертикальные */}
                <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.6rem' }}>
                  {([['cash_in', 'Внесение', ArrowDownToLine, '#17a45e'], ['cash_out', 'Изъятие', ArrowUpFromLine, '#e8890c'], ['expense', 'Расход', ReceiptText, '#e0245a']] as const).map(([a, l, Icon, color]) => (
                    <button key={a} onClick={() => openAction(a)} className="flex flex-col items-center justify-center gap-1.5 rounded-2xl font-bold text-white active:scale-[0.98] transition-transform" style={{ background: color, padding: 'clamp(1rem,1.6vw,1.4rem) 0.4rem', fontSize: 'calc(var(--pv-ctl) - 0.02rem)', boxShadow: `0 4px 12px ${color}44` }}>
                      <Icon style={{ width: '1.6em', height: '1.6em' }} />{l}
                    </button>
                  ))}
                </div>
                {/* Расходы из смены — список + удаление */}
                <div className="rounded-2xl flex flex-col" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1rem,1.6vw,1.4rem)', gap: '0.6rem' }}>
                  <div className="flex items-center justify-between">
                    <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.35vw,1.15rem)' }}>Расходы из смены</span>
                    {expenses > 0 && <span className="rounded-lg font-bold" style={{ background: 'var(--pv-occ-soft)', color: 'var(--pv-occ-text)', padding: '0.15rem 0.6rem', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>Итого {formatCurrency(expenses)}</span>}
                  </div>
                  {expenseOps.length === 0 ? <span style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Расходов пока нет</span> : expenseOps.map(o => (
                    <div key={o.id} className="flex items-center gap-2 rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.55rem 0.7rem' }}>
                      <div className="rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--pv-occ-soft)', width: '2rem', height: '2rem' }}><ReceiptText style={{ width: '1rem', height: '1rem', color: 'var(--pv-occ-text)' }} /></div>
                      <div className="flex-1 min-w-0"><div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'calc(var(--pv-ctl) - 0.02rem)' }}>{o.category}</div>{o.description && <div className="truncate" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.2rem)' }}>{o.description}</div>}</div>
                      <span className="font-bold shrink-0" style={{ color: 'var(--pv-occ-text)', fontSize: 'calc(var(--pv-ctl) - 0.02rem)' }}>−{formatCurrency(Number(o.amount))}</span>
                      <button onClick={() => deleteExpense(o.id)} disabled={busy} className="shrink-0 disabled:opacity-40" style={{ padding: '0.2rem' }} aria-label="Удалить расход"><Trash2 style={{ width: '1rem', height: '1rem', color: 'var(--pv-text-3)' }} /></button>
                    </div>
                  ))}
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
                    {stuckOrders.map(o => { const label = o.type === 'takeaway' ? 'С собой' : o.type === 'delivery' ? 'Доставка' : 'Зал'; return (
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
                      <button key={s.id} onClick={() => openHistZ(s)} className="w-full text-left rounded-2xl active:scale-[0.99] transition-transform" style={{ background: 'var(--pv-bg)', padding: 'clamp(0.7rem,1.1vw,1rem)' }} title="Открыть разбивку смены">
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
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Разбивка прошлой смены (Z-отчёт по тапу в истории) */}
      {histZShift && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => setHistZShift(null)}>
          <div className="rounded-3xl overflow-hidden flex flex-col" style={{ background: 'var(--pv-card)', width: 'clamp(22rem,56vw,44rem)', maxHeight: '88vh', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b shrink-0" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
              <div className="min-w-0">
                <div className="font-bold" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.35rem)', color: 'var(--pv-text)' }}>Разбивка смены</div>
                <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{new Date(histZShift.openedAt).toLocaleString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}{histZShift.closedAt ? ` — ${new Date(histZShift.closedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}` : ''}</div>
              </div>
              <button onClick={() => setHistZShift(null)} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'clamp(0.8rem,1.4vw,1.2rem)', display: 'flex', flexDirection: 'column', gap: 'var(--pv-gap)' }}>
              {histZLoading || !histZ ? (
                <div className="text-center" style={{ color: 'var(--pv-text-3)', padding: '2rem' }}>Загрузка…</div>
              ) : (() => {
                const rev = histZ.cashRevenue + histZ.cardRevenue
                return (<>
                  <div className="grid grid-cols-3" style={{ gap: 'var(--pv-gap)' }}>
                    {([['Выручка', formatCurrency(rev)], ['Заказов', String(histZ.ordersCount)], ['Средний чек', formatCurrency(histZ.avgCheck)]] as const).map(([l, v]) => (
                      <div key={l} className="rounded-2xl" style={{ background: 'var(--pv-bg)', padding: 'clamp(0.7rem,1.1vw,1rem)' }}>
                        <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{l}</div>
                        <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.05rem,1.5vw,1.3rem)' }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-2xl flex flex-col" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.9rem,1.4vw,1.2rem)', gap: '0.6rem' }}>
                    <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Оплата по способам</div>
                    {histZ.revenueByMethod.length === 0 ? <span style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>Нет продаж</span> : histZ.revenueByMethod.map((r, i) => { const cash = r.paymentMethod === 'cash'; return (
                      <div key={i} className="flex items-center justify-between"><span style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>{r.accountName || (cash ? 'Наличные' : 'Безналичные')}</span><span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(r.total)}</span></div>
                    ) })}
                    <div style={{ height: '1px', background: 'var(--pv-border)' }} />
                    <div className="flex items-center justify-between"><span style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Расход</span><span className="font-semibold" style={{ color: 'var(--pv-occ-text)', fontSize: 'var(--pv-ctl)' }}>−{formatCurrency(histZ.expensesTotal)}</span></div>
                    {histZ.refundsCount > 0 && <div className="flex items-center justify-between"><span style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Возвраты · {histZ.refundsCount} чек{histZ.refundsCount === 1 ? '' : histZ.refundsCount < 5 ? 'а' : 'ов'}</span><span className="font-semibold" style={{ color: 'var(--pv-occ-text)', fontSize: 'var(--pv-ctl)' }}>−{formatCurrency(histZ.refundsTotal)}</span></div>}
                    <div className="flex items-center justify-between"><span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Итог</span><span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.3vw,1.15rem)' }}>{formatCurrency(rev - histZ.expensesTotal - histZ.refundsTotal)}</span></div>
                  </div>
                  <div className="flex flex-wrap" style={{ gap: 'var(--pv-gap)' }}>
                    <div className="flex-1 rounded-2xl flex flex-col" style={{ minWidth: '12rem', background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.9rem,1.4vw,1.2rem)', gap: '0.5rem' }}>
                      <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>По категориям</div>
                      {histZ.salesByCategory.length === 0 ? <span style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>—</span> : histZ.salesByCategory.map((r, i) => (
                        <div key={i} className="flex items-center justify-between gap-2"><span className="truncate" style={{ color: 'var(--pv-text-2)', fontSize: 'calc(var(--pv-ctl) - 0.02rem)' }}>{r.name} · {r.qty}</span><span className="font-semibold shrink-0" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(r.total)}</span></div>
                      ))}
                    </div>
                    <div className="flex-1 rounded-2xl flex flex-col" style={{ minWidth: '12rem', background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.9rem,1.4vw,1.2rem)', gap: '0.5rem' }}>
                      <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Проданные блюда</div>
                      {histZ.salesByItem.length === 0 ? <span style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>—</span> : histZ.salesByItem.map((r, i) => (
                        <div key={i} className="flex items-center justify-between gap-2"><span className="truncate" style={{ color: 'var(--pv-text-2)', fontSize: 'calc(var(--pv-ctl) - 0.02rem)' }}>{r.name} ×{r.qty}</span><span className="font-semibold shrink-0" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(r.total)}</span></div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-2xl flex flex-col" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.9rem,1.4vw,1.2rem)', gap: '0.5rem' }}>
                    <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>По типу заказа</div>
                    {histZ.salesByOrderType.map((r, i) => (
                      <div key={i} className="flex items-center justify-between"><span style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>{r.type === 'hall' ? 'В зале' : r.type === 'takeaway' ? 'С собой' : r.type === 'delivery' ? 'Доставка' : r.type} · {r.ordersCount}</span><span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(r.total)}</span></div>
                    ))}
                  </div>
                  {histZ.salesByWaiter.length > 0 && (
                    <div className="rounded-2xl flex flex-col" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.9rem,1.4vw,1.2rem)', gap: '0.5rem' }}>
                      <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>По официантам</div>
                      {histZ.salesByWaiter.map((w, i) => (
                        <div key={i} className="flex items-center justify-between gap-2"><span className="truncate" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>{w.name} · {w.ordersCount} зак.</span><span className="font-semibold shrink-0" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(w.total)}</span></div>
                      ))}
                    </div>
                  )}
                </>)
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
    </PinSection>
  )
}
