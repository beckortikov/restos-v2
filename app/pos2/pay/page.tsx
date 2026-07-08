'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, RefreshCw, Banknote, CreditCard, X, UtensilsCrossed, ShoppingBag } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import {
  fetchTables, fetchOrders, fetchActiveShift, fetchFinancialAccounts, closeOrderWithPayment,
} from '@/lib/queries'
import { formatCurrency, calcLineCogs } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import type { Order, Table, FinancialAccount } from '@/lib/types'

// Phase 2.4: оплата уже открытого заказа (замыкает dine-in цикл).
// Открытые заказы = tables.currentOrderIds → fetchOrders({ids}); закрытие через
// существующий closeOrderWithPayment (бэк сам пересчитывает суммы/cogs/сервис).
export default function PosV2Pay() {
  const navigate = useNavigate()
  const { user, restaurant } = useAuth()

  const [orders, setOrders] = useState<Order[]>([])
  const [tables, setTables] = useState<Table[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [target, setTarget] = useState<Order | null>(null)
  const [paying, setPaying] = useState(false)
  const payingRef = useRef(false)

  const tableNo = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tables) m.set(t.id, t.number)
    return m
  }, [tables])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const ts = await fetchTables().catch(() => [] as Table[])
      setTables(ts)
      const ids = ts.flatMap(t => t.currentOrderIds).filter(Boolean)
      if (ids.length === 0) { setOrders([]); return }
      const os = await fetchOrders({ ids, slim: false }).catch(() => [] as Order[])
      setOrders(os.filter(o => o.status !== 'done' && o.status !== 'cancelled'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    fetchFinancialAccounts().then(setAccounts).catch(() => {})
  }, [load])

  async function pay(o: Order, method: 'cash' | 'card') {
    if (payingRef.current) return
    payingRef.current = true
    setPaying(true)
    try {
      const shift = await fetchActiveShift()
      if (!shift) { toast.error('Откройте кассовую смену перед оплатой'); return }

      // Счёт зачисления: нал → cash-счёт (или счёт смены), безнал → первый не-cash.
      const acc = method === 'cash'
        ? (accounts.find(a => a.type === 'cash') ?? accounts[0])
        : (accounts.find(a => a.type !== 'cash') ?? accounts[0])
      const accId = ((shift as { accountId?: string }).accountId && method === 'cash')
        ? (shift as { accountId?: string }).accountId
        : acc?.id

      const cogs = (o.items ?? []).reduce(
        (s, i) => s + calcLineCogs(i.cogs || 0, i.qty, i.unit, i.unitSize), 0,
      )
      // Сервис применяет бэк из servicePercent (только зал). Суммы/cogs бэк
      // пересчитывает сам (в closeOrderWithPayment они помечены void).
      const servicePercent = o.type === 'hall' ? (restaurant?.servicePercent ?? 0) : 0
      const subtotal = o.subtotal ?? o.total
      await closeOrderWithPayment(
        o.id, method, o.tableId || null, subtotal, cogs, user?.id, accId, acc?.name,
        servicePercent, 0, o.total,
      )
      toast.success(`Оплачено · ${formatCurrency(o.total)} · ${method === 'cash' ? 'Наличные' : 'Безналичные'}`, {
        description: 'Чек отправлен на печать',
      })
      setTarget(null)
      await load()
    } catch (e) {
      toast.error(`Оплата не прошла: ${humanizeError(e)}`)
    } finally {
      payingRef.current = false
      setPaying(false)
    }
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button
          onClick={() => navigate('/pos2')}
          className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform"
          style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}
        >
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>Заказы к оплате</span>
        <div className="flex-1" />
        <button
          onClick={() => load()}
          className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform"
          style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}
        >
          <RefreshCw style={{ width: 'clamp(1.05rem,1.3vw,1.3rem)', height: 'clamp(1.05rem,1.3vw,1.3rem)', color: 'var(--pv-text-2)' }} className={loading ? 'animate-spin' : ''} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Обновить</span>
        </button>
      </div>

      {/* Orders grid */}
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'var(--pv-gap) var(--pv-pad-x) var(--pv-pad-x)' }}>
        {loading ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Загрузка заказов…</div>
        ) : orders.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2" style={{ color: 'var(--pv-text-3)' }}>
            <UtensilsCrossed style={{ width: '2.5rem', height: '2.5rem', opacity: 0.5 }} />
            <span style={{ fontSize: 'var(--pv-ctl)' }}>Нет открытых заказов</span>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(12rem, 18vw, 16rem), 1fr))' }}>
            {orders.map(o => {
              const hall = o.type === 'hall'
              const label = hall ? `Стол ${o.tableId ? (tableNo.get(o.tableId) ?? '—') : '—'}` : 'С собой'
              const Icon = hall ? UtensilsCrossed : ShoppingBag
              const n = (o.items ?? []).length
              return (
                <button
                  key={o.id}
                  onClick={() => setTarget(o)}
                  className="flex flex-col rounded-2xl text-left active:scale-[0.98] transition-transform"
                  style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', boxShadow: '0 2px 10px rgba(0,0,0,0.05)', padding: 'clamp(1rem,1.5vw,1.4rem)', gap: 'clamp(0.5rem,0.9vw,0.8rem)' }}
                >
                  <div className="flex items-center gap-2">
                    <div className="rounded-xl flex items-center justify-center" style={{ background: 'var(--pv-brand-soft)', width: 'clamp(2.2rem,3vw,2.75rem)', height: 'clamp(2.2rem,3vw,2.75rem)' }}>
                      <Icon style={{ width: '55%', height: '55%', color: 'var(--pv-brand)' }} />
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold truncate" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.4vw,1.25rem)' }}>{label}</div>
                      <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{n} поз.</div>
                    </div>
                  </div>
                  <div className="font-bold mt-auto" style={{ color: 'var(--pv-brand)', fontSize: 'clamp(1.2rem,1.7vw,1.6rem)' }}>{formatCurrency(o.total)}</div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Pay overlay */}
      {target && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => { if (!paying) setTarget(null) }}>
          <div className="rounded-3xl overflow-hidden" style={{ background: 'var(--pv-card)', width: 'clamp(22rem, 42vw, 34rem)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b" style={{ padding: 'clamp(1rem,1.6vw,1.4rem) clamp(1.2rem,1.8vw,1.6rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold" style={{ fontSize: 'clamp(1.1rem,1.6vw,1.4rem)', color: 'var(--pv-text)' }}>
                Оплата · {target.type === 'hall' ? `Стол ${target.tableId ? (tableNo.get(target.tableId) ?? '—') : '—'}` : 'С собой'} · {formatCurrency(target.total)}
              </span>
              <button onClick={() => { if (!paying) setTarget(null) }} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)' }}>
              <div className="grid grid-cols-2 gap-3">
                <button disabled={paying} onClick={() => pay(target, 'cash')} className="flex flex-col items-center justify-center gap-2 rounded-2xl disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ padding: 'clamp(1.1rem,1.8vw,1.6rem)', background: 'var(--pv-free-soft)', color: 'var(--pv-free-text)' }}>
                  <Banknote style={{ width: '2rem', height: '2rem' }} />
                  <span className="font-bold" style={{ fontSize: 'clamp(1rem,1.3vw,1.15rem)' }}>Наличные</span>
                </button>
                <button disabled={paying} onClick={() => pay(target, 'card')} className="flex flex-col items-center justify-center gap-2 rounded-2xl disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ padding: 'clamp(1.1rem,1.8vw,1.6rem)', background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)' }}>
                  <CreditCard style={{ width: '2rem', height: '2rem' }} />
                  <span className="font-bold" style={{ fontSize: 'clamp(1rem,1.3vw,1.15rem)' }}>Безналичные</span>
                </button>
              </div>
              {paying && <div className="text-center" style={{ marginTop: '1rem', color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>Проводим оплату…</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
