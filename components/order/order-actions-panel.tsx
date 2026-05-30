'use client'

// Inline-панель действий по существующему заказу — Phase 2 интеграции
// «всё-в-одном POS». Раньше эти действия жили в OrderActionsDialog (slide-up
// Sheet); теперь основной кассирский флоу (списать позицию, скидка, %
// обслуживания, оплата нал/безнал, пре-чек, закрытие, отмена) полностью
// инлайн в правом сайдбаре POS. Реже используемые действия (split-bill,
// split-payment, чаевые, реopen) остаются в OrderActionsDialog — он
// открывается из этой панели через кнопку «Дополнительно».

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CreditCard, X, Tag, Trash2, Settings2, Receipt, AlertTriangle, FileText, Printer, ChevronDown, ChevronLeft, User as UserIcon, Clock, CheckCircle2, Pencil } from 'lucide-react'
import { toast } from 'sonner'

import { useAuth } from '@/lib/auth-store'
import { calcLineCogs, calcLineTotal, formatCurrency, getTimeSince, visibleReceiptItems, voidedItemFlags } from '@/lib/helpers'
import { dDiv, dMul, dRound, dSub, dSum } from '@/lib/decimal'
import {
  assignWaiter, cancelOrder, cancelOrderItem, closeOrderWithPayment, fetchActiveShift, fetchFinancialAccounts,
  setOrderItemNote, printPreBill,
} from '@/lib/queries'
// fetchVoidsForOrder через @/lib/queries обёрнут в cachedQuery (Dexie SWR) —
// после createVoid synchronously возвращает старый список, и наш
// optimistic-void перетирается стейл-фетчем. Берём оригинал из supabase-queries
// чтобы каждый раз идти прямо в API. Размер списка voids на заказ — единицы
// строк, кэш тут не выигрывает.
import { fetchVoidsForOrder } from '@/lib/queries'
import { buildReceiptData } from '@/lib/receipt-data'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { PrintReceipt, type ReceiptData } from '@/components/print-receipt'
import type { FinancialAccount, Order, OrderVoid, User, VoidReason } from '@/lib/types'
import { VOID_REASON_LABELS } from '@/lib/types'
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover'

interface OrderActionsPanelProps {
  order: Order
  /** All users — used to render the «Официант» picker. Filter to role='waiter'
   *  internally; передаётся целиком чтобы не дублировать fetchUsers. */
  users?: User[]
  /** Successful close & pay; parent should refresh tabs and reset selection. */
  onClosed?: () => void
  /** Order cancelled via Отменить; parent should reset selection + free table. */
  onCancelled?: () => void
  /** Item voided / discount applied — parent should re-fetch tabs. */
  onItemsChanged?: () => void
  /** Open the legacy OrderActionsDialog for advanced flows (split bill / split
   *  payment / tip / reopen). Optional — if not provided, the «Дополнительно»
   *  button is hidden. */
  onOpenAdvanced?: () => void
}

const isHallOrder = (t?: string | null) => t !== 'delivery' && t !== 'takeaway'

const VOID_REASONS: VoidReason[] = ['guest_changed_mind', 'kitchen_error', 'quality', 'other']

const DISCOUNT_PRESETS_PERCENT = [5, 10, 15, 20]

// Round-down steps для fixed-discount пресетов: 1 / 10 / 50 TJS.
// Для итога 215,50 это даёт цели «215», «210», «200» — типичные «закругляем
// до красивого». Скидка — это subtotalWithService − target. Шаги, при которых
// target = 0 или скидка = 0, отфильтровываются.
const FIXED_ROUND_DOWN_STEPS = [1, 10, 50]

export function OrderActionsPanel({ order, users, onClosed, onCancelled, onItemsChanged, onOpenAdvanced }: OrderActionsPanelProps) {
  const { user, restaurant } = useAuth()
  const navigate = useNavigate()

  // Waiter picker -----------------------------------------------------------
  const waiters = useMemo(
    () => (users ?? []).filter(u => u.role === 'waiter'),
    [users],
  )
  const currentWaiter = useMemo(
    () => (users ?? []).find(u => u.id === order.waiterId) ?? null,
    [users, order.waiterId],
  )
  const [waiterPickerOpen, setWaiterPickerOpen] = useState(false)
  const [changingWaiter, setChangingWaiter] = useState(false)

  const handleChangeWaiter = async (newWaiterId: string | null) => {
    if (!order.tableId) {
      toast.error('Заказ не привязан к столу — менять официанта здесь нельзя')
      return
    }
    if (newWaiterId === order.waiterId) {
      setWaiterPickerOpen(false)
      return
    }
    setChangingWaiter(true)
    try {
      // assignWaiter cascades через активные заказы стола, обновляя их
      // waiter_id. Ровно то, что нужно для смены официанта на текущей группе.
      await assignWaiter(order.tableId, newWaiterId)
      toast.success(newWaiterId
        ? `Передано: ${waiters.find(w => w.id === newWaiterId)?.name ?? 'официанту'}`
        : 'Официант снят')
      setWaiterPickerOpen(false)
      onItemsChanged?.()
    } catch (e) {
      toast.error(e instanceof Error ? `Ошибка передачи: ${e.message}` : 'Ошибка передачи')
    }
    setChangingWaiter(false)
  }

  // Payment ----------------------------------------------------------------
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'noncash'>('cash')
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState<string>('')

  // Service charge ---------------------------------------------------------
  const [includeService, setIncludeService] = useState(isHallOrder(order.type))
  // Service % — read-only в кассирском интерфейсе. Источник: либо уже
  // зафиксированный на заказе (после первой частичной оплаты split-flow),
  // либо дефолт ресторана. Кассир может только включить/выключить, не
  // редактировать значение.
  const servicePercent = useMemo<number>(() =>
    order.servicePercent && order.servicePercent > 0
      ? order.servicePercent
      : (restaurant?.servicePercent ?? 10),
  [order.servicePercent, restaurant?.servicePercent])

  // Discount ---------------------------------------------------------------
  // Two-tier state:
  //   • applied (discountType / discountValue / discountAmount / discountReason)
  //     влияет на total и payload. Меняется только по «Применить» / «×».
  //   • draft  (draft*) — local form state, не влияет на total пока юзер не
  //     нажал «Применить». Раньше был один набор и useEffect пересчитывал
  //     discountAmount на каждый ввод — итого дёргалось при каждой цифре.
  const [showDiscountForm, setShowDiscountForm] = useState(false)
  const [discountType, setDiscountType] = useState<'percent' | 'fixed' | null>(
    order.discountType === 'percent' || order.discountType === 'fixed' ? order.discountType : null
  )
  const [discountValue, setDiscountValue] = useState<number>(order.discountValue ?? 0)
  const [discountAmount, setDiscountAmount] = useState<number>(order.discountAmount ?? 0)
  const [discountReason, setDiscountReason] = useState<string>(order.discountReason ?? '')
  const [draftType, setDraftType] = useState<'percent' | 'fixed' | null>('fixed')
  const [draftValue, setDraftValue] = useState<number>(0)
  const [draftReason, setDraftReason] = useState<string>('')
  const draftValueRef = useRef<HTMLInputElement | null>(null)
  // Autofocus on amount input when form opens — кассир приходит сюда чтобы
  // ввести сумму, мышиный клик в input — лишний шаг. select() выделяет
  // существующее значение чтобы перенабор сразу заменял.
  useEffect(() => {
    if (showDiscountForm) {
      const t = setTimeout(() => { draftValueRef.current?.focus(); draftValueRef.current?.select() }, 0)
      return () => clearTimeout(t)
    }
  }, [showDiscountForm])

  // Voids ------------------------------------------------------------------
  // `voids` — биллинговые списания из таблицы order_voids (от старого
  // OrderActionsDialog или будущего split-bill). Влияют на subtotal через
  // visibleReceiptItems. В панели мы их НЕ создаём — × per-item теперь
  // вызывает cancelOrderItem (выставляет order_items.cancelled_at), чтобы
  // AutoPrintRunner заметил и напечатал кухонную отмену.
  const [voids, setVoids] = useState<OrderVoid[]>([])
  // Optimistically-cancelled item ids — пока сервер не подтвердил, мы уже
  // показываем зачёркивание. После подтверждения родитель перезаливает
  // order через onItemsChanged, и cancelled_at прилетает в order.items[*].
  const [pendingCancelIds, setPendingCancelIds] = useState<Set<string>>(new Set())
  const [voidingItem, setVoidingItem] = useState<{ id: string; name: string; qty: number; price: number } | null>(null)
  const [voidReason, setVoidReason] = useState<VoidReason>('guest_changed_mind')

  // Note-edit state: { id, name, draftNote } или null.
  const [editingNote, setEditingNote] = useState<{ id: string; name: string; draftNote: string } | null>(null)
  const [savingNote, setSavingNote] = useState(false)
  const [voiding, setVoiding] = useState(false)

  // Pre-check preview ------------------------------------------------------
  // На таблмепе и в OrderActionsDialog «Пре-чек» сначала рендерится в drawer
  // как превью (PrintReceipt), и оттуда уже идёт на печать. Мирроурим тот же
  // UX: build → показать в Sheet → кассир жмёт «Печать» когда готов.
  const [receiptPreview, setReceiptPreview] = useState<ReceiptData | null>(null)
  const [receiptOpen, setReceiptOpen] = useState(false)
  const receiptRef = useRef<HTMLDivElement>(null)

  // Close-and-pay preview --------------------------------------------------
  // Аналогично пре-чеку: при нажатии «Закрыть и оплатить» сначала открываем
  // drawer с финальным чеком (isPreCheck=false), даём кассиру визуально
  // убедиться, что состав и итог сошлись, и только по «Закрыть и
  // распечатать» / «Только печать» делаем реальный close + print.
  const [closeReceiptData, setCloseReceiptData] = useState<ReceiptData | null>(null)
  const [closeReceiptOpen, setCloseReceiptOpen] = useState(false)
  const closeReceiptRef = useRef<HTMLDivElement>(null)

  // Time-since-open ticker. Tick раз в 30 сек — getTimeSince возвращает
  // строки в минутах, чаще нет смысла. Без тикера счётчик «застывает» на
  // первом значении и кассир не видит как растёт время.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const timeSince = useMemo(
    () => order.createdAt ? getTimeSince(order.createdAt, new Date(now).toISOString()) : '',
    [order.createdAt, now],
  )

  // Cancel order -----------------------------------------------------------
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState<string>('Ошибка официанта')
  const [cancelReasonCustom, setCancelReasonCustom] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Initial load -----------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    fetchFinancialAccounts().then(a => {
      if (cancelled) return
      setAccounts(a)
      const cash = a.find(acc => acc.type === 'cash')
      if (cash) setSelectedAccountId(cash.id)
      else if (a.length > 0) setSelectedAccountId(a[0].id)
    }).catch(() => {})
    fetchVoidsForOrder(order.id).then(v => { if (!cancelled) setVoids(v) }).catch(() => {})
    return () => { cancelled = true }
  }, [order.id])

  // Derived totals ---------------------------------------------------------
  // visibleItems: только живые позиции — в счёт идут они и они же определяют
  // subtotal/cogs.
  // displayItems: ВСЕ позиции (живые + отменённые + воиднутые) для рендера.
  // Отменённые/воиднутые показываются в списке как «зачёркнутые» — кассир
  // видит полный состав заказа и понимает что было списано/отменено.
  const visibleItems = useMemo(() => visibleReceiptItems(order.items, voids), [order.items, voids])
  // Merge server-side cancellation/void state with optimistic local cancels —
  // strike-through появляется до round-trip'а к API.
  const voidFlags = useMemo(() => {
    const base = voidedItemFlags(order.items, voids)
    return order.items.map((it, idx) =>
      base[idx] || (it.id ? pendingCancelIds.has(it.id) : false),
    )
  }, [order.items, voids, pendingCancelIds])
  const subtotal = useMemo(
    () => Number(dRound(dSum(visibleItems.map(i => calcLineTotal(i.price, i.qty, i.unit, i.unitSize))))),
    [visibleItems],
  )

  // Order: subtotal → +service → −discount → total.
  // Раньше скидка шла до сервиса (discountedSubtotal × servicePercent), но
  // ресторанная норма — service считается на меню-цену, а скидка применяется
  // к итоговому чеку. Поэтому процент скидки тоже теперь от subtotalWithService.
  const serviceAmount = includeService && servicePercent > 0
    ? Number(dRound(dDiv(dMul(subtotal, servicePercent), 100)))
    : 0
  const subtotalWithService = Number(dSum([subtotal, serviceAmount]))

  // discountAmount пересчитывается ТОЛЬКО если изменилась сумма базы
  // (subtotalWithService) ИЛИ применённое значение/тип. Draft изменения
  // никак не задевают totals — это и есть смысл «применяется по клику».
  useEffect(() => {
    if (discountType === 'percent' && discountValue > 0) {
      setDiscountAmount(Number(dRound(dDiv(dMul(subtotalWithService, discountValue), 100))))
    } else if (discountType === 'fixed' && discountValue > 0) {
      setDiscountAmount(Math.min(discountValue, subtotalWithService))
    } else {
      setDiscountAmount(0)
    }
  }, [discountType, discountValue, subtotalWithService])

  const total = Math.max(0, Number(dSub(subtotalWithService, discountAmount > 0 ? discountAmount : 0)))

  // Handlers ---------------------------------------------------------------
  // «Закрыть и оплатить» в панели → НЕ закрывает заказ сразу, а открывает
  // drawer с финальным receipt-preview'ом. Закрытие/печать происходят из
  // драйвер-кнопок (handleFinalizeAndPrint / handlePrintCloseReceipt).
  const handleClose = async () => {
    if (submitting) return
    if (visibleItems.length === 0) {
      toast.error('Нет позиций для оплаты')
      return
    }
    if (paymentMethod === 'noncash' && !selectedAccountId) {
      toast.error('Выберите счёт зачисления')
      return
    }
    // Hard-block: проверим открытую смену ДО открытия receipt-drawer'а,
    // чтобы кассир увидел понятное сообщение сразу, а не на финализации.
    // closeOrderWithPayment сам тоже throw'нет (defense in depth), здесь
    // pre-check ради UX. При ошибке fetch'а — пускаем дальше, server-side
    // gate всё равно сработает.
    try {
      const shift = await fetchActiveShift()
      if (!shift) {
        toast.error('Откройте кассовую смену перед оплатой', {
          action: { label: 'Открыть смену', onClick: () => navigate('/operations/shifts') },
          duration: 6000,
        })
        return
      }
    } catch { /* network hiccup — пускаем, server-side gate ловит */ }
    const acct = accounts.find(a => a.id === selectedAccountId)
    const data = buildReceiptData(
      order,
      { restaurant, currentUser: user, voids },
      {
        isPreCheck: false,
        includeService,
        servicePercent,
        discountAmount: discountAmount > 0 ? discountAmount : undefined,
        discountReason: discountReason || undefined,
        paymentMethod: paymentMethod === 'cash' ? 'cash' : 'card',
        accountName: acct?.name,
      },
    )
    setCloseReceiptData(data)
    setCloseReceiptOpen(true)
  }

  // «Закрыть и распечатать» / «Закрыть» — финализируем заказ. Чек-job
  // создаётся бэкендом внутри POST /orders/{id}/close (см.
  // server/internal/service/orders_close.go enqueueReceipt) — фронт ничего
  // дополнительно не печатает. Раньше тут был client-side printReceiptDirect
  // через legacy print-server (Path A) — теперь весь pipeline server-side
  // (Path B): backend → print_jobs → worker → driver.
  const handleFinalizeAndPrint = async ({ alsoPrint }: { alsoPrint: boolean }) => {
    if (submitting || !closeReceiptData) return
    setSubmitting(true)
    try {
      const acct = accounts.find(a => a.id === selectedAccountId)
      const cogs = visibleItems.reduce(
        (s, i) => s + calcLineCogs(i.cogs || 0, i.qty, i.unit, i.unitSize),
        0,
      )
      await closeOrderWithPayment(
        order.id,
        paymentMethod === 'cash' ? 'cash' : 'card',
        order.tableId || null,
        subtotal,
        cogs,
        user?.id,
        selectedAccountId || undefined,
        acct?.name,
        servicePercent,
        serviceAmount,
        total,
        0,
        discountAmount > 0 ? discountAmount : undefined,
        discountType ?? undefined,
        discountValue || undefined,
        discountReason || undefined,
        undefined,
      )
      toast.success(alsoPrint ? 'Заказ оплачен · чек отправлен на печать' : 'Заказ оплачен')
      setCloseReceiptOpen(false)
      setCloseReceiptData(null)
      onClosed?.()
    } catch (e) {
      toast.error(e instanceof Error ? `Ошибка оплаты: ${e.message}` : 'Ошибка оплаты')
    }
    setSubmitting(false)
  }

  const handleCancel = async () => {
    if (submitting) return
    const reason = (cancelReason === 'Другое' ? cancelReasonCustom.trim() : cancelReason).trim()
    if (!reason) {
      toast.error('Укажите причину отмены')
      return
    }
    setSubmitting(true)
    try {
      // Soft-cancel: помечает order_items.cancelled_at, ставит order.status =
      // 'cancelled', освобождает стол. AutoPrintRunner затем видит элементы
      // с (cancelledAt && printedAt && !cancelPrintedAt) и печатает
      // кухонный «ОТМЕНА». Раньше использовался deleteOrder — он жёстко
      // удалял строки, и runner не находил что отменять.
      await cancelOrder(order.id, reason, user?.id)
      toast.success('Заказ отменён')
      setCancelOpen(false)
      onCancelled?.()
    } catch (e) {
      toast.error(e instanceof Error ? `Ошибка отмены: ${e.message}` : 'Ошибка отмены')
    }
    setSubmitting(false)
  }

  const handleVoidConfirm = async () => {
    if (!voidingItem || voiding) return
    const item = voidingItem
    const reasonLabel = VOID_REASON_LABELS[voidReason]
    setVoiding(true)
    // Optimistic: подсветим item как отменённый сразу (стрейк появляется без
    // ожидания API). cancelOrderItem ставит cancelled_at в БД → SSE →
    // AutoPrintRunner подхватит и напечатает кухонную «ОТМЕНА» для уже
    // напечатанных позиций. Раньше тут был createVoid (биллинговый void в
    // отдельной таблице) — кухня не уведомлялась.
    setPendingCancelIds(prev => new Set(prev).add(item.id))
    setVoidingItem(null)
    setVoidReason('guest_changed_mind')
    try {
      await cancelOrderItem(item.id, reasonLabel, user?.id)
      toast.success(`Отменено: ${item.name}`)
      // Parent перечитает order — cancelled_at прилетит в order.items[*],
      // и pending можно очистить (флаг уже закрепится через voidedItemFlags).
      onItemsChanged?.()
      setPendingCancelIds(prev => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    } catch (e) {
      // Rollback optimistic.
      setPendingCancelIds(prev => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
      toast.error(e instanceof Error ? `Ошибка отмены: ${e.message}` : 'Ошибка отмены')
    }
    setVoiding(false)
  }

  const handleSaveNote = async () => {
    if (!editingNote || savingNote) return
    const target = editingNote
    const trimmed = target.draftNote.trim()
    setSavingNote(true)
    try {
      await setOrderItemNote(order.id, target.id, trimmed.length === 0 ? null : trimmed)
      toast.success('Комментарий сохранён')
      setEditingNote(null)
      onItemsChanged?.()
    } catch (e) {
      toast.error(e instanceof Error ? `Ошибка: ${e.message}` : 'Ошибка сохранения')
    }
    setSavingNote(false)
  }

  const handleClearNote = async () => {
    if (!editingNote || savingNote) return
    const target = editingNote
    setSavingNote(true)
    try {
      await setOrderItemNote(order.id, target.id, null)
      toast.success('Комментарий очищен')
      setEditingNote(null)
      onItemsChanged?.()
    } catch (e) {
      toast.error(e instanceof Error ? `Ошибка: ${e.message}` : 'Ошибка очистки')
    }
    setSavingNote(false)
  }

  const handlePreCheck = () => {
    try {
      const data = buildReceiptData(
        order,
        { restaurant, currentUser: user, voids },
        {
          isPreCheck: true,
          includeService,
          servicePercent,
          discountAmount: discountAmount > 0 ? discountAmount : undefined,
          discountReason: discountReason || undefined,
        },
      )
      setReceiptPreview(data)
      setReceiptOpen(true)
    } catch (e) {
      toast.error(e instanceof Error ? `Ошибка пре-чека: ${e.message}` : 'Ошибка пре-чека')
    }
  }

  // Печать пре-чека из drawer'а превью.
  // Пре-чек идёт через backend (POST /orders/{id}/print-pre-bill → job в БД
  // → worker → physical / virtual printer). Финальный чек после оплаты
  // создаётся бэкендом автоматически при closeOrderWithPayment — отдельная
  // кнопка печати финала больше не нужна.
  const handlePrintReceipt = async () => {
    if (!receiptPreview) return
    try {
      const { jobId } = await printPreBill(order.id)
      toast.success(jobId ? `Пре-чек отправлен на печать (${jobId.slice(0, 8)}…)` : 'Пре-чек отправлен на печать')
      setReceiptOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? `Ошибка печати: ${e.message}` : 'Ошибка печати')
    }
  }

  const clearDiscount = () => {
    setDiscountType(null); setDiscountValue(0); setDiscountAmount(0); setDiscountReason('')
    setDraftType('fixed'); setDraftValue(0); setDraftReason('')
  }

  const openDiscountForm = () => {
    // Заполняем draft из текущего applied (если есть), иначе дефолт fixed/0.
    setDraftType(discountType ?? 'fixed')
    setDraftValue(discountValue || 0)
    setDraftReason(discountReason || '')
    setShowDiscountForm(true)
  }

  const closeDiscountForm = () => {
    setShowDiscountForm(false)
  }

  const applyDiscount = () => {
    if (!draftType || !draftValue) return
    setDiscountType(draftType)
    setDiscountValue(draftValue)
    setDiscountReason(draftReason)
    // discountAmount пересчитается через useEffect выше, на следующем рендере.
    setShowDiscountForm(false)
  }

  // Live preview суммы скидки от draft'а — для CTA «Применить · −X TJS».
  const draftPreviewAmount = useMemo(() => {
    if (!draftType || !draftValue) return 0
    if (draftType === 'percent') {
      return Number(dRound(dDiv(dMul(subtotalWithService, draftValue), 100)))
    }
    return Math.min(draftValue, subtotalWithService)
  }, [draftType, draftValue, subtotalWithService])

  // Fixed-amount пресеты «округлить вниз до X». Кнопки подписаны целевой
  // суммой (то, что увидит гость в чеке), а не размером скидки — это
  // совпадает с интентом кассира («хочу чтобы было 200»).
  const fixedRoundDownPresets = useMemo(() => {
    if (draftType !== 'fixed' || subtotalWithService <= 0) return []
    const seenTargets = new Set<number>()
    const out: { target: number; amount: number }[] = []
    for (const step of FIXED_ROUND_DOWN_STEPS) {
      const target = Math.floor(subtotalWithService / step) * step
      if (target <= 0 || seenTargets.has(target)) continue
      const amount = Number(dRound(dSub(subtotalWithService, target)))
      if (amount <= 0) continue
      seenTargets.add(target)
      out.push({ target, amount })
    }
    return out
  }, [draftType, subtotalWithService])

  // ------------------------------------------------------------------------
  return (
    <div className="flex flex-col h-full">
      {/* Order metadata row: # заказа + текущий официант + смена.
          Раньше эта инфа жила только в OrderActionsDialog — кассир, работая
          в инлайн-панели, не видел кому принадлежит заказ и не мог передать
          его другому официанту без ухода в карту зала. */}
      <div className="shrink-0 px-3 pt-3 pb-2 border-b border-border space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex items-baseline gap-2 min-w-0">
            <span className="text-sm font-bold text-foreground shrink-0">
              Заказ #{order.orderNumber ?? order.id.slice(-6)}
            </span>
            {timeSince ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums shrink-0">
                <Clock className="size-3" />
                {timeSince}
              </span>
            ) : null}
          </div>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
            {order.status === 'new' ? 'Новый'
              : order.status === 'cooking' ? 'Готовится'
              : order.status === 'ready' ? 'К выдаче'
              : order.status === 'served' ? 'Подан'
              : order.status === 'bill_requested' ? 'Счёт'
              : order.status}
          </span>
        </div>
        {/* Waiter picker — только для зальных заказов. Takeaway/delivery
            не привязаны к официанту: некого назначать, и assignWaiter
            операция привязана к столу. Скрываем чтобы не плодить
            disabled-контролы и визуальный шум. */}
        {isHallOrder(order.type) ? (
          <Popover open={waiterPickerOpen} onOpenChange={setWaiterPickerOpen}>
            <PopoverTrigger asChild>
              <button
                disabled={!order.tableId || changingWaiter}
                className="w-full inline-flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-muted hover:bg-muted/70 text-xs disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title={order.tableId ? 'Сменить официанта' : 'Заказ без стола — изменить нельзя'}
              >
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  <UserIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">Официант:</span>
                  <span className="font-semibold text-foreground truncate">
                    {currentWaiter?.name ?? 'не назначен'}
                  </span>
                </span>
                {order.tableId ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : null}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-1">
              {waiters.length === 0 ? (
                <p className="text-xs text-muted-foreground p-2 text-center">Нет официантов</p>
              ) : (
                <div className="max-h-72 overflow-y-auto">
                  {currentWaiter ? (
                    <button
                      onClick={() => handleChangeWaiter(null)}
                      disabled={changingWaiter}
                      className="w-full text-left px-2.5 py-2 rounded-md text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      Снять официанта
                    </button>
                  ) : null}
                  {waiters.map(w => {
                    const active = w.id === order.waiterId
                    return (
                      <button
                        key={w.id}
                        onClick={() => handleChangeWaiter(w.id)}
                        disabled={changingWaiter || active}
                        className={`w-full text-left px-2.5 py-2 rounded-md text-xs ${
                          active
                            ? 'bg-primary/10 text-primary font-semibold cursor-default'
                            : 'text-foreground hover:bg-muted disabled:opacity-50'
                        }`}
                      >
                        {w.name}
                        {active ? <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">текущий</span> : null}
                      </button>
                    )
                  })}
                </div>
              )}
            </PopoverContent>
          </Popover>
        ) : null}
      </div>

      {/* Items list — все позиции, отменённые/воиднутые показаны зачёркнутыми. */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Позиции заказа · {visibleItems.length}
            {voidFlags.some(Boolean) ? (
              <span className="ml-1.5 text-muted-foreground/70 font-normal">
                · списано {voidFlags.filter(Boolean).length}
              </span>
            ) : null}
          </h3>
        </div>
        {order.items.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">Нет позиций</p>
        ) : order.items.map((item, idx) => {
          const voided = voidFlags[idx]
          return (
            <div
              key={`${item.id ?? idx}-${idx}`}
              className={`flex items-center gap-2 rounded-xl p-2.5 border ${
                voided ? 'bg-muted/40 border-dashed border-border/60' : 'bg-background border-border'
              }`}
            >
              <span className={`text-base shrink-0 ${voided ? 'opacity-40' : ''}`}>{item.emoji ?? '·'}</span>
              <div className="flex-1 min-w-0">
                <p className={`text-xs font-medium truncate ${voided ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                  {item.name}
                </p>
                <p className={`text-[10px] ${voided ? 'text-muted-foreground/70 line-through' : 'text-muted-foreground'}`}>
                  ×{item.qty} · {formatCurrency(item.price)}
                </p>
                {item.note ? (
                  <p className="text-[10px] italic text-amber-700/90 dark:text-amber-300/90 truncate">
                    ! {item.note}
                  </p>
                ) : null}
              </div>
              <span className={`text-xs font-bold min-w-[5rem] text-right tabular-nums whitespace-nowrap ${
                voided ? 'text-muted-foreground line-through' : 'text-foreground'
              }`}>
                {formatCurrency(calcLineTotal(item.price, item.qty, item.unit, item.unitSize))}
              </span>
              {!voided && item.id ? (
                <button
                  onClick={() => setEditingNote({ id: item.id!, name: item.name, draftNote: item.note ?? '' })}
                  title={item.note ? 'Редактировать комментарий' : 'Добавить комментарий'}
                  className={`size-6 rounded-md flex items-center justify-center transition-colors shrink-0 ${
                    item.note
                      ? 'text-amber-700 dark:text-amber-300 hover:bg-amber-500/10'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                >
                  <Pencil className="size-3.5" />
                </button>
              ) : null}
              {!voided && item.id ? (
                <button
                  onClick={() => setVoidingItem({ id: item.id!, name: item.name, qty: item.qty, price: item.price })}
                  title="Отменить позицию"
                  className="size-6 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 flex items-center justify-center transition-colors shrink-0"
                >
                  <X className="size-3.5" />
                </button>
              ) : (
                <span className="size-6 shrink-0" aria-hidden />
              )}
            </div>
          )
        })}
      </div>

      {/* Footer: totals + payment + actions.
          Порядок: Подытог → Обслуживание → Скидка → К оплате.
          Service применяется к меню-цене (subtotal), а скидка — к итогу
          (subtotal + service). Это ресторанная норма: «service на чек,
          скидка с финальной суммы». */}
      <div className="border-t border-border bg-card p-3 space-y-2.5">
        {/* Subtotal */}
        <div className="flex justify-between items-center text-sm">
          <span className="text-muted-foreground">Подытог</span>
          <span className="font-medium tabular-nums">{formatCurrency(subtotal)}</span>
        </div>

        {/* Service — checkbox + read-only %. Процент задаётся на уровне
            ресторана (restaurant.servicePercent) и кассир не должен его
            менять «на лету» (раньше тут был number input — это давало
            кассиру простор подгонять чек). Можно только включить/выключить. */}
        <div className="flex items-center justify-between text-sm">
          <label className="inline-flex items-center gap-2 text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeService}
              onChange={e => setIncludeService(e.target.checked)}
              className="size-3.5 accent-primary"
            />
            Обслуживание
            {servicePercent > 0 ? (
              <span className="text-xs text-muted-foreground/70 tabular-nums">({servicePercent}%)</span>
            ) : null}
          </label>
          {includeService && servicePercent > 0 ? (
            <span className="text-sm font-medium tabular-nums">+{formatCurrency(serviceAmount)}</span>
          ) : null}
        </div>

        {/* Discount — applied chip OR compact inline editor.
            Раньше тут была громоздкая форма с заголовком «Скрыть форму скидки»,
            двумя полноразмерными типа-табами и отдельной парой Отмена/Применить.
            Теперь:
              • applied → одна строка как у Подытог: «Скидка · причина  −X TJS [×]»
              • editor → segmented-control + numeric input с suffix-юнитом +
                presets (для %) + причина + primary «Применить · −X TJS».
              • collapsed → один компактный chip «+ Скидка» вместо текстовой
                ссылки и нелинейного toggle. */}
        {discountAmount > 0 ? (
          <div className="flex justify-between items-center text-sm">
            <span className="text-muted-foreground inline-flex items-center gap-1.5 min-w-0">
              <Tag className="size-3.5 shrink-0" />
              <span className="truncate">Скидка{discountReason ? ` · ${discountReason}` : ''}</span>
              <button
                onClick={clearDiscount}
                title="Убрать скидку"
                className="shrink-0 text-muted-foreground hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </span>
            <span className="font-medium text-destructive tabular-nums">−{formatCurrency(discountAmount)}</span>
          </div>
        ) : !showDiscountForm ? (
          <button
            onClick={openDiscountForm}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-muted-foreground border border-dashed border-border hover:border-primary/50 hover:text-primary hover:bg-primary/5 transition-colors"
          >
            <Tag className="size-3.5" /> Скидка
          </button>
        ) : (
          <div className="rounded-lg border border-border bg-background p-2.5 space-y-2">
            {/* Header: title + close */}
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                <Tag className="size-3" /> Скидка
              </span>
              <button
                onClick={closeDiscountForm}
                title="Закрыть"
                className="size-5 rounded text-muted-foreground hover:text-foreground hover:bg-muted inline-flex items-center justify-center"
              >
                <X className="size-3.5" />
              </button>
            </div>

            {/* Segmented control: % / TJS */}
            <div className="grid grid-cols-2 p-0.5 bg-muted rounded-md">
              <button
                onClick={() => setDraftType('percent')}
                className={`py-1 rounded text-xs font-medium transition-colors ${
                  draftType === 'percent' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >%</button>
              <button
                onClick={() => setDraftType('fixed')}
                className={`py-1 rounded text-xs font-medium transition-colors ${
                  draftType === 'fixed' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >TJS</button>
            </div>

            {/* Value input with adaptive suffix as one visual unit. step=0.01
                чтобы можно было вводить дробные значения вроде 0,75 / 5,50. */}
            <div className="flex items-center rounded-md border border-border focus-within:ring-2 focus-within:ring-primary/30 focus-within:border-primary/40 bg-background">
              <input
                ref={draftValueRef}
                type="number"
                min={0}
                step="0.01"
                value={draftValue || ''}
                onChange={e => setDraftValue(Math.max(0, Number(e.target.value) || 0))}
                onKeyDown={e => { if (e.key === 'Enter' && draftType && draftValue > 0) applyDiscount() }}
                placeholder={draftType === 'percent' ? '10' : '10'}
                className="flex-1 px-2.5 py-1.5 text-base font-semibold tabular-nums bg-transparent rounded-l-md focus:outline-none"
              />
              <span className="px-2.5 text-xs font-medium text-muted-foreground select-none">
                {draftType === 'percent' ? '%' : 'TJS'}
              </span>
            </div>

            {/* Quick presets — meaning depends on type. */}
            {draftType === 'percent' && (
              <div className="flex gap-1">
                {DISCOUNT_PRESETS_PERCENT.map(p => (
                  <button
                    key={p}
                    onClick={() => setDraftValue(p)}
                    className={`flex-1 py-1 rounded text-xs font-medium transition-colors ${
                      draftValue === p
                        ? 'bg-primary/10 text-primary border border-primary/40'
                        : 'bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground border border-transparent'
                    }`}
                  >{p}%</button>
                ))}
              </div>
            )}
            {draftType === 'fixed' && fixedRoundDownPresets.length > 0 && (
              <div className="space-y-1">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                  Округлить до
                </p>
                <div className="flex gap-1">
                  {fixedRoundDownPresets.map(p => {
                    const active = draftValue === p.amount
                    return (
                      <button
                        key={p.target}
                        onClick={() => setDraftValue(p.amount)}
                        className={`flex-1 py-1 rounded text-xs font-medium tabular-nums transition-colors ${
                          active
                            ? 'bg-primary/10 text-primary border border-primary/40'
                            : 'bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground border border-transparent'
                        }`}
                        title={`Скидка −${formatCurrency(p.amount)} TJS`}
                      >
                        {formatCurrency(p.target)}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Reason — optional, muted weight */}
            <input
              type="text"
              value={draftReason}
              onChange={e => setDraftReason(e.target.value)}
              placeholder="Причина (необязательно)"
              className="w-full px-2.5 py-1.5 text-xs border border-border rounded-md bg-background placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40"
            />

            {/* Apply — single primary CTA. Preview computed from draft, totals
                не двигаются пока не нажата кнопка. */}
            <button
              onClick={applyDiscount}
              disabled={!draftType || !draftValue}
              className="w-full py-2 text-xs font-bold bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {!draftValue
                ? 'Введите значение'
                : `Применить · −${formatCurrency(draftPreviewAmount)}`}
            </button>
          </div>
        )}

        {/* Total */}
        <div className="flex justify-between items-center pt-2 border-t border-border">
          <span className="text-sm font-semibold text-foreground">К оплате</span>
          <span className="text-2xl font-bold text-primary tabular-nums leading-none">{formatCurrency(total)}</span>
        </div>

        {/* Payment method */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setPaymentMethod('cash')}
            className={`py-2.5 rounded-lg text-sm font-medium border-2 transition-colors ${
              paymentMethod === 'cash' ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >Наличные</button>
          <button
            onClick={() => setPaymentMethod('noncash')}
            className={`py-2.5 rounded-lg text-sm font-medium border-2 transition-colors ${
              paymentMethod === 'noncash' ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >Безналичные</button>
        </div>

        {/* Account picker for noncash. Only shown when there's more than one
            non-cash account; otherwise we silently use the auto-selected one. */}
        {paymentMethod === 'noncash' && accounts.filter(a => a.type !== 'cash').length > 1 && (
          <select
            value={selectedAccountId}
            onChange={e => setSelectedAccountId(e.target.value)}
            className="w-full px-2.5 py-2 text-sm border border-border rounded-lg bg-background"
          >
            {accounts.filter(a => a.type !== 'cash').map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}

        {/* Main CTA */}
        <button
          onClick={handleClose}
          disabled={submitting || total <= 0}
          className="w-full py-3.5 bg-primary text-primary-foreground rounded-xl text-sm font-bold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
        >
          <CreditCard className="size-5" />
          {submitting ? 'Обработка...' : `Закрыть и оплатить · ${formatCurrency(total)}`}
        </button>

        {/* Secondary actions */}
        <div className={`grid gap-2 ${onOpenAdvanced ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <button
            onClick={handlePreCheck}
            className="py-2 text-xs font-medium text-muted-foreground border border-border rounded-lg hover:bg-muted inline-flex items-center justify-center gap-1.5"
          >
            <Receipt className="size-3.5" /> Пре-чек
          </button>
          {onOpenAdvanced ? (
            <button
              onClick={onOpenAdvanced}
              className="py-2 text-xs font-medium text-muted-foreground border border-border rounded-lg hover:bg-muted inline-flex items-center justify-center gap-1.5"
              title="Разделить счёт, смешанная оплата, чаевые, переоткрытие"
            >
              <Settings2 className="size-3.5" /> Дополнительно
            </button>
          ) : null}
        </div>

        {/* Cancel order */}
        <button
          onClick={() => setCancelOpen(true)}
          className="w-full text-xs text-destructive hover:underline py-1 inline-flex items-center justify-center gap-1"
        >
          <Trash2 className="size-3" /> Отменить заказ
        </button>
      </div>

      {/* Pre-check preview drawer. Mirrors OrderActionsDialog: показывает
          PrintReceipt с кнопками «Печать чека» и «Закрыть». Нужен чтобы
          кассир мог визуально проверить состав/итог до вывода на термопринтер,
          и чтобы закрытие drawer'а отменяло печать (т.е. это превью, не
          fire-and-forget). */}
      <Sheet open={receiptOpen} onOpenChange={setReceiptOpen}>
        <SheetContent className="md:h-full h-[95vh] flex flex-col md:!max-w-lg lg:!max-w-xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <button
                onClick={() => setReceiptOpen(false)}
                className="size-7 rounded-md hover:bg-muted inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
                title="Назад"
              >
                <ChevronLeft className="size-5" />
              </button>
              <FileText className="size-5 text-blue-500" />
              Предварительный счёт
            </SheetTitle>
            <SheetDescription>
              Заказ #{order.orderNumber ?? order.id.slice(-6)}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 flex flex-col items-center py-4">
            {receiptPreview ? (
              <div className="bg-white rounded-lg shadow-lg border border-border p-2">
                <PrintReceipt ref={receiptRef} data={receiptPreview} />
              </div>
            ) : null}
          </div>
          <SheetFooter className="px-4 gap-2">
            <button
              onClick={handlePrintReceipt}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-4 text-base font-medium md:py-3 md:text-sm text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Printer className="size-4" />
              Печать чека
            </button>
            <button
              onClick={() => setReceiptOpen(false)}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border-2 border-border px-5 py-4 text-base font-medium md:py-3 md:text-sm hover:bg-muted transition-colors"
            >
              Назад
            </button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Close-and-pay receipt drawer.
          Открывается из «Закрыть и оплатить» в футере панели — показывает
          финальный чек-превью (с указанным методом оплаты), не закрывая
          ещё заказ. Действия:
            • Назад / × — закрыть drawer, заказ остался открытым.
            • Только печать — напечатать чек, заказ остался открытым.
            • Закрыть и распечатать — closeOrderWithPayment + печать +
              закрыть drawer. Это happy-path. */}
      <Sheet open={closeReceiptOpen} onOpenChange={(o) => { if (!submitting) setCloseReceiptOpen(o) }}>
        <SheetContent className="md:h-full h-[95vh] flex flex-col md:!max-w-lg lg:!max-w-xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <button
                onClick={() => { if (!submitting) setCloseReceiptOpen(false) }}
                disabled={submitting}
                className="size-7 rounded-md hover:bg-muted inline-flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
                title="Назад"
              >
                <ChevronLeft className="size-5" />
              </button>
              <CheckCircle2 className="size-5 text-emerald-500" />
              Закрытие заказа
            </SheetTitle>
            <SheetDescription>
              Заказ #{order.orderNumber ?? order.id.slice(-6)} · {paymentMethod === 'cash' ? 'Наличные' : 'Безналичные'} · {formatCurrency(total)}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 flex flex-col items-center py-4">
            {closeReceiptData ? (
              <div className="bg-white rounded-lg shadow-lg border border-border p-2">
                <PrintReceipt ref={closeReceiptRef} data={closeReceiptData} />
              </div>
            ) : null}
          </div>
          <SheetFooter className="px-4 flex-col gap-2 sm:flex-col">
            <button
              onClick={() => handleFinalizeAndPrint({ alsoPrint: true })}
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-4 text-base font-bold md:py-3 md:text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <CheckCircle2 className="size-4" />
              {submitting ? 'Обработка...' : `Закрыть и распечатать · ${formatCurrency(total)}`}
            </button>
            <button
              onClick={() => handleFinalizeAndPrint({ alsoPrint: false })}
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-border px-4 py-2.5 text-sm font-medium hover:bg-muted disabled:opacity-50 transition-colors"
              title="Закрыть заказ без печати чека"
            >
              <CheckCircle2 className="size-4" />
              Закрыть без печати
            </button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Void item confirmation */}
      <AlertDialog open={!!voidingItem} onOpenChange={(o) => { if (!o) setVoidingItem(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отменить позицию?</AlertDialogTitle>
            <AlertDialogDescription>
              {voidingItem ? `«${voidingItem.name}» (×${voidingItem.qty}) — ${formatCurrency(voidingItem.price * voidingItem.qty)}. Если позиция уже напечатана на кухню — туда уйдёт уведомление об отмене.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid grid-cols-2 gap-1.5">
            {VOID_REASONS.map(r => (
              <button
                key={r}
                onClick={() => setVoidReason(r)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-md border ${
                  voidReason === r ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'
                }`}
              >{VOID_REASON_LABELS[r]}</button>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={voiding}>Не отменять</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleVoidConfirm}
              disabled={voiding}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {voiding ? '...' : 'Отменить позицию'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit note dialog — комментарий к позиции (без лука / без перца / на вынос). */}
      <AlertDialog open={!!editingNote} onOpenChange={(o) => { if (!o) setEditingNote(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Комментарий к «{editingNote?.name ?? ''}»</AlertDialogTitle>
            <AlertDialogDescription>
              Пожелания клиента или особенности приготовления. Печатается в кухонном ранере вместе с позицией.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <textarea
            value={editingNote?.draftNote ?? ''}
            onChange={e => setEditingNote(prev => prev ? { ...prev, draftNote: e.target.value } : prev)}
            placeholder="например: без лука, хорошо прожарить"
            rows={3}
            className="w-full px-2.5 py-1.5 text-sm border border-border rounded-md bg-background resize-none"
            autoFocus
          />
          <div className="flex flex-wrap gap-1.5">
            {['Без лука', 'Без соли', 'Хорошо прожарить', 'На вынос', 'Острое', 'Без перца'].map(preset => (
              <button
                key={preset}
                onClick={() => setEditingNote(prev => prev ? { ...prev, draftNote: preset } : prev)}
                className="px-2 py-1 text-[11px] rounded-full border border-border text-muted-foreground hover:bg-muted"
              >{preset}</button>
            ))}
          </div>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={savingNote}>Отмена</AlertDialogCancel>
            <button
              onClick={handleClearNote}
              disabled={savingNote}
              className="px-3 py-1.5 text-sm rounded-md border border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >Очистить</button>
            <AlertDialogAction onClick={handleSaveNote} disabled={savingNote}>
              {savingNote ? '...' : 'Сохранить'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel whole order confirmation + reason picker. Reason обязателен —
          без него cancelOrder() падает на сервере. Кухня получит «ОТМЕНА» с
          указанной причиной для каждой уже напечатанной позиции. */}
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="inline-flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" /> Отменить весь заказ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Заказ #{order.orderNumber ?? order.id.slice(-6)} будет помечен как отменённый, стол освободится. Кухне уйдёт уведомление об отмене для уже напечатанных позиций.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-foreground">Причина отмены</p>
            <div className="grid grid-cols-2 gap-1.5">
              {['Ошибка официанта', 'Нет ингредиента', 'Отменено клиентом', 'Другое'].map(r => (
                <button
                  key={r}
                  onClick={() => setCancelReason(r)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md border ${
                    cancelReason === r ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'
                  }`}
                >{r}</button>
              ))}
            </div>
            {cancelReason === 'Другое' && (
              <input
                type="text"
                value={cancelReasonCustom}
                onChange={e => setCancelReasonCustom(e.target.value)}
                placeholder="Опишите причину"
                autoFocus
                className="w-full px-2.5 py-1.5 text-sm border border-border rounded-md bg-background"
              />
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Не отменять</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancel}
              disabled={submitting || (cancelReason === 'Другое' && !cancelReasonCustom.trim())}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {submitting ? '...' : 'Отменить заказ'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
