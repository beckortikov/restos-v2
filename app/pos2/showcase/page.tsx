'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, RefreshCw, Trash2, Minus, Plus, UtensilsCrossed, FlaskConical } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import { fetchSemiStock, fetchMenuItems, fetchIngredients, fetchWriteoffs, createWriteoff } from '@/lib/queries'
import { api, unwrap } from '@/lib/api'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { PosModal } from '@/components/pos-v2/pos-modal'
import type { SemiFinishedStock, MenuItem, Ingredient, StockWriteoff, WriteoffReason } from '@/lib/types'

const REASONS: { value: WriteoffReason; label: string }[] = [
  { value: 'spoilage', label: 'Порча' },
  { value: 'expired', label: 'Просрочка' },
  { value: 'breakage', label: 'Бой' },
  { value: 'tasting', label: 'Дегустация' },
  { value: 'other', label: 'Прочее' },
]
const reasonLabel = (r: string) => REASONS.find(x => x.value === r)?.label ?? r
type Tab = 'writeoff' | 'history'
const num = (s: string) => Math.max(0, parseFloat(s.replace(',', '.').replace(/\s/g, '')) || 0)

export default function PosV2Showcase() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('writeoff')
  const [semi, setSemi] = useState<SemiFinishedStock[]>([])
  const [dishes, setDishes] = useState<MenuItem[]>([])
  const [ings, setIngs] = useState<Ingredient[]>([])
  const [woffs, setWoffs] = useState<StockWriteoff[]>([])
  const [loading, setLoading] = useState(true)

  // Writeoff modal
  const [target, setTarget] = useState<{ type: 'menu' | 'semi'; name: string; id: string; unit: string; max: number } | null>(null)
  const [qtyStr, setQtyStr] = useState('1')
  const [reason, setReason] = useState<WriteoffReason>('spoilage')
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, m, i, w] = await Promise.all([
        fetchSemiStock().catch(() => [] as SemiFinishedStock[]),
        fetchMenuItems().catch(() => [] as MenuItem[]),
        fetchIngredients().catch(() => [] as Ingredient[]),
        fetchWriteoffs().catch(() => [] as StockWriteoff[]),
      ])
      setSemi(s)
      setDishes(m.filter(x => x.station === 'showcase' && x.isAvailable))
      setIngs(i)
      const cut = Date.now() - 30 * 24 * 60 * 60 * 1000
      setWoffs(w.filter(x => new Date(x.createdAt).getTime() > cut).slice(0, 40))
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const ingByName = useMemo(() => { const m = new Map<string, Ingredient>(); for (const i of ings) m.set(i.name.toLowerCase(), i); return m }, [ings])

  function openWriteoff(type: 'menu' | 'semi', name: string, id: string, unit: string, max: number) {
    setTarget({ type, name, id, unit, max }); setQtyStr('1'); setReason('spoilage'); setDesc('')
  }

  async function submit() {
    if (busyRef.current || !target) return
    // Дробное кол-во (весовые п/ф в кг/л) + гард нуля: бэк semi/consume не
    // клампит остаток к 0 → без этого п/ф уходит в минус. Как в старом POS.
    const qty = num(qtyStr)
    if (qty <= 0) { toast.error('Укажите количество'); return }
    if (target.max > 0 && qty > target.max) { toast.error(`Доступно только ${target.max} ${target.unit}`); return }
    busyRef.current = true; setBusy(true)
    try {
      if (target.type === 'menu') {
        const ing = ingByName.get(target.name.toLowerCase())
        if (!ing) { toast.error(`Ингредиент «${target.name}» не найден на складе`); return }
        await createWriteoff({ reason, description: desc || `Списание с витрины: ${target.name}`, lines: [{ ingredientId: ing.id, name: ing.name, qty, unit: ing.unit, pricePerUnit: ing.pricePerUnit }], createdBy: user?.id })
      } else {
        const s = semi.find(x => x.id === target.id)
        if (!s) { toast.error('Полуфабрикат не найден'); return }
        await unwrap(api.POST('/api/v1/semi/consume', { body: { semi_type_id: s.semiTypeId, qty: String(qty) } as any }))
        await createWriteoff({ reason, description: desc || `Списание полуфабриката: ${target.name}`, lines: [{ ingredientId: s.id, name: s.name, qty, unit: s.unit, pricePerUnit: s.pricePerUnit }], createdBy: user?.id })
      }
      toast.success(`Списано: ${target.name} × ${qty}`)
      setTarget(null); await load()
    } catch (e) { toast.error(humanizeError(e)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>Витрина</span>
        <div className="flex items-center rounded-2xl border shrink-0" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: '4px', gap: '4px', marginLeft: '0.5rem' }}>
          {([['writeoff', 'Списать'], ['history', `История${woffs.length ? ` · ${woffs.length}` : ''}`]] as [Tab, string][]).map(([t, l]) => { const on = tab === t; return (
            <button key={t} onClick={() => setTab(t)} className="rounded-xl font-semibold whitespace-nowrap" style={{ background: on ? 'var(--pv-brand)' : 'transparent', color: on ? '#fff' : 'var(--pv-text-2)', padding: 'clamp(0.5rem,0.8vw,0.75rem) clamp(0.8rem,1.2vw,1.3rem)', fontSize: 'var(--pv-ctl)' }}>{l}</button>
          ) })}
        </div>
        <div className="flex-1" />
        <button onClick={() => load()} className="flex items-center justify-center rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem)' }}>
          <RefreshCw style={{ width: 'clamp(1.05rem,1.3vw,1.3rem)', height: 'clamp(1.05rem,1.3vw,1.3rem)', color: 'var(--pv-text-2)' }} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'var(--pv-gap) var(--pv-pad-x) var(--pv-pad-x)' }}>
        {loading ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Загрузка…</div>
        ) : tab === 'history' ? (
          woffs.length === 0 ? (
            <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Списаний за 30 дней нет</div>
          ) : (
            <div className="mx-auto flex flex-col" style={{ maxWidth: '48rem', gap: '0.5rem' }}>
              {woffs.map(w => (
                <div key={w.id} className="rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.7rem,1.1vw,1.1rem)' }}>
                  <div className="flex items-center justify-between" style={{ gap: '0.5rem' }}>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="rounded-full font-semibold shrink-0" style={{ background: 'var(--pv-occ-soft)', color: 'var(--pv-occ-text)', padding: '0.15rem 0.6rem', fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>{reasonLabel(w.reason)}</span>
                      <span className="truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{w.lines.map(l => `${l.name} ×${l.qty}`).join(', ')}</span>
                    </div>
                    <span className="font-bold shrink-0" style={{ color: 'var(--pv-occ-text)', fontSize: 'var(--pv-ctl)' }}>−{formatCurrency(w.totalCost)}</span>
                  </div>
                  <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.12rem)', marginTop: '0.3rem' }}>{new Date(w.createdAt).toLocaleString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}{w.createdByName ? ` · ${w.createdByName}` : ''}{w.description ? ` · ${w.description}` : ''}</div>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="flex flex-col" style={{ gap: 'clamp(1rem,1.8vw,1.6rem)' }}>
            {/* Блюда витрины */}
            {dishes.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 font-semibold" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)', marginBottom: '0.6rem' }}><UtensilsCrossed style={{ width: '1rem', height: '1rem' }} />Блюда витрины</div>
                <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(13rem,20vw,17rem), 1fr))' }}>
                  {dishes.map(d => {
                    const ing = ingByName.get(d.name.toLowerCase())
                    const low = ing ? ing.qty <= ing.minQty : false
                    return (
                      <div key={d.id} className="flex items-center gap-3 rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.7rem,1.1vw,1rem)' }}>
                        <span style={{ fontSize: 'clamp(1.4rem,2.2vw,2rem)' }}>{d.emoji || '🍽️'}</span>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{d.name}</div>
                          <div style={{ color: low ? 'var(--pv-occ-text)' : 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.12rem)' }}>{ing ? `остаток ${ing.qty} ${ing.unit}` : 'нет на складе'}</div>
                        </div>
                        <button onClick={() => openWriteoff('menu', d.name, d.id, ing?.unit ?? 'шт', ing?.qty ?? 0)} disabled={!ing || ing.qty <= 0} className="rounded-xl flex items-center justify-center shrink-0 disabled:opacity-40 active:scale-90 transition-transform" style={{ background: 'var(--pv-occ-soft)', width: '2.4rem', height: '2.4rem' }}>
                          <Trash2 style={{ width: '1.2rem', height: '1.2rem', color: 'var(--pv-occ-text)' }} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            {/* Полуфабрикаты */}
            {semi.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 font-semibold" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)', marginBottom: '0.6rem' }}><FlaskConical style={{ width: '1rem', height: '1rem' }} />Полуфабрикаты</div>
                <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(13rem,20vw,17rem), 1fr))' }}>
                  {semi.map(s => (
                    <div key={s.id} className="flex items-center gap-3 rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.7rem,1.1vw,1rem)' }}>
                      <span style={{ fontSize: 'clamp(1.4rem,2.2vw,2rem)' }}>🥣</span>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{s.name}</div>
                        <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.12rem)' }}>остаток {s.qty} {s.unit}</div>
                      </div>
                      <button onClick={() => openWriteoff('semi', s.name, s.id, s.unit, s.qty)} disabled={s.qty <= 0} className="rounded-xl flex items-center justify-center shrink-0 disabled:opacity-40 active:scale-90 transition-transform" style={{ background: 'var(--pv-occ-soft)', width: '2.4rem', height: '2.4rem' }}>
                        <Trash2 style={{ width: '1.2rem', height: '1.2rem', color: 'var(--pv-occ-text)' }} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {dishes.length === 0 && semi.length === 0 && (
              <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)', padding: '3rem' }}>Нет блюд витрины и полуфабрикатов</div>
            )}
          </div>
        )}
      </div>

      {/* Writeoff modal */}
      {target && (
        <PosModal open onClose={() => { if (!busy) setTarget(null) }} dismissable={!busy} width="clamp(20rem,42vw,32rem)" title={`Списать · ${target.name}`}>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.9rem' }}>
              <div>
                <div className="flex items-center justify-between" style={{ marginBottom: '0.45rem' }}>
                  <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Количество ({target.unit})</span>
                  <span style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>доступно {target.max} {target.unit}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setQtyStr(s => String(Math.max(0, num(s) - 1)))} className="rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.6rem', height: '2.6rem' }}><Minus className="size-4" style={{ color: 'var(--pv-text-2)' }} /></button>
                  <div className="flex items-center rounded-xl border flex-1 min-w-0" style={{ borderColor: 'var(--pv-brand)', borderWidth: '2px', padding: '0.5rem 0.9rem' }}>
                    <input inputMode="decimal" value={qtyStr} onChange={e => setQtyStr(e.target.value)} aria-label={`Количество, ${target.unit}`} className="flex-1 min-w-0 bg-transparent outline-none font-bold text-center" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.1rem,1.5vw,1.4rem)' }} />
                    <span style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{target.unit}</span>
                  </div>
                  <button onClick={() => setQtyStr(s => String(target.max > 0 ? Math.min(target.max, num(s) + 1) : num(s) + 1))} className="rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.6rem', height: '2.6rem' }}><Plus className="size-4" style={{ color: 'var(--pv-text-2)' }} /></button>
                </div>
              </div>
              <div>
                <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.45rem' }}>Причина</div>
                <div className="flex flex-wrap gap-2">
                  {REASONS.map(r => { const on = r.value === reason; return (
                    <button key={r.value} onClick={() => setReason(r.value)} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.35rem 0.8rem', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{r.label}</button>
                  ) })}
                </div>
              </div>
              <input aria-label="Комментарий (необязательно)" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Комментарий (необязательно)" className="rounded-xl border bg-transparent outline-none" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.6rem 1rem' }} />
              <button disabled={busy} onClick={submit} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-occ-dot)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                <Trash2 style={{ width: '1.3em', height: '1.3em' }} />{busy ? 'Списываем…' : 'Списать'}
              </button>
            </div>
        </PosModal>
      )}
    </div>
  )
}
