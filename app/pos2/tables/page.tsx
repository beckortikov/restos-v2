'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, Users, Plus, CalendarPlus, Combine, Clock, Check, Ban, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import { useOrderData } from '@/components/order/use-order-data'
import { createReservation, fetchReservationForTable, updateReservationStatus, mergeTables, unmergeTables, createTable, updateTableData, deleteTable, createZone, updateZone, deleteZone, fetchOrders, cleanupStuckTables, ordersFromBoundary } from '@/lib/queries'
import { formatCurrency, formatCurrencyCompact, getTimeSince, calcOrderDisplayTotal } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { PosModal } from '@/components/pos-v2/pos-modal'
import type { Table, TableStatus, Reservation } from '@/lib/types'

const STATUS: Record<TableStatus, { soft: string; dot: string; text: string; label: string; border: string }> = {
  free: { soft: 'var(--pv-free-soft)', dot: 'var(--pv-free-dot)', text: 'var(--pv-free-text)', label: 'Свободен', border: 'var(--pv-free-border)' },
  occupied: { soft: 'var(--pv-occ-soft)', dot: 'var(--pv-occ-dot)', text: 'var(--pv-occ-text)', label: 'Занят', border: 'var(--pv-occ-border)' },
  reserved: { soft: 'var(--pv-res-soft)', dot: 'var(--pv-res-dot)', text: 'var(--pv-res-text)', label: 'Бронь', border: '#c9c0ef' },
  bill_requested: { soft: 'var(--pv-bill-soft)', dot: 'var(--pv-bill-dot)', text: 'var(--pv-bill-text)', label: 'Счёт', border: '#ead49c' },
}
type Mode = 'order' | 'reserve' | 'merge' | 'manage'
const pad = (n: number) => String(n).padStart(2, '0')

export default function PosV2Tables() {
  const navigate = useNavigate()
  const { user, canDo, canAccessRoles, restaurant } = useAuth()
  const { tables, zones, users, loading, reload } = useOrderData(true)
  const waiterById = useMemo(() => new Map((users ?? []).map(u => [u.id, u.name])), [users])
  const canManage = canDo('tables.edit') || canAccessRoles(['manager', 'owner'])
  // Гейт orders.view_others: официант видит только свободные + свои столы
  // (иначе утечка чужих столов и сумм). Копия старого table-map.
  const canViewOthers = canDo('orders.view_others')
  const visibleTables = useMemo(() => canViewOthers ? tables : tables.filter(t => t.status === 'free' || t.waiterId === user?.id), [tables, canViewOthers, user?.id])

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
  // Активная зона-таб на карте (иначе при многих зонах — длинная простыня).
  const [mapZone, setMapZone] = useState<string | null>(null)

  // Сумма открытого счёта по столам — для показа на плитке (карта зала была
  // информационно бедной: не видно, на сколько «висит» стол).
  const [tableTotals, setTableTotals] = useState<Map<string, number>>(new Map())
  useEffect(() => {
    let cancelled = false
    ordersFromBoundary().then(from => fetchOrders({ from, slim: true })).then(os => {
      if (cancelled) return
      const m = new Map<string, number>()
      for (const o of os) {
        if (!o.tableId || o.status === 'done' || o.status === 'cancelled') continue
        // calcOrderDisplayTotal = subtotal + обслуживание (для зала) — то же, что
        // считает сайдбар заказа. Раньше брали totalWithService ?? total: у
        // открытого заказа totalWithService не заполнен → падало на total БЕЗ
        // обслуживания, и сумма на плитке не совпадала с «Итого» в сайдбаре.
        m.set(o.tableId, (m.get(o.tableId) ?? 0) + calcOrderDisplayTotal(o, restaurant?.servicePercent))
      }
      setTableTotals(m)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [tables, restaurant?.servicePercent])

  // Самолечение залипших «оплачен-но-занят» столов при входе на карту (как
  // старый table-map). Без этого стол мог висеть занятым после оплаты.
  const cleanedRef = useRef(false)
  useEffect(() => {
    if (cleanedRef.current) return
    cleanedRef.current = true
    cleanupStuckTables().then(n => { if (n > 0) reload() }).catch(() => {})
  }, [reload])

  const byZone = useMemo(() => {
    const zoneName = (z: string) => zones.find(zz => zz.id === z)?.name ?? z ?? 'Зал'
    const map = new Map<string, Table[]>()
    for (const t of visibleTables) { const k = zoneName(t.zone); (map.get(k) ?? map.set(k, []).get(k)!).push(t) }
    return Array.from(map.entries()).map(([zone, ts]) => ({ zone, tables: [...ts].sort((a, b) => a.number - b.number) }))
  }, [visibleTables, zones])

  // Сводка сверху карты (по дизайну restos.pen): Свободно / Занято / Бронь /
  // Выручка (сумма открытых столов). Занятость — по наличию активных заказов.
  const stats = useMemo(() => {
    let free = 0, occ = 0, res = 0, revenue = 0
    for (const t of visibleTables) {
      const busy = !!t.currentOrderIds?.length
      if (busy) { occ++; revenue += tableTotals.get(t.id) ?? 0 }
      else if (t.status === 'reserved') res++
      else free++
    }
    return { free, occ, res, revenue }
  }, [visibleTables, tableTotals])

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
    // order mode → единый экран заказа (одно окно): свободный = новый заказ,
    // занятый = стол раскрывается в сайдбаре (группы + содержимое + оплата).
    if (t.status === 'reserved' && !(t.currentOrderIds?.length)) { setViewTable(t); setResInfo(null); fetchReservationForTable(t.id).then(setResInfo).catch(() => {}); return }
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

  const MODES: [Mode, string][] = [['order', 'Заказы'], ['reserve', 'Бронь'], ...(canManage ? [['manage', 'Управление'] as [Mode, string]] : [])]

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
          {mode === 'reserve' ? 'Нажмите свободный стол, чтобы забронировать.' : 'Нажмите стол, чтобы изменить или удалить. Кнопки сверху — добавить зону/стол.'}
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
        ) : (
          <>
            {/* Сводка (как в старом POS — БЕЗ выручки): Свободно / Занято / Бронь. */}
            {mode === 'order' && (
              <div className="grid grid-cols-3" style={{ gap: 'var(--pv-gap)', marginBottom: 'var(--pv-gap)' }}>
                {([['Свободно', stats.free, '#EAF7EF', '#1F6B3E'], ['Занято', stats.occ, '#FBEAE8', '#A0392C'], ['Бронь', stats.res, '#E9EFFB', '#2F4E9E']] as const).map(([lbl, val, bg, color]) => (
                  <div key={lbl} className="flex flex-col rounded-2xl" style={{ background: bg, padding: 'clamp(0.8rem,1.4vw,1.15rem) clamp(1rem,1.6vw,1.4rem)', gap: '0.1rem', boxShadow: '0 1px 6px rgba(0,0,0,0.05)' }}>
                    <span style={{ color, fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{lbl}</span>
                    <span className="font-bold" style={{ color, fontSize: 'clamp(1.5rem,2.6vw,2rem)' }}>{val}</span>
                  </div>
                ))}
              </div>
            )}
            {(() => {
              // Табы зон + «Все» (все столы из всех зон — как карта зала старого POS).
              const ALL = '__all__'
              const activeZone = (mapZone && (mapZone === ALL || byZone.some(g => g.zone === mapZone))) ? mapZone : ALL
              const allTables = byZone.flatMap(g => g.tables)
              const activeTables = activeZone === ALL ? allTables : (byZone.find(g => g.zone === activeZone)?.tables ?? [])
              return (
              <>
                {byZone.length > 1 && (
                  <div className="flex items-center overflow-x-auto shrink-0 pv-noscroll" style={{ gap: 'clamp(0.4rem,0.8vw,0.7rem)', marginBottom: 'clamp(0.8rem,1.4vw,1.2rem)' }}>
                    {[{ key: ALL, label: 'Все' }, ...byZone.map(g => ({ key: g.zone, label: g.zone }))].map(tab => { const on = tab.key === activeZone; return (
                      <button key={tab.key} onClick={() => setMapZone(tab.key)} className="rounded-full font-semibold whitespace-nowrap shrink-0 border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: 'clamp(0.45rem,0.7vw,0.65rem) clamp(0.9rem,1.4vw,1.4rem)', fontSize: 'var(--pv-ctl)' }}>{tab.label}</button>
                    ) })}
                  </div>
                )}
                <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(9rem,14vw,13rem), 1fr))' }}>
                  {activeTables.map(t => {
                    const st = STATUS[t.status] ?? STATUS.free
                    const busyTile = !!t.currentOrderIds?.length
                    const selForMerge = mergePrimary?.id === t.id
                    const groups = t.currentOrderIds?.length ?? 0
                    const since = busyTile && t.openedAt ? getTimeSince(t.openedAt) : null
                    const total = tableTotals.get(t.id)
                    const sumBig = total != null ? formatCurrencyCompact(total).replace(/\sс\.$/, '') : '—'
                    // Подпись стола — по имени (Диван N / Кабина N / Стол N), как в старом POS.
                    const tableLabel = t.name || `Стол ${t.number}`
                    const waiterName = t.waiterId ? waiterById.get(t.waiterId) : undefined
                    return (
                      <button key={t.id} onClick={() => tap(t)} disabled={busy} className="relative flex flex-col justify-between text-left active:scale-[0.98] transition-transform disabled:opacity-60" style={{ background: selForMerge ? 'var(--pv-brand)' : st.soft, border: `${selForMerge ? 2 : 1}px solid ${selForMerge ? 'var(--pv-brand)' : st.border}`, borderRadius: '16px', boxShadow: '0 2px 10px rgba(0,0,0,0.06)', padding: 'clamp(0.85rem,1.4vw,1.2rem)', minHeight: 'clamp(8rem,12vw,10.5rem)' }}>
                        {selForMerge ? (
                          <div className="flex-1 flex flex-col items-center justify-center" style={{ gap: '0.25rem' }}>
                            <span className="font-bold text-white" style={{ fontSize: 'clamp(1.4rem,2.2vw,2rem)' }}>№{t.number}</span>
                            <span className="font-semibold text-white" style={{ fontSize: 'var(--pv-ctl)' }}>Выбран</span>
                          </div>
                        ) : busyTile ? (
                          <>
                            <div className="flex items-center justify-between">
                              <div className="flex flex-col min-w-0">
                                <span className="font-bold truncate" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.05rem,1.5vw,1.35rem)' }}>{tableLabel}</span>
                                {waiterName && <span className="truncate" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.2rem)' }}>{waiterName}</span>}
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {t.mergedWith && <Combine style={{ width: '1rem', height: '1rem', color: 'var(--pv-text-3)' }} />}
                                {groups >= 2 && <span className="rounded-full font-bold flex items-center justify-center" style={{ background: 'var(--pv-brand)', color: '#fff', minWidth: '1.35rem', height: '1.35rem', fontSize: '0.7rem', padding: '0 0.35rem' }}>{groups}</span>}
                              </div>
                            </div>
                            <div className="flex items-end gap-1">
                              <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.6rem,2.8vw,2.3rem)', lineHeight: 1 }}>{sumBig}</span>
                              <span className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)', marginBottom: '0.15rem' }}>с.</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="flex items-center gap-1.5 font-semibold" style={{ color: st.text, fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}><span className="rounded-full" style={{ width: '0.5rem', height: '0.5rem', background: st.dot }} />{st.label}</span>
                              {since && <span className="flex items-center gap-0.5" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}><Clock style={{ width: '0.75rem', height: '0.75rem' }} />{since}</span>}
                            </div>
                          </>
                        ) : t.status === 'reserved' ? (
                          <>
                            <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.05rem,1.5vw,1.35rem)' }}>{tableLabel}</span>
                            <span className="flex items-center gap-1.5 font-semibold" style={{ color: st.text, fontSize: 'clamp(1.05rem,1.5vw,1.35rem)' }}><span className="rounded-full" style={{ width: '0.5rem', height: '0.5rem', background: st.dot }} />Бронь</span>
                            <div className="flex items-center gap-1" style={{ color: 'var(--pv-text-3)' }}><Users style={{ width: '0.9rem', height: '0.9rem' }} /><span style={{ fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{t.capacity} мест</span></div>
                          </>
                        ) : (
                          <>
                            <div className="flex flex-col" style={{ gap: '0.35rem' }}>
                              <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.05rem,1.5vw,1.35rem)' }}>{tableLabel}</span>
                              <span className="flex items-center gap-1.5 font-semibold" style={{ color: st.text, fontSize: 'var(--pv-ctl)' }}><span className="rounded-full" style={{ width: '0.5rem', height: '0.5rem', background: st.dot }} />{st.label}</span>
                            </div>
                            <div className="flex items-center gap-1" style={{ color: 'var(--pv-text-3)' }}><Users style={{ width: '0.9rem', height: '0.9rem' }} /><span style={{ fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{t.capacity} мест</span></div>
                          </>
                        )}
                      </button>
                    )
                  })}
                </div>
              </>
              )
            })()}
          </>
        )}
      </div>

      {/* Reservation form */}
      {resTable && (
        <PosModal open onClose={() => { if (!busy) setResTable(null) }} dismissable={!busy} width="clamp(22rem,44vw,34rem)" title={`Бронь · Стол ${resTable.number}`}>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.85rem' }}>
              <input aria-label="Имя гостя *" autoFocus value={rName} onChange={e => setRName(e.target.value)} placeholder="Имя гостя *" className="rounded-xl border bg-transparent outline-none font-semibold" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
              <input aria-label="Телефон" value={rPhone} onChange={e => setRPhone(e.target.value.replace(/[^\d+]/g, ''))} inputMode="tel" placeholder="Телефон" className="rounded-xl border bg-transparent outline-none" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
              <div className="flex items-center justify-between">
                <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Гостей</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setRGuests(g => Math.max(1, g - 1))} className="rounded-lg flex items-center justify-center font-bold" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.1rem', height: '2.1rem', color: 'var(--pv-text-2)' }}>−</button>
                  <span className="text-center font-bold" style={{ color: 'var(--pv-text)', width: '2rem', fontSize: 'var(--pv-ctl)' }}>{rGuests}</span>
                  <button onClick={() => setRGuests(g => Math.min(30, g + 1))} className="rounded-lg flex items-center justify-center font-bold" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2.1rem', height: '2.1rem', color: 'var(--pv-text-2)' }}>+</button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input aria-label="Дата брони" type="date" value={rDate} onChange={e => setRDate(e.target.value)} className="flex-1 min-w-0 rounded-xl border bg-transparent outline-none" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
                <input aria-label="Время брони" type="time" value={rTime} onChange={e => setRTime(e.target.value)} className="rounded-xl border bg-transparent outline-none" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
              </div>
              <div className="flex items-center gap-2">
                {[60, 90, 120, 180].map(d => { const on = rDur === d; return <button key={d} onClick={() => setRDur(d)} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.35rem 0.8rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{d} мин</button> })}
              </div>
              <input aria-label="Комментарий" value={rNote} onChange={e => setRNote(e.target.value)} placeholder="Комментарий" className="rounded-xl border bg-transparent outline-none" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
              <button disabled={busy} onClick={submitReservation} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                <CalendarPlus style={{ width: '1.3em', height: '1.3em' }} />Забронировать
              </button>
            </div>
        </PosModal>
      )}

      {/* Reservation view */}
      {viewTable && (
        <PosModal open onClose={() => { if (!busy) setViewTable(null) }} dismissable={!busy} width="clamp(20rem,42vw,32rem)" title={`Бронь · Стол ${viewTable.number}`}>
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
        </PosModal>
      )}

      {/* Table create/edit form */}
      {tf && (
        <PosModal open onClose={() => { if (!busy) setTf(null) }} dismissable={!busy} width="clamp(20rem,42vw,32rem)" title={tf.id ? `Стол ${tf.number}` : 'Новый стол'}>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.85rem' }}>
              <input aria-label="Название стола" autoFocus value={tf.name} onChange={e => setTf(v => v && { ...v, name: e.target.value })} placeholder={`Название (по умолч. «Стол ${tf.number}»)`} className="rounded-xl border bg-transparent outline-none font-semibold" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
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
        </PosModal>
      )}

      {/* Zone create/edit form */}
      {zf && (
        <PosModal open onClose={() => { if (!busy) setZf(null) }} dismissable={!busy} width="clamp(18rem,36vw,26rem)" title={zf.id ? 'Изменить зону' : 'Новая зона'}>
            <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.85rem' }}>
              <input aria-label="Название зоны *" autoFocus value={zf.name} onChange={e => setZf(v => v && { ...v, name: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') saveZone() }} placeholder="Название зоны *" className="rounded-xl border bg-transparent outline-none font-semibold" style={{ borderColor: 'var(--pv-border)', color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', padding: '0.7rem 1rem' }} />
              <button disabled={busy} onClick={saveZone} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                <Check style={{ width: '1.3em', height: '1.3em' }} />{zf.id ? 'Сохранить' : 'Создать зону'}
              </button>
            </div>
        </PosModal>
      )}
    </div>
  )
}
