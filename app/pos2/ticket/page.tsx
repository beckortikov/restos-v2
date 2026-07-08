'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { LayoutGrid, RefreshCw, Plus, CreditCard, XCircle, Trash2, X, ArrowRightLeft, Users } from 'lucide-react'
import { toast } from 'sonner'
import { fetchOrders, fetchTables, cancelOrder, cancelOrderItem, transferOrder } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import type { Order, OrderItem, Table } from '@/lib/types'

const ITEM_REASONS = ['Гость передумал', 'Ошибка кухни', 'Некачественно', 'Другое']
const ORDER_REASONS = ['Ошибка официанта', 'Нет ингредиента', 'Отменено клиентом', 'Другое']

// Phase 3.3: тикет открытого заказа — позиции, отмена позиции/заказа, добор, оплата.
export default function PosV2Ticket() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const orderId = params.get('order') ?? ''

  const [order, setOrder] = useState<Order | null>(null)
  const [tables, setTables] = useState<Table[]>([])
  const [groups, setGroups] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [cancelItem, setCancelItem] = useState<OrderItem | null>(null)
  const [cancelOrderOpen, setCancelOrderOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
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
      // Мультитаб: другие открытые заказы (группы) на том же столе.
      const t = o?.tableId ? ts.find(x => x.id === o.tableId) : undefined
      const gids = (t?.currentOrderIds ?? []).filter(Boolean)
      if (gids.length > 1) {
        const gs = await fetchOrders({ ids: gids, slim: true }).catch(() => [] as Order[])
        setGroups(gs.filter(g => g.status !== 'done' && g.status !== 'cancelled'))
      } else setGroups([])
    } finally { setLoading(false) }
  }, [orderId])

  useEffect(() => { load() }, [load])

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
                  </div>
                  <span className="font-bold shrink-0" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(i.price * i.qty)}</span>
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
    </div>
  )
}
