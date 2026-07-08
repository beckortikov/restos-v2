'use client'

import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, Users, Plus, CalendarPlus, Combine, X, Clock, Check, Ban, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import { useOrderData } from '@/components/order/use-order-data'
import { createReservation, fetchReservationForTable, updateReservationStatus, mergeTables, unmergeTables, createTable, updateTableData, deleteTable, createZone, updateZone, deleteZone } from '@/lib/queries'
import { humanizeError } from '@/lib/errors'
import type { Table, TableStatus, Reservation } from '@/lib/types'

const STATUS: Record<TableStatus, { soft: string; dot: string; text: string; label: string }> = {
  free: { soft: 'var(--pv-free-soft)', dot: 'var(--pv-free-dot)', text: 'var(--pv-free-text)', label: 'Свободен' },
  occupied: { soft: 'var(--pv-occ-soft)', dot: 'var(--pv-occ-dot)', text: 'var(--pv-occ-text)', label: 'Занят' },
  reserved: { soft: 'var(--pv-res-soft)', dot: 'var(--pv-res-dot)', text: 'var(--pv-res-text)', label: 'Бронь' },
  bill_requested: { soft: 'var(--pv-bill-soft)', dot: 'var(--pv-bill-dot)', text: 'var(--pv-bill-text)', label: 'Счёт' },
}
type Mode = 'order' | 'reserve' | 'merge' | 'manage'
const pad = (n: number) => String(n).padStart(2, '0')

export default function PosV2Tables() {
  const navigate = useNavigate()
  const { user, canDo, canAccessRoles } = useAuth()
  const { tables, zones, loading, reload } = useOrderData(true)
  const canManage = canDo('tables.edit') || canAccessRoles(['manager', 'owner'])

  const [mode, setMode] = useState<Mode>('order')
  const [mergePrimary, setMergePrimary] = useState<Table | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  // Manage forms (table / zone CRUD)
  const [tf, setTf] = useState<{ id?: string; name: string; number: number; capacity: number; zoneId: string } | null>(null)
  const [zf, setZf] = useState<{ id?: string; name: string } | null>(null)

  // Reservation form
  const [resTable, setResTable] = useState<Table | null>(null)
  const [rName, setRName] = useState('')
  const [rPhone, setRPhone] = useState('')
  const [rGuests, setRGuests] = useState(2)
  const [rDate, setRDate] = useState('')
  const [rTime, setRTime] = useState('')
  const [rDur, setRDur] = useState(120)
  const [rNote, setRNote] = useState('')
  // Reservation view
  const [viewTable, setViewTable] = useState<Table | null>(null)
  const [resInfo, setResInfo] = useState<Reservation | null>(null)

  const byZone = useMemo(() => {
    const zoneName = (z: string) => zones.find(zz => zz.id === z)?.name ?? z ?? 'Зал'
    const map = new Map<string, Table[]>()
    for (const t of tables) { const k = zoneName(t.zone); (map.get(k) ?? map.set(k, []).get(k)!).push(t) }
    return Array.from(map.entries()).map(([zone, ts]) => ({ zone, tables: [...ts].sort((a, b) => a.number - b.number) }))
  }, [tables, zones])

  function openReserveForm(t: Table) {
    const d = new Date(Date.now() + 3600_000)
    setResTable(t); setRName(''); setRPhone(''); setRGuests(Math.min(t.capacity, 2)); setRDur(120); setRNote('')
    setRDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    setRTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`)
  }

  function openTableCreate() {
    if (zones.length === 0) { toast.error('Сначала создайте зону'); return }
    const maxN = tables.reduce((m, t) => Math.max(m, t.number), 0)
    setTf({ name: '', number: maxN + 1, capacity: 4, zoneId: zones[0].id })
  }

  async function saveTable() {
    if (busyRef.current || !tf) return
    if (!tf.zoneId) { toast.error('Выберите зону'); return }
    if (!(tf.number > 0)) { toast.error('Номер стола должен быть больше 0'); return }
    busyRef.current = true; setBusy(true)
    try {
      const name = tf.name.trim() || `Стол ${tf.number}`
      if (tf.id) await updateTableData(tf.id, { name, capacity: tf.capacity, zone_id: tf.zoneId })
      else await createTable({ name, number: tf.number, capacity: tf.capacity, zone_id: tf.zoneId })
      toast.success(tf.id ? 'Стол сохранён' : `Стол ${tf.number} создан`)
      setTf(null); await reload()
    } catch (e) { toast.error(humanizeError(e)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function removeTable() {
    if (busyRef.current || !tf?.id) return
    if (!confirm(`Удалить стол ${tf.number}?`)) return
    busyRef.current = true; setBusy(true)
    try { await deleteTable(tf.id); toast.success('Стол удалён'); setTf(null); await reload() }
    catch (e) { toast.error(humanizeError(e)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function saveZone() {
    if (busyRef.current || !zf) return
    const name = zf.name.trim()
    if (!name) { toast.error('Укажите название зоны'); return }
    busyRef.current = true; setBusy(true)
    try {
      if (zf.id) await updateZone(zf.id, name); else await createZone(name)
      toast.success(zf.id ? 'Зона сохранена' : `Зона «${name}» создана`)
      setZf(null); await reload()
    } catch (e) { toast.error(humanizeError(e)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function removeZone(id: string, name: string) {
    if (busyRef.current) return
    if (!confirm(`Удалить зону «${name}»? Столы в ней должны быть перемещены или удалены.`)) return
    busyRef.current = true; setBusy(true)
    try { await deleteZone(id); toast.success('Зона удалена'); await reload() }
    catch (e) { toast.error(humanizeError(e)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function tap(t: Table) {
    if (mode === 'manage') {
      setTf({ id: t.id, name: t.name ?? `Стол ${t.number}`, number: t.number, capacity: t.capacity, zoneId: t.zone })
      return
    }
    if (mode === 'merge') {
      if (busyRef.current) return
      if (t.mergedWith) { busyRef.current = true; setBusy(true); try { await unmergeTables(t.mergedWith); toast.success('Столы разъединены'); await reload() } catch (e) { toast.error(humanizeError(e)) } finally { busyRef.current = false; setBusy(false) }; return }
      if (!mergePrimary) { setMergePrimary(t); return }
      if (mergePrimary.id === t.id) { setMergePrimary(null); return }
      busyRef.current = true; setBusy(true)
      try { await mergeTables(mergePrimary.id, t.id); toast.success(`Столы ${mergePrimary.number}+${t.number} объединены`); setMergePrimary(null); await reload() }
      catch (e) { toast.error(humanizeError(e)) } finally { busyRef.current = false; setBusy(false) }
      return
    }
    if (mode === 'reserve') { if (t.status === 'free') openReserveForm(t); else toast.error('Бронь — только на свободный стол'); return }
    // order mode
    const open = t.currentOrderIds?.[0]
    if (open) { navigate(`/pos2/ticket?order=${encodeURIComponent(open)}`); return }
    if (t.status === 'reserved') { setViewTable(t); setResInfo(null); fetchReservationForTable(t.id).then(setResInfo).catch(() => {}); return }
    navigate(`/pos2/order?table=${encodeURIComponent(t.id)}`)
  }

  async function submitReservation() {
    if (busyRef.current || !resTable) return
    if (!rName.trim()) { toast.error('Укажите имя гостя'); return }
    if (!rDate || !rTime) { toast.error('Укажите дату и время'); return }
    busyRef.current = true; setBusy(true)
    try {
      await createReservation({ tableId: resTable.id, guestName: rName.trim(), guestPhone: rPhone.trim() || undefined, guestsCount: rGuests, reservedAt: new Date(`${rDate}T${rTime}`).toISOString(), durationMin: rDur, note: rNote.trim() || undefined, createdBy: user?.id })
      toast.success(`Бронь · Стол ${resTable.number} · ${rName.trim()}`)
      setResTable(null); await reload()
    } catch (e) { toast.error(`Не удалось забронировать: ${humanizeError(e)}`) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function resAction(status: 'seated' | 'cancelled' | 'no_show') {
    if (busyRef.current || !viewTable || !resInfo) return
    busyRef.current = true; setBusy(true)
    try {
      await updateReservationStatus(resInfo.id, status, viewTable.id)
      if (status === 'seated') { setViewTable(null); navigate(`/pos2/order?table=${encodeURIComponent(viewTable.id)}`); return }
      toast.success(status === 'cancelled' ? 'Бронь отменена' : 'Отмечено «не пришёл»')
      setViewTable(null); await reload()
    } catch (e) { toast.error(humanizeError(e)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  const MODES: [Mode, string][] = [['order', 'Заказы'], ['reserve', 'Бронь'], ['merge', 'Объединить'], ...(canManage ? [['manage', 'Управление'] as [Mode, string]] : [])]

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>Карта зала</span>
        <div className="flex items-center rounded-2xl border shrink-0" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: '4px', gap: '4px', marginLeft: '0.5rem' }}>
          {MODES.map(([m, l]) => {
            const on = mode === m
            return <button key={m} onClick={() => { setMode(m); setMergePrimary(null) }} className="rounded-xl font-semibold whitespace-nowrap" style={{ background: on ? 'var(--pv-brand)' : 'transparent', color: on ? '#fff' : 'var(--pv-text-2)', padding: 'clamp(0.5rem,0.8vw,0.75rem) clamp(0.8rem,1.2vw,1.3rem)', fontSize: 'var(--pv-ctl)' }}>{l}</button>
          })}
        </div>
        <div className="flex-1" />
        {mode === 'order' && (
          <button onClick={() => navigate('/pos2/order')} className="flex items-center gap-2 rounded-xl font-bold text-white shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.9rem,1.3vw,1.3rem)', boxShadow: '0 4px 12px rgba(216,90,48,0.3)' }}>
            <Plus style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)' }} /><span style={{ fontSize: 'var(--pv-ctl)' }}>Новый заказ</span>
          </button>
        )}
        {mode === 'manage' && (
          <div className="flex items-center shrink-0" style={{ gap: '0.5rem' }}>
            <button onClick={() => setZf({ name: '' })} className="flex items-center gap-2 rounded-xl border font-semibold shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', color: 'var(--pv-text-2)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.9rem,1.3vw,1.2rem)' }}>
              <Plus style={{ width: 'clamp(1rem,1.3vw,1.3rem)', height: 'clamp(1rem,1.3vw,1.3rem)' }} /><span style={{ fontSize: 'var(--pv-ctl)' }}>Зона</span>
            </button>
            <button onClick={openTableCreate} className="flex items-center gap-2 rounded-xl font-bold text-white shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.9rem,1.3vw,1.3rem)', boxShadow: '0 4px 12px rgba(216,90,48,0.3)' }}>
              <Plus style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)' }} /><span style={{ fontSize: 'var(--pv-ctl)' }}>Стол</span>
            </button>
          </div>
        )}
      </div>

      {mode !== 'order' && (
        <div className="shrink-0" style={{ padding: '0.5rem var(--pv-pad-x) 0', color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>
          {mode === 'reserve' ? 'Нажмите свободный стол, чтобы забронировать.' : mode === 'manage' ? 'Нажмите стол, чтобы изменить или удалить. Кнопки сверху — добавить зону/стол.' : mergePrimary ? `Выбран стол ${mergePrimary.number} — нажмите второй для объединения. Объединённый стол — нажать для разъединения.` : 'Нажмите два стола для объединения (или объединённый — для разъединения).'}
        </div>
      )}

      {mode === 'manage' && zones.length > 0 && (
        <div className="shrink-0 flex items-center flex-wrap" style={{ gap: '0.5rem', padding: '0.6rem var(--pv-pad-x) 0' }}>
          {zones.map(z => (
            <div key={z.id} className="flex items-center rounded-full border" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: '0.3rem 0.4rem 0.3rem 0.9rem', gap: '0.35rem' }}>
              <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{z.name}</span>
              <button onClick={() => setZf({ id: z.id, name: z.name })} className="rounded-full active:scale-90 transition-transform" style={{ padding: '0.3rem' }}><Pencil style={{ width: '0.95rem', height: '0.95rem', color: 'var(--pv-text-3)' }} /></button>
              <button onClick={() => removeZone(z.id, z.name)} disabled={busy} className="rounded-full active:scale-90 transition-transform" style={{ padding: '0.3rem' }}><Trash2 style={{ width: '0.95rem', height: '0.95rem', color: 'var(--pv-occ-text)' }} /></button>
            </div>
          ))}
        </div>
      )}

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
                const busyTile = !!t.currentOrderIds?.length
                const selForMerge = mergePrimary?.id === t.id
                return (
                  <button key={t.id} onClick={() => tap(t)} disabled={busy} className="relative flex flex-col items-center justify-center rounded-2xl active:scale-[0.97] transition-transform disabled:opacity-60" style={{ background: selForMerge ? 'var(--pv-brand)' : st.soft, border: `${selForMerge || busyTile ? 2 : 1}px solid ${selForMerge ? 'var(--pv-brand)' : busyTile ? st.dot : 'transparent'}`, padding: 'clamp(0.9rem,1.5vw,1.4rem)', gap: '0.4rem', minHeight: 'clamp(6rem,9vw,8rem)' }}>
                    {t.mergedWith && <span className="absolute" style={{ top: '0.4rem', right: '0.4rem' }}><Combine style={{ width: '0.95rem', height: '0.95rem', color: 'var(--pv-text-3)' }} /></span>}
                    <span className="font-bold" style={{ color: selForMerge ? '#fff' : 'var(--pv-text)', fontSize: 'clamp(1.4rem,2.2vw,2rem)' }}>№{t.number}</span>
                    <div className="flex items-center gap-1.5">
                      <span className="rounded-full" style={{ width: '0.55rem', height: '0.55rem', background: selForMerge ? '#fff' : st.dot }} />
                      <span className="font-semibold" style={{ color: selForMerge ? '#fff' : st.text, fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{selForMerge ? 'Выбран' : st.label}</span>
                    </div>
                    <div className="flex items-center gap-1" style={{ color: selForMerge ? 'rgba(255,255,255,0.8)' : 'var(--pv-text-3)' }}>
                      <Users style={{ width: '0.85rem', height: '0.85rem' }} /><span style={{ fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>{t.capacity}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Reservation form */}
      {resTable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => { if (!busy) setResTable(null) }}>
          <div className="rounded-3xl overflow-hidden" style={{ background: 'var(--pv-card)', width: 'clamp(22rem,44vw,34rem)', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.35rem)', color: 'var(--pv-text)' }}>Бронь · Стол {resTable.number}</span>
              <button onClick={() => { if (!busy) setResTable(null) }} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.85rem' }}>
              <input autoFocus value={rName} onChange={e => setRName(e.target.value)} placeholder="Имя гостя *" className="rounded-xl border bg-transparent outline-none font-semibold" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
              <input value={rPhone} onChange={e => setRPhone(e.target.value.replace(/[^\d+]/g, ''))} inputMode="tel" placeholder="Телефон" className="rounded-xl border bg-transparent outline-none" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
              <div className="flex items-center justify-between">
                <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Гостей</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setRGuests(g => Math.max(1, g - 1))} className="rounded-lg flex items-center justify-center font-bold" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.1rem', height: '2.1rem', color: 'var(--pv-text-2)' }}>−</button>
                  <span className="text-center font-bold" style={{ color: 'var(--pv-text)', width: '2rem', fontSize: 'var(--pv-ctl)' }}>{rGuests}</span>
                  <button onClick={() => setRGuests(g => Math.min(30, g + 1))} className="rounded-lg flex items-center justify-center font-bold" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.1rem', height: '2.1rem', color: 'var(--pv-text-2)' }}>+</button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input type="date" value={rDate} onChange={e => setRDate(e.target.value)} className="flex-1 min-w-0 rounded-xl border bg-transparent outline-none" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
                <input type="time" value={rTime} onChange={e => setRTime(e.target.value)} className="rounded-xl border bg-transparent outline-none" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
              </div>
              <div className="flex items-center gap-2">
                {[60, 90, 120, 180].map(d => { const on = rDur === d; return <button key={d} onClick={() => setRDur(d)} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.35rem 0.8rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{d} мин</button> })}
              </div>
              <input value={rNote} onChange={e => setRNote(e.target.value)} placeholder="Комментарий" className="rounded-xl border bg-transparent outline-none" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
              <button disabled={busy} onClick={submitReservation} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                <CalendarPlus style={{ width: '1.3em', height: '1.3em' }} />Забронировать
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reservation view */}
      {viewTable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => { if (!busy) setViewTable(null) }}>
          <div className="rounded-3xl overflow-hidden" style={{ background: 'var(--pv-card)', width: 'clamp(20rem,42vw,32rem)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.35rem)', color: 'var(--pv-text)' }}>Бронь · Стол {viewTable.number}</span>
              <button onClick={() => { if (!busy) setViewTable(null) }} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.8rem' }}>
              {!resInfo ? (
                <div style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>Загрузка брони…</div>
              ) : (
                <>
                  <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.1rem,1.5vw,1.35rem)' }}>{resInfo.guestName}</div>
                  <div className="flex items-center gap-2" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}><Clock style={{ width: '1.05rem', height: '1.05rem' }} />{new Date(resInfo.reservedAt).toLocaleString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · {resInfo.durationMin ?? 120} мин</div>
                  <div className="flex items-center gap-2" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}><Users style={{ width: '1.05rem', height: '1.05rem' }} />{resInfo.guestsCount} гостей{resInfo.guestPhone ? ` · ${resInfo.guestPhone}` : ''}</div>
                  {resInfo.note && <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{resInfo.note}</div>}
                </>
              )}
              <div className="flex items-center gap-2" style={{ marginTop: '0.4rem' }}>
                <button disabled={busy || !resInfo} onClick={() => resAction('seated')} className="flex-1 flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.8rem,1.2vw,1.1rem)', fontSize: 'var(--pv-ctl)' }}><Check style={{ width: '1.2em', height: '1.2em' }} />Гость пришёл</button>
                <button disabled={busy || !resInfo} onClick={() => resAction('no_show')} className="flex items-center justify-center gap-2 rounded-2xl font-semibold disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-bg)', color: 'var(--pv-text-2)', padding: 'clamp(0.8rem,1.2vw,1.1rem) clamp(0.9rem,1.3vw,1.2rem)', fontSize: 'var(--pv-ctl)' }}>Не пришёл</button>
                <button disabled={busy || !resInfo} onClick={() => resAction('cancelled')} className="flex items-center justify-center gap-2 rounded-2xl font-semibold disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-occ-soft)', color: 'var(--pv-occ-text)', padding: 'clamp(0.8rem,1.2vw,1.1rem) clamp(0.9rem,1.3vw,1.2rem)', fontSize: 'var(--pv-ctl)' }}><Ban style={{ width: '1.2em', height: '1.2em' }} /></button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Table create/edit form */}
      {tf && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => { if (!busy) setTf(null) }}>
          <div className="rounded-3xl overflow-hidden" style={{ background: 'var(--pv-card)', width: 'clamp(20rem,42vw,32rem)', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.35rem)', color: 'var(--pv-text)' }}>{tf.id ? `Стол ${tf.number}` : 'Новый стол'}</span>
              <button onClick={() => { if (!busy) setTf(null) }} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.85rem' }}>
              <input autoFocus value={tf.name} onChange={e => setTf(v => v && { ...v, name: e.target.value })} placeholder={`Название (по умолч. «Стол ${tf.number}»)`} className="rounded-xl border bg-transparent outline-none font-semibold" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
              {!tf.id && (
                <div className="flex items-center justify-between">
                  <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Номер стола</span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setTf(v => v && { ...v, number: Math.max(1, v.number - 1) })} className="rounded-lg flex items-center justify-center font-bold" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.1rem', height: '2.1rem', color: 'var(--pv-text-2)' }}>−</button>
                    <span className="text-center font-bold" style={{ color: 'var(--pv-text)', width: '2.5rem', fontSize: 'var(--pv-ctl)' }}>{tf.number}</span>
                    <button onClick={() => setTf(v => v && { ...v, number: v.number + 1 })} className="rounded-lg flex items-center justify-center font-bold" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.1rem', height: '2.1rem', color: 'var(--pv-text-2)' }}>+</button>
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Вместимость</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setTf(v => v && { ...v, capacity: Math.max(1, v.capacity - 1) })} className="rounded-lg flex items-center justify-center font-bold" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.1rem', height: '2.1rem', color: 'var(--pv-text-2)' }}>−</button>
                  <span className="text-center font-bold" style={{ color: 'var(--pv-text)', width: '2.5rem', fontSize: 'var(--pv-ctl)' }}>{tf.capacity}</span>
                  <button onClick={() => setTf(v => v && { ...v, capacity: Math.min(50, v.capacity + 1) })} className="rounded-lg flex items-center justify-center font-bold" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.1rem', height: '2.1rem', color: 'var(--pv-text-2)' }}>+</button>
                </div>
              </div>
              <div className="flex flex-col" style={{ gap: '0.45rem' }}>
                <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Зона</span>
                <div className="flex items-center flex-wrap" style={{ gap: '0.4rem' }}>
                  {zones.map(z => { const on = tf.zoneId === z.id; return (
                    <button key={z.id} onClick={() => setTf(v => v && { ...v, zoneId: z.id })} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.4rem 0.9rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{z.name}</button>
                  ) })}
                </div>
              </div>
              <button disabled={busy} onClick={saveTable} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                <Check style={{ width: '1.3em', height: '1.3em' }} />{tf.id ? 'Сохранить' : 'Создать стол'}
              </button>
              {tf.id && (
                <button disabled={busy} onClick={removeTable} className="w-full flex items-center justify-center gap-2 rounded-2xl font-semibold disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-occ-soft)', color: 'var(--pv-occ-text)', padding: 'clamp(0.75rem,1.1vw,1rem)', fontSize: 'var(--pv-ctl)' }}>
                  <Trash2 style={{ width: '1.2em', height: '1.2em' }} />Удалить стол
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Zone create/edit form */}
      {zf && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => { if (!busy) setZf(null) }}>
          <div className="rounded-3xl overflow-hidden" style={{ background: 'var(--pv-card)', width: 'clamp(18rem,36vw,26rem)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.35rem)', color: 'var(--pv-text)' }}>{zf.id ? 'Изменить зону' : 'Новая зона'}</span>
              <button onClick={() => { if (!busy) setZf(null) }} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.85rem' }}>
              <input autoFocus value={zf.name} onChange={e => setZf(v => v && { ...v, name: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') saveZone() }} placeholder="Название зоны *" className="rounded-xl border bg-transparent outline-none font-semibold" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
              <button disabled={busy} onClick={saveZone} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                <Check style={{ width: '1.3em', height: '1.3em' }} />{zf.id ? 'Сохранить' : 'Создать зону'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
