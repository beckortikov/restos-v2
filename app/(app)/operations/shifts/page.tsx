'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency } from '@/lib/helpers'
import { dAdd, dSub, dSum } from '@/lib/decimal'
import { type CashShift, type CashShiftOperation, type FinancialAccount } from '@/lib/types'
import { fetchActiveShift, fetchShifts, openShift, closeShift, addShiftOperation, createShiftExpense, deleteShiftExpense, fetchShiftOperations, fetchShiftRevenue, fetchShiftZReport, fetchFinancialAccounts, fetchUsers, fetchServiceAccrualByShift, fetchServicePayoutByShift, payServiceCharge, type ShiftZReport } from '@/lib/queries'
import { Play, Square, ArrowDownToLine, ArrowUpFromLine, Clock, Receipt, ChevronDown, ChevronRight, ShoppingBag, Wallet, Banknote, HandCoins, FileDown, Trash2, Users, BarChart3, Tag, MapPin, CreditCard } from 'lucide-react'
import { exportShiftToXlsx } from '@/lib/shift-export'
import { toast } from 'sonner'
import { DecimalInput } from '@/components/ui/decimal-input'
import { useDataSync } from '@/hooks/use-data-sync'

const EXPENSE_CATEGORIES = ['Закупка продуктов', 'Зарплата', 'Ремонт', 'Транспорт', 'Хозтовары', 'Прочие расходы']

export default function ShiftsPage() {
  const { user, canDo } = useAuth()
  const [activeShift, setActiveShift] = useState<CashShift | null>(null)
  const [shiftOps, setShiftOps] = useState<CashShiftOperation[]>([])
  const [history, setHistory] = useState<CashShift[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedShift, setExpandedShift] = useState<string | null>(null)
  const [expandedOps, setExpandedOps] = useState<CashShiftOperation[]>([])

  // Фильтр истории смен.
  const [historyPeriod, setHistoryPeriod] = useState<'7d' | '30d' | 'all'>('7d')
  const [historySearch, setHistorySearch] = useState('')

  // Live revenue for active shift
  const [liveRevenue, setLiveRevenue] = useState<{ cashRevenue: number; cardRevenue: number; ordersCount: number; avgCheck: number }>({ cashRevenue: 0, cardRevenue: 0, ordersCount: 0, avgCheck: 0 })

  // Z-report (полная разбивка: способы оплаты, категории, типы заказов, официанты, гостей).
  // Подтягиваем для активной смены параллельно с liveRevenue, обновляем по SSE.
  const [zReport, setZReport] = useState<ShiftZReport | null>(null)

  // Tab внутри активной смены: «Сводка» / «Официанты» (frame «15» / «16»).
  const [activeTab, setActiveTab] = useState<'summary' | 'waiters'>('summary')

  // Cash accounts for shift linkage
  const [cashAccounts, setCashAccounts] = useState<FinancialAccount[]>([])

  // Open shift form
  const [showOpen, setShowOpen] = useState(false)
  const [openBalance, setOpenBalance] = useState(0)
  const [openAccountId, setOpenAccountId] = useState<string>('')

  // Close shift form
  const [showClose, setShowClose] = useState(false)
  const [closeBalance, setCloseBalance] = useState(0)

  // Cash operation form
  const [showOp, setShowOp] = useState<'cash_in' | 'cash_out' | null>(null)
  const [opAmount, setOpAmount] = useState(0)
  const [opDesc, setOpDesc] = useState('')

  // Shift expense form
  const [showExpense, setShowExpense] = useState(false)
  const [expAmount, setExpAmount] = useState(0)
  const [expCategory, setExpCategory] = useState(EXPENSE_CATEGORIES[0])
  const [expDesc, setExpDesc] = useState('')

  // Service-charge accruals during the active shift
  const [waiterServiceRows, setWaiterServiceRows] = useState<Array<{
    waiterId: string; waiterName: string; ordersCount: number; accrued: number; paid: number; toPay: number
  }>>([])
  const [payingService, setPayingService] = useState<string | null>(null)

  const loadServiceRows = useCallback(async (shift: CashShift) => {
    // Раньше тянули по периоду (shift.openedAt..now) — но fetchServiceAccrualByWaiter
    // фильтрует по closed_at без shift_id, и в активной смене показывался долг с
    // прошлых смен (если их обслуживание не выплатили). Теперь — строго по shift_id
    // текущей смены. Для исторических периодов остаётся отчёт /finance/service-report.
    const [accrual, payout, users] = await Promise.all([
      fetchServiceAccrualByShift(shift.id),
      fetchServicePayoutByShift(shift.id),
      fetchUsers(),
    ])
    const userMap = new Map(users.map(u => [u.id, u.name]))
    const rows = accrual
      .filter(r => r.waiterId)
      .map(r => {
        const wid = r.waiterId as string
        const paid = payout[wid] ?? 0
        return {
          waiterId: wid,
          waiterName: userMap.get(wid) ?? 'Неизвестно',
          ordersCount: r.ordersCount,
          accrued: r.accrued,
          paid,
          toPay: Math.max(0, r.accrued - paid),
        }
      })
      .sort((a, b) => b.toPay - a.toPay)
    setWaiterServiceRows(rows)
  }, [])

  const reload = useCallback(async () => {
    const [active, hist] = await Promise.all([fetchActiveShift(), fetchShifts()])
    setActiveShift(active)
    setHistory(hist.filter(s => s.status === 'closed'))
    if (active) {
      const [ops, rev, zr] = await Promise.all([
        fetchShiftOperations(active.id),
        fetchShiftRevenue(active.id),
        fetchShiftZReport(active.id).catch(() => null),
      ])
      setShiftOps(ops)
      setLiveRevenue(rev)
      setZReport(zr)
      await loadServiceRows(active)
    } else {
      setShiftOps([])
      setLiveRevenue({ cashRevenue: 0, cardRevenue: 0, ordersCount: 0, avgCheck: 0 })
      setZReport(null)
      setWaiterServiceRows([])
    }
  }, [loadServiceRows])

  useEffect(() => {
    reload().finally(() => setLoading(false))
    fetchFinancialAccounts().then(accs => {
      const cashOnly = accs.filter(a => a.type === 'cash')
      setCashAccounts(cashOnly)
      if (cashOnly.length > 0) setOpenAccountId(cashOnly[0].id)
    }).catch(() => {})
  }, [reload])

  const filteredHistory = useMemo(() => {
    const now = Date.now()
    const cutoff = historyPeriod === '7d'
      ? now - 7 * 24 * 60 * 60 * 1000
      : historyPeriod === '30d'
        ? now - 30 * 24 * 60 * 60 * 1000
        : 0
    const q = historySearch.trim().toLowerCase()
    return history.filter(s => {
      if (cutoff > 0 && new Date(s.closedAt ?? s.openedAt).getTime() < cutoff) return false
      if (q) {
        const hay = [s.openedByName, s.closedByName, s.accountName].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [history, historyPeriod, historySearch])

  const expectedAtClose = useMemo(() => {
    if (!activeShift) return 0
    const cashIn = dSum(shiftOps.filter(o => o.type === 'cash_in').map(o => o.amount))
    const cashOut = dSum(shiftOps.filter(o => o.type === 'cash_out').map(o => o.amount))
    return dSub(dAdd(dAdd(activeShift.openingBalance, liveRevenue.cashRevenue), cashIn), cashOut)
  }, [activeShift, shiftOps, liveRevenue.cashRevenue])

  // SSE-driven auto-refresh — заменяет polling каждые 2с активной смены.
  // Live revenue зависит от заказов (closeOrder) и операций смены.
  const liveRefresh = useCallback(() => {
    if (!activeShift) { reload().catch(console.error); return }
    fetchShiftRevenue(activeShift.id).then(setLiveRevenue).catch(() => {})
    fetchShiftOperations(activeShift.id).then(setShiftOps).catch(() => {})
    fetchShiftZReport(activeShift.id).then(setZReport).catch(() => {})
    loadServiceRows(activeShift).catch(() => {})
  }, [activeShift, reload, loadServiceRows])
  useDataSync(
    ['cash_shifts', 'cash_shift_operations', 'orders', 'financial_operations'],
    liveRefresh,
  )

  const handlePayService = async (row: { waiterId: string; waiterName: string; toPay: number }) => {
    if (!activeShift || row.toPay <= 0) return
    if (!activeShift.accountId || !activeShift.accountName) {
      toast.error('У смены не указан счёт — нельзя выплатить наличными')
      return
    }
    setPayingService(row.waiterId)
    try {
      await payServiceCharge({
        waiterId: row.waiterId,
        waiterName: row.waiterName,
        amount: row.toPay,
        accountId: activeShift.accountId,
        accountName: activeShift.accountName,
        periodFrom: activeShift.openedAt,
        periodTo: new Date().toISOString(),
        shiftId: activeShift.id,
      })
      toast.success(`Выплачено ${formatCurrency(row.toPay)}: ${row.waiterName}`)
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка выплаты')
    } finally {
      setPayingService(null)
    }
  }

  const handleOpen = async () => {
    if (!user) return
    try {
      await openShift(user.id, openBalance, openAccountId || undefined)
      toast.success('Смена открыта')
      setShowOpen(false)
      setOpenBalance(0)
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка открытия смены')
    }
  }

  const handleExpense = async () => {
    if (!activeShift || expAmount <= 0) return
    try {
      await createShiftExpense(activeShift.id, expAmount, expCategory, expDesc, user?.id)
      toast.success('Расход оформлен')
      setShowExpense(false)
      setExpAmount(0)
      setExpDesc('')
      setExpCategory(EXPENSE_CATEGORIES[0])
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    }
  }

  const handleDeleteExpense = async (opId: string, amount: number, description?: string) => {
    const ok = window.confirm(
      `Удалить расход «${description ?? 'Расход'}» на сумму ${formatCurrency(amount)}? ` +
      `Это действие нельзя отменить, баланс счёта будет скорректирован.`
    )
    if (!ok) return
    try {
      await deleteShiftExpense(opId)
      toast.success('Расход удалён')
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка удаления расхода')
    }
  }

  const handleClose = async () => {
    if (!activeShift || !user) return
    const unpaidService = waiterServiceRows.reduce((s, r) => s + r.toPay, 0)
    if (unpaidService > 0) {
      const ok = window.confirm(
        `Не выплачено обслуживание официантам: ${formatCurrency(unpaidService)}.\n` +
        `Закрыть смену без выплаты? Сумма останется в отчёте «Обслуживание».`
      )
      if (!ok) return
    }
    try {
      await closeShift(activeShift.id, user.id, closeBalance)
      toast.success('Смена закрыта')
      // Полный сброс локальных стейтов всех форм — иначе после закрытия
      // у формы открытия новой смены input «зависает» (стейт DecimalInput
      // и openAccountId висят со старыми значениями, кнопки не реагируют).
      setShowClose(false)
      setCloseBalance(0)
      setShowOpen(false)
      setOpenBalance(0)
      setShowOp(null)
      setOpAmount(0)
      setOpDesc('')
      setShowExpense(false)
      setExpAmount(0)
      setExpDesc('')
      // Восстанавливаем дефолтный счёт открытия (первый cash) — иначе после закрытия
      // openAccountId остаётся id уже закрытой смены и openShift падает.
      if (cashAccounts.length > 0) setOpenAccountId(cashAccounts[0].id)
      else setOpenAccountId('')
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? `Ошибка закрытия смены: ${e.message}` : 'Ошибка закрытия смены')
    }
  }

  const handleOp = async () => {
    if (!activeShift || !showOp || opAmount <= 0) return
    try {
      await addShiftOperation(activeShift.id, showOp, opAmount, opDesc, user?.id)
      toast.success(showOp === 'cash_in' ? 'Внесение оформлено' : 'Изъятие оформлено')
      setShowOp(null)
      setOpAmount(0)
      setOpDesc('')
      await reload()
    } catch {
      toast.error('Ошибка')
    }
  }

  const handleExpandHistory = async (shiftId: string) => {
    if (expandedShift === shiftId) {
      setExpandedShift(null)
      return
    }
    setExpandedShift(shiftId)
    const ops = await fetchShiftOperations(shiftId)
    setExpandedOps(ops)
  }

  const formatDuration = (start: string, end?: string) => {
    const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()
    const hrs = Math.floor(ms / 3600000)
    const mins = Math.floor((ms % 3600000) / 60000)
    return `${hrs}ч ${mins}м`
  }

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  if (!canDo('shifts.manage')) {
    return <div className="p-6 flex items-center justify-center h-64"><p className="text-muted-foreground">Нет доступа</p></div>
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 md:p-6 space-y-5 max-w-7xl mx-auto pb-24">
      <div className="sticky top-0 z-10 -mx-4 -mt-4 px-4 pt-4 pb-3 md:-mx-6 md:-mt-6 md:px-6 md:pt-6 md:pb-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border mb-1">
        <h1 className="text-xl font-bold text-foreground">Кассовые смены</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Управление сменами и кассовыми операциями</p>
      </div>

      {/* Active shift or open button */}
      {activeShift ? (
        <div className="bg-card rounded-xl border-2 border-primary/30 p-4 md:p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full bg-emerald-500" />
                <h2 className="font-semibold text-foreground">Смена открыта</h2>
                <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-md font-medium">Активна</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-muted-foreground">
                <span className="flex items-center gap-1"><Clock className="size-3.5" />{formatDuration(activeShift.openedAt)}</span>
                <span>Открыл: {activeShift.openedByName || '—'}</span>
                <span>{new Date(activeShift.openedAt).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                {activeShift.accountName && (
                  <span className="flex items-center gap-1 text-primary font-medium">
                    <Wallet className="size-3.5" />{activeShift.accountName}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => { exportShiftToXlsx(activeShift).catch(e => toast.error(e instanceof Error ? e.message : 'Ошибка экспорта')) }}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-card border border-border text-foreground rounded-lg text-xs font-medium hover:bg-muted transition-colors whitespace-nowrap"
                title="Экспорт текущей смены в Excel"
              >
                <FileDown className="size-3.5" />Excel
              </button>
            <button
              onClick={() => { setShowClose(true); setCloseBalance(0) }}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-destructive text-destructive-foreground rounded-lg text-xs font-medium hover:bg-destructive/90 transition-colors whitespace-nowrap"
            >
              <Square className="size-3.5" />Закрыть смену
            </button>
            </div>
          </div>

          {/* KPI cards — iiko-style: Выручка / Средний чек / Заказов / Гостей */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-muted/50 rounded-lg p-3">
              <p className="text-xs text-muted-foreground">Выручка</p>
              <p className="text-lg font-bold text-primary">{formatCurrency(liveRevenue.cashRevenue + liveRevenue.cardRevenue)}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Нал {formatCurrency(liveRevenue.cashRevenue)} · Безнал {formatCurrency(liveRevenue.cardRevenue)}
              </p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3">
              <p className="text-xs text-muted-foreground">Средний чек</p>
              <p className="text-lg font-bold text-foreground">{formatCurrency(liveRevenue.avgCheck)}</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><ShoppingBag className="size-3" />Заказов</p>
              <p className="text-lg font-bold text-foreground">{liveRevenue.ordersCount}</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Users className="size-3" />Гостей</p>
              <p className="text-lg font-bold text-foreground">{zReport?.guestsCount ?? 0}</p>
              {(zReport?.guestsCount ?? 0) > 0 && (
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Ср. на гостя {formatCurrency((liveRevenue.cashRevenue + liveRevenue.cardRevenue) / Math.max(1, zReport?.guestsCount ?? 0))}
                </p>
              )}
            </div>
          </div>

          {/* Tabs «Сводка» / «Официанты» */}
          <div className="flex items-center gap-1 border-b border-border -mb-2">
            <button
              onClick={() => setActiveTab('summary')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'summary'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              <BarChart3 className="inline-block size-3.5 mr-1.5 -mt-0.5" />Сводка
            </button>
            <button
              onClick={() => setActiveTab('waiters')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'waiters'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              <Users className="inline-block size-3.5 mr-1.5 -mt-0.5" />Официанты
              {zReport && zReport.salesByWaiter.length > 0 && (
                <span className="ml-1.5 text-[11px] text-muted-foreground">({zReport.salesByWaiter.length})</span>
              )}
            </button>
          </div>

          {activeTab === 'summary' ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* Оплата по способам */}
              <div className="bg-muted/40 rounded-xl p-4 border border-border">
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1.5"><CreditCard className="size-3.5 text-muted-foreground" />Оплата по способам</h3>
                {!zReport || zReport.revenueByMethod.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Закрытых заказов пока нет</p>
                ) : (
                  <div className="space-y-1.5 text-sm">
                    {zReport.revenueByMethod.map(m => {
                      const label = m.paymentMethod === 'cash' ? 'Наличные'
                        : m.paymentMethod === 'card' ? 'Банк. карта'
                        : m.paymentMethod === 'transfer' ? 'Перевод'
                        : m.paymentMethod || '—'
                      return (
                        <div key={m.paymentMethod || 'unknown'} className="flex items-center justify-between">
                          <span className="text-muted-foreground">{label} <span className="text-[11px]">({m.ordersCount})</span></span>
                          <span className="font-medium text-foreground tabular-nums">{formatCurrency(m.total)}</span>
                        </div>
                      )
                    })}
                    <div className="border-t border-border pt-1.5 mt-1.5 flex items-center justify-between font-semibold">
                      <span>Итого</span>
                      <span className="tabular-nums">{formatCurrency(zReport.revenueByMethod.reduce((s, m) => s + m.total, 0))}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Продажи по категориям */}
              <div className="bg-muted/40 rounded-xl p-4 border border-border">
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1.5"><Tag className="size-3.5 text-muted-foreground" />Продажи по категориям</h3>
                {!zReport || zReport.salesByCategory.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Закрытых заказов пока нет</p>
                ) : (
                  <div className="space-y-1.5 text-sm">
                    {zReport.salesByCategory.slice(0, 8).map(c => (
                      <div key={c.name} className="flex items-center justify-between">
                        <span className="text-muted-foreground truncate pr-2">{c.name} <span className="text-[11px]">({c.qty} шт)</span></span>
                        <span className="font-medium text-foreground tabular-nums">{formatCurrency(c.total)}</span>
                      </div>
                    ))}
                    {zReport.salesByCategory.length > 8 && (
                      <p className="text-[11px] text-muted-foreground italic pt-1">…и ещё {zReport.salesByCategory.length - 8}</p>
                    )}
                  </div>
                )}
              </div>

              {/* По типу заказа */}
              <div className="bg-muted/40 rounded-xl p-4 border border-border">
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1.5"><MapPin className="size-3.5 text-muted-foreground" />По типу заказа</h3>
                {!zReport || zReport.salesByOrderType.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Закрытых заказов пока нет</p>
                ) : (
                  <div className="space-y-1.5 text-sm">
                    {zReport.salesByOrderType.map(t => {
                      const label = t.type === 'hall' ? 'В зале'
                        : t.type === 'takeaway' ? 'С собой'
                        : t.type === 'delivery' ? 'Доставка'
                        : t.type
                      return (
                        <div key={t.type} className="flex items-center justify-between">
                          <span className="text-muted-foreground">{label} <span className="text-[11px]">({t.ordersCount})</span></span>
                          <span className="font-medium text-foreground tabular-nums">{formatCurrency(t.total)}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* Tab «Официанты» — per-waiter breakdown по frame «16. Официанты» */
            <div className="bg-muted/40 rounded-xl border border-border overflow-hidden">
              {!zReport || zReport.salesByWaiter.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  Пока нет закрытых заказов с привязкой к официанту
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border">
                        <th className="text-left px-3 py-2.5 font-semibold">Официант</th>
                        <th className="text-right px-3 py-2.5 font-semibold">Заказов</th>
                        <th className="text-right px-3 py-2.5 font-semibold">Продажи</th>
                        <th className="text-right px-3 py-2.5 font-semibold">Ср. чек</th>
                      </tr>
                    </thead>
                    <tbody>
                      {zReport.salesByWaiter.map(w => (
                        <tr key={w.waiterId} className="border-b border-border/50 last:border-b-0">
                          <td className="px-3 py-2.5 text-foreground font-medium">{w.name}</td>
                          <td className="px-3 py-2.5 text-right text-muted-foreground tabular-nums">{w.ordersCount}</td>
                          <td className="px-3 py-2.5 text-right text-foreground font-medium tabular-nums">{formatCurrency(w.total)}</td>
                          <td className="px-3 py-2.5 text-right text-muted-foreground tabular-nums">{formatCurrency(w.avgCheck)}</td>
                        </tr>
                      ))}
                      <tr className="bg-muted/60 font-semibold">
                        <td className="px-3 py-2.5">Итого</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{zReport.salesByWaiter.reduce((s, w) => s + w.ordersCount, 0)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(zReport.salesByWaiter.reduce((s, w) => s + w.total, 0))}</td>
                        <td className="px-3 py-2.5 text-right text-muted-foreground tabular-nums">—</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Cash operations summary */}
          {shiftOps.length > 0 && (
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground">Нач. остаток</p>
                <p className="text-sm font-bold text-foreground">{formatCurrency(activeShift.openingBalance)}</p>
              </div>
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground">Внесения</p>
                <p className="text-sm font-bold text-emerald-600">{formatCurrency(shiftOps.filter(o => o.type === 'cash_in').reduce((s, o) => s + o.amount, 0))}</p>
              </div>
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground">Изъятия</p>
                <p className="text-sm font-bold text-destructive">{formatCurrency(shiftOps.filter(o => o.type === 'cash_out').reduce((s, o) => s + o.amount, 0))}</p>
              </div>
            </div>
          )}

          {/* Service-charge accruals per waiter */}
          {waiterServiceRows.length > 0 && (
            <div className="bg-blue-50/40 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-200 flex items-center gap-1.5">
                  <HandCoins className="size-4" />Обслуживание официантов
                </h3>
                <p className="text-xs text-blue-700 dark:text-blue-300">
                  К выплате: <span className="font-bold">{formatCurrency(waiterServiceRows.reduce((s, r) => s + r.toPay, 0))}</span>
                </p>
              </div>
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase text-blue-700/80 dark:text-blue-300/80">
                      <th className="text-left px-2 py-1 font-semibold">Официант</th>
                      <th className="text-right px-2 py-1 font-semibold">Заказов</th>
                      <th className="text-right px-2 py-1 font-semibold">Начислено</th>
                      <th className="text-right px-2 py-1 font-semibold">Выплачено</th>
                      <th className="text-right px-2 py-1 font-semibold">К выплате</th>
                      <th className="px-2 py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {waiterServiceRows.map(row => (
                      <tr key={row.waiterId} className="border-t border-blue-100 dark:border-blue-900">
                        <td className="px-2 py-2 text-foreground font-medium">{row.waiterName}</td>
                        <td className="px-2 py-2 text-right text-muted-foreground">{row.ordersCount}</td>
                        <td className="px-2 py-2 text-right text-blue-700 dark:text-blue-300">{formatCurrency(row.accrued)}</td>
                        <td className="px-2 py-2 text-right text-muted-foreground">{row.paid > 0 ? formatCurrency(row.paid) : '—'}</td>
                        <td className="px-2 py-2 text-right font-bold text-blue-700 dark:text-blue-300">{formatCurrency(row.toPay)}</td>
                        <td className="px-2 py-2 text-right">
                          <button
                            onClick={() => handlePayService(row)}
                            disabled={row.toPay <= 0 || payingService === row.waiterId}
                            className="px-2.5 py-1 text-[11px] font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md disabled:opacity-40"
                          >
                            {payingService === row.waiterId ? '…' : 'Выплатить'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!activeShift.accountId && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-2">
                  ⚠ У смены не указан счёт — выплата невозможна. Закройте и откройте смену со счётом.
                </p>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => { setShowOp('cash_in'); setOpAmount(0); setOpDesc('') }}
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors"
            >
              <ArrowDownToLine className="size-4" />Внесение
            </button>
            <button
              onClick={() => { setShowOp('cash_out'); setOpAmount(0); setOpDesc('') }}
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 transition-colors"
            >
              <ArrowUpFromLine className="size-4" />Изъятие
            </button>
            <button
              onClick={() => { setShowExpense(true); setExpAmount(0); setExpDesc(''); setExpCategory(EXPENSE_CATEGORIES[0]) }}
              disabled={!activeShift.accountId}
              title={!activeShift.accountId ? 'У смены не указан счёт' : ''}
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-rose-600 text-white rounded-lg text-sm font-medium hover:bg-rose-700 transition-colors disabled:opacity-50"
            >
              <Banknote className="size-4" />Расход
            </button>
          </div>

          {/* Cash operation form */}
          {showOp && (
            <div className="bg-muted/50 rounded-xl p-4 space-y-3 border border-border">
              <p className="text-sm font-medium text-foreground">
                {showOp === 'cash_in' ? 'Внесение наличных' : 'Изъятие наличных'}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Сумма</label>
                  <DecimalInput min={0} value={opAmount} onChange={v => setOpAmount(v)}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Описание</label>
                  <input value={opDesc} onChange={e => setOpDesc(e.target.value)} placeholder="Причина"
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={handleOp} disabled={opAmount <= 0}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                  Подтвердить
                </button>
                <button onClick={() => setShowOp(null)} className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground">Отмена</button>
              </div>
            </div>
          )}

          {/* Shift expense form */}
          {showExpense && (
            <div className="bg-rose-50 dark:bg-rose-950/20 rounded-xl p-4 space-y-3 border border-rose-200 dark:border-rose-900">
              <p className="text-sm font-medium text-foreground">Расход из смены</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Категория</label>
                  <select value={expCategory} onChange={e => setExpCategory(e.target.value)}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                    {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Сумма</label>
                  <DecimalInput min={0} value={expAmount} onChange={v => setExpAmount(v)}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Описание</label>
                <input value={expDesc} onChange={e => setExpDesc(e.target.value)} placeholder="Куда пошли деньги"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <p className="text-[11px] text-muted-foreground">Списание со счёта «{activeShift.accountName || 'Касса'}» и в журнал смены.</p>
              <div className="flex gap-2">
                <button onClick={handleExpense} disabled={expAmount <= 0}
                  className="px-4 py-2 bg-rose-600 text-white rounded-lg text-sm font-medium hover:bg-rose-700 disabled:opacity-50">
                  Провести расход
                </button>
                <button onClick={() => setShowExpense(false)} className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground">Отмена</button>
              </div>
            </div>
          )}

          {/* Close shift form */}
          {showClose && (() => {
            const delta = closeBalance - expectedAtClose
            return (
              <div className="bg-destructive/5 rounded-xl p-4 space-y-3 border border-destructive/20">
                <p className="text-sm font-medium text-foreground">Закрытие смены</p>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="bg-muted/50 rounded-lg p-2.5">
                    <p className="text-xs text-muted-foreground">Ожидается в кассе</p>
                    <p className="font-bold text-foreground">{formatCurrency(expectedAtClose)}</p>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-2.5">
                    <p className="text-xs text-muted-foreground">Разница</p>
                    <p className={`font-bold ${Math.abs(delta) < 0.01 ? 'text-muted-foreground' : delta > 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                      {closeBalance > 0 ? (delta >= 0 ? '+' : '') + formatCurrency(delta) : '—'}
                    </p>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Фактический остаток в кассе</label>
                  <DecimalInput min={0} value={closeBalance} onChange={v => setCloseBalance(v)}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                {closeBalance > 0 && Math.abs(delta) >= 0.01 && activeShift.accountId && (
                  <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 rounded-lg p-2.5">
                    ⚠ Будет создана операция «{delta < 0 ? 'Недостача' : 'Излишек'}» на счёте «{activeShift.accountName || 'Касса'}» на сумму {formatCurrency(Math.abs(delta))}.
                  </p>
                )}
                <div className="flex gap-2">
                  <button onClick={handleClose}
                    className="px-4 py-2 bg-destructive text-destructive-foreground rounded-lg text-sm font-medium hover:bg-destructive/90">
                    Закрыть смену
                  </button>
                  <button onClick={() => setShowClose(false)} className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground">Отмена</button>
                </div>
              </div>
            )
          })()}

          {/* Recent operations */}
          {shiftOps.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Операции смены</h3>
              <div className="space-y-1">
                {shiftOps.map(op => (
                  <div key={op.id} className="flex items-center justify-between px-3 py-2 bg-muted/30 rounded-lg text-sm">
                    <div className="flex items-center gap-2">
                      {op.type === 'cash_in' ? (
                        <ArrowDownToLine className="size-3.5 text-emerald-600" />
                      ) : (
                        <ArrowUpFromLine className="size-3.5 text-destructive" />
                      )}
                      <span className="text-foreground">{op.description || (op.type === 'cash_in' ? 'Внесение' : 'Изъятие')}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`font-medium ${op.type === 'cash_in' ? 'text-emerald-600' : 'text-destructive'}`}>
                        {op.type === 'cash_in' ? '+' : '-'}{formatCurrency(op.amount)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(op.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {op.type === 'cash_out' && (
                        <button
                          onClick={() => handleDeleteExpense(op.id, op.amount, op.description)}
                          title="Удалить расход (баланс счёта будет скорректирован)"
                          className="p-1 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* No active shift — key forces clean remount после закрытия предыдущей смены,
           иначе DecimalInput и состояние формы могут «залипнуть». */
        <div key={`open-form-${history[0]?.id ?? 'fresh'}`} className="bg-card rounded-xl border border-border p-8 text-center space-y-4">
          <Receipt className="size-12 text-muted-foreground/30 mx-auto" />
          <div>
            <p className="font-medium text-foreground">Нет активной смены</p>
            <p className="text-sm text-muted-foreground mt-1">Откройте смену чтобы начать принимать заказы</p>
          </div>

          {!showOpen ? (
            <button
              onClick={() => setShowOpen(true)}
              className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Play className="size-4" />Открыть смену
            </button>
          ) : (
            <div className="max-w-sm mx-auto space-y-3 text-left">
              {cashAccounts.length > 1 && (
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Касса</label>
                  <select value={openAccountId} onChange={e => setOpenAccountId(e.target.value)}
                    className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                    {cashAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              )}
              {cashAccounts.length === 0 && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                  ⚠ В Финансах нет ни одного счёта типа «Касса». Смена откроется без привязки к счёту — операции по смене не попадут в баланс счетов.
                </p>
              )}
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Начальный остаток в кассе</label>
                <DecimalInput min={0} value={openBalance} onChange={v => setOpenBalance(v)}
                  className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div className="flex gap-2 justify-center">
                <button onClick={handleOpen}
                  className="px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90">
                  Открыть
                </button>
                <button onClick={() => setShowOpen(false)} className="px-3 py-2.5 text-sm text-muted-foreground hover:text-foreground">Отмена</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Shift history */}
      {history.length > 0 && (
        <div>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">История смен</h2>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={historySearch}
                onChange={e => setHistorySearch(e.target.value)}
                placeholder="Поиск по официанту/счёту"
                className="px-3 py-1.5 text-xs bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 w-56"
              />
              <div className="flex items-center gap-1 bg-card border border-border rounded-lg p-1">
                {([
                  { value: '7d', label: '7 дней' },
                  { value: '30d', label: '30 дней' },
                  { value: 'all', label: 'Все' },
                ] as const).map(p => (
                  <button
                    key={p.value}
                    onClick={() => setHistoryPeriod(p.value)}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                      historyPeriod === p.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {filteredHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">Смен в выбранном периоде не найдено</p>
          ) : (
          <div className="space-y-2">
            {filteredHistory.map(shift => {
              const isExpanded = expandedShift === shift.id
              const diff = shift.closingBalance != null && shift.expectedCash != null
                ? shift.closingBalance - shift.expectedCash
                : null

              return (
                <div key={shift.id} className="bg-card rounded-xl border border-border overflow-hidden">
                  <div
                    onClick={() => handleExpandHistory(shift.id)}
                    className="flex items-center justify-between px-4 py-3.5 hover:bg-muted/30 transition-colors cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground text-sm">
                          {new Date(shift.openedAt).toLocaleDateString('ru', { day: 'numeric', month: 'short' })}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(shift.openedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
                          {' — '}
                          {shift.closedAt ? new Date(shift.closedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }) : '?'}
                        </span>
                        <span className="text-xs text-muted-foreground">({formatDuration(shift.openedAt, shift.closedAt)})</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs text-muted-foreground">
                        <span>{shift.ordersCount} заказ{shift.ordersCount === 1 ? '' : shift.ordersCount < 5 ? 'а' : 'ов'}</span>
                        <span>Нал: {formatCurrency(shift.cashRevenue)}</span>
                        <span>Безнал: {formatCurrency(shift.cardRevenue)}</span>
                        <span>Ср. чек: {formatCurrency(shift.avgCheck)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-right">
                        <p className="font-bold text-foreground text-sm">{formatCurrency(shift.cashRevenue + shift.cardRevenue)}</p>
                        {diff != null && diff !== 0 && (
                          <p className={`text-xs font-medium ${diff > 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                            {diff > 0 ? '+' : ''}{formatCurrency(diff)}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          exportShiftToXlsx(shift).catch(err =>
                            toast.error(err instanceof Error ? err.message : 'Ошибка экспорта')
                          )
                        }}
                        className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                        title="Экспорт смены в Excel"
                      >
                        <FileDown className="size-4" />
                      </button>
                      {isExpanded ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="px-4 pb-4 border-t border-border bg-muted/20 space-y-3 pt-3">
                      {/* Z-Report summary */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                        <div>
                          <p className="text-xs text-muted-foreground">Открытие</p>
                          <p className="font-medium text-foreground">{formatCurrency(shift.openingBalance)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Закрытие</p>
                          <p className="font-medium text-foreground">{formatCurrency(shift.closingBalance ?? 0)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Ожидалось</p>
                          <p className="font-medium text-foreground">{formatCurrency(shift.expectedCash ?? 0)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Разница</p>
                          <p className={`font-medium ${(diff ?? 0) >= 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                            {diff != null ? (diff >= 0 ? '+' : '') + formatCurrency(diff) : '—'}
                          </p>
                        </div>
                      </div>

                      <div className="text-xs text-muted-foreground">
                        Открыл: {shift.openedByName || '—'} · Закрыл: {shift.closedByName || '—'}
                      </div>

                      {/* Shift operations */}
                      {expandedOps.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-muted-foreground mb-1.5">Кассовые операции</p>
                          <div className="space-y-1">
                            {expandedOps.map(op => (
                              <div key={op.id} className="flex items-center justify-between text-xs px-2 py-1.5 bg-background rounded">
                                <span className="text-foreground">{op.description || (op.type === 'cash_in' ? 'Внесение' : 'Изъятие')}</span>
                                <span className={op.type === 'cash_in' ? 'text-emerald-600 font-medium' : 'text-destructive font-medium'}>
                                  {op.type === 'cash_in' ? '+' : '-'}{formatCurrency(op.amount)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          )}
        </div>
      )}
      </div>
    </div>
  )
}
