'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Banknote, CreditCard, SquareSplitHorizontal, Printer, ArrowLeft, Trash2, Plus, ReceiptText, Percent } from 'lucide-react'
import { toast } from 'sonner'
import { closeOrderWithPayment, printPreBill, fetchActiveShift } from '@/lib/queries'
import { selectableAccounts } from '@/lib/queries/finance'
import { V4Error } from '@/lib/api'
import { formatCurrency, calcLineCogs } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { dSub, dSum } from '@/lib/decimal'
import { discountAmount, payable as calcPayable, type DiscountType } from '@/lib/pos-v2/pay'
import { buildReceiptData } from '@/lib/receipt-data'
import { PrintReceipt } from '@/components/print-receipt'
import type { Order, FinancialAccount, OrderPayment, Restaurant, Table, Zone, User } from '@/lib/types'

// Единая панель оплаты заказа (сайдбар зала + /pos2/pay). Нал / Безнал с выбором
// счёта-кошелька / Смешанная (нал+безнал по счетам) / скидка / обслуживание /
// пре-чек. Бэк пересчитывает суммы; клиент шлёт метод, account_id, servicePercent,
// discountType/Value. payable = (subtotal − скидка) + сервис (зал).
export function PaymentPanel({ order, servicePercent, accounts: allAccounts, userId, onPaid, previewCtx }: {
  order: Order
  servicePercent: number
  accounts: FinancialAccount[]
  userId?: string
  onPaid: () => void
  // Контекст для превью чека слева от панели (имена стола/официанта/ресторана).
  previewCtx?: { restaurant?: Restaurant | null; tables?: Table[]; zones?: Zone[]; users?: User[]; currentUser?: { name?: string } | null }
}) {
  const navigate = useNavigate()
  const [serviceOn, setServiceOn] = useState(order.type === 'hall')
  const [discType, setDiscType] = useState<DiscountType>('none')
  const [discVal, setDiscVal] = useState('')
  const [mode, setMode] = useState<'pick' | 'mixed'>('pick')
  // Смешанная оплата — билдер из N платежей (нал/безнал по счетам) с остатком,
  // по дизайну restos.pen «POS — Смешанная оплата»: Итого/Внесено/Остаток +
  // список платежей + форма добавления + «Провести».
  const [parts, setParts] = useState<OrderPayment[]>([])
  const [addMethod, setAddMethod] = useState<'cash' | 'card'>('cash')
  const [addAmt, setAddAmt] = useState('')
  const [mixedShift, setMixedShift] = useState<{ accountId?: string; accountName?: string } | null>(null)
  const [paying, setPaying] = useState(false)
  const [printing, setPrinting] = useState(false)
  // Выбор безналичного счёта раскрывается только по тапу на «Безналичные»
  // (и только если счетов >1). Тап по чипу счёта сразу проводит оплату.
  const [showCardPicker, setShowCardPicker] = useState(false)
  // Чек не всегда нужен (как в старом POS — закрытие без чека). Тумблер: по
  // умолчанию печатаем, но кассир может выключить → закрытие без печати чека.
  // Состояние СОХРАНЯЕТСЯ (localStorage): выключил раз — так и стоит, пока не включит.
  const [printReceipt, setPrintReceipt] = useState(() => {
    try { return localStorage.getItem('pos-v2-print-receipt') !== '0' } catch { return true }
  })
  useEffect(() => { try { localStorage.setItem('pos-v2-print-receipt', printReceipt ? '1' : '0') } catch {} }, [printReceipt])
  const payingRef = useRef(false)

  // Отключённые счета (миграция 063) к оплате не предлагаем — сервер такую
  // проводку отклонит с 409.
  const accounts = useMemo(() => selectableAccounts(allAccounts), [allAccounts])
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
  // Превью чека — с ЖИВЫМИ скидкой/обслуживанием (итог совпадает с «К оплате»).
  const receiptPreview = useMemo(() => previewCtx ? buildReceiptData(
    order,
    { restaurant: previewCtx.restaurant, tables: previewCtx.tables, zones: previewCtx.zones, users: previewCtx.users, currentUser: previewCtx.currentUser },
    { isPreCheck: false, includeService: sp > 0, servicePercent: sp, discountAmount: discAmt > 0 ? discAmt : undefined },
  ) : null, [previewCtx, order, sp, discAmt])
  const paidSum = useMemo(() => dSum(parts.map(p => p.amount)), [parts])
  const remaining = dSub(payable, paidSum)
  const canContinue = parts.length > 0 && Math.abs(remaining) <= 0.01

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
      toast.error('Скидка требует одобрения менеджера', { description: 'Скидка выше порога ресторана — уменьшите её или проведите через менеджера.', duration: 6000 })
      return
    }
    toast.error(`Оплата не прошла: ${humanizeError(e)}`)
  }

  // Смена не открыта — заметное предупреждение с прямой кнопкой открытия смены,
  // вместо «ничего не происходит» (тап по «Наличные/Безналичные» молча ничего
  // не давал). Тост-экшен ведёт на экран смены нового POS.
  function warnNoShift() {
    toast.error('Смена не открыта', {
      description: 'Откройте кассовую смену, чтобы принимать оплату.',
      action: { label: 'Открыть смену', onClick: () => navigate('/pos2/shift') },
      duration: 7000,
    })
  }

  // Наличные зачисляем на cash-счёт смены (если задан), иначе первый cash-счёт.
  function cashAccount(shift: unknown): { id?: string; name?: string } {
    const s = shift as { accountId?: string; accountName?: string }
    return s.accountId ? { id: s.accountId, name: s.accountName } : { id: cashAcc?.id, name: cashAcc?.name }
  }

  async function payFull(method: 'cash' | 'card', cardAccountId?: string) {
    if (payingRef.current) return
    // Для безнала берём явно выбранный счёт (тап по чипу) или текущий по умолчанию.
    const chosenCard = method === 'card'
      ? (cardAccountId ? (nonCash.find(a => a.id === cardAccountId) ?? cardAcc) : cardAcc)
      : undefined
    if (method === 'card' && !chosenCard) { toast.error('Нет безналичного счёта — заведите его в настройках'); return }
    payingRef.current = true; setPaying(true)
    try {
      const shift = await fetchActiveShift()
      if (!shift) { warnNoShift(); return }
      const acc = method === 'cash' ? cashAccount(shift) : { id: chosenCard?.id, name: chosenCard?.name }
      const [dA, dT, dV] = discArgs()
      await closeOrderWithPayment(order.id, method, order.tableId || null, base, cogsOf(order), userId, acc.id, acc.name, sp, 0, payable, 0, dA, dT, dV, undefined, undefined, !printReceipt)
      toast.success(`Оплачено · ${formatCurrency(payable)} · ${method === 'cash' ? 'Наличные' : 'Безналичные'}`, { description: printReceipt ? 'Чек отправлен на печать' : 'Без чека' })
      onPaid()
    } catch (e) { handleErr(e) }
    finally { payingRef.current = false; setPaying(false) }
  }

  // Вход в смешанную: подтягиваем cash-счёт смены (для наличной части) и ставим
  // сумму добавления = весь остаток (чаще всего первый платёж закрывает большую часть).
  async function enterMixed() {
    setMode('mixed'); setParts([]); setAddMethod('cash')
    const shift = await fetchActiveShift().catch(() => null)
    const s = shift as { accountId?: string; accountName?: string } | null
    setMixedShift(s?.accountId ? { accountId: s.accountId, accountName: s.accountName } : { accountId: cashAcc?.id, accountName: cashAcc?.name })
    setAddAmt(String(payable))
  }
  function addPart() {
    const raw = Math.max(0, parseFloat(addAmt.replace(',', '.').replace(/\s/g, '')) || 0)
    // Не даём внести больше остатка (бэк требует sum(payments)==итог; переплата
    // завела бы в тупик). Последний платёж закрывается ровно на остаток.
    const amt = Math.min(raw, remaining)
    if (amt <= 0) { toast.error('Укажите сумму'); return }
    // Нал → счёт смены (Касса); безнал → выбранный кошелёк.
    const acc = addMethod === 'cash'
      ? { id: mixedShift?.accountId, name: mixedShift?.accountName ?? 'Касса' }
      : { id: cardAcc?.id, name: cardAcc?.name }
    if (!acc.id) { toast.error(addMethod === 'cash' ? 'Нет счёта кассы' : 'Нет безналичного счёта'); return }
    setParts(p => [...p, { method: addMethod, amount: amt, accountId: acc.id!, accountName: acc.name }])
    const rest = dSub(remaining, amt)
    setAddAmt(rest > 0.001 ? String(rest) : '')
  }
  function removePart(i: number) { setParts(p => p.filter((_, idx) => idx !== i)) }
  async function submitMixed() {
    if (payingRef.current) return
    if (!canContinue) { toast.error('Сумма платежей должна равняться сумме к оплате'); return }
    payingRef.current = true; setPaying(true)
    try {
      const shift = await fetchActiveShift()
      if (!shift) { warnNoShift(); return }
      const [dA, dT, dV] = discArgs()
      await closeOrderWithPayment(order.id, parts[0].method, order.tableId || null, base, cogsOf(order), userId, undefined, undefined, sp, 0, payable, 0, dA, dT, dV, undefined, parts, !printReceipt)
      toast.success(`Оплачено · ${formatCurrency(payable)}`, { description: parts.map(p => `${p.method === 'cash' ? 'Нал' : 'Безнал'} ${formatCurrency(p.amount)}`).join(' + ') })
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
    <div className="flex items-stretch">
      {previewCtx && receiptPreview && (
        <aside className="shrink-0 overflow-y-auto pv-noscroll flex justify-center border-r" style={{ width: 'clamp(18rem,27vw,23rem)', background: 'var(--pv-bg)', padding: 'clamp(0.7rem,1vw,1rem)', maxHeight: '82vh', borderColor: 'var(--pv-border)' }}>
          <div className="flex flex-col" style={{ gap: 'clamp(0.7rem,1vw,1rem)', width: 'fit-content' }}>
            <div style={{ zoom: 1.12 }}>
              <PrintReceipt data={receiptPreview} />
            </div>
            {/* Печатать чек — тумблер под превью чека (чек не всегда нужен;
                выкл → закрытие без печати). Состояние в localStorage. */}
            <button onClick={() => setPrintReceipt(v => !v)} className="w-full flex items-center justify-between rounded-xl border active:scale-[0.99] transition-transform" style={{ padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)', borderColor: 'var(--pv-border)', background: 'var(--pv-card)' }} aria-pressed={printReceipt} aria-label="Печатать чек">
              <span className="flex items-center gap-2 font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>
                <Printer style={{ width: '1.15rem', height: '1.15rem', color: printReceipt ? 'var(--pv-brand)' : 'var(--pv-text-3)' }} />Печатать чек
              </span>
              <span className="rounded-full shrink-0" style={{ position: 'relative', width: '2.7rem', height: '1.5rem', background: printReceipt ? 'var(--pv-brand)' : 'var(--pv-border)', transition: 'background 0.15s' }}>
                <span className="rounded-full" style={{ position: 'absolute', top: '0.15rem', left: printReceipt ? '1.35rem' : '0.15rem', width: '1.2rem', height: '1.2rem', background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
              </span>
            </button>
          </div>
        </aside>
      )}
      <div className="flex-1 min-w-0" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)' }}>
      {mode === 'mixed' ? (
        <div className="flex flex-col" style={{ gap: '1rem' }}>
          <button onClick={() => setMode('pick')} className="flex items-center gap-1.5 font-semibold self-start" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}><ArrowLeft style={{ width: '1.1rem', height: '1.1rem' }} />Назад</button>

          {/* Итого / Внесено / Остаток */}
          <div className="grid grid-cols-3" style={{ gap: '0.6rem' }}>
            {([['Итого', payable], ['Внесено', paidSum]] as const).map(([l, v]) => (
              <div key={l} className="flex flex-col items-center rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.7rem 0.5rem', gap: '0.2rem' }}>
                <span className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>{l}</span>
                <span className="font-bold whitespace-nowrap" style={{ color: 'var(--pv-text)', fontSize: 'clamp(0.95rem,1.3vw,1.15rem)' }}>{formatCurrency(v)}</span>
              </div>
            ))}
            <div className="flex flex-col items-center rounded-xl" style={{ background: 'var(--pv-bill-soft)', border: '1px solid #EAD49C', padding: '0.7rem 0.5rem', gap: '0.2rem' }}>
              <span className="font-medium" style={{ color: 'var(--pv-bill-text)', fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>Остаток</span>
              <span className="font-bold whitespace-nowrap" style={{ color: 'var(--pv-bill-text)', fontSize: 'clamp(0.95rem,1.3vw,1.15rem)' }}>{formatCurrency(Math.max(0, remaining))}</span>
            </div>
          </div>

          {/* Добавленные платежи */}
          {parts.length > 0 && (
            <div className="flex flex-col" style={{ gap: '0.5rem' }}>
              {parts.map((p, i) => (
                <div key={i} className="flex items-center justify-between rounded-2xl" style={{ border: '1px solid var(--pv-border)', padding: '0.7rem 0.9rem' }}>
                  <div className="flex items-center gap-2 min-w-0">
                    {p.method === 'cash' ? <Banknote style={{ width: '1.15rem', height: '1.15rem', color: 'var(--pv-text-2)' }} /> : <CreditCard style={{ width: '1.15rem', height: '1.15rem', color: 'var(--pv-brand)' }} />}
                    <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{p.method === 'cash' ? 'Наличные' : 'Безналичные'}</span>
                    {p.accountName && <span className="truncate" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>· {p.accountName}</span>}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(p.amount)}</span>
                    <button onClick={() => removePart(i)} aria-label="Удалить платёж" className="pv-mini"><Trash2 style={{ width: '1.05rem', height: '1.05rem', color: 'var(--pv-text-3)' }} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Форма добавления (пока есть остаток) */}
          {remaining > 0.01 && (
            <div className="rounded-2xl flex flex-col" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', padding: 'clamp(0.9rem,1.4vw,1.15rem)', gap: '0.8rem' }}>
              <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Добавить платёж</span>
              <div className="grid grid-cols-2" style={{ gap: '0.6rem' }}>
                {([['cash', Banknote, 'Наличные'], ['card', CreditCard, 'Безналичные']] as const).map(([mm, Icon, label]) => { const on = addMethod === mm; return (
                  <button key={mm} onClick={() => setAddMethod(mm)} className="flex items-center justify-center gap-2 rounded-xl font-semibold" style={{ height: '3.1rem', background: on ? 'var(--pv-brand-soft)' : 'var(--pv-card)', border: on ? '2px solid var(--pv-brand)' : '1px solid var(--pv-border)', color: on ? 'var(--pv-brand)' : 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>
                    <Icon style={{ width: '1.2rem', height: '1.2rem' }} />{label}
                  </button>
                ) })}
              </div>
              {addMethod === 'card' && nonCash.length > 1 && (
                <div className="flex flex-wrap gap-2">
                  {nonCash.map(a => { const on = a.id === cardAccId; return (
                    <button key={a.id} onClick={() => setCardAccId(a.id)} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.35rem 0.85rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{a.name}</button>
                  ) })}
                </div>
              )}
              <div className="flex items-center rounded-xl" style={{ border: '1px solid var(--pv-border)', background: 'var(--pv-card)', padding: '0.65rem 1rem' }}>
                <input autoFocus inputMode="decimal" value={addAmt} onChange={e => setAddAmt(e.target.value)} placeholder="0" className="flex-1 min-w-0 bg-transparent outline-none font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.7vw,1.5rem)', textAlign: 'center' }} />
                <span className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>с.</span>
              </div>
              <button onClick={addPart} className="w-full flex items-center justify-center gap-2 rounded-xl font-bold text-white active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.7rem,1.1vw,0.95rem)', fontSize: 'var(--pv-ctl)' }}>
                <Plus style={{ width: '1.2rem', height: '1.2rem' }} />Добавить платёж
              </button>
            </div>
          )}

          <button disabled={!canContinue || paying} onClick={submitMixed} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-40 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.9rem,1.4vw,1.2rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)', boxShadow: canContinue ? '0 6px 18px rgba(216,90,48,0.35)' : 'none' }}>
            <ReceiptText style={{ width: '1.3em', height: '1.3em' }} />Провести · {formatCurrency(payable)}
          </button>
        </div>
      ) : (
        <>
          {/* Обслуживание — тумблер в едином стиле с «Печатать чек» (компактная
              строка-карточка, а не голый переключатель). */}
          {order.type === 'hall' && servicePercent > 0 && (
            <button onClick={() => setServiceOn(v => !v)} className="w-full flex items-center justify-between rounded-xl border active:scale-[0.99] transition-transform" style={{ marginBottom: '0.9rem', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)', borderColor: 'var(--pv-border)', background: 'var(--pv-card)' }} aria-pressed={serviceOn} aria-label="Обслуживание">
              <span className="flex items-center gap-2 font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>
                <Percent style={{ width: '1.15rem', height: '1.15rem', color: serviceOn ? 'var(--pv-brand)' : 'var(--pv-text-3)' }} />Обслуживание {servicePercent}%
              </span>
              <span className="rounded-full shrink-0" style={{ position: 'relative', width: '2.7rem', height: '1.5rem', background: serviceOn ? 'var(--pv-brand)' : 'var(--pv-border)', transition: 'background 0.15s' }}>
                <span className="rounded-full" style={{ position: 'absolute', top: '0.15rem', left: serviceOn ? '1.35rem' : '0.15rem', width: '1.2rem', height: '1.2rem', background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
              </span>
            </button>
          )}
          {/* Скидка */}
          <div style={{ marginBottom: '0.9rem' }}>
            <div className="flex items-center gap-2" style={{ marginBottom: discType !== 'none' ? '0.5rem' : 0 }}>
              <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Скидка</span>
              <div className="flex rounded-lg border" style={{ borderColor: 'var(--pv-border)', padding: '2px', gap: '2px', marginLeft: 'auto' }}>
                {(['none', 'percent', 'fixed'] as const).map(v => { const on = discType === v; const l = v === 'none' ? 'Нет' : v === 'percent' ? '%' : 'с.'; return (
                  <button key={v} onClick={() => { setDiscType(v); if (v === 'none') setDiscVal('') }} className="rounded-md font-semibold" style={{ background: on ? 'var(--pv-brand)' : 'transparent', color: on ? '#fff' : 'var(--pv-text-2)', padding: '0.35rem 0.7rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{l}</button>
                ) })}
              </div>
            </div>
            {discType !== 'none' && (
              <div className="flex items-center gap-2">
                <div className="flex items-center rounded-xl border flex-1 min-w-0" style={{ borderColor: 'var(--pv-border)', padding: '0.5rem 0.8rem' }}>
                  <input inputMode="decimal" value={discVal} onChange={e => setDiscVal(e.target.value)} placeholder="0" className="flex-1 min-w-0 bg-transparent outline-none font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }} />
                  <span style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{discType === 'percent' ? '%' : 'с.'}</span>
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
          {!showCardPicker ? (
            <div className="grid grid-cols-2 gap-3">
              <button disabled={paying} onClick={() => payFull('cash')} className="flex flex-col items-center justify-center gap-2 rounded-2xl disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ padding: 'clamp(1rem,1.6vw,1.5rem)', background: 'var(--pv-free-soft)', color: 'var(--pv-free-text)' }}>
                <Banknote style={{ width: '1.9rem', height: '1.9rem' }} /><span className="font-bold" style={{ fontSize: 'clamp(1rem,1.3vw,1.15rem)' }}>Наличные</span>
              </button>
              {/* Безналичные: 1 счёт → сразу оплата; >1 → показываем выбор счёта
                  НА МЕСТЕ этих же кнопок (без роста высоты — модалка не «дёргается»). */}
              <button disabled={paying} onClick={() => { if (nonCash.length > 1) setShowCardPicker(true); else payFull('card') }} className="flex flex-col items-center justify-center gap-2 rounded-2xl disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ padding: 'clamp(1rem,1.6vw,1.5rem)', background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)' }}>
                <CreditCard style={{ width: '1.9rem', height: '1.9rem' }} /><span className="font-bold" style={{ fontSize: 'clamp(1rem,1.3vw,1.15rem)' }}>Безналичные</span>
              </button>
            </div>
          ) : (
            // Выбор безнал-счёта заменяет пару кнопок на месте: тот же грид, тот же
            // размер плиток → без прыжка высоты. Тап по счёту сразу проводит оплату.
            <div className="flex flex-col" style={{ gap: '0.6rem' }}>
              <button onClick={() => setShowCardPicker(false)} className="flex items-center gap-1.5 font-semibold self-start active:scale-95 transition-transform" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>
                <ArrowLeft style={{ width: '1.1rem', height: '1.1rem' }} />Назад
              </button>
              <div className="grid grid-cols-2 gap-3">
                {nonCash.map(a => (
                  <button key={a.id} disabled={paying} onClick={() => payFull('card', a.id)} className="flex flex-col items-center justify-center gap-2 rounded-2xl disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ padding: 'clamp(1rem,1.6vw,1.5rem)', border: '2px solid var(--pv-brand)', background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)' }}>
                    <CreditCard style={{ width: '1.7rem', height: '1.7rem' }} /><span className="font-bold text-center leading-tight" style={{ fontSize: 'clamp(0.95rem,1.2vw,1.1rem)' }}>{a.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {canMix && (
            <button disabled={paying} onClick={enterMixed} className="w-full flex items-center justify-center gap-2 rounded-2xl border disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ marginTop: '0.75rem', padding: 'clamp(0.8rem,1.2vw,1rem)', borderColor: 'var(--pv-border)', color: 'var(--pv-text-2)' }}>
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
    </div>
  )
}
