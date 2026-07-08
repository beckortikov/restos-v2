'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, RefreshCw, Search, X, CreditCard, UtensilsCrossed, ShoppingBag, Bike } from 'lucide-react'
import { fetchActiveShift, fetchOrders, fetchTables } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { ORDER_STATUS_LABELS } from '@/lib/types'
import type { Order, Table, CashShift, OrderStatus } from '@/lib/types'

const ACTIVE = new Set<OrderStatus>(['new', 'cooking', 'ready', 'served', 'bill_requested'])
type Tab = 'all' | 'hall' | 'togo' | 'closed'

const STATUS_TONE: Record<OrderStatus, { soft: string; text: string }> = {
  new: { soft: 'var(--pv-brand-soft)', text: 'var(--pv-brand)' },
  cooking: { soft: 'var(--pv-occ-soft)', text: 'var(--pv-occ-text)' },
  ready: { soft: 'var(--pv-free-soft)', text: 'var(--pv-free-text)' },
  served: { soft: 'var(--pv-brand-soft)', text: 'var(--pv-brand)' },
  bill_requested: { soft: 'var(--pv-bill-soft)', text: 'var(--pv-bill-text)' },
  done: { soft: 'var(--pv-free-soft)', text: 'var(--pv-free-text)' },
  cancelled: { soft: 'var(--pv-bg)', text: 'var(--pv-text-3)' },
}

export default function PosV2Orders() {
  const navigate = useNavigate()
  const [shift, setShift] = useState<CashShift | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [tables, setTables] = useState<Table[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('all')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const active = await fetchActiveShift().catch(() => null)
      setShift(active)
      const [os, ts] = await Promise.all([
        active ? fetchOrders({ shiftId: active.id, slim: false }).catch(() => [] as Order[]) : Promise.resolve([] as Order[]),
        fetchTables().catch(() => [] as Table[]),
      ])
      setOrders(os); setTables(ts)
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const tableNo = useMemo(() => { const m = new Map<string, number>(); for (const t of tables) m.set(t.id, t.number); return m }, [tables])

  const counts = useMemo(() => {
    const act = orders.filter(o => ACTIVE.has(o.status) && (o.aliveItemsCount ?? o.items.filter(i => !i.cancelledAt).length) > 0)
    return {
      all: act.length,
      hall: act.filter(o => o.type === 'hall').length,
      togo: act.filter(o => o.type !== 'hall').length,
      closed: orders.filter(o => o.status === 'done' || o.status === 'cancelled').length,
    }
  }, [orders])

  const list = useMemo(() => {
    let rows = orders
    if (tab === 'closed') rows = orders.filter(o => o.status === 'done' || o.status === 'cancelled')
    else {
      rows = orders.filter(o => ACTIVE.has(o.status) && (o.aliveItemsCount ?? o.items.filter(i => !i.cancelledAt).length) > 0)
      if (tab === 'hall') rows = rows.filter(o => o.type === 'hall')
      if (tab === 'togo') rows = rows.filter(o => o.type !== 'hall')
    }
    const q = search.trim().toLowerCase()
    if (q) rows = rows.filter(o => String(o.orderNumber ?? '').includes(q) || String(o.tableId ? tableNo.get(o.tableId) ?? '' : '').includes(q))
    return [...rows].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }, [orders, tab, search, tableNo])

  const TABS: [Tab, string, number][] = [['all', 'Все', counts.all], ['hall', 'Зал', counts.hall], ['togo', 'С собой', counts.togo], ['closed', 'Закрытые', counts.closed]]
  const typeMeta = (t: string) => t === 'hall' ? { icon: UtensilsCrossed, label: 'Зал' } : t === 'delivery' ? { icon: Bike, label: 'Доставка' } : { icon: ShoppingBag, label: 'С собой' }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>Заказы</span>
        <div className="flex items-center rounded-2xl border shrink-0" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: '4px', gap: '4px', marginLeft: '0.5rem' }}>
          {TABS.map(([t, l, n]) => { const on = tab === t; return (
            <button key={t} onClick={() => setTab(t)} className="rounded-xl font-semibold whitespace-nowrap" style={{ background: on ? 'var(--pv-brand)' : 'transparent', color: on ? '#fff' : 'var(--pv-text-2)', padding: 'clamp(0.5rem,0.8vw,0.75rem) clamp(0.7rem,1.1vw,1.2rem)', fontSize: 'var(--pv-ctl)' }}>{l}{n > 0 ? ` · ${n}` : ''}</button>
          ) })}
        </div>
        <div className="flex-1" />
        <div className="flex items-center rounded-xl border shrink-0" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: '0.4rem 0.8rem', gap: '0.5rem', width: 'clamp(9rem,16vw,14rem)' }}>
          <Search style={{ width: '1.1rem', height: '1.1rem', color: 'var(--pv-text-3)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} inputMode="numeric" placeholder="№ / стол" className="flex-1 min-w-0 bg-transparent outline-none" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }} />
          {search && <button onClick={() => setSearch('')}><X style={{ width: '1rem', height: '1rem', color: 'var(--pv-text-3)' }} /></button>}
        </div>
        <button onClick={() => load()} className="flex items-center justify-center rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem)' }}>
          <RefreshCw style={{ width: 'clamp(1.05rem,1.3vw,1.3rem)', height: 'clamp(1.05rem,1.3vw,1.3rem)', color: 'var(--pv-text-2)' }} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'var(--pv-gap) var(--pv-pad-x) var(--pv-pad-x)' }}>
        {loading ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Загрузка…</div>
        ) : !shift && tab !== 'closed' ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Смена не открыта</div>
        ) : list.length === 0 ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Заказов нет</div>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(14rem,22vw,18rem), 1fr))' }}>
            {list.map(o => {
              const tm = typeMeta(o.type)
              const tone = STATUS_TONE[o.status] ?? STATUS_TONE.new
              const closed = o.status === 'done' || o.status === 'cancelled'
              const n = o.aliveItemsCount ?? o.items.filter(i => !i.cancelledAt).length
              const loc = o.type === 'hall' ? `Стол ${o.tableId ? (tableNo.get(o.tableId) ?? '—') : '—'}` : tm.label
              return (
                <div key={o.id} className="flex flex-col rounded-2xl overflow-hidden" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)' }}>
                  <button onClick={() => navigate(closed ? '/pos2/history' : `/pos2/ticket?order=${encodeURIComponent(o.id)}`)} className="flex flex-col items-stretch text-left active:scale-[0.99] transition-transform" style={{ padding: 'clamp(0.7rem,1.1vw,1rem)', gap: '0.5rem' }}>
                    <div className="flex items-center justify-between">
                      <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.4vw,1.25rem)' }}>№{o.orderNumber ?? '—'}</span>
                      <span className="rounded-full font-semibold" style={{ background: tone.soft, color: tone.text, padding: '0.2rem 0.6rem', fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>{ORDER_STATUS_LABELS[o.status]}</span>
                    </div>
                    <div className="flex items-center gap-1.5" style={{ color: 'var(--pv-text-2)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>
                      <tm.icon style={{ width: '1rem', height: '1rem' }} /><span className="truncate">{loc}</span>
                      <span style={{ color: 'var(--pv-text-3)' }}>· {n} поз.</span>
                    </div>
                    <div className="font-bold" style={{ color: closed && o.status === 'cancelled' ? 'var(--pv-text-3)' : 'var(--pv-brand)', fontSize: 'clamp(1.15rem,1.6vw,1.45rem)' }}>{formatCurrency(o.total)}</div>
                  </button>
                  {!closed && o.type === 'hall' && (
                    <button onClick={() => navigate(`/pos2/pay?order=${encodeURIComponent(o.id)}`)} className="flex items-center justify-center gap-2 font-bold text-white active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.55rem,0.9vw,0.8rem)', fontSize: 'var(--pv-ctl)' }}>
                      <CreditCard style={{ width: '1.15em', height: '1.15em' }} />К оплате
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
