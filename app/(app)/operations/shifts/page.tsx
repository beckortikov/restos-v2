'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { OwnerPinGate } from '@/components/owner-pin-gate'
import { formatCurrency } from '@/lib/helpers'
import { dAdd, dSub, dSum } from '@/lib/decimal'
import { type CashShift, type CashShiftOperation, type FinancialAccount, type Order } from '@/lib/types'
import { fetchActiveShift, fetchShifts, openShift, closeShift, addShiftOperation, createShiftExpense, deleteShiftExpense, fetchShiftOperations, fetchShiftRevenue, fetchShiftZReport, fetchFinancialAccounts, fetchUsers, fetchServiceAccrualByShift, fetchServicePayoutByShift, payServiceCharge, patchShiftAccount, printShiftZ, printShiftX, printShiftService, fetchOrders, cancelOrder, type ShiftZReport } from '@/lib/queries'
import { selectableAccounts } from '@/lib/queries/finance'
import { Play, Square, ArrowDownToLine, ArrowUpFromLine, Clock, Receipt, ChevronDown, ChevronRight, ShoppingBag, Wallet, Banknote, HandCoins, FileDown, Trash2, Users, BarChart3, Tag, MapPin, CreditCard, Printer, ArrowUp, ArrowDown, AlertTriangle, Ban } from 'lucide-react'
import { exportShiftToXlsx } from '@/lib/shift-export'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'
import { V4Error } from '@/lib/api'
import { DecimalInput } from '@/components/ui/decimal-input'
import { useDataSync } from '@/hooks/use-data-sync'
import { OnScreenKeyboard } from '@/components/on-screen-keyboard'
import { confirmDialog } from '@/lib/confirm'

const EXPENSE_CATEGORIES = ['Закупка продуктов', 'Зарплата', 'Ремонт', 'Транспорт', 'Хозтовары', 'Прочие расходы']

// Внутренняя метка авто-зеркал cash_out (возврат/выплата/списание со счёта),
// которую ставит бэк при оттоке денег со счёта открытой смены. Возврат-зеркало
// (описание «Возврат заказа #…») выносим в отдельную строку «Возвраты», прочие
// авто-зеркала показываем как «Списание со счёта» — сырую метку не светим.
const AUTO_MIRROR_CAT = '__auto_mirror__'
const REFUND_DESC_PREFIX = 'Возврат заказа #'

// склонение слова «чек» по количеству (1 чек, 2 чека, 5 чеков).
function checksWord(n: number): string {
  const d = n % 10, dd = n % 100
  if (d === 1 && dd !== 11) return 'чек'
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'чека'
  return 'чеков'
}

// DeltaChip — маленький бейдж «↑ +5% к прошлой смене» под KPI-числом.
// Серый «—» если предыдущее значение 0 (деление на ноль) или previous отсутствует.
function DeltaChip({ current, previous, hasPrevious }: { current: number; previous: number; hasPrevious: boolean }) {
  if (!hasPrevious) return null
  if (!Number.isFinite(previous) || previous === 0) {
    return <p className="text-[11px] text-muted-foreground mt-0.5">— к прошлой смене</p>
  }
  const delta = ((current - previous) / Math.abs(previous)) * 100
  const isUp = delta >= 0
  const cls = isUp ? 'text-emerald-600' : 'text-rose-600'
  const Icon = isUp ? ArrowUp : ArrowDown
  const sign = isUp ? '+' : '−'
  const abs = Math.abs(delta)
  return (
    <p className={`text-[11px] mt-0.5 flex items-center gap-0.5 ${cls}`}>
      <Icon className="size-3" />
      <span className="font-medium">{sign}{abs < 10 ? abs.toFixed(1) : Math.round(abs)}%</span>
      <span className="text-muted-foreground"> к прошлой смене</span>
    </p>
  )
}

// ClosedShiftZBreakdown — полная разбивка Z-отчёта для ЗАКРЫТОЙ смены в истории.
// Тот же набор, что в своде активной смены (методы оплаты / категории / блюда /
// тип заказа / расходы / официанты), но источник — fetchShiftZReport(shiftId),
// а не live-стейт. Раньше в истории раскрывались только Открытие/Закрытие +
// кассовые операции; полный отчёт был доступен лишь в новом ПОС.
function ClosedShiftZBreakdown({ z, loading }: { z: ShiftZReport | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
        <div className="size-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        Загрузка Z-отчёта…
      </div>
    )
  }
  if (!z) return <p className="text-xs text-muted-foreground py-2">Z-отчёт недоступен</p>
  const revenueTotal = z.revenueByMethod.reduce((s, m) => s + m.total, 0)
  return (
    <div className="space-y-3">
      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        <div className="bg-background rounded-lg p-2.5">
          <p className="text-xs text-muted-foreground">Выручка</p>
          <p className="font-bold text-primary tabular-nums">{formatCurrency(z.cashRevenue + z.cardRevenue)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">Нал {formatCurrency(z.cashRevenue)} · Безнал {formatCurrency(z.cardRevenue)}</p>
        </div>
        <div className="bg-background rounded-lg p-2.5">
          <p className="text-xs text-muted-foreground">Средний чек</p>
          <p className="font-bold text-foreground tabular-nums">{formatCurrency(z.avgCheck)}</p>
        </div>
        <div className="bg-background rounded-lg p-2.5">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><ShoppingBag className="size-3" />Заказов</p>
          <p className="font-bold text-foreground tabular-nums">{z.ordersCount}</p>
        </div>
        <div className="bg-background rounded-lg p-2.5">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Users className="size-3" />Гостей</p>
          <p className="font-bold text-foreground tabular-nums">{z.guestsCount || 0}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
        {/* Оплата по способам */}
        <div className="bg-background rounded-lg p-3 border border-border">
          <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5"><CreditCard className="size-3.5 text-muted-foreground" />Оплата по способам</h4>
          {z.revenueByMethod.length === 0 ? (
            <p className="text-xs text-muted-foreground">Нет данных</p>
          ) : (
            <div className="space-y-1 text-sm">
              {z.revenueByMethod.map(m => {
                const generic = m.paymentMethod === 'cash' ? 'Наличные' : m.paymentMethod === 'card' ? 'Банк. карта' : m.paymentMethod === 'transfer' ? 'Перевод' : m.paymentMethod || '—'
                const label = m.accountType === 'cash' ? generic : (m.accountName || generic)
                return (
                  <div key={m.accountId || m.paymentMethod || 'u'} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{label} <span className="text-[11px]">({m.ordersCount})</span></span>
                    <span className="font-medium text-foreground tabular-nums">{formatCurrency(m.total)}</span>
                  </div>
                )
              })}
              <div className="border-t border-border pt-1.5 mt-1.5 flex items-center justify-between">
                <span className="text-muted-foreground">Выручка</span>
                <span className="font-medium tabular-nums">{formatCurrency(revenueTotal)}</span>
              </div>
              {z.expensesTotalAll > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Расход</span>
                  <span className="font-medium tabular-nums text-destructive">−{formatCurrency(z.expensesTotalAll)}</span>
                </div>
              )}
              {z.withdrawals > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Изъятия</span>
                  <span className="font-medium tabular-nums text-destructive">−{formatCurrency(z.withdrawals)}</span>
                </div>
              )}
              {z.refundsCount > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Возвраты · {z.refundsCount} чек{z.refundsCount === 1 ? '' : z.refundsCount < 5 ? 'а' : 'ов'}</span>
                  <span className="font-medium tabular-nums text-destructive">−{formatCurrency(z.refundsTotal)}</span>
                </div>
              )}
              <div className="border-t border-border pt-1.5 mt-1.5 flex items-center justify-between font-semibold">
                <span>Итог</span>
                <span className="tabular-nums">{formatCurrency(revenueTotal - z.expensesTotalAll - z.withdrawals - z.refundsTotal)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Продажи по категориям */}
        <div className="bg-background rounded-lg p-3 border border-border">
          <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5"><Tag className="size-3.5 text-muted-foreground" />Продажи по категориям</h4>
          {z.salesByCategory.length === 0 ? (
            <p className="text-xs text-muted-foreground">Нет данных</p>
          ) : (
            <div className="space-y-1 text-sm">
              {z.salesByCategory.slice(0, 8).map(c => (
                <div key={c.name} className="flex items-center justify-between">
                  <span className="text-muted-foreground truncate pr-2">{c.name} <span className="text-[11px]">({c.qty} шт)</span></span>
                  <span className="font-medium text-foreground tabular-nums">{formatCurrency(c.total)}</span>
                </div>
              ))}
              {z.salesByCategory.length > 8 && <p className="text-[11px] text-muted-foreground italic pt-1">…и ещё {z.salesByCategory.length - 8}</p>}
            </div>
          )}
        </div>

        {/* Проданные блюда */}
        <div className="bg-background rounded-lg p-3 border border-border">
          <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5"><ShoppingBag className="size-3.5 text-muted-foreground" />Проданные блюда</h4>
          {z.salesByItem.length === 0 ? (
            <p className="text-xs text-muted-foreground">Нет данных</p>
          ) : (
            <div className="space-y-1 text-sm max-h-60 overflow-y-auto">
              {z.salesByItem.map(it => (
                <div key={it.name} className="flex items-center justify-between">
                  <span className="text-muted-foreground truncate pr-2">{it.name} <span className="text-[11px]">×{it.qty % 1 === 0 ? it.qty : it.qty.toFixed(2)}</span></span>
                  <span className="font-medium text-foreground tabular-nums">{formatCurrency(it.total)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* По типу заказа */}
        <div className="bg-background rounded-lg p-3 border border-border">
          <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5"><MapPin className="size-3.5 text-muted-foreground" />По типу заказа</h4>
          {z.salesByOrderType.length === 0 ? (
            <p className="text-xs text-muted-foreground">Нет данных</p>
          ) : (
            <div className="space-y-1 text-sm">
              {z.salesByOrderType.map(t => {
                const label = t.type === 'hall' ? 'В зале' : t.type === 'takeaway' ? 'С собой' : t.type === 'delivery' ? 'Доставка' : t.type
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

        {/* Расходы */}
        <div className="bg-background rounded-lg p-3 border border-border">
          <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5"><Banknote className="size-3.5 text-muted-foreground" />Расходы</h4>
          {z.expensesByCategory.length === 0 ? (
            <p className="text-xs text-muted-foreground">Расходов нет</p>
          ) : (
            <div className="space-y-1 text-sm">
              {z.expensesByCategory.map(c => (
                <div key={c.category} className="flex items-center justify-between">
                  <span className="text-muted-foreground truncate pr-2">{c.category} <span className="text-[11px]">({c.count})</span></span>
                  <span className="font-medium text-destructive tabular-nums">{formatCurrency(c.amount)}</span>
                </div>
              ))}
              <div className="border-t border-border pt-1.5 mt-1.5 flex items-center justify-between font-semibold">
                <span>Итого расходов</span>
                <span className="tabular-nums text-destructive">{formatCurrency(z.expensesTotal)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Официанты */}
        <div className="bg-background rounded-lg p-3 border border-border">
          <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5"><Users className="size-3.5 text-muted-foreground" />Официанты</h4>
          {z.salesByWaiter.length === 0 ? (
            <p className="text-xs text-muted-foreground">Нет данных</p>
          ) : (
            <div className="space-y-1 text-sm">
              {z.salesByWaiter.map(w => (
                <div key={w.waiterId} className="flex items-center justify-between">
                  <span className="text-muted-foreground truncate pr-2">{w.name} <span className="text-[11px]">({w.ordersCount})</span></span>
                  <span className="font-medium text-foreground tabular-nums">{formatCurrency(w.total)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ShiftsPage() {
  const { user, canDo, restaurantId, homeRoute } = useAuth()
  const navigate = useNavigate()
  // Право shifts.history: история всех дней. Без него (кассир) — только
  // сегодняшние смены (бэк тоже клампит список к сегодняшнему дню).
  const canSeeHistory = canDo('shifts.history')
  // Раздел «Смены» под ПИН владельца. Кассир может открыть смену без ПИН (когда
  // активной смены нет — показываем только форму открытия). Любой другой доступ
  // к разделу (история, X/Z-отчёты, закрытие, пересчёт) — после ввода ПИН владельца.
  // Владелец/superadmin заходят без запроса ПИН.
  const isOwnerRole = user?.role === 'owner' || user?.role === 'superadmin'
  const [unlocked, setUnlocked] = useState(false)
  // Кассир без активной смены явно запросил вход в управление (история/отчёты).
  const [requestOwner, setRequestOwner] = useState(false)
  const [activeShift, setActiveShift] = useState<CashShift | null>(null)
  const [shiftOps, setShiftOps] = useState<CashShiftOperation[]>([])
  const [history, setHistory] = useState<CashShift[]>([])
  // Нонс для перемонтирования формы открытия смены: бампается на каждом
  // открытии/закрытии. Раньше форма перемонтировалась по history[0].id, но при
  // пустой истории (новый ресторан / кассир с сегодняшним клампом) ключ всегда
  // был 'fresh' → DecimalInput остатка «залипал» при повторном открытии.
  const [openFormNonce, setOpenFormNonce] = useState(0)
  const [loading, setLoading] = useState(true)
  const [expandedShift, setExpandedShift] = useState<string | null>(null)
  const [expandedOps, setExpandedOps] = useState<CashShiftOperation[]>([])
  // Полный Z-отчёт раскрытой закрытой смены (методы оплаты, категории, блюда,
  // тип заказа, расходы, официанты) — тот же, что в своде активной смены.
  const [expandedZ, setExpandedZ] = useState<ShiftZReport | null>(null)
  const [expandedZLoading, setExpandedZLoading] = useState(false)

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

  // Заказы, блокирующие закрытие смены (могут принадлежать УЖЕ ЗАКРЫТОЙ
  // прошлой смене — тогда их не видно ни в «Активные заказы» (скоуп по
  // текущей смене), ни в «Закрытые» (скоуп по статусу done/cancelled).
  // Бэк называет их в details.order_ids/order_numbers ошибки закрытия —
  // подгружаем их отдельно и даём отменить прямо здесь.
  const [stuckOrders, setStuckOrders] = useState<Order[] | null>(null)
  const [cancellingStuckId, setCancellingStuckId] = useState<string | null>(null)
  // 068: можно ли закрыть смену «всё равно» — право shifts.close_with_open_orders,
  // приходит с бэка в details.can_force (бэк — источник правды по правам).
  const [canForceClose, setCanForceClose] = useState(false)
  const [forcingClose, setForcingClose] = useState(false)
  // Синхронный гвард поверх confirmDialog(): в отличие от window.confirm()
  // (блокировал JS-поток сам), async-диалог не мешает второму тапу открыть
  // второй диалог поверх первого, пока первый ещё висит.
  const confirmBusyRef = useRef(false)

  // Cash operation form
  const [showOp, setShowOp] = useState<'cash_in' | 'cash_out' | null>(null)
  const [opAmount, setOpAmount] = useState(0)
  const [opDesc, setOpDesc] = useState('')

  // Recovery — привязка счёта к уже открытой legacy-смене (account_id = null)
  const [attachAccountId, setAttachAccountId] = useState<string>('')
  const [attaching, setAttaching] = useState(false)

  // Shift expense form
  const [showExpense, setShowExpense] = useState(false)
  const [expAmount, setExpAmount] = useState(0)
  const [expCategory, setExpCategory] = useState(EXPENSE_CATEGORIES[0])
  const [expDesc, setExpDesc] = useState('')
  // Безналичные счета (банк/карта) — для безналичного расхода. Расход нал →
  // счёт смены (ящик), безнал → выбранный банк-счёт (ящик не трогает).
  const [nonCashAccounts, setNonCashAccounts] = useState<FinancialAccount[]>([])
  const [expenseCash, setExpenseCash] = useState(true)
  const [expenseBankId, setExpenseBankId] = useState('')

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
    fetchFinancialAccounts().then(selectableAccounts).then(accs => {
      // Раньше показывали ТОЛЬКО type='cash'. Но юзер мог создать счёт с
      // именем «Касса» но type='bank' (бывший default'ом в /finance/accounts
      // до v2.0.98), и форма смены показывала «Нет счёта типа Касса» даже
      // когда счёт фактически есть. Теперь: cash-приоритет, но если их нет,
      // показываем все. В select подписи отмечают тип, чтобы юзер видел.
      const cashOnly = accs.filter(a => a.type === 'cash')
      const list = cashOnly.length > 0 ? cashOnly : accs
      setCashAccounts(list)
      if (list.length > 0) setOpenAccountId(list[0].id)
      const bank = accs.filter(a => a.type !== 'cash')
      setNonCashAccounts(bank)
      if (bank.length > 0) setExpenseBankId(prev => prev || bank[0].id)
    }).catch(() => {})
  }, [reload])

  const filteredHistory = useMemo(() => {
    const now = Date.now()
    // Без права истории — только сегодняшние смены (по началу дня).
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
    const cutoff = !canSeeHistory
      ? startOfToday.getTime()
      : historyPeriod === '7d'
        ? now - 7 * 24 * 60 * 60 * 1000
        : historyPeriod === '30d'
          ? now - 30 * 24 * 60 * 60 * 1000
          : 0
    const q = canSeeHistory ? historySearch.trim().toLowerCase() : ''
    return history.filter(s => {
      if (cutoff > 0 && new Date(s.closedAt ?? s.openedAt).getTime() < cutoff) return false
      if (q) {
        const hay = [s.openedByName, s.closedByName, s.accountName].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [history, historyPeriod, historySearch, canSeeHistory])

  const expectedAtClose = useMemo(() => {
    if (!activeShift) return 0
    // Наличный ящик трогают только операции без своего счёта или на счёте смены.
    // Безналичный расход (accountId = банк-счёт) в кассовую математику не идёт.
    const drawer = (o: CashShiftOperation) => !o.accountId || o.accountId === activeShift.accountId
    const cashIn = dSum(shiftOps.filter(o => o.type === 'cash_in' && drawer(o)).map(o => o.amount))
    const cashOut = dSum(shiftOps.filter(o => o.type === 'cash_out' && drawer(o)).map(o => o.amount))
    return dSub(dAdd(dAdd(activeShift.openingBalance, liveRevenue.cashRevenue), cashIn), cashOut)
  }, [activeShift, shiftOps, liveRevenue.cashRevenue])

  // Движение денег по кассе: внесения / изъятия (cash_out без категории) /
  // расходы (cash_out С категорией, агрегируем по категории).
  const cashMovement = useMemo(() => {
    const cashIn = dSum(shiftOps.filter(o => o.type === 'cash_in').map(o => o.amount))
    const withdrawalOps = shiftOps.filter(o => o.type === 'cash_out' && !o.category)
    // Возврат-зеркало (авто-зеркало с описанием «Возврат заказа #…») исключаем из
    // расходов — оно показывается отдельной строкой «Возвраты» (не задваиваем).
    const expenseOps = shiftOps.filter(o => o.type === 'cash_out' && !!o.category
      && !(o.category === AUTO_MIRROR_CAT && (o.description ?? '').startsWith(REFUND_DESC_PREFIX)))
    const withdrawals = dSum(withdrawalOps.map(o => o.amount))
    const expensesTotal = dSum(expenseOps.map(o => o.amount))
    const byCat = new Map<string, { amount: number; count: number }>()
    for (const o of expenseOps) {
      const c = o.category === AUTO_MIRROR_CAT ? 'Списание со счёта' : (o.category || 'Прочее')
      const cur = byCat.get(c) ?? { amount: 0, count: 0 }
      cur.amount += o.amount
      cur.count++
      byCat.set(c, cur)
    }
    const byCategory = Array.from(byCat.entries())
      .map(([category, v]) => ({ category, amount: v.amount, count: v.count }))
      .sort((a, b) => b.amount - a.amount)
    return { cashIn, withdrawals, expensesTotal, expenseOps, byCategory }
  }, [shiftOps])

  // SSE-driven auto-refresh — заменяет polling каждые 2с активной смены.
  // Live revenue зависит от заказов (closeOrder) и операций смены.
  const liveRefresh = useCallback(() => {
    // Пауза live-обновлений пока открыта любая форма ввода. Иначе SSE-эвент
    // (официант через Kotlin меняет заказ → orders/financial_operations) вызывал
    // reload → перерисовку формы → сброс фокуса, и инпуты «зависали» во время
    // ввода расхода/внесения/изъятия. После закрытия формы обновления
    // возобновляются (submit-обработчики и так вызывают reload).
    if (showExpense || showOp !== null || showClose || showOpen) return
    if (!activeShift) { reload().catch(console.error); return }
    fetchShiftRevenue(activeShift.id).then(setLiveRevenue).catch(() => {})
    fetchShiftOperations(activeShift.id).then(setShiftOps).catch(() => {})
    fetchShiftZReport(activeShift.id).then(setZReport).catch(() => {})
    loadServiceRows(activeShift).catch(() => {})
  }, [activeShift, reload, loadServiceRows, showExpense, showOp, showClose, showOpen])
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
      toast.error(humanizeError(e, 'Ошибка выплаты'))
    } finally {
      setPayingService(null)
    }
  }

  const handleAttachAccount = async () => {
    if (!activeShift || !attachAccountId) return
    setAttaching(true)
    try {
      await patchShiftAccount(activeShift.id, attachAccountId)
      toast.success('Счёт привязан к смене')
      setAttachAccountId('')
      await reload()
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка привязки счёта'))
    } finally {
      setAttaching(false)
    }
  }

  // Дефолтный выбор счёта для recovery-блока — первый доступный.
  useEffect(() => {
    if (activeShift && !activeShift.accountId && !attachAccountId && cashAccounts.length > 0) {
      setAttachAccountId(cashAccounts[0].id)
    }
  }, [activeShift, cashAccounts, attachAccountId])

  const handleOpen = async () => {
    if (!user) return
    if (!openAccountId) {
      toast.error('Выберите счёт смены — без него операции работать не будут')
      return
    }
    try {
      await openShift(user.id, openBalance, openAccountId || undefined)
      toast.success('Смена открыта')
      setShowOpen(false)
      setOpenBalance(0)
      setOpenFormNonce(n => n + 1)
      // Кассир открыл смену без ПИН — уводим на рабочий экран, чтобы он не
      // упёрся в гейт ПИН владельца (управление сменой защищено).
      if (!isOwnerRole && !unlocked) {
        navigate(homeRoute || '/operations/table-map')
        return
      }
      await reload()
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка открытия смены'))
    }
  }

  const handleExpense = async () => {
    if (!activeShift || expAmount <= 0) return
    try {
      await createShiftExpense(activeShift.id, expAmount, expCategory, expDesc, expenseCash ? undefined : expenseBankId)
      toast.success('Расход оформлен')
      setShowExpense(false)
      setExpAmount(0)
      setExpDesc('')
      setExpCategory(EXPENSE_CATEGORIES[0])
      await reload()
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка'))
    }
  }

  const handleDeleteExpense = async (opId: string, amount: number, description?: string) => {
    // НЕ window.confirm: нативный диалог в Electron ломает фокус инпутов
    // после закрытия (electron/electron#19977 и класс дублей — экранная
    // клавиатура, живущая только на focusin, переставала открываться).
    if (confirmBusyRef.current) return
    confirmBusyRef.current = true
    try {
      const ok = await confirmDialog({
        title: 'Удалить расход?',
        message: `«${description ?? 'Расход'}» на сумму ${formatCurrency(amount)}. ` +
          `Действие нельзя отменить, баланс счёта будет скорректирован.`,
        confirmLabel: 'Удалить',
        danger: true,
      })
      if (!ok) return
      try {
        await deleteShiftExpense(opId)
        toast.success('Расход удалён')
        await reload()
      } catch (e) {
        toast.error(humanizeError(e, 'Ошибка удаления расхода'))
      }
    } finally { confirmBusyRef.current = false }
  }

  const handleClose = async () => {
    if (!activeShift || !user) return
    if (confirmBusyRef.current) return
    const unpaidService = waiterServiceRows.reduce((s, r) => s + r.toPay, 0)
    if (unpaidService > 0) {
      confirmBusyRef.current = true
      let ok: boolean
      try {
        ok = await confirmDialog({
          title: 'Закрыть смену без выплаты?',
          message: `Не выплачено обслуживание официантам: ${formatCurrency(unpaidService)}.\n` +
            `Сумма останется в отчёте «Обслуживание».`,
          confirmLabel: 'Закрыть смену',
          danger: true,
        })
      } finally { confirmBusyRef.current = false }
      if (!ok) return
    }
    setStuckOrders(null)
    setCanForceClose(false)
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
      setOpenFormNonce(n => n + 1) // гарантированный remount формы открытия
      // Восстанавливаем дефолтный счёт открытия (первый cash) — иначе после закрытия
      // openAccountId остаётся id уже закрытой смены и openShift падает.
      if (cashAccounts.length > 0) setOpenAccountId(cashAccounts[0].id)
      else setOpenAccountId('')
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? `Ошибка закрытия смены: ${e.message}` : 'Ошибка закрытия смены')
      // Бэк называет конкретные блокирующие заказы в details.order_ids —
      // подгружаем их напрямую по id (без scope по текущей смене/дате), иначе
      // заказ-«хвост» из прошлой смены невозможно найти нигде в интерфейсе.
      // details.can_force (068) — доступна ли кнопка «закрыть всё равно» этому
      // пользователю (право shifts.close_with_open_orders).
      const details = e instanceof V4Error ? e.envelope()?.details : undefined
      const orderIds = details?.order_ids as unknown
      if (Array.isArray(orderIds) && orderIds.length > 0) {
        try {
          const found = await fetchOrders({ ids: orderIds as string[], slim: true })
          setStuckOrders(found)
        } catch { /* покажем только текст ошибки — не критично */ }
      }
      setCanForceClose(Boolean(details?.can_force))
    }
  }

  // 068 — «Закрыть всё равно»: подтверждаем закрытие с висящими столами явно
  // (confirm_open_orders), не тихим повтором того же запроса.
  const handleForceClose = async () => {
    if (!activeShift || !user || confirmBusyRef.current) return
    confirmBusyRef.current = true
    let ok: boolean
    try {
      ok = await confirmDialog({
        title: 'Закрыть смену с открытыми столами?',
        message: `Незакрытых заказов: ${stuckOrders?.length ?? 0}. Они прикрепятся к следующей открытой смене, когда будут оплачены.`,
        confirmLabel: 'Закрыть всё равно',
        cancelLabel: 'Отмена',
        danger: true,
      })
    } finally { confirmBusyRef.current = false }
    if (!ok) return
    setForcingClose(true)
    try {
      await closeShift(activeShift.id, user.id, closeBalance, true)
      toast.success('Смена закрыта')
      setStuckOrders(null)
      setCanForceClose(false)
      setShowClose(false)
      setCloseBalance(0)
      await reload()
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка закрытия смены'))
    } finally {
      setForcingClose(false)
    }
  }

  const handleCancelStuckOrder = async (orderId: string) => {
    if (confirmBusyRef.current) return
    confirmBusyRef.current = true
    try {
      const ok = await confirmDialog({
        title: 'Отменить заказ?',
        message: 'Он мешает закрыть смену — отмена нужна, чтобы освободить смену.',
        confirmLabel: 'Отменить заказ',
        cancelLabel: 'Оставить',
        danger: true,
      })
      if (!ok) return
      setCancellingStuckId(orderId)
      try {
        await cancelOrder(orderId, 'Зависший заказ — отменён при закрытии смены')
        setStuckOrders(prev => (prev ?? []).filter(o => o.id !== orderId))
        toast.success('Заказ отменён')
      } catch (e) {
        toast.error(humanizeError(e, 'Не удалось отменить заказ'))
      } finally {
        setCancellingStuckId(null)
      }
    } finally { confirmBusyRef.current = false }
  }

  const handlePrintZ = async (shiftId: string) => {
    try {
      await printShiftZ(shiftId)
      toast.success('Z-отчёт отправлен на принтер')
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка печати Z-отчёта'))
    }
  }

  const handlePrintX = async (shiftId: string) => {
    try {
      await printShiftX(shiftId)
      toast.success('X-отчёт отправлен на принтер')
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка печати X-отчёта'))
    }
  }

  const handlePrintService = async (shiftId: string) => {
    try {
      await printShiftService(shiftId)
      toast.success('Отчёт «Обслуживание» отправлен на принтер')
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка печати отчёта обслуживания'))
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
    setExpandedZ(null)
    setExpandedZLoading(true)
    const [ops] = await Promise.all([
      fetchShiftOperations(shiftId),
      fetchShiftZReport(shiftId)
        .then(z => setExpandedZ(z))
        .catch(() => setExpandedZ(null))
        .finally(() => setExpandedZLoading(false)),
    ])
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

  // Форма открытия смены — единственное, что доступно кассиру без ПИН владельца.
  const openShiftCard = (
    <div key={`open-form-${openFormNonce}`} className="bg-card rounded-xl border border-border p-8 text-center space-y-4">
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
          {cashAccounts.length === 0 ? (
            /* Hard-block: без cash-счёта смена работать не может (выплаты + расходы). */
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3 space-y-2">
              <p className="font-medium">❌ Нет счёта типа «Касса»</p>
              <p>Создайте счёт в разделе{' '}
                <a href="/finance/accounts" className="underline font-medium hover:text-rose-900">Финансы → Счета</a>
                {' '}— без него смена не сможет принимать выплаты и расходы.</p>
            </div>
          ) : (
            /* Всегда показываем селект — даже если счёт один, кассир должен видеть какой именно. */
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Счёт смены</label>
              <select value={openAccountId} onChange={e => setOpenAccountId(e.target.value)}
                disabled={cashAccounts.length === 1}
                className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-70">
                {cashAccounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.name}{a.type !== 'cash' ? ` (${a.type === 'bank' ? 'банк' : a.type})` : ''}
                  </option>
                ))}
              </select>
              {cashAccounts.length === 1 && (
                <p className="text-[11px] text-muted-foreground mt-1">Единственный счёт автоматически выбран.</p>
              )}
              {cashAccounts.every(a => a.type !== 'cash') && (
                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded mt-1.5 px-2 py-1">
                  ⚠ В списке нет cash-счётов. Используется счёт другого типа — корректно работать будет, но в /finance/accounts желательно изменить тип на «Касса (наличные)».
                </p>
              )}
            </div>
          )}
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Начальный остаток в кассе</label>
            <DecimalInput min={0} value={openBalance} onChange={v => setOpenBalance(v)}
              className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <div className="flex gap-2 justify-center">
            <button onClick={handleOpen}
              disabled={cashAccounts.length === 0 || !openAccountId}
              className="px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed">
              Открыть
            </button>
            <button onClick={() => setShowOpen(false)} className="px-3 py-2.5 text-sm text-muted-foreground hover:text-foreground">Отмена</button>
          </div>
        </div>
      )}
    </div>
  )

  // Гейт ПИН владельца. Владелец/superadmin — без запроса. Кассир: если есть
  // активная смена (или он явно запросил управление) — требуем ПИН владельца;
  // иначе показываем только форму открытия смены.
  if (!isOwnerRole && !unlocked) {
    if (activeShift || requestOwner) {
      return (
        <OwnerPinGate
          restaurantId={restaurantId ?? ''}
          sectionLabel="Смены"
          onSuccess={() => { setUnlocked(true); setRequestOwner(false) }}
          onBack={() => { if (activeShift) navigate(homeRoute || '/operations/table-map'); else setRequestOwner(false) }}
        />
      )
    }
    return (
      <div className="h-full overflow-y-auto">
        <div className="p-4 md:p-6 space-y-5 max-w-2xl mx-auto pb-24">
          <div className="mb-1">
            <h1 className="text-xl font-bold text-foreground">Кассовые смены</h1>
            <p className="text-muted-foreground text-sm mt-0.5">Откройте смену, чтобы начать работу</p>
          </div>
          {openShiftCard}
          <button
            onClick={() => setRequestOwner(true)}
            className="w-full flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Управление сменами (ПИН владельца)
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <OnScreenKeyboard />
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
                onClick={() => handlePrintX(activeShift.id)}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-card border border-border text-foreground rounded-lg text-xs font-medium hover:bg-muted transition-colors whitespace-nowrap"
                title="Печать промежуточного X-отчёта (без обнуления)"
              >
                <Printer className="size-3.5" />X-отчёт
              </button>
              <button
                onClick={() => handlePrintService(activeShift.id)}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-card border border-border text-foreground rounded-lg text-xs font-medium hover:bg-muted transition-colors whitespace-nowrap"
                title="Печать чека «Обслуживание официантов»"
              >
                <Printer className="size-3.5" />Обслуживание
              </button>
              <button
                onClick={() => handlePrintZ(activeShift.id)}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-card border border-border text-foreground rounded-lg text-xs font-medium hover:bg-muted transition-colors whitespace-nowrap"
                title="Печать Z-отчёта на принтер"
              >
                <Printer className="size-3.5" />Печать Z
              </button>
              <button
                onClick={() => { exportShiftToXlsx(activeShift).catch(e => toast.error(humanizeError(e, 'Ошибка экспорта'))) }}
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
              <DeltaChip
                current={liveRevenue.cashRevenue + liveRevenue.cardRevenue}
                previous={zReport?.previous?.revenue ?? 0}
                hasPrevious={!!zReport?.previous}
              />
            </div>
            <div className="bg-muted/50 rounded-lg p-3">
              <p className="text-xs text-muted-foreground">Средний чек</p>
              <p className="text-lg font-bold text-foreground">{formatCurrency(liveRevenue.avgCheck)}</p>
              <DeltaChip
                current={liveRevenue.avgCheck}
                previous={zReport?.previous?.avgCheck ?? 0}
                hasPrevious={!!zReport?.previous}
              />
            </div>
            <div className="bg-muted/50 rounded-lg p-3">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><ShoppingBag className="size-3" />Заказов</p>
              <p className="text-lg font-bold text-foreground">{liveRevenue.ordersCount}</p>
              <DeltaChip
                current={liveRevenue.ordersCount}
                previous={zReport?.previous?.ordersCount ?? 0}
                hasPrevious={!!zReport?.previous}
              />
            </div>
            <div className="bg-muted/50 rounded-lg p-3">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Users className="size-3" />Гостей</p>
              <p className="text-lg font-bold text-foreground">{zReport?.guestsCount ?? 0}</p>
              {(zReport?.guestsCount ?? 0) > 0 && (
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Ср. на гостя {formatCurrency((liveRevenue.cashRevenue + liveRevenue.cardRevenue) / Math.max(1, zReport?.guestsCount ?? 0))}
                </p>
              )}
              <DeltaChip
                current={zReport?.guestsCount ?? 0}
                previous={zReport?.previous?.guestsCount ?? 0}
                hasPrevious={!!zReport?.previous}
              />
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
                      // Для безнала показываем имя конкретного счёта/терминала
                      // («какая карта»); для наличных — обобщённое «Наличные».
                      const genericLabel = m.paymentMethod === 'cash' ? 'Наличные'
                        : m.paymentMethod === 'card' ? 'Банк. карта'
                        : m.paymentMethod === 'transfer' ? 'Перевод'
                        : m.paymentMethod || '—'
                      const label = m.accountType === 'cash'
                        ? genericLabel
                        : (m.accountName || genericLabel)
                      return (
                        <div key={m.accountId || m.paymentMethod || 'unknown'} className="flex items-center justify-between">
                          <span className="text-muted-foreground">{label} <span className="text-[11px]">({m.ordersCount})</span></span>
                          <span className="font-medium text-foreground tabular-nums">{formatCurrency(m.total)}</span>
                        </div>
                      )
                    })}
                    {(() => {
                      const revenueTotal = zReport.revenueByMethod.reduce((s, m) => s + m.total, 0)
                      const expenses = cashMovement.expensesTotal
                      const refunds = zReport.refundsTotal
                      const refundsN = zReport.refundsCount
                      return (
                        <>
                          <div className="border-t border-border pt-1.5 mt-1.5 flex items-center justify-between">
                            <span className="text-muted-foreground">Выручка</span>
                            <span className="font-medium tabular-nums">{formatCurrency(revenueTotal)}</span>
                          </div>
                          {expenses > 0 && (
                            <div className="flex items-center justify-between">
                              <span className="text-muted-foreground">Расход</span>
                              <span className="font-medium tabular-nums text-destructive">−{formatCurrency(expenses)}</span>
                            </div>
                          )}
                          {refundsN > 0 && (
                            <div className="flex items-center justify-between">
                              <span className="text-muted-foreground">Возвраты · {refundsN} {checksWord(refundsN)}</span>
                              <span className="font-medium tabular-nums text-destructive">−{formatCurrency(refunds)}</span>
                            </div>
                          )}
                          <div className="border-t border-border pt-1.5 mt-1.5 flex items-center justify-between font-semibold">
                            <span>Итог</span>
                            <span className="tabular-nums">{formatCurrency(revenueTotal - expenses - refunds)}</span>
                          </div>
                        </>
                      )
                    })()}
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

              {/* Проданные блюда/товары */}
              <div className="bg-muted/40 rounded-xl p-4 border border-border">
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1.5"><ShoppingBag className="size-3.5 text-muted-foreground" />Проданные блюда</h3>
                {!zReport || zReport.salesByItem.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Закрытых заказов пока нет</p>
                ) : (
                  <div className="space-y-1.5 text-sm max-h-72 overflow-y-auto">
                    {zReport.salesByItem.map(it => (
                      <div key={it.name} className="flex items-center justify-between">
                        <span className="text-muted-foreground truncate pr-2">
                          {it.name} <span className="text-[11px]">×{it.qty % 1 === 0 ? it.qty : it.qty.toFixed(2)}</span>
                        </span>
                        <span className="font-medium text-foreground tabular-nums">{formatCurrency(it.total)}</span>
                      </div>
                    ))}
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

              {/* Расходы — раньше в своде их не было вовсе (#3). Итог + разбор
                  по категориям из движения по кассе. */}
              <div className="bg-muted/40 rounded-xl p-4 border border-border">
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1.5"><Banknote className="size-3.5 text-muted-foreground" />Расходы</h3>
                {cashMovement.expenseOps.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Расходов за смену нет</p>
                ) : (
                  <div className="space-y-1.5 text-sm">
                    {cashMovement.byCategory.map(c => (
                      <div key={c.category} className="flex items-center justify-between">
                        <span className="text-muted-foreground truncate pr-2">{c.category} <span className="text-[11px]">({c.count})</span></span>
                        <span className="font-medium text-destructive tabular-nums">{formatCurrency(c.amount)}</span>
                      </div>
                    ))}
                    <div className="border-t border-border pt-1.5 mt-1.5 flex items-center justify-between font-semibold">
                      <span>Итого расходов</span>
                      <span className="tabular-nums text-destructive">{formatCurrency(cashMovement.expensesTotal)}</span>
                    </div>
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
            <div className={`grid grid-cols-2 gap-3 ${zReport && zReport.refundsCount > 0 ? 'md:grid-cols-5' : 'md:grid-cols-4'}`}>
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground">Нач. остаток</p>
                <p className="text-sm font-bold text-foreground">{formatCurrency(activeShift.openingBalance)}</p>
              </div>
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground">Внесения</p>
                <p className="text-sm font-bold text-emerald-600">{formatCurrency(cashMovement.cashIn)}</p>
              </div>
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground">Изъятия</p>
                <p className="text-sm font-bold text-destructive">{formatCurrency(cashMovement.withdrawals)}</p>
              </div>
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground">Расходы</p>
                <p className="text-sm font-bold text-destructive">{formatCurrency(cashMovement.expensesTotal)}</p>
              </div>
              {zReport && zReport.refundsCount > 0 && (
                <div className="bg-muted/50 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground">Возвраты · {zReport.refundsCount} {checksWord(zReport.refundsCount)}</p>
                  <p className="text-sm font-bold text-destructive">−{formatCurrency(zReport.refundsTotal)}</p>
                </div>
              )}
            </div>
          )}

          {/* Расходы по категориям — структурный разбор (раньше расходы были
              «спрятаны» в Изъятиях). Каждая строка кликабельна на удаление. */}
          {cashMovement.expenseOps.length > 0 && (
            <div className="bg-rose-50/50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-rose-900 dark:text-rose-200 flex items-center gap-1.5">
                  <Banknote className="size-4" />Расходы из смены
                </h3>
                <p className="text-xs text-rose-700 dark:text-rose-300">
                  Итого: <span className="font-bold">{formatCurrency(cashMovement.expensesTotal)}</span>
                </p>
              </div>
              <div className="space-y-1.5">
                {cashMovement.expenseOps.map(op => (
                  <div key={op.id} className="flex items-center justify-between gap-2 text-sm bg-white/60 dark:bg-black/20 rounded-lg px-3 py-2">
                    <div className="min-w-0">
                      <span className="font-medium text-foreground">{op.category}</span>
                      {op.accountId && op.accountId !== activeShift.accountId && <span className="ml-1.5 rounded bg-primary/10 text-primary px-1.5 py-0.5 text-[10px] font-bold">безнал</span>}
                      {op.description && <span className="text-muted-foreground"> · {op.description}</span>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-semibold tabular-nums text-destructive">−{formatCurrency(op.amount)}</span>
                      {activeShift.status === 'open' && (
                        <button
                          onClick={() => handleDeleteExpense(op.id, op.amount, op.category)}
                          className="text-muted-foreground hover:text-destructive transition-colors"
                          title="Удалить расход"
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
                  ⚠ У смены не указан счёт — выплата невозможна. Привяжите счёт в блоке выше.
                </p>
              )}
            </div>
          )}

          {/* Recovery — у legacy-смен может не быть accountId; без него Расход
              и выплата обслуживания недоступны. Показываем inline-блок с
              селектом и кнопкой «Привязать». */}
          {!activeShift.accountId && (
            <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-300 dark:border-amber-800 rounded-xl p-4 space-y-3">
              <div className="flex items-start gap-2">
                <span className="text-amber-700 dark:text-amber-300 mt-0.5">⚠</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">У смены не указан счёт</p>
                  <p className="text-xs text-amber-800 dark:text-amber-300/90 mt-0.5">
                    Привяжите счёт чтобы разблокировать <b>Расход</b> и <b>выплату обслуживания</b> официантам.
                  </p>
                </div>
              </div>
              {cashAccounts.length === 0 ? (
                <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                  Нет cash-счетов. Создайте в <a href="/finance/accounts" className="underline">Финансы → Счета</a>.
                </p>
              ) : (
                <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                  <div className="flex-1">
                    <label className="text-[11px] text-amber-800 dark:text-amber-300 block mb-1">Счёт</label>
                    <select
                      value={attachAccountId}
                      onChange={e => setAttachAccountId(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-amber-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                    >
                      {cashAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                  <button
                    onClick={handleAttachAccount}
                    disabled={!attachAccountId || attaching}
                    className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50 whitespace-nowrap"
                  >
                    {attaching ? '…' : 'Привязать'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Actions. Выбран вариант «3 кнопки + раздельные inline-формы»:
              Внесение/Изъятие — одинаковая форма (cash_in/cash_out отличаются только знаком),
              Расход — отдельная с категорией. Унификация под единую модалку с табами
              рассмотрена, но тут симметрия и так очевидна, а отдельная форма Расхода
              сохраняет акцент на категории. Расход НЕ disable как только accountId привязан
              (через auto-select при открытии или recovery-блок выше). */}
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
              onClick={() => { setShowExpense(true); setExpAmount(0); setExpDesc(''); setExpCategory(EXPENSE_CATEGORIES[0]); setExpenseCash(true) }}
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
              {/* Наличные (счёт смены) или безналичные (банк-счёт). Безнал дебетует
                  свой счёт, наличный ящик не трогает. Показываем только при наличии
                  безналичного счёта. */}
              {nonCashAccounts.length > 0 && (
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Откуда</label>
                  <div className="flex gap-2">
                    {([[true, 'Наличные'], [false, 'Безналичные']] as const).map(([isCash, lbl]) => (
                      <button key={lbl} type="button" onClick={() => setExpenseCash(isCash)}
                        className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${expenseCash === isCash ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground border-border hover:bg-muted'}`}>{lbl}</button>
                    ))}
                  </div>
                  {!expenseCash && (
                    <select value={expenseBankId} onChange={e => setExpenseBankId(e.target.value)}
                      className="mt-2 w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                      {nonCashAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  )}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">{expenseCash ? `Списание со счёта «${activeShift.accountName || 'Касса'}» и в журнал смены.` : 'Безналичный расход: списание с банк-счёта, наличный ящик не трогает.'}</p>
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

          {/* Заказы, блокирующие закрытие смены — могут быть «хвостом» из
              прошлой (уже закрытой) смены и потому НЕ видны ни в «Активные
              заказы», ни в «Закрытые». Даём отменить их прямо здесь. */}
          {stuckOrders && stuckOrders.length > 0 && (
            <div className="bg-amber-50 dark:bg-amber-950/20 rounded-xl p-4 space-y-3 border border-amber-300 dark:border-amber-900">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
                <AlertTriangle className="size-4" />
                Смена не закрывается — есть незакрытые заказы
              </p>
              <p className="text-xs text-amber-800 dark:text-amber-300">
                Эти заказы могли остаться от прошлой смены и поэтому не видны в
                «Активные заказы». Отмените их (или закройте с оплатой из
                карточки заказа), затем повторите закрытие смены.
                {canForceClose && ' Либо закройте всё равно — столы прикрепятся к следующей смене.'}
              </p>
              <div className="space-y-1.5">
                {stuckOrders.map(o => {
                  const label = o.type === 'takeaway' ? '«С собой»' : o.type === 'delivery' ? 'Доставка' : 'Зал'
                  return (
                    <div key={o.id} className="flex items-center justify-between px-3 py-2 bg-card rounded-lg text-sm border border-amber-200 dark:border-amber-900">
                      <span className="text-foreground">
                        {label} №{o.orderNumber ?? '—'}
                        <span className="text-muted-foreground ml-2">{formatCurrency(o.total ?? 0)}</span>
                      </span>
                      <button
                        onClick={() => handleCancelStuckOrder(o.id)}
                        disabled={cancellingStuckId === o.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-destructive/10 text-destructive rounded-md text-xs font-medium hover:bg-destructive/20 disabled:opacity-50"
                      >
                        <Ban className="size-3.5" />
                        {cancellingStuckId === o.id ? 'Отмена…' : 'Отменить заказ'}
                      </button>
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={handleClose}
                  className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700">
                  Повторить закрытие смены
                </button>
                {canForceClose && (
                  <button onClick={handleForceClose} disabled={forcingClose}
                    className="px-4 py-2 bg-destructive text-destructive-foreground rounded-lg text-sm font-medium hover:bg-destructive/90 disabled:opacity-50">
                    {forcingClose ? 'Закрываем…' : 'Закрыть всё равно'}
                  </button>
                )}
              </div>
            </div>
          )}

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
                      <span className="text-foreground">
                        {op.category
                          ? (op.description ? `${op.category} · ${op.description}` : op.category)
                          : (op.description || (op.type === 'cash_in' ? 'Внесение' : 'Изъятие'))}
                      </span>
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
                          onClick={() => handleDeleteExpense(op.id, op.amount, op.category || op.description || 'Изъятие')}
                          title="Удалить операцию (баланс счёта будет скорректирован)"
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
        openShiftCard
      )}

      {/* Shift history */}
      {history.length > 0 && (
        <div>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              {canSeeHistory ? 'История смен' : 'Сегодняшние смены'}
            </h2>
            {canSeeHistory && (
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
            )}
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
                        {!!shift.closedOpenOrdersCount && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400" title="Закрыта с незакрытыми заказами">
                            закрыта с {shift.closedOpenOrdersCount} столами
                          </span>
                        )}
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

                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs text-muted-foreground">
                          Открыл: {shift.openedByName || '—'} · Закрыл: {shift.closedByName || '—'}
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); handlePrintZ(shift.id) }}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-card border border-border text-foreground rounded-md text-xs font-medium hover:bg-muted transition-colors whitespace-nowrap shrink-0"
                          title="Печать Z-отчёта на принтер"
                        >
                          <Printer className="size-3.5" />Печать Z
                        </button>
                      </div>

                      {/* Полный Z-отчёт закрытой смены */}
                      <ClosedShiftZBreakdown z={expandedZ} loading={expandedZLoading} />

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
