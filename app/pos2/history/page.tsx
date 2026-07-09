'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, RefreshCw, RotateCcw, UtensilsCrossed, ShoppingBag, Banknote, CreditCard, Printer, Undo2, FileDown, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { fetchTables, fetchZones, fetchUsers, fetchOrders, fetchOrdersWithCursor, fetchVoidsForOrders, refundOrder, reprintOrderReceipt, reopenOrder } from '@/lib/queries'
import { formatCurrency, startOfDay, endOfDay } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { exportOrdersToXlsx } from '@/lib/orders-export'
import { getPresetRange, type RangePreset } from '@/components/finance/date-range-presets'
import { PosModal } from '@/components/pos-v2/pos-modal'
import { PinSection } from '@/components/pos-v2/pin-section'
import type { Order, Table, Zone, User, OrderVoid } from '@/lib/types'

const REASONS = ['Ошибка кассира', 'Просьба гостя', 'Некачественное блюдо', 'Отмена заказа', 'Другое']
const PAGE = 50
const PRESETS: { value: RangePreset; label: string }[] = [
  { value: 'today', label: 'Сегодня' },
  { value: 'yesterday', label: 'Вчера' },
  { value: 'week', label: '7 дней' },
  { value: 'month', label: 'Месяц' },
]
const STATUSES: { value: 'all' | 'done' | 'cancelled'; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'done', label: 'Оплачены' },
  { value: 'cancelled', label: 'Отменённые' },
]

// s = 'YYYY-MM-DD' (local). Начало/конец дня в локальной TZ — как старый POS.
function parseYmdToDate(s: string, end = false): Date {
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1)
  return end ? endOfDay(dt) : startOfDay(dt)
}

// Phase 2.8 + паритет: история закрытых/отменённых заказов за ПЕРИОД (не только
// 60 последних), фильтр статуса, cursor-пагинация, экспорт xlsx, возврат по
// ОСТАТКУ (paid − refunded) — та же логика, что старый history-orders-tab.
export default function PosV2History() {
  const navigate = useNavigate()
  const [orders, setOrders] = useState<Order[]>([])
  const [tables, setTables] = useState<Table[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [voidsByOrder, setVoidsByOrder] = useState<Map<string, OrderVoid[]>>(new Map())
  const [preset, setPreset] = useState<RangePreset>('today')
  const [statusFilter, setStatusFilter] = useState<'all' | 'done' | 'cancelled'>('all')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [target, setTarget] = useState<Order | null>(null)
  const [reason, setReason] = useState(REASONS[0])
  const [amountStr, setAmountStr] = useState('')
  const [refunding, setRefunding] = useState(false)
  const refundRef = useRef(false)

  const tableNo = useMemo(() => { const m = new Map<string, number>(); for (const t of tables) m.set(t.id, t.number); return m }, [tables])

  const load = useCallback(async (opts?: { append?: boolean; cursor?: string }) => {
    const range = getPresetRange(preset)
    const from = parseYmdToDate(range.from), to = parseYmdToDate(range.to, true)
    // «Все» → closed (done+cancelled), иначе активные протекают в историю.
    const status = statusFilter === 'all' ? 'closed' : statusFilter
    if (opts?.append) setLoadingMore(true); else setLoading(true)
    try {
      const r = await fetchOrdersWithCursor({ from, to, status, slim: true, limit: PAGE, cursor: opts?.cursor })
      setOrders(prev => opts?.append ? [...prev, ...r.orders] : r.orders)
      setNextCursor(r.nextCursor)
      const ids = (opts?.append ? [...orders, ...r.orders] : r.orders).map(o => o.id)
      if (ids.length) fetchVoidsForOrders(ids).then(setVoidsByOrder).catch(() => {})
      else setVoidsByOrder(new Map())
    } catch (e) { toast.error(humanizeError(e, 'Ошибка загрузки истории')) }
    finally { setLoading(false); setLoadingMore(false) }
    // orders намеренно не в deps — читается только в append-режиме (как старый tab).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, statusFilter])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    fetchTables().then(setTables).catch(() => {})
    fetchZones().then(setZones).catch(() => {})
    fetchUsers().then(setUsers).catch(() => {})
  }, [])

  const labelOf = (o: Order): string => o.type === 'hall' ? `Стол ${o.tableId ? (tableNo.get(o.tableId) ?? '—') : '—'}` : 'С собой'
  const paidOf = (o: Order): number => o.totalWithService ?? o.total
  // Остаток к возврату = оплачено − уже возвращено. Возврат сверх остатка бэк
  // режет; дефолт = полная сумма давал пере-возврат на 2-м возврате.
  const remainingOf = (o: Order): number => Math.max(0, paidOf(o) - Number(o.refundedTotal ?? 0))
  const timeOf = (o: Order): string => {
    if (!o.closedAt) return ''
    try { return new Date(o.closedAt).toLocaleString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) } catch { return '' }
  }

  function open(o: Order) {
    if (o.status === 'cancelled') { toast.info('Заказ отменён — возврат не требуется'); return }
    setTarget(o); setReason(REASONS[0]); setAmountStr(remainingOf(o).toFixed(2))
  }

  async function doRefund() {
    if (refundRef.current || !target) return
    const max = remainingOf(target)
    const amt = Math.max(0, Math.min(max, parseFloat(amountStr.replace(',', '.').replace(/\s/g, '')) || 0))
    if (amt <= 0) { toast.error(max <= 0 ? 'По заказу уже нет остатка к возврату' : 'Укажите сумму возврата'); return }
    refundRef.current = true; setRefunding(true)
    try {
      await refundOrder(target.id, reason, amt)
      toast.success(`Возврат оформлен · ${formatCurrency(amt)}`, { description: reason })
      setTarget(null); await load()
    } catch (e) { toast.error(`Возврат не прошёл: ${humanizeError(e)}`) }
    finally { refundRef.current = false; setRefunding(false) }
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

  // Экспорт xlsx за период: догружаем ПОЛНЫЕ заказы (с позициями) + воиды, иначе
  // лист «Позиции» пуст и счётчик расходится с чеком.
  async function doExport() {
    if (exporting) return
    setExporting(true)
    try {
      const range = getPresetRange(preset)
      const from = parseYmdToDate(range.from), to = parseYmdToDate(range.to, true)
      const status = statusFilter === 'all' ? 'closed' : statusFilter
      const full = await fetchOrders({ from, to, status, slim: false, limit: 5000 })
      if (full.length === 0) { toast.info('Нет заказов за период'); return }
      const voids = await fetchVoidsForOrders(full.map(o => o.id)).catch(() => new Map<string, OrderVoid[]>())
      exportOrdersToXlsx(full, { tables, zones, users, voidsByOrderId: voids, filenameSuffix: `${range.from}_${range.to}` })
      toast.success('Excel сформирован')
    } catch (e) { toast.error(`Экспорт не удался: ${humanizeError(e)}`) }
    finally { setExporting(false) }
  }

  return (
    <PinSection label="История заказов">
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>История заказов</span>
        <div className="flex-1" />
        <button onClick={doExport} disabled={exporting} className="flex items-center gap-2 rounded-xl border shrink-0 disabled:opacity-50 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <FileDown style={{ width: 'clamp(1.05rem,1.3vw,1.3rem)', height: 'clamp(1.05rem,1.3vw,1.3rem)', color: 'var(--pv-text-2)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{exporting ? 'Excel…' : 'Excel'}</span>
        </button>
        <button onClick={() => load()} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <RefreshCw style={{ width: 'clamp(1.05rem,1.3vw,1.3rem)', height: 'clamp(1.05rem,1.3vw,1.3rem)', color: 'var(--pv-text-2)' }} className={loading ? 'animate-spin' : ''} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Обновить</span>
        </button>
      </div>

      {/* Filters: период + статус */}
      <div className="flex items-center overflow-x-auto shrink-0" style={{ gap: 'clamp(0.4rem,0.8vw,0.7rem)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        {PRESETS.map(p => { const on = p.value === preset; return (
          <button key={p.value} onClick={() => setPreset(p.value)} className="rounded-full font-semibold whitespace-nowrap shrink-0 border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: 'clamp(0.45rem,0.75vw,0.65rem) clamp(0.9rem,1.3vw,1.3rem)', fontSize: 'var(--pv-ctl)' }}>{p.label}</button>
        ) })}
        <div className="shrink-0" style={{ width: '1px', height: '1.6rem', background: 'var(--pv-border)', margin: '0 0.3rem' }} />
        {STATUSES.map(s => { const on = s.value === statusFilter; return (
          <button key={s.value} onClick={() => setStatusFilter(s.value)} className="rounded-full font-semibold whitespace-nowrap shrink-0 border" style={{ background: on ? 'var(--pv-text)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-text)' : 'var(--pv-border)', padding: 'clamp(0.45rem,0.75vw,0.65rem) clamp(0.9rem,1.3vw,1.3rem)', fontSize: 'var(--pv-ctl)' }}>{s.label}</button>
        ) })}
      </div>

      {/* Orders grid */}
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'var(--pv-gap) var(--pv-pad-x) var(--pv-pad-x)' }}>
        {loading ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Загрузка истории…</div>
        ) : orders.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2" style={{ color: 'var(--pv-text-3)' }}>
            <RotateCcw style={{ width: '2.5rem', height: '2.5rem', opacity: 0.5 }} />
            <span style={{ fontSize: 'var(--pv-ctl)' }}>Нет заказов за период</span>
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(12rem, 18vw, 16rem), 1fr))' }}>
              {orders.map(o => {
                const hall = o.type === 'hall'
                const Icon = hall ? UtensilsCrossed : ShoppingBag
                const isCash = o.paymentMethod === 'cash'
                const cancelled = o.status === 'cancelled'
                const refunded = Number(o.refundedTotal ?? 0) > 0
                return (
                  <button key={o.id} onClick={() => open(o)} className="flex flex-col rounded-2xl text-left active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-card)', border: `1px solid ${cancelled ? 'var(--pv-occ-border)' : 'var(--pv-border)'}`, boxShadow: '0 2px 10px rgba(0,0,0,0.05)', padding: 'clamp(1rem,1.5vw,1.4rem)', gap: 'clamp(0.5rem,0.9vw,0.8rem)', opacity: cancelled ? 0.75 : 1 }}>
                    <div className="flex items-center gap-2">
                      <div className="rounded-xl flex items-center justify-center" style={{ background: cancelled ? 'var(--pv-occ-soft)' : 'var(--pv-brand-soft)', width: 'clamp(2.2rem,3vw,2.75rem)', height: 'clamp(2.2rem,3vw,2.75rem)' }}>
                        <Icon style={{ width: '55%', height: '55%', color: cancelled ? 'var(--pv-occ-text)' : 'var(--pv-brand)' }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-bold truncate" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.4vw,1.25rem)' }}>{labelOf(o)}{o.orderNumber ? ` · №${o.orderNumber}` : ''}</div>
                        <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{timeOf(o)}</div>
                      </div>
                      {!cancelled && o.paymentMethod && (
                        <div className="rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--pv-bg)', width: '1.9rem', height: '1.9rem' }}>
                          {isCash
                            ? <Banknote style={{ width: '55%', height: '55%', color: 'var(--pv-free-text)' }} />
                            : <CreditCard style={{ width: '55%', height: '55%', color: 'var(--pv-brand)' }} />}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {cancelled && <span className="rounded-full font-bold" style={{ background: 'var(--pv-occ-soft)', color: 'var(--pv-occ-text)', padding: '0.1rem 0.5rem', fontSize: '0.65rem' }}>ОТМЕНЁН</span>}
                      {refunded && <span className="rounded-full font-bold" style={{ background: 'var(--pv-bill-soft)', color: 'var(--pv-bill-text)', padding: '0.1rem 0.5rem', fontSize: '0.65rem' }}>ВОЗВРАТ</span>}
                    </div>
                    <div className="font-bold mt-auto" style={{ color: cancelled ? 'var(--pv-text-3)' : 'var(--pv-text)', fontSize: 'clamp(1.2rem,1.7vw,1.6rem)', textDecoration: cancelled ? 'line-through' : 'none' }}>{formatCurrency(paidOf(o))}</div>
                  </button>
                )
              })}
            </div>
            {nextCursor && (
              <div className="flex justify-center" style={{ paddingTop: 'var(--pv-gap)' }}>
                <button disabled={loadingMore} onClick={() => load({ append: true, cursor: nextCursor })} className="flex items-center gap-2 rounded-xl border disabled:opacity-50 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(1.2rem,2vw,1.8rem)' }}>
                  <ChevronDown style={{ width: '1.15rem', height: '1.15rem', color: 'var(--pv-text-2)' }} className={loadingMore ? 'animate-pulse' : ''} />
                  <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{loadingMore ? 'Загрузка…' : 'Показать ещё'}</span>
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Refund overlay */}
      {target && (
        <PosModal open onClose={() => { if (!refunding) setTarget(null) }} dismissable={!refunding} width="clamp(22rem, 44vw, 34rem)" title={`Возврат · ${labelOf(target)}`}>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '1rem' }}>
              <div className="flex items-center justify-between rounded-xl" style={{ background: 'var(--pv-occ-soft)', padding: '0.8rem 1.1rem' }}>
                <div className="flex flex-col">
                  <span className="font-medium" style={{ color: 'var(--pv-occ-text)', fontSize: 'var(--pv-ctl)' }}>Оплачено</span>
                  {Number(target.refundedTotal ?? 0) > 0 && <span style={{ color: 'var(--pv-occ-text)', fontSize: 'calc(var(--pv-ctl) - 0.15rem)', opacity: 0.85 }}>уже возвращено {formatCurrency(Number(target.refundedTotal ?? 0))} · остаток {formatCurrency(remainingOf(target))}</span>}
                </div>
                <span className="font-bold" style={{ color: 'var(--pv-occ-text)', fontSize: 'clamp(1.1rem,1.5vw,1.35rem)' }}>{formatCurrency(paidOf(target))}</span>
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
                  <span className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>с.</span>
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
    </PinSection>
  )
}
