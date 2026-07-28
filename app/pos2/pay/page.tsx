'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { LayoutGrid, RefreshCw, UtensilsCrossed, ShoppingBag } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import { fetchTables, fetchOrders, fetchFinancialAccounts } from '@/lib/queries'
import { selectableAccounts } from '@/lib/queries/finance'
import { useDataSync } from '@/hooks/use-data-sync'
import { formatCurrency } from '@/lib/helpers'
import { payable as calcPayable } from '@/lib/pos-v2/pay'
import { PosModal } from '@/components/pos-v2/pos-modal'
import { PaymentPanel } from '@/components/pos-v2/payment-panel'
import type { Order, Table, FinancialAccount } from '@/lib/types'

// Список открытых заказов к оплате. Сама оплата — общий PaymentPanel (тот же,
// что инлайн в сайдбаре /pos2/order): нал/безнал с выбором кошелька/смешанная/
// скидка/сервис/пре-чек. Дублирующей платёжной логики здесь больше нет.
export default function PosV2Pay() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user, restaurant } = useAuth()

  const [orders, setOrders] = useState<Order[]>([])
  const [tables, setTables] = useState<Table[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [target, setTarget] = useState<Order | null>(null)

  const tableNo = useMemo(() => { const m = new Map<string, number>(); for (const t of tables) m.set(t.id, t.number); return m }, [tables])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const ts = await fetchTables().catch(() => [] as Table[])
      setTables(ts)
      const ids = ts.flatMap(t => t.currentOrderIds).filter(Boolean)
      if (ids.length === 0) { setOrders([]); return 0 }
      const os = await fetchOrders({ ids, slim: false }).catch(() => [] as Order[])
      // Прячем заказы с активными сплитами: их платят по частям в тикете
      // (split-UI). Полная оплата поверх оплаченных сплитов = двойная выручка.
      const open = os.filter(o => o.status !== 'done' && o.status !== 'cancelled' && !o.isSplit)
      setOrders(open)
      return open.length
    } finally { setLoading(false) }
  }, [])

  const loadAccounts = useCallback(() => fetchFinancialAccounts().then(selectableAccounts).then(setAccounts).catch(() => {}), [])
  useEffect(() => { load(); loadAccounts() }, [load, loadAccounts])
  // Счёт включили/отключили на другом терминале — пикер не должен предлагать
  // уже отключённый до следующего F5.
  useDataSync(['financial_accounts'], loadAccounts)

  // Приход с карты/сайдбара ?order=<id> → сразу открыть оплату этого заказа (один раз).
  const autoOpenRef = useRef(false)
  useEffect(() => {
    if (autoOpenRef.current) return
    const oid = searchParams.get('order')
    if (oid && orders.length) { const o = orders.find(x => x.id === oid); if (o) { autoOpenRef.current = true; setTarget(o) } }
  }, [orders, searchParams])

  const labelOf = (o: Order) => o.type === 'hall' ? `Стол ${o.tableId ? (tableNo.get(o.tableId) ?? '—') : '—'}` : o.type === 'delivery' ? 'Доставка' : 'С собой'
  // База = o.total (с модификаторами), как считает бэк; см. PaymentPanel.
  const payableOf = (o: Order) => calcPayable(o.total, 0, o.type === 'hall' ? (restaurant?.servicePercent ?? 0) : 0)

  // После оплаты: если открытых заказов больше нет — не оставляем кассира на
  // пустом экране «Заказы к оплате», а возвращаем в ПОС (следующий заказ).
  async function onPaid() {
    setTarget(null)
    const remaining = await load()
    if (remaining === 0) { toast.success('Заказ оплачен'); navigate('/pos2/order') }
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>Заказы к оплате</span>
        <div className="flex-1" />
        <button onClick={() => load()} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
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
              const Icon = hall ? UtensilsCrossed : ShoppingBag
              const n = (o.items ?? []).length
              return (
                <button key={o.id} onClick={() => setTarget(o)} className="flex flex-col rounded-2xl text-left active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', boxShadow: '0 2px 10px rgba(0,0,0,0.05)', padding: 'clamp(1rem,1.5vw,1.4rem)', gap: 'clamp(0.5rem,0.9vw,0.8rem)' }}>
                  <div className="flex items-center gap-2">
                    <div className="rounded-xl flex items-center justify-center" style={{ background: 'var(--pv-brand-soft)', width: 'clamp(2.2rem,3vw,2.75rem)', height: 'clamp(2.2rem,3vw,2.75rem)' }}>
                      <Icon style={{ width: '55%', height: '55%', color: 'var(--pv-brand)' }} />
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold truncate" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.4vw,1.25rem)' }}>{labelOf(o)}</div>
                      <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{n} поз.</div>
                    </div>
                  </div>
                  <div className="font-bold mt-auto" style={{ color: 'var(--pv-brand)', fontSize: 'clamp(1.2rem,1.7vw,1.6rem)' }}>{formatCurrency(payableOf(o))}</div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Payment modal — общий PaymentPanel */}
      {target && (
        <PosModal open onClose={() => setTarget(null)} width="clamp(22rem,64vw,52rem)"
          title={`Оплата · ${labelOf(target)} · ${formatCurrency(target.total)}`}>
          <PaymentPanel order={target} servicePercent={restaurant?.servicePercent ?? 0} accounts={accounts} userId={user?.id} onPaid={onPaid} previewCtx={{ restaurant, tables, currentUser: user }} />
        </PosModal>
      )}
    </div>
  )
}
