'use client'

import { useState, useRef, useEffect } from 'react'
import { SquareSplitHorizontal, ArrowRightLeft, Trash2, Users, ChevronRight, UserCog, Receipt, CheckCircle2, Check } from 'lucide-react'
import { toast } from 'sonner'
import { splitOrderEqual, splitOrderByItems, transferOrder, cancelOrder, updateOrderStatus, updateTableStatus, assignWaiter, fetchUsers } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { buildItemAssignments, isSplitValid } from '@/lib/pos-v2/split'
import { PosModal } from '@/components/pos-v2/pos-modal'
import type { Order, Table, User } from '@/lib/types'

const ORDER_REASONS = ['Ошибка официанта', 'Нет ингредиента', 'Отменено клиентом', 'Другое']

// Инлайн-действия над заказом на экране /pos2/order (без ухода на тикет):
// разделить счёт (поровну / по позициям), перенести на свободный стол, отменить.
// onChanged — перечитать контекст стола; onCancelled — заказ отменён (снять группу).
export function OrderExtras({ order, tables, servicePercent, open, onClose, onChanged, onCancelled }: {
  order: Order
  tables: Table[]
  servicePercent: number
  open: boolean
  onClose: () => void
  onChanged: () => void
  onCancelled: () => void
}) {
  const [view, setView] = useState<'menu' | 'split' | 'transfer' | 'cancel' | 'waiter'>('menu')
  const [splitN, setSplitN] = useState(2)
  const [splitMode, setSplitMode] = useState<'equal' | 'items'>('equal')
  const [itemPart, setItemPart] = useState<Record<string, number>>({})
  const [orderReason, setOrderReason] = useState(ORDER_REASONS[0])
  const [waiters, setWaiters] = useState<User[]>([])
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  // Официанты для назначения на стол (только при открытом меню действий).
  useEffect(() => { if (open) fetchUsers().then(u => setWaiters(u.filter(x => x.role === 'waiter'))).catch(() => {}) }, [open])

  if (!open) return null
  const sp = order.type === 'hall' ? servicePercent : 0
  const freeTables = tables.filter(t => t.status === 'free' && t.id !== order.tableId)
  // Назначение официанта / запрос счёта — только для зальных заказов (нужен стол).
  const isHall = order.type === 'hall' && !!order.tableId
  const curWaiter = waiters.find(w => w.id === order.waiterId)

  function reset() { setView('menu'); setSplitN(2); setSplitMode('equal'); setItemPart({}); setOrderReason(ORDER_REASONS[0]) }
  function close() { reset(); onClose() }

  async function run(fn: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    try { await fn() } catch (e) { toast.error(humanizeError(e)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  const doSplitEqual = () => run(async () => {
    await splitOrderEqual(order.id, splitN, sp)
    toast.success(`Счёт разделён на ${splitN}`); reset(); onChanged()
  })
  const doSplitItems = () => {
    const liveIds = (order.items ?? []).filter(i => !i.cancelledAt && i.id).map(i => i.id!)
    const assignments = buildItemAssignments(liveIds, itemPart, splitN)
    if (!isSplitValid(assignments)) { toast.error('Разнесите позиции минимум на 2 части'); return }
    return run(async () => {
      await splitOrderByItems(order.id, assignments, sp)
      toast.success('Счёт разделён по позициям'); reset(); onChanged()
    })
  }
  const doTransfer = (tableId: string) => run(async () => {
    await transferOrder(order.id, { tableId })
    toast.success('Заказ перенесён'); reset(); onChanged()
  })
  const doCancel = () => run(async () => {
    await cancelOrder(order.id, orderReason)
    toast.success('Заказ отменён'); reset(); onCancelled()
  })
  const doAssign = (waiterId: string | null) => run(async () => {
    await assignWaiter(order.tableId!, waiterId)
    toast.success(waiterId ? 'Официант назначен' : 'Официант снят'); reset(); onChanged()
  })
  // Запрос счёта: order-level bill_requested в v4 не имеет эндпоинта — флипаем
  // статус СТОЛА (updateTableStatus), он и красит плитку «Счёт» на карте.
  const doRequestBill = () => run(async () => {
    await updateTableStatus(order.tableId!, 'bill_requested')
    toast.success('Счёт запрошен'); reset(); onChanged()
  })
  const doServed = () => run(async () => {
    await updateOrderStatus(order.id, 'served')
    toast.success('Отмечено «подано»'); reset(); onChanged()
  })

  const title = view === 'menu' ? 'Действия с заказом'
    : view === 'split' ? 'Разделить счёт'
    : view === 'transfer' ? 'Перенести на стол'
    : view === 'waiter' ? 'Назначить официанта'
    : 'Отменить заказ'

  return (
    <PosModal open onClose={close} dismissable={!busy} width="clamp(22rem,46vw,36rem)" title={title}>
      <div style={{ padding: 'clamp(1.1rem,1.7vw,1.5rem)' }}>
        {view === 'menu' && (
          <div className="flex flex-col" style={{ gap: '0.5rem' }}>
            {isHall && (
              <button onClick={() => setView('waiter')} className="flex items-center gap-3 rounded-2xl text-left active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-bg)', padding: 'clamp(0.8rem,1.2vw,1.1rem)' }}>
                <div className="rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--pv-brand-soft)', width: '2.6rem', height: '2.6rem' }}><UserCog style={{ width: '1.35rem', height: '1.35rem', color: 'var(--pv-brand)' }} /></div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Официант</div>
                  <div className="truncate" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{curWaiter ? curWaiter.name : 'не назначен'}</div>
                </div>
                <ChevronRight style={{ width: '1.2rem', height: '1.2rem', color: 'var(--pv-text-3)' }} />
              </button>
            )}
            {isHall && order.status !== 'bill_requested' && (
              <button disabled={busy} onClick={doRequestBill} className="flex items-center gap-3 rounded-2xl text-left disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-bg)', padding: 'clamp(0.8rem,1.2vw,1.1rem)' }}>
                <div className="rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--pv-bill-soft)', width: '2.6rem', height: '2.6rem' }}><Receipt style={{ width: '1.35rem', height: '1.35rem', color: 'var(--pv-bill-text)' }} /></div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Запросить счёт</div>
                  <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>Стол → «Счёт» на карте зала</div>
                </div>
              </button>
            )}
            {order.status !== 'served' && order.status !== 'done' && (
              <button disabled={busy} onClick={doServed} className="flex items-center gap-3 rounded-2xl text-left disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-bg)', padding: 'clamp(0.8rem,1.2vw,1.1rem)' }}>
                <div className="rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--pv-free-soft)', width: '2.6rem', height: '2.6rem' }}><CheckCircle2 style={{ width: '1.35rem', height: '1.35rem', color: 'var(--pv-free-text)' }} /></div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Отметить «подано»</div>
                  <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>Заказ подан гостю</div>
                </div>
              </button>
            )}
            {([
              ['split', SquareSplitHorizontal, 'Разделить счёт', 'Поровну или по позициям'],
              ['transfer', ArrowRightLeft, 'Перенести на другой стол', 'Свободный стол'],
              ['cancel', Trash2, 'Отменить заказ', 'С указанием причины'],
            ] as const).map(([v, Icon, label, sub]) => (
              <button key={v} onClick={() => setView(v)} className="flex items-center gap-3 rounded-2xl text-left active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-bg)', padding: 'clamp(0.8rem,1.2vw,1.1rem)' }}>
                <div className="rounded-xl flex items-center justify-center shrink-0" style={{ background: v === 'cancel' ? 'var(--pv-occ-soft)' : 'var(--pv-brand-soft)', width: '2.6rem', height: '2.6rem' }}>
                  <Icon style={{ width: '1.35rem', height: '1.35rem', color: v === 'cancel' ? 'var(--pv-occ-text)' : 'var(--pv-brand)' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{label}</div>
                  <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{sub}</div>
                </div>
                <ChevronRight style={{ width: '1.2rem', height: '1.2rem', color: 'var(--pv-text-3)' }} />
              </button>
            ))}
          </div>
        )}

        {view === 'split' && (
          <div className="flex flex-col" style={{ gap: '0.9rem' }}>
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
                <button disabled={busy} onClick={doSplitEqual} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                  <SquareSplitHorizontal style={{ width: '1.3em', height: '1.3em' }} />Разделить на {splitN}
                </button>
              </>
            ) : (
              <>
                <div className="flex flex-col" style={{ gap: '0.4rem', maxHeight: '38vh', overflowY: 'auto' }}>
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
            <button onClick={() => setView('menu')} className="text-center font-semibold" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>← Назад</button>
          </div>
        )}

        {view === 'transfer' && (
          <div className="flex flex-col" style={{ gap: '0.9rem' }}>
            {freeTables.length === 0 ? (
              <div className="text-center" style={{ color: 'var(--pv-text-3)', padding: '2rem' }}>Нет свободных столов</div>
            ) : (
              <div style={{ display: 'grid', gap: 'clamp(0.6rem,1vw,0.9rem)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(6rem,10vw,8rem), 1fr))', maxHeight: '46vh', overflowY: 'auto' }}>
                {freeTables.map(t => (
                  <button key={t.id} disabled={busy} onClick={() => doTransfer(t.id)} className="flex flex-col items-center justify-center rounded-2xl disabled:opacity-50 active:scale-[0.97] transition-transform" style={{ background: 'var(--pv-free-soft)', padding: 'clamp(0.8rem,1.3vw,1.2rem)', gap: '0.35rem', minHeight: 'clamp(5rem,7vw,6.5rem)' }}>
                    <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.1rem,1.6vw,1.5rem)' }}>№{t.number}</span>
                    <div className="flex items-center gap-1" style={{ color: 'var(--pv-free-text)' }}><Users style={{ width: '0.8rem', height: '0.8rem' }} /><span style={{ fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>{t.capacity}</span></div>
                  </button>
                ))}
              </div>
            )}
            <button onClick={() => setView('menu')} className="text-center font-semibold" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>← Назад</button>
          </div>
        )}

        {view === 'waiter' && (
          <div className="flex flex-col" style={{ gap: '0.5rem' }}>
            {waiters.length === 0 && <div className="text-center" style={{ color: 'var(--pv-text-3)', padding: '1.5rem', fontSize: 'var(--pv-ctl)' }}>Официанты не заведены</div>}
            {waiters.map(w => { const on = order.waiterId === w.id; return (
              <button key={w.id} disabled={busy} onClick={() => doAssign(w.id)} className="flex items-center gap-3 rounded-2xl text-left disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: on ? 'var(--pv-brand-soft)' : 'var(--pv-bg)', padding: 'clamp(0.7rem,1.1vw,1rem)' }}>
                <div className="rounded-full flex items-center justify-center font-bold shrink-0" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', width: '2.4rem', height: '2.4rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{w.name.trim().split(/\s+/).slice(0, 2).map(s => s[0]?.toUpperCase() ?? '').join('')}</div>
                <span className="flex-1 min-w-0 truncate font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{w.name}</span>
                {on && <Check style={{ width: '1.2rem', height: '1.2rem', color: 'var(--pv-brand)' }} />}
              </button>
            ) })}
            {order.waiterId && (
              <button disabled={busy} onClick={() => doAssign(null)} className="w-full text-center font-semibold rounded-xl disabled:opacity-50" style={{ color: 'var(--pv-occ-text)', padding: '0.6rem', fontSize: 'var(--pv-ctl)' }}>Снять официанта</button>
            )}
            <button onClick={() => setView('menu')} className="text-center font-semibold" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>← Назад</button>
          </div>
        )}

        {view === 'cancel' && (
          <div className="flex flex-col" style={{ gap: '1rem' }}>
            <div className="flex flex-wrap gap-2">
              {ORDER_REASONS.map(r => { const on = r === orderReason; return <button key={r} onClick={() => setOrderReason(r)} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.4rem 0.9rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{r}</button> })}
            </div>
            <button disabled={busy} onClick={doCancel} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-occ-dot)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
              <Trash2 style={{ width: '1.3em', height: '1.3em' }} />Отменить заказ
            </button>
            <button onClick={() => setView('menu')} className="text-center font-semibold" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>← Назад</button>
          </div>
        )}
      </div>
    </PosModal>
  )
}
