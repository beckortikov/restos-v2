'use client'

import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, Users, Plus } from 'lucide-react'
import { useOrderData } from '@/components/order/use-order-data'
import type { Table, TableStatus } from '@/lib/types'

const STATUS: Record<TableStatus, { soft: string; dot: string; text: string; label: string }> = {
  free: { soft: 'var(--pv-free-soft)', dot: 'var(--pv-free-dot)', text: 'var(--pv-free-text)', label: 'Свободен' },
  occupied: { soft: 'var(--pv-occ-soft)', dot: 'var(--pv-occ-dot)', text: 'var(--pv-occ-text)', label: 'Занят' },
  reserved: { soft: 'var(--pv-res-soft)', dot: 'var(--pv-res-dot)', text: 'var(--pv-res-text)', label: 'Бронь' },
  bill_requested: { soft: 'var(--pv-bill-soft)', dot: 'var(--pv-bill-dot)', text: 'var(--pv-bill-text)', label: 'Счёт' },
}

// Phase 2.9: карта зала в /pos2. Свободный стол → новый заказ (/pos2/order?table=),
// занятый → оплата его заказа (/pos2/pay?order=). Данные + realtime через useOrderData.
export default function PosV2Tables() {
  const navigate = useNavigate()
  const { tables, zones, loading } = useOrderData(true)

  const byZone = useMemo(() => {
    const zoneName = (z: string) => zones.find(zz => zz.id === z)?.name ?? z ?? 'Зал'
    const map = new Map<string, Table[]>()
    for (const t of tables) {
      const key = zoneName(t.zone)
      const arr = map.get(key) ?? []
      arr.push(t)
      map.set(key, arr)
    }
    return Array.from(map.entries()).map(([zone, ts]) => ({ zone, tables: [...ts].sort((a, b) => a.number - b.number) }))
  }, [tables, zones])

  function tap(t: Table) {
    const open = t.currentOrderIds?.[0]
    if (open) navigate(`/pos2/ticket?order=${encodeURIComponent(open)}`)
    else navigate(`/pos2/order?table=${encodeURIComponent(t.id)}`)
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>Карта зала</span>
        <div className="flex-1" />
        <button onClick={() => navigate('/pos2/order')} className="flex items-center gap-2 rounded-xl font-bold text-white shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.9rem,1.3vw,1.3rem)', boxShadow: '0 4px 12px rgba(216,90,48,0.3)' }}>
          <Plus style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)' }} />
          <span style={{ fontSize: 'var(--pv-ctl)' }}>Новый заказ</span>
        </button>
      </div>

      {/* Zones + tables */}
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'var(--pv-gap) var(--pv-pad-x) var(--pv-pad-x)' }}>
        {loading ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Загрузка зала…</div>
        ) : tables.length === 0 ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Столы не заведены</div>
        ) : byZone.map(group => (
          <div key={group.zone} style={{ marginBottom: 'clamp(1rem,1.8vw,1.75rem)' }}>
            <div className="font-semibold" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)', marginBottom: '0.7rem' }}>{group.zone}</div>
            <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(7rem,11vw,10rem), 1fr))' }}>
              {group.tables.map(t => {
                const st = STATUS[t.status] ?? STATUS.free
                const busy = !!t.currentOrderIds?.length
                return (
                  <button
                    key={t.id}
                    onClick={() => tap(t)}
                    className="flex flex-col items-center justify-center rounded-2xl active:scale-[0.97] transition-transform"
                    style={{ background: st.soft, border: `1px solid ${busy ? st.dot : 'transparent'}`, padding: 'clamp(0.9rem,1.5vw,1.4rem)', gap: '0.4rem', minHeight: 'clamp(6rem,9vw,8rem)' }}
                  >
                    <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.4rem,2.2vw,2rem)' }}>№{t.number}</span>
                    <div className="flex items-center gap-1.5">
                      <span className="rounded-full" style={{ width: '0.55rem', height: '0.55rem', background: st.dot }} />
                      <span className="font-semibold" style={{ color: st.text, fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{st.label}</span>
                    </div>
                    <div className="flex items-center gap-1" style={{ color: 'var(--pv-text-3)' }}>
                      <Users style={{ width: '0.85rem', height: '0.85rem' }} />
                      <span style={{ fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>{t.capacity}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
