'use client'

import { useMemo, useRef, useState, useDeferredValue } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, Search, ShoppingBag, Plus, Minus, Trash2, CreditCard, UtensilsCrossed, Banknote, X } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import { useOrderData } from '@/components/order/use-order-data'
import { createOrder, closeOrderWithPayment, fetchActiveShift, fetchFinancialAccounts } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { dMul, dDiv, dSum } from '@/lib/decimal'
import type { MenuItem, OrderItem } from '@/lib/types'
import type { CartLine } from '@/components/order/types'

// Phase 2 (шаг 1): экран заказа на РЕАЛЬНЫХ данных (useOrderData — тот же хук,
// что и старый POS). Меню + категории + локальная корзина + суммы.
// Оплата — следующий шаг (самый рисковый), пока обозначена заглушкой.
export default function PosV2Order() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { menuItems, categories, loading } = useOrderData(true)

  const [orderType, setOrderType] = useState<'hall' | 'takeaway'>('hall')
  const [search, setSearch] = useState('')
  const deferred = useDeferredValue(search)
  const [activeCat, setActiveCat] = useState<string | null>(null)
  const [cart, setCart] = useState<CartLine[]>([])

  const visibleCats = useMemo(
    () => categories.filter(c => c && !c.toLowerCase().includes('полуфабрикат')),
    [categories],
  )
  const currentCat = activeCat ?? visibleCats[0] ?? null

  const dishes = useMemo(() => {
    const q = deferred.trim().toLowerCase()
    return menuItems.filter(m => {
      if (q) return m.name.toLowerCase().includes(q)
      return m.category === currentCat
    })
  }, [menuItems, currentCat, deferred])

  function add(m: MenuItem) {
    if (m.isAvailable === false) return
    setCart(prev => {
      const i = prev.findIndex(l => l.menuItemId === m.id)
      if (i >= 0) {
        const next = [...prev]
        next[i] = { ...next[i], qty: next[i].qty + 1 }
        return next
      }
      return [...prev, {
        menuItemId: m.id, name: m.name, emoji: m.emoji, qty: 1, price: m.price,
        cogs: m.cogs, unit: (m.unit ?? 'piece'), unitSize: (m.unitSize ?? 1),
      }]
    })
  }
  function setQty(id: string, delta: number) {
    setCart(prev => prev.flatMap(l => {
      if (l.menuItemId !== id) return [l]
      const q = l.qty + delta
      return q <= 0 ? [] : [{ ...l, qty: q }]
    }))
  }
  function removeLine(id: string) {
    setCart(prev => prev.filter(l => l.menuItemId !== id))
  }

  const subtotal = useMemo(() => dSum(cart.map(l => dMul(l.qty, l.price))), [cart])
  const count = cart.reduce((s, l) => s + l.qty, 0)

  const [payOpen, setPayOpen] = useState(false)
  const [paying, setPaying] = useState(false)
  // Guard-латч ставится СИНХРОННО до первого await → двойной тап невозможен
  // (в старом POS флаг ставился после await — отсюда баг двойного платежа).
  const payingRef = useRef(false)

  async function payTakeaway(method: 'cash' | 'card') {
    if (payingRef.current || cart.length === 0) return
    payingRef.current = true
    setPaying(true)
    try {
      const shift = await fetchActiveShift()
      if (!shift) {
        toast.error('Откройте кассовую смену перед оплатой')
        return
      }
      const total = subtotal
      const items: OrderItem[] = cart.map(l => ({
        menuItemId: l.menuItemId, name: l.name, qty: l.qty, price: l.price,
        cogs: l.cogs, unit: l.unit, unitSize: l.unitSize, emoji: l.emoji,
      }))
      const order = await createOrder({
        type: 'takeaway', items, total, shiftId: shift.id,
        waiterId: user?.id ?? undefined, guestsCount: 1,
      })
      if (!order) throw new Error('Заказ не создан')

      // Счёт зачисления: активной смены, иначе первый cash-счёт.
      let accId = (shift as { accountId?: string }).accountId
      let accName = (shift as { accountName?: string }).accountName
      if (!accId) {
        const accs = await fetchFinancialAccounts().catch(() => [])
        const cash = accs.find(a => a.type === 'cash')
        accId = cash?.id
        accName = cash?.name
      }
      const cogs = dSum(cart.map(l =>
        l.unit === 'piece'
          ? dMul(l.cogs, l.qty)
          : dMul(l.cogs, dDiv(l.qty, l.unitSize > 0 ? l.unitSize : 1)),
      ))
      // Сервис для takeaway = 0. Чек печатает бэк внутри close (server enqueue).
      await closeOrderWithPayment(order.id, method, null, total, cogs, user?.id, accId, accName, 0, 0, total)
      toast.success(`Оплачено · ${formatCurrency(total)} · ${method === 'cash' ? 'Наличные' : 'Безналичные'}`, {
        description: 'Чек отправлен на печать',
      })
      setCart([])
      setPayOpen(false)
    } catch (e) {
      toast.error(`Оплата не прошла: ${humanizeError(e)}`)
    } finally {
      payingRef.current = false
      setPaying(false)
    }
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* ── Left: menu ─────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col" style={{ padding: 'var(--pv-gap) 0 0 var(--pv-pad-x)' }}>
        {/* Topbar */}
        <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', paddingRight: 'var(--pv-gap)' }}>
          <button
            onClick={() => navigate('/pos2')}
            className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform"
            style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}
          >
            <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
            <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
          </button>

          {/* order type segment */}
          <div className="flex items-center rounded-2xl border shrink-0" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: '4px', gap: '4px' }}>
            {([['hall', 'ЗАЛ', UtensilsCrossed], ['takeaway', 'С СОБОЙ', ShoppingBag]] as const).map(([val, label, Icon]) => {
              const on = orderType === val
              return (
                <button
                  key={val}
                  onClick={() => setOrderType(val)}
                  className="flex items-center gap-1.5 rounded-xl font-semibold whitespace-nowrap"
                  style={{ background: on ? 'var(--pv-brand)' : 'transparent', color: on ? '#fff' : 'var(--pv-text-2)', padding: 'clamp(0.5rem,0.8vw,0.75rem) clamp(0.7rem,1.2vw,1.3rem)', fontSize: 'var(--pv-ctl)' }}
                >
                  <Icon style={{ width: 'clamp(0.9rem,1.2vw,1.15rem)', height: 'clamp(0.9rem,1.2vw,1.15rem)' }} />
                  {label}
                </button>
              )
            })}
          </div>

          {/* search */}
          <div className="flex items-center gap-2 rounded-xl border flex-1 min-w-0" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1vw,1rem)' }}>
            <Search style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-text-3)' }} className="shrink-0" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Поиск блюда"
              className="flex-1 min-w-0 bg-transparent outline-none"
              style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}
            />
          </div>
        </div>

        {/* Category chips */}
        {!deferred.trim() && (
          <div className="flex items-center overflow-x-auto shrink-0" style={{ gap: 'clamp(0.4rem,0.8vw,0.7rem)', padding: 'var(--pv-gap) var(--pv-gap) 0 0' }}>
            {visibleCats.map(c => {
              const on = c === currentCat
              return (
                <button
                  key={c}
                  onClick={() => setActiveCat(c)}
                  className="rounded-full font-semibold whitespace-nowrap shrink-0 border"
                  style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: 'clamp(0.5rem,0.8vw,0.7rem) clamp(0.9rem,1.4vw,1.4rem)', fontSize: 'var(--pv-ctl)' }}
                >
                  {c}
                </button>
              )
            })}
          </div>
        )}

        {/* Dish grid (scrolls) */}
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'var(--pv-gap) var(--pv-gap) var(--pv-pad-x) 0' }}>
          {loading ? (
            <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Загрузка меню…</div>
          ) : dishes.length === 0 ? (
            <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Ничего не найдено</div>
          ) : (
            <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(9rem, 13vw, 12rem), 1fr))' }}>
              {dishes.map(m => {
                const stopped = m.isAvailable === false
                return (
                  <button
                    key={m.id}
                    onClick={() => add(m)}
                    disabled={stopped}
                    className="flex flex-col rounded-2xl text-left transition-transform active:scale-[0.97] disabled:opacity-45 disabled:pointer-events-none"
                    style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', boxShadow: '0 1px 4px rgba(0,0,0,0.04)', padding: 'clamp(0.7rem,1.1vw,1.1rem)', gap: 'clamp(0.4rem,0.8vw,0.7rem)', minHeight: 'clamp(6rem,9vw,8rem)' }}
                  >
                    <span style={{ fontSize: 'clamp(1.4rem,2.4vw,2rem)' }}>{m.emoji || '🍽️'}</span>
                    <span className="font-semibold leading-tight line-clamp-2" style={{ color: 'var(--pv-text)', fontSize: 'clamp(0.82rem,1.1vw,1rem)' }}>{m.name}</span>
                    <span className="font-bold mt-auto" style={{ color: 'var(--pv-brand)', fontSize: 'clamp(0.85rem,1.15vw,1.05rem)' }}>{formatCurrency(m.price)}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Right: cart ────────────────────────────────────────── */}
      <aside
        className="shrink-0 flex flex-col border-l"
        style={{ width: 'clamp(20rem, 26vw, 30rem)', background: 'var(--pv-card)', borderColor: 'var(--pv-border)' }}
      >
        <div className="flex items-center justify-between shrink-0 border-b" style={{ padding: 'clamp(0.9rem,1.4vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
          <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.05rem,1.5vw,1.4rem)' }}>Заказ</span>
          <span className="rounded-full font-semibold" style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', padding: '0.25rem 0.7rem', fontSize: 'var(--pv-ctl)' }}>{count} поз.</span>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'clamp(0.7rem,1vw,1rem)' }}>
          {cart.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-2" style={{ color: 'var(--pv-text-3)' }}>
              <ShoppingBag style={{ width: '2.5rem', height: '2.5rem', opacity: 0.5 }} />
              <span style={{ fontSize: 'var(--pv-ctl)' }}>Корзина пуста</span>
            </div>
          ) : (
            <div className="flex flex-col" style={{ gap: 'clamp(0.5rem,0.8vw,0.75rem)' }}>
              {cart.map(l => (
                <div key={l.menuItemId} className="flex items-center gap-2 rounded-xl" style={{ background: 'var(--pv-bg)', padding: 'clamp(0.5rem,0.8vw,0.75rem)' }}>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{l.emoji} {l.name}</div>
                    <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{formatCurrency(l.price)} × {l.qty}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => setQty(l.menuItemId, -1)} className="rounded-lg flex items-center justify-center active:scale-90 transition-transform" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', width: '2rem', height: '2rem' }}><Minus className="size-4" style={{ color: 'var(--pv-text-2)' }} /></button>
                    <span className="text-center font-bold" style={{ color: 'var(--pv-text)', width: '1.75rem', fontSize: 'var(--pv-ctl)' }}>{l.qty}</span>
                    <button onClick={() => setQty(l.menuItemId, +1)} className="rounded-lg flex items-center justify-center active:scale-90 transition-transform" style={{ background: 'var(--pv-brand)', width: '2rem', height: '2rem' }}><Plus className="size-4 text-white" /></button>
                    <button onClick={() => removeLine(l.menuItemId)} className="rounded-lg flex items-center justify-center ml-1" style={{ width: '2rem', height: '2rem' }}><Trash2 className="size-4" style={{ color: 'var(--pv-occ-text)' }} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer: total + pay */}
        <div className="shrink-0 border-t" style={{ padding: 'clamp(0.9rem,1.4vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 'clamp(0.6rem,1vw,1rem)' }}>
            <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Итого</span>
            <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.3rem,2vw,1.9rem)' }}>{formatCurrency(subtotal)}</span>
          </div>
          <button
            disabled={cart.length === 0}
            onClick={() => setPayOpen(true)}
            className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-40 active:scale-[0.98] transition-transform"
            style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)', boxShadow: cart.length ? '0 6px 18px rgba(216,90,48,0.35)' : 'none' }}
          >
            <CreditCard style={{ width: '1.35em', height: '1.35em' }} />
            К оплате
          </button>
        </div>
      </aside>

      {/* ── Payment overlay ────────────────────────────────────── */}
      {payOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(26,26,26,0.5)' }}
          onClick={() => { if (!paying) setPayOpen(false) }}
        >
          <div
            className="rounded-3xl overflow-hidden"
            style={{ background: 'var(--pv-card)', width: 'clamp(22rem, 42vw, 34rem)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b" style={{ padding: 'clamp(1rem,1.6vw,1.4rem) clamp(1.2rem,1.8vw,1.6rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold" style={{ fontSize: 'clamp(1.1rem,1.6vw,1.4rem)', color: 'var(--pv-text)' }}>
                Оплата · {formatCurrency(subtotal)}
              </span>
              <button onClick={() => { if (!paying) setPayOpen(false) }} className="rounded-lg" style={{ padding: '0.4rem' }}>
                <X style={{ color: 'var(--pv-text-2)' }} />
              </button>
            </div>
            <div style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)' }}>
              {orderType === 'takeaway' ? (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    disabled={paying}
                    onClick={() => payTakeaway('cash')}
                    className="flex flex-col items-center justify-center gap-2 rounded-2xl disabled:opacity-50 active:scale-[0.98] transition-transform"
                    style={{ padding: 'clamp(1.1rem,1.8vw,1.6rem)', background: 'var(--pv-free-soft)', color: 'var(--pv-free-text)' }}
                  >
                    <Banknote style={{ width: '2rem', height: '2rem' }} />
                    <span className="font-bold" style={{ fontSize: 'clamp(1rem,1.3vw,1.15rem)' }}>Наличные</span>
                  </button>
                  <button
                    disabled={paying}
                    onClick={() => payTakeaway('card')}
                    className="flex flex-col items-center justify-center gap-2 rounded-2xl disabled:opacity-50 active:scale-[0.98] transition-transform"
                    style={{ padding: 'clamp(1.1rem,1.8vw,1.6rem)', background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)' }}
                  >
                    <CreditCard style={{ width: '2rem', height: '2rem' }} />
                    <span className="font-bold" style={{ fontSize: 'clamp(1rem,1.3vw,1.15rem)' }}>Безналичные</span>
                  </button>
                </div>
              ) : (
                <div className="text-center" style={{ color: 'var(--pv-text-2)', padding: '0.5rem 0.5rem 1rem', fontSize: 'var(--pv-ctl)', lineHeight: 1.5 }}>
                  Оплата зала требует выбора стола — это следующий шаг внедрения.
                  Пока в новом POS доступна оплата «С собой» (переключите вверху).
                </div>
              )}
              {paying && (
                <div className="text-center" style={{ marginTop: '1rem', color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>
                  Проводим оплату…
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
