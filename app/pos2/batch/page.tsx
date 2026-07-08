'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, RefreshCw, ChefHat, Trash2, Minus, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { useOrderData } from '@/components/order/use-order-data'
import { fetchBatchAvailability, calculateMaxPortions, produceBatch, writeoffPreparedBatch, fetchBatchCookingLogs } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import type { BatchPortionCalc, BatchCookingLog, MenuItem } from '@/lib/types'

const REASONS = [
  { value: 'spoilage', label: 'Порча' },
  { value: 'expired', label: 'Просрочка' },
  { value: 'breakage', label: 'Бой' },
  { value: 'tasting', label: 'Дегустация' },
  { value: 'other', label: 'Прочее' },
]
type Tab = 'batch' | 'history'

export default function PosV2Batch() {
  const navigate = useNavigate()
  const { menuItems, loading, reload } = useOrderData(true)
  const [tab, setTab] = useState<Tab>('batch')
  const [avail, setAvail] = useState<Map<string, number>>(new Map())
  const [logs, setLogs] = useState<BatchCookingLog[]>([])

  const [prod, setProd] = useState<MenuItem | null>(null)
  const [calc, setCalc] = useState<BatchPortionCalc | null>(null)
  const [qty, setQty] = useState(1)
  const [woff, setWoff] = useState<MenuItem | null>(null)
  const [wQty, setWQty] = useState(1)
  const [wReason, setWReason] = useState('spoilage')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const items = useMemo(() => menuItems.filter(m => m.isBatchCooking), [menuItems])

  const loadExtra = useCallback(() => {
    fetchBatchAvailability().then(setAvail).catch(() => {})
    fetchBatchCookingLogs().then(rs => setLogs(rs.slice(0, 40))).catch(() => {})
  }, [])
  useEffect(() => { loadExtra() }, [loadExtra])

  async function openProduce(m: MenuItem) {
    setProd(m); setQty(1); setCalc(null)
    try { setCalc(await calculateMaxPortions(m.id)) } catch (e) { toast.error(humanizeError(e)) }
  }

  async function doProduce() {
    if (busyRef.current || !prod) return
    const max = calc?.maxPortions ?? 0
    if (qty < 1 || (max > 0 && qty > max)) { toast.error(`Можно приготовить максимум ${max} порц`); return }
    busyRef.current = true; setBusy(true)
    try { await produceBatch(prod.id, qty); toast.success(`Приготовлено: ${prod.name} × ${qty}`); setProd(null); await reload(); loadExtra() }
    catch (e) { toast.error(humanizeError(e)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function doWriteoff() {
    if (busyRef.current || !woff) return
    busyRef.current = true; setBusy(true)
    try { await writeoffPreparedBatch(woff.id, wQty, wReason); toast.success(`Списано: ${woff.name} × ${wQty}`); setWoff(null); await reload(); loadExtra() }
    catch (e) { toast.error(humanizeError(e)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  const reasonLabel = (r?: string) => REASONS.find(x => x.value === r)?.label ?? r

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>Заготовки</span>
        <div className="flex items-center rounded-2xl border shrink-0" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: '4px', gap: '4px', marginLeft: '0.5rem' }}>
          {([['batch', 'Заготовки'], ['history', 'История']] as [Tab, string][]).map(([t, l]) => { const on = tab === t; return (
            <button key={t} onClick={() => setTab(t)} className="rounded-xl font-semibold whitespace-nowrap" style={{ background: on ? 'var(--pv-brand)' : 'transparent', color: on ? '#fff' : 'var(--pv-text-2)', padding: 'clamp(0.5rem,0.8vw,0.75rem) clamp(0.8rem,1.2vw,1.3rem)', fontSize: 'var(--pv-ctl)' }}>{l}</button>
          ) })}
        </div>
        <div className="flex-1" />
        <button onClick={() => { reload(); loadExtra() }} className="flex items-center justify-center rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem)' }}>
          <RefreshCw style={{ width: 'clamp(1.05rem,1.3vw,1.3rem)', height: 'clamp(1.05rem,1.3vw,1.3rem)', color: 'var(--pv-text-2)' }} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'var(--pv-gap) var(--pv-pad-x) var(--pv-pad-x)' }}>
        {tab === 'history' ? (
          logs.length === 0 ? (
            <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>История пуста</div>
          ) : (
            <div className="mx-auto flex flex-col" style={{ maxWidth: '48rem', gap: '0.5rem' }}>
              {logs.map(l => (
                <div key={l.id} className="flex items-center justify-between rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.7rem,1.1vw,1.1rem)', gap: '0.5rem' }}>
                  <div className="min-w-0">
                    <div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{l.menuItemName} × {l.qty}</div>
                    <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.12rem)' }}>{l.reason ? `Списание: ${reasonLabel(l.reason)}` : 'Приготовлено'} · {new Date(l.createdAt).toLocaleString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}{l.producedBy ? ` · ${l.producedBy}` : ''}</div>
                  </div>
                  <span className="font-bold shrink-0" style={{ color: l.reason ? 'var(--pv-occ-text)' : 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>{l.reason ? '−' : ''}{formatCurrency(l.costTotal)}</span>
                </div>
              ))}
            </div>
          )
        ) : items.length === 0 ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Нет заготовочных блюд</div>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(14rem,22vw,18rem), 1fr))' }}>
            {items.map(m => {
              const ready = avail.get(m.id) ?? m.preparedQty ?? 0
              const low = ready <= (m.lowStockThreshold ?? 5)
              return (
                <div key={m.id} className="flex flex-col rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.8rem,1.2vw,1.1rem)', gap: '0.6rem' }}>
                  <div className="flex items-center gap-3">
                    <span style={{ fontSize: 'clamp(1.4rem,2.2vw,2rem)' }}>{m.emoji || '🍲'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{m.name}</div>
                      <div className="font-bold" style={{ color: low ? 'var(--pv-occ-text)' : 'var(--pv-free-text)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Готово: {ready} порц</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => openProduce(m)} className="flex-1 flex items-center justify-center gap-2 rounded-xl font-bold text-white active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: '0.6rem', fontSize: 'var(--pv-ctl)' }}>
                      <ChefHat style={{ width: '1.15em', height: '1.15em' }} />Приготовить
                    </button>
                    <button onClick={() => { setWoff(m); setWQty(1); setWReason('spoilage') }} disabled={ready <= 0} className="rounded-xl flex items-center justify-center disabled:opacity-40 active:scale-90 transition-transform" style={{ background: 'var(--pv-occ-soft)', width: '2.6rem', height: '2.6rem' }}>
                      <Trash2 style={{ width: '1.2rem', height: '1.2rem', color: 'var(--pv-occ-text)' }} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Produce modal */}
      {prod && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => { if (!busy) setProd(null) }}>
          <div className="rounded-3xl overflow-hidden" style={{ background: 'var(--pv-card)', width: 'clamp(20rem,42vw,32rem)', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold truncate" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.3rem)', color: 'var(--pv-text)' }}>Приготовить · {prod.name}</span>
              <button onClick={() => { if (!busy) setProd(null) }} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.9rem' }}>
              <div className="flex items-center justify-between rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.6rem 1rem' }}>
                <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Максимум из остатков</span>
                <span className="font-bold" style={{ color: 'var(--pv-brand)', fontSize: 'var(--pv-ctl)' }}>{calc ? `${calc.maxPortions} порц` : '…'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Приготовить порций</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setQty(q => Math.max(1, q - 1))} className="rounded-lg flex items-center justify-center" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.2rem', height: '2.2rem' }}><Minus className="size-4" style={{ color: 'var(--pv-text-2)' }} /></button>
                  <span className="text-center font-bold" style={{ color: 'var(--pv-text)', width: '3rem', fontSize: 'clamp(1.1rem,1.5vw,1.4rem)' }}>{qty}</span>
                  <button onClick={() => setQty(q => (calc && calc.maxPortions > 0 ? Math.min(calc.maxPortions, q + 1) : q + 1))} className="rounded-lg flex items-center justify-center" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.2rem', height: '2.2rem' }}><Plus className="size-4" style={{ color: 'var(--pv-text-2)' }} /></button>
                </div>
              </div>
              {calc && calc.ingredients.length > 0 && (
                <div>
                  <div className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)', marginBottom: '0.4rem' }}>Будет списано:</div>
                  <div className="flex flex-col rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.5rem 0.8rem', gap: '0.25rem' }}>
                    {calc.ingredients.map(g => (
                      <div key={g.ingredientId} className="flex items-center justify-between" style={{ fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>
                        <span className="truncate" style={{ color: g.isBottleneck ? 'var(--pv-occ-text)' : 'var(--pv-text-2)', marginRight: '0.5rem' }}>{g.name}{g.isBottleneck ? ' · лимит' : ''}</span>
                        <span className="shrink-0" style={{ color: 'var(--pv-text-3)' }}>{(g.stockQtyPerPortion * qty).toFixed(2)} {g.unit} / {g.stockQty} {g.unit}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <button disabled={busy || (calc?.maxPortions ?? 0) < 1} onClick={doProduce} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                <ChefHat style={{ width: '1.3em', height: '1.3em' }} />{busy ? 'Готовим…' : `Приготовить ${qty}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Writeoff prepared modal */}
      {woff && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => { if (!busy) setWoff(null) }}>
          <div className="rounded-3xl overflow-hidden" style={{ background: 'var(--pv-card)', width: 'clamp(20rem,42vw,32rem)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold truncate" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.3rem)', color: 'var(--pv-text)' }}>Списать заготовку · {woff.name}</span>
              <button onClick={() => { if (!busy) setWoff(null) }} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.9rem' }}>
              <div className="flex items-center justify-between">
                <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Порций</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setWQty(q => Math.max(1, q - 1))} className="rounded-lg flex items-center justify-center" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.2rem', height: '2.2rem' }}><Minus className="size-4" style={{ color: 'var(--pv-text-2)' }} /></button>
                  <span className="text-center font-bold" style={{ color: 'var(--pv-text)', width: '3rem', fontSize: 'clamp(1.1rem,1.5vw,1.4rem)' }}>{wQty}</span>
                  <button onClick={() => setWQty(q => q + 1)} className="rounded-lg flex items-center justify-center" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.2rem', height: '2.2rem' }}><Plus className="size-4" style={{ color: 'var(--pv-text-2)' }} /></button>
                </div>
              </div>
              <div>
                <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.45rem' }}>Причина</div>
                <div className="flex flex-wrap gap-2">
                  {REASONS.map(r => { const on = r.value === wReason; return (
                    <button key={r.value} onClick={() => setWReason(r.value)} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.35rem 0.8rem', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{r.label}</button>
                  ) })}
                </div>
              </div>
              <button disabled={busy} onClick={doWriteoff} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-occ-dot)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                <Trash2 style={{ width: '1.3em', height: '1.3em' }} />{busy ? 'Списываем…' : 'Списать'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
