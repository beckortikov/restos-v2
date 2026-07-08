'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { LayoutGrid, RefreshCw, Plus, CreditCard, XCircle, Trash2, X, ArrowRightLeft, Users, SquareSplitHorizontal, Banknote, Check, StickyNote } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import { fetchOrders, fetchTables, cancelOrder, cancelOrderItem, transferOrder, splitOrderEqual, splitOrderByItems, fetchOrderSplits, paySplit, cancelSplits, fetchFinancialAccounts, setOrderItemNote } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { buildItemAssignments, isSplitValid } from '@/lib/pos-v2/split'
import type { Order, OrderItem, Table, OrderSplit, FinancialAccount } from '@/lib/types'

const ITEM_REASONS = ['Гость передумал', 'Ошибка кухни', 'Некачественно', 'Другое']
const ORDER_REASONS = ['Ошибка официанта', 'Нет ингредиента', 'Отменено клиентом', 'Другое']

// Phase 3.3: тикет открытого заказа — позиции, отмена позиции/заказа, добор, оплата.
export default function PosV2Ticket() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const orderId = params.get('order') ?? ''
  const { user, restaurant } = useAuth()

  const [order, setOrder] = useState<Order | null>(null)
  const [tables, setTables] = useState<Table[]>([])
  const [groups, setGroups] = useState<Order[]>([])
  const [splits, setSplits] = useState<OrderSplit[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitN, setSplitN] = useState(2)
  const [splitMode, setSplitMode] = useState<'equal' | 'items'>('equal')
  const [itemPart, setItemPart] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [cancelItem, setCancelItem] = useState<OrderItem | null>(null)
  const [cancelOrderOpen, setCancelOrderOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [noteItem, setNoteItem] = useState<OrderItem | null>(null)
  const [noteText, setNoteText] = useState('')
  const [itemReason, setItemReason] = useState(ITEM_REASONS[0])
  const [orderReason, setOrderReason] = useState(ORDER_REASONS[0])

  const tableNo = useMemo(() => { const m = new Map<string, number>(); for (const t of tables) m.set(t.id, t.number); return m }, [tables])

  const load = useCallback(async () => {
    if (!orderId) { setLoading(false); return }
    setLoading(true)
    try {
      const [os, ts] = await Promise.all([
        fetchOrders({ ids: [orderId], slim: false }).catch(() => [] as Order[]),
        fetchTables().catch(() => [] as Table[]),
      ])
      setTables(ts)
      const o = os[0] ?? null
      setOrder(o)
      if (o?.isSplit) setSplits(await fetchOrderSplits(o.id).catch(() => [] as OrderSplit[]))
      else setSplits([])
      // Мультитаб: другие открытые заказы (группы) на том же столе.
      const t = o?.tableId ? ts.find(x => x.id === o.tableId) : undefined
      const gids = (t?.currentOrderIds ?? []).filter(Boolean)
      if (gids.length > 1) {
        const gs = await fetchOrders({ ids: gids, slim: true }).catch(() => [] as Order[])
        setGroups(gs.filter(g => g.status !== 'done' && g.status !== 'cancelled'))
      } else setGroups([])
    } finally { setLoading(false) }
  }, [orderId])

  useEffect(() => { load(); fetchFinancialAccounts().then(setAccounts).catch(() => {}) }, [load])

  const label = order ? (order.type === 'hall' ? `Стол ${order.tableId ? (tableNo.get(order.tableId) ?? '—') : '—'}` : 'С собой') : ''
  const items = order?.items ?? []
  const liveItems = items.filter(i => !i.cancelledAt)

  async function doCancelItem() {
    if (busyRef.current || !cancelItem?.id) return
    busyRef.current = true; setBusy(true)
    try {
      const res = await cancelOrderItem(cancelItem.id, itemReason)
      toast.success('Позиция отменена')
      setCancelItem(null)
      if (res.allCancelled) { toast.info('Все позиции отменены — заказ закрыт'); navigate('/pos2/tables'); return }
      await load()
    } catch (e) { toast.error(`Не удалось: ${humanizeError(e)}`) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function doCancelOrder() {
    if (busyRef.current || !order) return
    busyRef.current = true; setBusy(true)
    try {
      await cancelOrder(order.id, orderReason)
      toast.success('Заказ отменён')
      navigate('/pos2/tables')
    } catch (e) { toast.error(`Не удалось отменить: ${humanizeError(e)}`) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function saveNote() {
    if (busyRef.current || !order || !noteItem?.id) return
    busyRef.current = true; setBusy(true)
    try {
      await setOrderItemNote(order.id, noteItem.id, noteText.trim() || null)
      toast.success('Комментарий сохранён')
      setNoteItem(null); await load()
    } catch (e) { toast.error(`Не удалось: ${humanizeError(e)}`) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function doTransfer(tableId: string) {
    if (busyRef.current || !order) return
    busyRef.current = true; setBusy(true)
    try {
      await transferOrder(order.id, { tableId })
      toast.success('Заказ перенесён')
      navigate('/pos2/tables')
    } catch (e) { toast.error(`Не удалось перенести: ${humanizeError(e)}`) }
    finally { busyRef.current = false; setBusy(false) }
  }

  const freeTables = tables.filter(t => t.status === 'free' && t.id !== order?.tableId)
  const cashAcc = accounts.find(a => a.type === 'cash') ?? accounts[0]
  const cardAcc = accounts.find(a => a.type !== 'cash') ?? accounts[0]

  async function doSplit() {
    if (busyRef.current || !order) return
    busyRef.current = true; setBusy(true)
    try {
      await splitOrderEqual(order.id, splitN, order.type === 'hall' ? (restaurant?.servicePercent ?? 0) : 0)
      toast.success(`Счёт разделён на ${splitN}`)
      setSplitOpen(false); await load()
    } catch (e) { toast.error(`Не удалось разделить: ${humanizeError(e)}`) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function doSplitItems() {
    if (busyRef.current || !order) return
    const liveIds = (order.items ?? []).filter(i => !i.cancelledAt && i.id).map(i => i.id!)
    const assignments = buildItemAssignments(liveIds, itemPart, splitN)
    if (!isSplitValid(assignments)) { toast.error('Разнесите позиции минимум на 2 части'); return }
    busyRef.current = true; setBusy(true)
    try {
      await splitOrderByItems(order.id, assignments, order.type === 'hall' ? (restaurant?.servicePercent ?? 0) : 0)
      toast.success('Счёт разделён по позициям')
      setSplitOpen(false); await load()
    } catch (e) { toast.error(`Не удалось разделить: ${humanizeError(e)}`) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function paySplitNow(s: OrderSplit, method: 'cash' | 'card') {
    if (busyRef.current) return
    const acc = method === 'cash' ? cashAcc : cardAcc
    if (!acc) { toast.error('Нет счёта для оплаты'); return }
    busyRef.current = true; setBusy(true)
    try {
      await paySplit(s.id, method, acc.id, acc.name ?? '', user?.id)
      toast.success(`Часть ${s.splitNumber} оплачена · ${formatCurrency(s.total)}`)
      const remaining = splits.filter(x => x.id !== s.id && x.status !== 'paid')
      if (remaining.length === 0) { toast.success('Все части оплачены — заказ закрыт'); navigate('/pos2/tables'); return }
      await load()
    } catch (e) { toast.error(`Оплата не прошла: ${humanizeError(e)}`) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function doCancelSplits() {
    if (busyRef.current || !order) return
    busyRef.current = true; setBusy(true)
    try { await cancelSplits(order.id); toast.success('Разделение отменено'); await load() }
    catch (e) { toast.error(`Не удалось: ${humanizeError(e)}`) }
    finally { busyRef.current = false; setBusy(false) }
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2/tables')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Столы</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>Заказ{label ? ` · ${label}` : ''}</span>
        <div className="flex-1" />
        {order?.type === 'hall' && order.tableId && (
          <button onClick={() => navigate(`/pos2/order?table=${encodeURIComponent(order.tableId!)}`)} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-brand-soft)', borderColor: 'var(--pv-brand)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
            <Plus style={{ width: 'clamp(1.05rem,1.3vw,1.3rem)', height: 'clamp(1.05rem,1.3vw,1.3rem)', color: 'var(--pv-brand)' }} />
            <span className="font-semibold" style={{ color: 'var(--pv-brand)', fontSize: 'var(--pv-ctl)' }}>Группа</span>
          </button>
        )}
        <button onClick={() => load()} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <RefreshCw style={{ width: 'clamp(1.05rem,1.3vw,1.3rem)', height: 'clamp(1.05rem,1.3vw,1.3rem)', color: 'var(--pv-text-2)' }} className={loading ? 'animate-spin' : ''} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Обновить</span>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'var(--pv-gap) var(--pv-pad-x)' }}>
        {loading ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Загрузка…</div>
        ) : !order ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Заказ не найден или закрыт</div>
        ) : (
          <div className="mx-auto flex flex-col" style={{ maxWidth: '44rem', gap: 'clamp(0.5rem,0.9vw,0.8rem)' }}>
            {order.isSplit && (
              <div className="flex flex-col" style={{ gap: 'clamp(0.5rem,0.9vw,0.8rem)', marginBottom: '0.5rem' }}>
                {splits.map(s => {
                  const paid = s.status === 'paid'
                  return (
                    <div key={s.id} className="flex items-center gap-3 rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.7rem,1.1vw,1.1rem)' }}>
                      <div className="rounded-full flex items-center justify-center font-bold shrink-0" style={{ background: paid ? 'var(--pv-free-soft)' : 'var(--pv-brand-soft)', color: paid ? 'var(--pv-free-text)' : 'var(--pv-brand)', width: '2.5rem', height: '2.5rem' }}>{s.splitNumber}</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Часть {s.splitNumber}</div>
                        <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{formatCurrency(s.total)}</div>
                      </div>
                      {paid ? (
                        <div className="flex items-center gap-1.5 rounded-xl shrink-0" style={{ background: 'var(--pv-free-soft)', color: 'var(--pv-free-text)', padding: '0.5rem 0.9rem' }}><Check style={{ width: '1.1rem', height: '1.1rem' }} /><span className="font-semibold" style={{ fontSize: 'var(--pv-ctl)' }}>Оплачено</span></div>
                      ) : (
                        <div className="flex items-center gap-2 shrink-0">
                          <button disabled={busy} onClick={() => paySplitNow(s, 'cash')} className="rounded-xl flex items-center gap-1.5 font-semibold disabled:opacity-50 active:scale-95 transition-transform" style={{ background: 'var(--pv-free-soft)', color: 'var(--pv-free-text)', padding: '0.5rem 0.8rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}><Banknote style={{ width: '1rem', height: '1rem' }} />Нал</button>
                          <button disabled={busy} onClick={() => paySplitNow(s, 'card')} className="rounded-xl flex items-center gap-1.5 font-semibold disabled:opacity-50 active:scale-95 transition-transform" style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', padding: '0.5rem 0.8rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}><CreditCard style={{ width: '1rem', height: '1rem' }} />Карта</button>
                        </div>
                      )}
                    </div>
                  )
                })}
                <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)', textAlign: 'center', marginTop: '0.2rem' }}>Позиции заказа (справочно):</div>
              </div>
            )}
            {groups.length > 1 && (
              <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: '0.3rem' }}>
                {groups.map((g, i) => {
                  const on = g.id === orderId
                  return <button key={g.id} onClick={() => navigate(`/pos2/ticket?order=${g.id}`)} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.4rem 0.9rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Группа {i + 1} · {formatCurrency(g.total)}</button>
                })}
              </div>
            )}
            {items.map((i, idx) => {
              const cancelled = !!i.cancelledAt
              return (
                <div key={i.id ?? idx} className="flex items-center gap-3 rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.7rem,1.1vw,1.1rem)', opacity: cancelled ? 0.5 : 1 }}>
                  <span style={{ fontSize: 'clamp(1.3rem,2vw,1.8rem)' }}>{i.emoji || '🍽️'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', textDecoration: cancelled ? 'line-through' : 'none' }}>{i.name}</div>
                    <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{formatCurrency(i.price)} × {i.qty}{cancelled ? ' · отменено' : ''}</div>
                    {i.note && <div className="truncate" style={{ color: 'var(--pv-brand)', fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>💬 {i.note}</div>}
                  </div>
                  <span className="font-bold shrink-0" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(i.price * i.qty)}</span>
                  {!cancelled && (
                    <button onClick={() => { setNoteItem(i); setNoteText(i.note ?? '') }} className="rounded-lg flex items-center justify-center shrink-0 active:scale-90 transition-transform" style={{ width: '2.2rem', height: '2.2rem', background: i.note ? 'var(--pv-brand-soft)' : 'var(--pv-bg)' }}>
                      <StickyNote style={{ width: '1.15rem', height: '1.15rem', color: i.note ? 'var(--pv-brand)' : 'var(--pv-text-3)' }} />
                    </button>
                  )}
                  {!cancelled && (
                    <button onClick={() => { setCancelItem(i); setItemReason(ITEM_REASONS[0]) }} className="rounded-lg flex items-center justify-center shrink-0 active:scale-90 transition-transform" style={{ width: '2.2rem', height: '2.2rem', background: 'var(--pv-occ-soft)' }}>
                      <XCircle style={{ width: '1.2rem', height: '1.2rem', color: 'var(--pv-occ-text)' }} />
                    </button>
                  )}
                </div>
              )
            })}
            {liveItems.length === 0 && <div className="text-center" style={{ color: 'var(--pv-text-3)', padding: '2rem', fontSize: 'var(--pv-ctl)' }}>Нет активных позиций</div>}
          </div>
        )}
      </div>

      {/* Footer actions */}
      {order && (
        <div className="shrink-0 border-t" style={{ padding: 'clamp(0.9rem,1.4vw,1.4rem) var(--pv-pad-x)', borderColor: 'var(--pv-border)', background: 'var(--pv-card)' }}>
          <div className="mx-auto flex items-center" style={{ maxWidth: '44rem', gap: 'var(--pv-gap)' }}>
            <div className="flex-1 min-w-0">
              <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Итого</div>
              <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.3rem,2vw,1.9rem)' }}>{formatCurrency(order.total)}</div>
            </div>
            <button onClick={() => setCancelOrderOpen(true)} className="flex items-center gap-2 rounded-2xl font-semibold shrink-0 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-card)', border: '2px solid var(--pv-occ-dot)', color: 'var(--pv-occ-text)', padding: 'clamp(0.75rem,1.2vw,1.05rem) clamp(1rem,1.5vw,1.4rem)', fontSize: 'var(--pv-ctl)' }}>
              <Trash2 style={{ width: '1.2em', height: '1.2em' }} />Отменить
            </button>
            {order.isSplit ? (
              splits.some(s => s.status === 'paid') ? (
                <span className="font-semibold shrink-0" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>Оплата по частям…</span>
              ) : (
                <button disabled={busy} onClick={doCancelSplits} className="flex items-center gap-2 rounded-2xl font-semibold shrink-0 disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-card)', border: '2px solid var(--pv-occ-dot)', color: 'var(--pv-occ-text)', padding: 'clamp(0.75rem,1.2vw,1.05rem) clamp(1rem,1.5vw,1.4rem)', fontSize: 'var(--pv-ctl)' }}>
                  <X style={{ width: '1.2em', height: '1.2em' }} />Отменить разделение
                </button>
              )
            ) : (
              <>
                <button onClick={() => { setSplitN(2); setSplitMode('equal'); setItemPart({}); setSplitOpen(true) }} className="flex items-center gap-2 rounded-2xl font-semibold shrink-0 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', color: 'var(--pv-text-2)', padding: 'clamp(0.75rem,1.2vw,1.05rem) clamp(0.9rem,1.4vw,1.3rem)', fontSize: 'var(--pv-ctl)' }}>
                  <SquareSplitHorizontal style={{ width: '1.2em', height: '1.2em' }} />Разделить
                </button>
                {order.type === 'hall' && (
                  <button onClick={() => setTransferOpen(true)} className="flex items-center gap-2 rounded-2xl font-semibold shrink-0 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', color: 'var(--pv-text-2)', padding: 'clamp(0.75rem,1.2vw,1.05rem) clamp(0.9rem,1.4vw,1.3rem)', fontSize: 'var(--pv-ctl)' }}>
                    <ArrowRightLeft style={{ width: '1.2em', height: '1.2em' }} />Перенести
                  </button>
                )}
                <button onClick={() => navigate(`/pos2/order?order=${encodeURIComponent(order.id)}`)} className="flex items-center gap-2 rounded-2xl font-semibold shrink-0 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', padding: 'clamp(0.75rem,1.2vw,1.05rem) clamp(0.9rem,1.4vw,1.3rem)', fontSize: 'var(--pv-ctl)' }}>
                  <Plus style={{ width: '1.2em', height: '1.2em' }} />Добавить
                </button>
                <button onClick={() => navigate(`/pos2/pay?order=${encodeURIComponent(order.id)}`)} className="flex items-center gap-2 rounded-2xl font-bold text-white shrink-0 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.75rem,1.2vw,1.05rem) clamp(1.2rem,1.8vw,1.6rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)', boxShadow: '0 6px 18px rgba(216,90,48,0.35)' }}>
                  <CreditCard style={{ width: '1.3em', height: '1.3em' }} />К оплате
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Cancel item modal */}
      {cancelItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => { if (!busy) setCancelItem(null) }}>
          <div className="rounded-3xl overflow-hidden" style={{ background: 'var(--pv-card)', width: 'clamp(20rem,40vw,30rem)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold truncate" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.3rem)', color: 'var(--pv-text)' }}>Отмена: {cancelItem.name}</span>
              <button onClick={() => { if (!busy) setCancelItem(null) }} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '1rem' }}>
              <div className="flex flex-wrap gap-2">
                {ITEM_REASONS.map(r => { const on = r === itemReason; return <button key={r} onClick={() => setItemReason(r)} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.4rem 0.9rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{r}</button> })}
              </div>
              <button disabled={busy} onClick={doCancelItem} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-occ-dot)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>Отменить позицию</button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel order modal */}
      {cancelOrderOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => { if (!busy) setCancelOrderOpen(false) }}>
          <div className="rounded-3xl overflow-hidden" style={{ background: 'var(--pv-card)', width: 'clamp(20rem,40vw,30rem)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.3rem)', color: 'var(--pv-text)' }}>Отменить весь заказ?</span>
              <button onClick={() => { if (!busy) setCancelOrderOpen(false) }} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '1rem' }}>
              <div className="flex flex-wrap gap-2">
                {ORDER_REASONS.map(r => { const on = r === orderReason; return <button key={r} onClick={() => setOrderReason(r)} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.4rem 0.9rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{r}</button> })}
              </div>
              <button disabled={busy} onClick={doCancelOrder} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-occ-dot)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                <Trash2 style={{ width: '1.3em', height: '1.3em' }} />Отменить заказ
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transfer modal */}
      {transferOpen && order && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => { if (!busy) setTransferOpen(false) }}>
          <div className="rounded-3xl overflow-hidden flex flex-col" style={{ background: 'var(--pv-card)', width: 'clamp(24rem,55vw,50rem)', maxHeight: '82vh', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b shrink-0" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.35rem)', color: 'var(--pv-text)' }}>Перенести на свободный стол</span>
              <button onClick={() => { if (!busy) setTransferOpen(false) }} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex-1 overflow-y-auto" style={{ padding: 'clamp(1rem,1.6vw,1.5rem)' }}>
              {freeTables.length === 0 ? (
                <div className="text-center" style={{ color: 'var(--pv-text-3)', padding: '2rem' }}>Нет свободных столов</div>
              ) : (
                <div style={{ display: 'grid', gap: 'clamp(0.6rem,1vw,0.9rem)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(6.5rem,10vw,8.5rem), 1fr))' }}>
                  {freeTables.map(t => (
                    <button key={t.id} disabled={busy} onClick={() => doTransfer(t.id)} className="flex flex-col items-center justify-center rounded-2xl disabled:opacity-50 active:scale-[0.97] transition-transform" style={{ background: 'var(--pv-free-soft)', padding: 'clamp(0.8rem,1.3vw,1.2rem)', gap: '0.35rem', minHeight: 'clamp(5rem,7vw,6.5rem)' }}>
                      <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.1rem,1.6vw,1.5rem)' }}>№{t.number}</span>
                      <div className="flex items-center gap-1" style={{ color: 'var(--pv-free-text)' }}>
                        <Users style={{ width: '0.8rem', height: '0.8rem' }} /><span style={{ fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>{t.capacity}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Split modal */}
      {splitOpen && order && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => { if (!busy) setSplitOpen(false) }}>
          <div className="rounded-3xl overflow-hidden" style={{ background: 'var(--pv-card)', width: 'clamp(20rem,40vw,30rem)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.3rem)', color: 'var(--pv-text)' }}>Разделить счёт</span>
              <button onClick={() => { if (!busy) setSplitOpen(false) }} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.9rem', maxHeight: '72vh', overflowY: 'auto' }}>
              <div className="flex items-center rounded-xl" style={{ background: 'var(--pv-bg)', padding: '3px', gap: '3px' }}>
                {(['equal', 'items'] as const).map(md => { const on = splitMode === md; return (
                  <button key={md} onClick={() => setSplitMode(md)} className="flex-1 rounded-lg font-semibold" style={{ background: on ? 'var(--pv-card)' : 'transparent', color: on ? 'var(--pv-brand)' : 'var(--pv-text-2)', padding: '0.5rem', fontSize: 'var(--pv-ctl)', boxShadow: on ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>{md === 'equal' ? 'Поровну' : 'По позициям'}</button>
                ) })}
              </div>
              <div className="flex items-center justify-between">
                <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Количество частей</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setSplitN(n => Math.max(2, n - 1))} className="rounded-lg flex items-center justify-center font-bold" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.2rem', height: '2.2rem', color: 'var(--pv-text-2)' }}>−</button>
                  <span className="text-center font-bold" style={{ color: 'var(--pv-text)', width: '2rem', fontSize: 'clamp(1.1rem,1.5vw,1.4rem)' }}>{splitN}</span>
                  <button onClick={() => setSplitN(n => Math.min(10, n + 1))} className="rounded-lg flex items-center justify-center font-bold" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.2rem', height: '2.2rem', color: 'var(--pv-text-2)' }}>+</button>
                </div>
              </div>
              {splitMode === 'equal' ? (
                <>
                  <div className="flex items-center justify-between rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.7rem 1rem' }}>
                    <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Примерно на часть</span>
                    <span className="font-bold" style={{ color: 'var(--pv-brand)', fontSize: 'clamp(1.1rem,1.5vw,1.35rem)' }}>{formatCurrency(order.total / splitN)}</span>
                  </div>
                  <button disabled={busy} onClick={doSplit} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                    <SquareSplitHorizontal style={{ width: '1.3em', height: '1.3em' }} />Разделить на {splitN}
                  </button>
                </>
              ) : (
                <>
                  <div className="flex flex-col" style={{ gap: '0.4rem' }}>
                    {(order.items ?? []).filter(i => !i.cancelledAt && i.id).map(i => (
                      <div key={i.id} className="flex items-center gap-2 rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.5rem 0.7rem' }}>
                        <span className="flex-1 min-w-0 truncate" style={{ color: 'var(--pv-text)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{i.name} · {formatCurrency(i.price * i.qty)}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          {Array.from({ length: splitN }, (_, k) => k + 1).map(p => { const on = (itemPart[i.id!] ?? 1) === p; return (
                            <button key={p} onClick={() => setItemPart(m => ({ ...m, [i.id!]: p }))} className="rounded-md font-bold" style={{ width: '1.9rem', height: '1.9rem', background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', border: '1px solid var(--pv-border)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{p}</button>
                          ) })}
                        </div>
                      </div>
                    ))}
                  </div>
                  <button disabled={busy} onClick={doSplitItems} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                    <SquareSplitHorizontal style={{ width: '1.3em', height: '1.3em' }} />Разделить по позициям
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Item note modal */}
      {noteItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => { if (!busy) setNoteItem(null) }}>
          <div className="rounded-3xl overflow-hidden" style={{ background: 'var(--pv-card)', width: 'clamp(20rem,42vw,32rem)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold truncate" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.3rem)', color: 'var(--pv-text)' }}>Комментарий: {noteItem.name}</span>
              <button onClick={() => { if (!busy) setNoteItem(null) }} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.9rem' }}>
              <div className="flex flex-wrap gap-2">
                {['Без лука', 'Без соли', 'Острое', 'Прожарить', 'Отдельно'].map(p => (
                  <button key={p} onClick={() => setNoteText(t => t ? `${t}, ${p}` : p)} className="rounded-full font-semibold border" style={{ background: 'var(--pv-card)', color: 'var(--pv-text-2)', borderColor: 'var(--pv-border)', padding: '0.35rem 0.8rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>+ {p}</button>
                ))}
              </div>
              <input autoFocus value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Комментарий к позиции" className="rounded-xl border bg-transparent outline-none" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
              <button disabled={busy} onClick={saveNote} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>Сохранить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
