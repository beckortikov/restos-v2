'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, RefreshCw, Search, OctagonX, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { useOrderData } from '@/components/order/use-order-data'
import { fetchStopList, toggleStopListOverride, toggleMenuAvailability } from '@/lib/queries'
import { humanizeError } from '@/lib/errors'

type StopRow = { menuItemId: string; menuItemName: string; emoji: string; category: string; ingredients: { name: string; qty: number; minQty: number; unit: string }[]; manual?: boolean; unavailable?: boolean }
type Tab = 'stop' | 'menu'

export default function PosV2Stop() {
  const navigate = useNavigate()
  const { menuItems, categories, loading, reload } = useOrderData(true)
  const [stop, setStop] = useState<StopRow[]>([])
  const [tab, setTab] = useState<Tab>('stop')
  const [search, setSearch] = useState('')
  const [cat, setCat] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const loadStop = useCallback(() => { fetchStopList().then(setStop).catch(() => {}) }, [])
  useEffect(() => { loadStop() }, [loadStop])

  const overrideOf = useMemo(() => {
    const m = new Map<string, boolean>()
    for (const mi of menuItems) m.set(mi.id, mi.stopListOverride)
    return m
  }, [menuItems])

  async function act(fn: () => Promise<void>, ok: string) {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    try { await fn(); toast.success(ok); await reload(); loadStop() }
    catch (e) { toast.error(humanizeError(e)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  const visibleCats = useMemo(() => categories.filter(c => c && !c.toLowerCase().includes('полуфабрикат')), [categories])
  const menuFiltered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return menuItems.filter(m => (q ? m.name.toLowerCase().includes(q) : (!cat || m.category === cat)))
  }, [menuItems, search, cat])

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>Стоп-лист</span>
        <div className="flex items-center rounded-2xl border shrink-0" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: '4px', gap: '4px', marginLeft: '0.5rem' }}>
          {([['stop', `Стоп-лист${stop.length ? ` · ${stop.length}` : ''}`], ['menu', 'Всё меню']] as [Tab, string][]).map(([t, l]) => {
            const on = tab === t
            return <button key={t} onClick={() => setTab(t)} className="rounded-xl font-semibold whitespace-nowrap" style={{ background: on ? 'var(--pv-brand)' : 'transparent', color: on ? '#fff' : 'var(--pv-text-2)', padding: 'clamp(0.5rem,0.8vw,0.75rem) clamp(0.8rem,1.2vw,1.3rem)', fontSize: 'var(--pv-ctl)' }}>{l}</button>
          })}
        </div>
        <div className="flex-1" />
        <button onClick={() => { reload(); loadStop() }} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <RefreshCw style={{ width: 'clamp(1.05rem,1.3vw,1.3rem)', height: 'clamp(1.05rem,1.3vw,1.3rem)', color: 'var(--pv-text-2)' }} className={loading ? 'animate-spin' : ''} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Обновить</span>
        </button>
      </div>

      {tab === 'menu' && (
        <div className="shrink-0 flex items-center gap-2 flex-wrap" style={{ padding: '0.6rem var(--pv-pad-x) 0' }}>
          <div className="flex items-center rounded-xl border" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: '0.4rem 0.8rem', gap: '0.5rem', minWidth: 'clamp(12rem,22vw,18rem)' }}>
            <Search style={{ width: '1.1rem', height: '1.1rem', color: 'var(--pv-text-3)' }} />
            <input aria-label="Поиск блюда" value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск блюда" className="flex-1 min-w-0 bg-transparent outline-none" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }} />
            {search && <button onClick={() => setSearch('')}><X style={{ width: '1rem', height: '1rem', color: 'var(--pv-text-3)' }} /></button>}
          </div>
          {!search && visibleCats.map(c => { const on = (cat ?? visibleCats[0]) === c; return (
            <button key={c} onClick={() => setCat(c)} className="rounded-full font-semibold border whitespace-nowrap" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.4rem 0.9rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{c}</button>
          ) })}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'var(--pv-gap) var(--pv-pad-x) var(--pv-pad-x)' }}>
        {tab === 'stop' ? (
          stop.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-2" style={{ color: 'var(--pv-text-3)' }}>
              <Check style={{ width: '3rem', height: '3rem', color: 'var(--pv-free-dot)' }} />
              <span className="font-semibold" style={{ fontSize: 'var(--pv-ctl)' }}>Стоп-лист пуст — всё в наличии</span>
            </div>
          ) : (
            <div className="mx-auto flex flex-col" style={{ maxWidth: '48rem', gap: '0.5rem' }}>
              {stop.map(item => {
                const override = overrideOf.get(item.menuItemId) ?? false
                const manual = item.manual ?? false
                const shortage = item.ingredients.find(g => g.qty <= g.minQty)
                return (
                  <div key={item.menuItemId} className="flex items-center gap-3 rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.7rem,1.1vw,1.1rem)' }}>
                    <span style={{ fontSize: 'clamp(1.3rem,2vw,1.8rem)' }}>{item.emoji || '🍽️'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{item.menuItemName}</div>
                      <div className="truncate" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.12rem)' }}>
                        {manual ? 'снято вручную' : shortage ? `нет ингредиента: ${shortage.name}` : 'нет ингредиента'}{override ? ' · продаётся (override)' : ''}
                      </div>
                    </div>
                    <button disabled={busy} onClick={() => act(() => toggleMenuAvailability(item.menuItemId, true), 'Возвращено в меню')} className="rounded-xl font-semibold shrink-0 disabled:opacity-50 active:scale-95 transition-transform" style={{ background: 'var(--pv-free-soft)', color: 'var(--pv-free-text)', padding: '0.5rem 0.9rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Вернуть в меню</button>
                    {!manual && (
                      <button disabled={busy} onClick={() => act(() => toggleStopListOverride(item.menuItemId, !override), override ? 'Возвращено в стоп' : 'Включено (override)')} className="rounded-xl font-semibold shrink-0 disabled:opacity-50 active:scale-95 transition-transform" style={{ background: override ? 'var(--pv-occ-soft)' : 'var(--pv-brand-soft)', color: override ? 'var(--pv-occ-text)' : 'var(--pv-brand)', padding: '0.5rem 0.9rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{override ? 'Вернуть в стоп' : 'Включить'}</button>
                    )}
                  </div>
                )
              })}
            </div>
          )
        ) : (
          <div className="mx-auto flex flex-col" style={{ maxWidth: '48rem', gap: '0.4rem' }}>
            {menuFiltered.map(m => {
              const off = m.isAvailable === false
              return (
                <div key={m.id} className="flex items-center gap-3 rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.6rem,1vw,0.95rem)', opacity: off ? 0.75 : 1 }}>
                  <span style={{ fontSize: 'clamp(1.2rem,1.8vw,1.6rem)' }}>{m.emoji || '🍽️'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{m.name}</div>
                    <div className="truncate" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.12rem)' }}>{m.category}</div>
                  </div>
                  <button disabled={busy} onClick={() => act(() => toggleMenuAvailability(m.id, off), off ? `«${m.name}» в наличии` : `«${m.name}» в стоп`)} className="rounded-xl font-semibold shrink-0 flex items-center gap-1.5 disabled:opacity-50 active:scale-95 transition-transform" style={{ background: off ? 'var(--pv-occ-soft)' : 'var(--pv-free-soft)', color: off ? 'var(--pv-occ-text)' : 'var(--pv-free-text)', padding: '0.5rem 0.9rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>
                    {off ? <><OctagonX style={{ width: '1rem', height: '1rem' }} />СТОП</> : <><Check style={{ width: '1rem', height: '1rem' }} />В наличии</>}
                  </button>
                </div>
              )
            })}
            {menuFiltered.length === 0 && <div className="text-center" style={{ color: 'var(--pv-text-3)', padding: '2rem', fontSize: 'var(--pv-ctl)' }}>Ничего не найдено</div>}
          </div>
        )}
      </div>
    </div>
  )
}
