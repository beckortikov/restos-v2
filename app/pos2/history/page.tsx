'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, RefreshCw, RotateCcw, UtensilsCrossed, ShoppingBag, Banknote, CreditCard, Printer, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { fetchTables, fetchOrders, refundOrder, reprintOrderReceipt, reopenOrder } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { PosModal } from '@/components/pos-v2/pos-modal'
import type { Order, Table } from '@/lib/types'

const REASONS = ['Ошибка кассира', 'Просьба гостя', 'Некачественное блюдо', 'Отмена заказа', 'Другое']

// Phase 2.8: история закрытых заказов + возврат. refundOrder(id, reason, amount?)
// — тот же серверный возврат, что старый POS.
export default function PosV2History() {
  const navigate = useNavigate()
  const [orders, setOrders] = useState<Order[]>([])
  const [tables, setTables] = useState<Table[]>([])
  const [loading, setLoading] = useState(true)
  const [target, setTarget] = useState<Order | null>(null)
  const [reason, setReason] = useState(REASONS[0])
  const [amountStr, setAmountStr] = useState('')
  const [refunding, setRefunding] = useState(false)
  const refundRef = useRef(false)

  const tableNo = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tables) m.set(t.id, t.number)
    return m
  }, [tables])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [ts, os] = await Promise.all([
        fetchTables().catch(() => [] as Table[]),
        fetchOrders({ status: 'done', slim: true, limit: 60 }).catch(() => [] as Order[]),
      ])
      setTables(ts)
      setOrders(os)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function labelOf(o: Order): string {
    return o.type === 'hall' ? `Стол ${o.tableId ? (tableNo.get(o.tableId) ?? '—') : '—'}` : 'С собой'
  }
  function amountOf(o: Order): number {
    return o.totalWithService ?? o.total
  }
  function timeOf(o: Order): string {
    if (!o.closedAt) return ''
    try { return new Date(o.closedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
  }

  function open(o: Order) {
    setTarget(o); setReason(REASONS[0]); setAmountStr(String(amountOf(o)))
  }

  async function doRefund() {
    if (refundRef.current || !target) return
    const max = amountOf(target)
    const amt = Math.max(0, Math.min(max, parseFloat(amountStr.replace(',', '.').replace(/\s/g, '')) || 0))
    if (amt <= 0) { toast.error('Укажите сумму возврата'); return }
    refundRef.current = true; setRefunding(true)
    try {
      await refundOrder(target.id, reason, amt)
      toast.success(`Возврат оформлен · ${formatCurrency(amt)}`, { description: reason })
      setTarget(null); await load()
    } catch (e) {
      toast.error(`Возврат не прошёл: ${humanizeError(e)}`)
    } finally {
      refundRef.current = false; setRefunding(false)
    }
  }

  const [reprinting, setReprinting] = useState(false)
  async function reprint(o: Order) {
    if (reprinting) return
    setReprinting(true)
    try { await reprintOrderReceipt(o.id); toast.success('Чек отправлен на печать') }
    catch (e) { toast.error(`Не удалось напечатать: ${humanizeError(e)}`) }
    finally { setReprinting(false) }
  }
  async function reopen(o: Order) {
    if (refundRef.current) return
    refundRef.current = true; setRefunding(true)
    try {
      await reopenOrder(o.id)
      toast.success('Заказ переоткрыт'); navigate(`/pos2/ticket?order=${encodeURIComponent(o.id)}`)
    } catch (e) { toast.error(`Не удалось переоткрыть: ${humanizeError(e)}`) }
    finally { refundRef.current = false; setRefunding(false) }
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>История заказов</span>
        <div className="flex-1" />
        <button onClick={() => load()} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <RefreshCw style={{ width: 'clamp(1.05rem,1.3vw,1.3rem)', height: 'clamp(1.05rem,1.3vw,1.3rem)', color: 'var(--pv-text-2)' }} className={loading ? 'animate-spin' : ''} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Обновить</span>
        </button>
      </div>

      {/* Orders grid */}
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'var(--pv-gap) var(--pv-pad-x) var(--pv-pad-x)' }}>
        {loading ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Загрузка истории…</div>
        ) : orders.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2" style={{ color: 'var(--pv-text-3)' }}>
            <RotateCcw style={{ width: '2.5rem', height: '2.5rem', opacity: 0.5 }} />
            <span style={{ fontSize: 'var(--pv-ctl)' }}>Нет оплаченных заказов</span>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(12rem, 18vw, 16rem), 1fr))' }}>
            {orders.map(o => {
              const hall = o.type === 'hall'
              const Icon = hall ? UtensilsCrossed : ShoppingBag
              const isCash = o.paymentMethod === 'cash'
              return (
                <button key={o.id} onClick={() => open(o)} className="flex flex-col rounded-2xl text-left active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', boxShadow: '0 2px 10px rgba(0,0,0,0.05)', padding: 'clamp(1rem,1.5vw,1.4rem)', gap: 'clamp(0.5rem,0.9vw,0.8rem)' }}>
                  <div className="flex items-center gap-2">
                    <div className="rounded-xl flex items-center justify-center" style={{ background: 'var(--pv-brand-soft)', width: 'clamp(2.2rem,3vw,2.75rem)', height: 'clamp(2.2rem,3vw,2.75rem)' }}>
                      <Icon style={{ width: '55%', height: '55%', color: 'var(--pv-brand)' }} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-bold truncate" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.4vw,1.25rem)' }}>{labelOf(o)}</div>
                      <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{timeOf(o)}</div>
                    </div>
                    {o.paymentMethod && (
                      <div className="rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--pv-bg)', width: '1.9rem', height: '1.9rem' }}>
                        {isCash
                          ? <Banknote style={{ width: '55%', height: '55%', color: 'var(--pv-free-text)' }} />
                          : <CreditCard style={{ width: '55%', height: '55%', color: 'var(--pv-brand)' }} />}
                      </div>
                    )}
                  </div>
                  <div className="font-bold mt-auto" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.2rem,1.7vw,1.6rem)' }}>{formatCurrency(amountOf(o))}</div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Refund overlay */}
      {target && (
        <PosModal open onClose={() => { if (!refunding) setTarget(null) }} dismissable={!refunding} width="clamp(22rem, 44vw, 34rem)" title={`Возврат · ${labelOf(target)}`}>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '1rem' }}>
              <div className="flex items-center justify-between rounded-xl" style={{ background: 'var(--pv-occ-soft)', padding: '0.8rem 1.1rem' }}>
                <span className="font-medium" style={{ color: 'var(--pv-occ-text)', fontSize: 'var(--pv-ctl)' }}>Оплачено</span>
                <span className="font-bold" style={{ color: 'var(--pv-occ-text)', fontSize: 'clamp(1.1rem,1.5vw,1.35rem)' }}>{formatCurrency(amountOf(target))}</span>
              </div>

              <div>
                <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.45rem' }}>Причина</div>
                <div className="flex flex-wrap gap-2">
                  {REASONS.map(r => {
                    const on = r === reason
                    return (
                      <button key={r} onClick={() => setReason(r)} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.4rem 0.9rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{r}</button>
                    )
                  })}
                </div>
              </div>

              <div>
                <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.45rem' }}>Сумма возврата</div>
                <div className="flex items-center rounded-xl border" style={{ borderColor: 'var(--pv-brand)', borderWidth: '2px', padding: '0.7rem 1rem' }}>
                  <input aria-label="Сумма возврата" inputMode="decimal" value={amountStr} onChange={e => setAmountStr(e.target.value)} className="flex-1 min-w-0 bg-transparent outline-none font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.2rem,1.8vw,1.6rem)' }} />
                  <span className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>TJS</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button disabled={reprinting} onClick={() => reprint(target)} className="flex-1 flex items-center justify-center gap-2 rounded-2xl font-semibold disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-bg)', color: 'var(--pv-text-2)', padding: 'clamp(0.7rem,1vw,0.9rem)', fontSize: 'var(--pv-ctl)' }}>
                  <Printer style={{ width: '1.15rem', height: '1.15rem' }} />{reprinting ? 'Печать…' : 'Печать чека'}
                </button>
                <button disabled={refunding} onClick={() => reopen(target)} className="flex-1 flex items-center justify-center gap-2 rounded-2xl font-semibold disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-bg)', color: 'var(--pv-text-2)', padding: 'clamp(0.7rem,1vw,0.9rem)', fontSize: 'var(--pv-ctl)' }}>
                  <Undo2 style={{ width: '1.15rem', height: '1.15rem' }} />Переоткрыть
                </button>
              </div>
              <button disabled={refunding} onClick={doRefund} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-40 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-occ-dot)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                <RotateCcw style={{ width: '1.3em', height: '1.3em' }} />
                {refunding ? 'Оформляем…' : 'Подтвердить возврат'}
              </button>
            </div>
        </PosModal>
      )}
    </div>
  )
}
