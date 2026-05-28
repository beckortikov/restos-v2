'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import {
  fetchMenuItems, fetchBatchCookingLogs, calculateMaxPortions, produceBatch, writeoffPreparedBatch,
} from '@/lib/queries'

import type { MenuItem, BatchCookingLog, BatchPortionCalc, MenuStation } from '@/lib/types'
import { ALL_STATIONS, STATION_LABELS } from '@/lib/types'
import {
  CookingPot, Loader2, Search, AlertTriangle, CheckCircle2, ChefHat,
  Flame, Clock, Package, Trash2, TrendingUp, BookOpen, X, ChevronDown, ChevronRight,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatCurrency } from '@/lib/helpers'

const STATION_ICONS: Record<string, string> = {
  hot_kitchen: '🔥', cold_kitchen: '❄️', grill: '🥩', bar: '🍹', showcase: '🧁',
}

type HistoryFilter = 'today' | 'week' | 'all'

export default function BatchCookingPage() {
  const { canDo } = useAuth()
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [logs, setLogs] = useState<BatchCookingLog[]>([])
  const [stationFilter, setStationFilter] = useState<MenuStation | 'all'>('all')
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('today')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  // Production state
  const [producingId, setProducingId] = useState<string | null>(null)
  const [portionCalc, setPortionCalc] = useState<BatchPortionCalc | null>(null)
  const [qty, setQty] = useState(0)
  const [calcLoading, setCalcLoading] = useState(false)
  const [producing, setProducing] = useState(false)

  // Writeoff state
  const [writeoffId, setWriteoffId] = useState<string | null>(null)
  const [writeoffQty, setWriteoffQty] = useState(1)
  const [writeoffReason, setWriteoffReason] = useState('')
  const [writingOff, setWritingOff] = useState(false)

  // Details view
  const [detailsId, setDetailsId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [items, logsData] = await Promise.all([
        fetchMenuItems(),
        fetchBatchCookingLogs(),
      ])
      setMenuItems(items.filter(i => i.isBatchCooking))
      setLogs(logsData)
    } catch { toast.error('Ошибка загрузки') }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Poll every 30s ONLY in local mode (Desktop app / Local DB)
  useEffect(() => {
    let isLocal = false
    try { isLocal = localStorage.getItem('restos-sync-mode') === 'local' } catch {}
    
    if (isLocal) {
      const interval = setInterval(() => load(), 2000)
      return () => clearInterval(interval)
    }
  }, [load])

  const handleStartProduce = async (itemId: string) => {
    setProducingId(itemId)
    setCalcLoading(true)
    setPortionCalc(null)
    setQty(0)
    try {
      const calc = await calculateMaxPortions(itemId)
      setPortionCalc(calc)
      // If no tech card or no ingredients — start with 1 (manual mode)
      if (calc.ingredients.length === 0) {
        setQty(1)
      } else {
        setQty(calc.maxPortions > 0 ? 1 : 0)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка расчёта')
      setProducingId(null)
    }
    setCalcLoading(false)
  }

  const handleProduce = async () => {
    if (!producingId || qty <= 0) return
    setProducing(true)
    try {
      await produceBatch(producingId, qty)
      toast.success(`Приготовлено: ${qty} порц.`)
      setProducingId(null)
      setPortionCalc(null)
      setQty(0)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ошибка')
    }
    setProducing(false)
  }

  const handleWriteoff = async () => {
    if (!writeoffId || writeoffQty <= 0) return
    setWritingOff(true)
    try {
      await writeoffPreparedBatch(writeoffId, writeoffQty, writeoffReason || 'Списание')
      toast.success(`Списано: ${writeoffQty} порц.`)
      setWriteoffId(null)
      setWriteoffQty(1)
      setWriteoffReason('')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ошибка')
    }
    setWritingOff(false)
  }

  // Классификация запаса порций по порогу (настраивается в карточке блюда).
  // Возвращает 0 для "пусто", 1 для "заканчивается", 2 для "норм" — удобно для сортировки.
  const classifyStock = useCallback((item: MenuItem): 0 | 1 | 2 => {
    const qty = item.preparedQty || 0
    if (qty === 0) return 0
    const threshold = item.lowStockThreshold ?? 5
    if (qty <= threshold) return 1
    return 2
  }, [])

  const filtered = useMemo(() => {
    const list = menuItems.filter(i => {
      if (stationFilter !== 'all' && i.station !== stationFilter) return false
      if (search && !i.name.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
    // Приоритет: пустые → заканчивается → норм; внутри групп по имени.
    return list.slice().sort((a, b) => {
      const d = classifyStock(a) - classifyStock(b)
      if (d !== 0) return d
      return a.name.localeCompare(b.name, 'ru')
    })
  }, [menuItems, stationFilter, search, classifyStock])

  // Группировка по станциям — показывается когда выбран фильтр "Все".
  // Каждая секция содержит свой отсортированный список + сводку "N блюд · K закончились".
  const groupedByStation = useMemo(() => {
    const groups: { station: MenuStation; items: MenuItem[]; emptyCount: number; lowCount: number }[] = []
    for (const st of ALL_STATIONS) {
      const items = filtered.filter(i => i.station === st)
      if (items.length === 0) continue
      const emptyCount = items.filter(i => classifyStock(i) === 0).length
      const lowCount = items.filter(i => classifyStock(i) === 1).length
      groups.push({ station: st, items, emptyCount, lowCount })
    }
    // Сначала те, где есть закончившиеся блюда — повар должен их увидеть сразу.
    return groups.sort((a, b) => (b.emptyCount - a.emptyCount) || (b.lowCount - a.lowCount))
  }, [filtered, classifyStock])

  // Свёрнутые секции (хранится в state). По умолчанию все раскрыты.
  const [collapsedStations, setCollapsedStations] = useState<Set<MenuStation>>(new Set())
  const toggleStation = useCallback((st: MenuStation) => {
    setCollapsedStations(prev => {
      const next = new Set(prev)
      if (next.has(st)) next.delete(st); else next.add(st)
      return next
    })
  }, [])

  // Stats: today's prepared, used, remaining
  const stats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    const todayLogs = logs.filter(l => l.createdAt.slice(0, 10) === today)
    const producedToday = todayLogs.filter(l => l.qty > 0).reduce((s, l) => s + l.qty, 0)
    const writtenOffToday = todayLogs.filter(l => l.qty < 0).reduce((s, l) => s + Math.abs(l.qty), 0)
    const totalReady = menuItems.reduce((s, i) => s + (i.preparedQty || 0), 0)
    const lowStock = menuItems.filter(i => classifyStock(i) === 1).length
    const empty = menuItems.filter(i => classifyStock(i) === 0).length
    return { producedToday, writtenOffToday, totalReady, lowStock, empty }
  }, [logs, menuItems, classifyStock])

  // Filtered history
  const filteredLogs = useMemo(() => {
    if (historyFilter === 'all') return logs
    const now = Date.now()
    const cutoff = historyFilter === 'today'
      ? new Date(new Date().setHours(0, 0, 0, 0)).getTime()
      : now - 7 * 24 * 60 * 60 * 1000
    return logs.filter(l => new Date(l.createdAt).getTime() >= cutoff)
  }, [logs, historyFilter])

  if (!canDo('batch_cooking.manage')) {
    return <div className="p-6 flex items-center justify-center h-64"><p className="text-muted-foreground">Нет доступа</p></div>
  }

  if (loading) {
    return <div className="p-6 flex items-center justify-center h-64"><Loader2 className="size-8 animate-spin text-primary" /></div>
  }

  const producingItem = menuItems.find(i => i.id === producingId)
  const writeoffItem = menuItems.find(i => i.id === writeoffId)

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <CookingPot className="size-6 text-primary" />Приготовление
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">Подготовка блюд партиями — ингредиенты списываются сразу</p>
        </div>
      </div>

      {menuItems.length === 0 ? (
        <div className="bg-card rounded-2xl border border-border p-12 text-center">
          <CookingPot className="size-12 text-muted-foreground mx-auto mb-3 opacity-50" />
          <h3 className="font-semibold text-foreground mb-1">Нет заготовочных блюд</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Включите режим &quot;Заготовочное блюдо&quot; в меню для нужных позиций
          </p>
          <Link to="/warehouse/menu" className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90">
            <BookOpen className="size-4" />
            Перейти в меню
          </Link>
        </div>
      ) : (
        <>
          {/* Stats cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-card rounded-xl border border-border p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <TrendingUp className="size-4" />Приготовлено сегодня
              </div>
              <p className="text-2xl font-bold text-foreground">{stats.producedToday}<span className="text-sm text-muted-foreground font-normal ml-1">порц.</span></p>
            </div>
            <div className="bg-card rounded-xl border border-border p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Package className="size-4" />Готово на складе
              </div>
              <p className="text-2xl font-bold text-emerald-600">{stats.totalReady}<span className="text-sm text-muted-foreground font-normal ml-1">порц.</span></p>
            </div>
            <div className="bg-card rounded-xl border border-border p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <AlertTriangle className="size-4" />Заканчивается
              </div>
              <p className="text-2xl font-bold text-amber-600">{stats.lowStock}<span className="text-sm text-muted-foreground font-normal ml-1">блюд</span></p>
            </div>
            <div className="bg-card rounded-xl border border-border p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Trash2 className="size-4" />Списано сегодня
              </div>
              <p className="text-2xl font-bold text-red-600">{stats.writtenOffToday}<span className="text-sm text-muted-foreground font-normal ml-1">порц.</span></p>
            </div>
          </div>

          {/* Station filter + search */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              <button
                onClick={() => setStationFilter('all')}
                className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                  stationFilter === 'all' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                Все
              </button>
              {ALL_STATIONS.map(s => (
                <button
                  key={s}
                  onClick={() => setStationFilter(s)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                    stationFilter === s ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {STATION_ICONS[s]} {STATION_LABELS[s]}
                </button>
              ))}
            </div>
            <div className="relative sm:ml-auto">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Поиск блюда..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9 pr-3 py-2 text-sm rounded-lg border border-border bg-card w-full sm:w-56"
              />
            </div>
          </div>

          {/* Dish card — общий рендер для плоского списка и секций по станциям */}
          {(() => {
          const renderCard = (item: MenuItem) => {
              const lastLog = logs.find(l => l.menuItemId === item.id && l.qty > 0)
              const state = classifyStock(item)
              const isEmpty = state === 0
              const isLow = state === 1
              return (
                <div key={item.id} className={`bg-card rounded-xl border p-4 space-y-3 ${
                  isEmpty ? 'border-red-200' : isLow ? 'border-amber-200' : 'border-border'
                }`}>
                  <div
                    className="flex items-start justify-between gap-2 cursor-pointer hover:opacity-80"
                    onClick={() => setDetailsId(item.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-foreground leading-tight hover:text-primary transition-colors">{item.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {STATION_ICONS[item.station]} {STATION_LABELS[item.station]}
                      </p>
                    </div>
                    {item.emoji && <span className="text-xl shrink-0">{item.emoji}</span>}
                  </div>

                  {/* Prepared qty — click for details */}
                  <button
                    onClick={() => setDetailsId(item.id)}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg transition-all hover:scale-[1.01] active:scale-95 ${
                      isEmpty ? 'bg-red-50 border border-red-200 hover:bg-red-100'
                      : isLow ? 'bg-amber-50 border border-amber-200 hover:bg-amber-100'
                      : 'bg-emerald-50 border border-emerald-200 hover:bg-emerald-100'
                    }`}>
                    <div className="flex items-center gap-1.5">
                      <Package className={`size-4 ${isEmpty ? 'text-red-500' : isLow ? 'text-amber-600' : 'text-emerald-600'}`} />
                      <span className={`text-sm font-bold ${isEmpty ? 'text-red-700' : isLow ? 'text-amber-700' : 'text-emerald-700'}`}>
                        {item.preparedQty || 0}
                      </span>
                      <span className={`text-xs ${isEmpty ? 'text-red-600' : isLow ? 'text-amber-600' : 'text-emerald-600'}`}>
                        порц.
                      </span>
                    </div>
                    {lastLog && (
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(lastLog.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </button>

                  <div className="flex gap-2">
                    <button
                      onClick={() => handleStartProduce(item.id)}
                      disabled={producingId === item.id && calcLoading}
                      className="flex-1 px-3 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5 active:scale-95"
                    >
                      {producingId === item.id && calcLoading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Flame className="size-4" />
                      )}
                      Готовить
                    </button>
                    {(item.preparedQty || 0) > 0 && (
                      <button
                        onClick={() => { setWriteoffId(item.id); setWriteoffQty(1); setWriteoffReason('') }}
                        className="px-3 py-2.5 bg-red-50 text-red-600 border border-red-200 text-sm font-medium rounded-lg hover:bg-red-100 transition-colors active:scale-95"
                        title="Списать испорченные"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                </div>
              )
          }

          // "Все" + нет поиска → группируем по станциям с аккордеонами.
          // Конкретный фильтр или активный поиск → плоская сетка отсортированных карточек.
          const showGrouped = stationFilter === 'all' && !search && groupedByStation.length > 1

          if (filtered.length === 0) {
            return <p className="text-center text-muted-foreground text-sm py-8">Нет блюд по фильтру</p>
          }

          if (!showGrouped) {
            return (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {filtered.map(renderCard)}
              </div>
            )
          }

          return (
            <div className="space-y-4">
              {groupedByStation.map(group => {
                const collapsed = collapsedStations.has(group.station)
                const hasAttention = group.emptyCount > 0 || group.lowCount > 0
                return (
                  <section key={group.station} className={`bg-card rounded-xl border ${hasAttention ? 'border-amber-200' : 'border-border'}`}>
                    <button
                      type="button"
                      onClick={() => toggleStation(group.station)}
                      className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/30 transition-colors rounded-t-xl"
                    >
                      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        {collapsed ? <ChevronRight className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
                        <span className="text-lg">{STATION_ICONS[group.station]}</span>
                        <span>{STATION_LABELS[group.station]}</span>
                        <span className="text-xs text-muted-foreground font-normal">· {group.items.length} блюд</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px]">
                        {group.emptyCount > 0 && (
                          <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                            {group.emptyCount} закончились
                          </span>
                        )}
                        {group.lowCount > 0 && (
                          <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                            {group.lowCount} заканчивается
                          </span>
                        )}
                      </div>
                    </button>
                    {!collapsed && (
                      <div className="px-3 pb-3 pt-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                        {group.items.map(renderCard)}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          )
          })()}
        </>
      )}

      {/* ═══ Details dialog ═══ */}
      {detailsId && (() => {
        const item = menuItems.find(i => i.id === detailsId)
        if (!item) return null
        const itemLogs = logs.filter(l => l.menuItemId === detailsId)
        const today = new Date().toISOString().slice(0, 10)
        const todayLogs = itemLogs.filter(l => l.createdAt.slice(0, 10) === today)
        const producedTodayQty = todayLogs.filter(l => l.qty > 0).reduce((s, l) => s + l.qty, 0)
        const writtenOffTodayQty = todayLogs.filter(l => l.qty < 0).reduce((s, l) => s + Math.abs(l.qty), 0)
        const usedToday = producedTodayQty - writtenOffTodayQty - (item.preparedQty || 0)
        const usedTodayDisplay = Math.max(0, usedToday)
        const lastProduced = itemLogs.find(l => l.qty > 0)
        const lastWriteoff = itemLogs.find(l => l.qty < 0)
        return (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setDetailsId(null)}>
            <div className="bg-card rounded-2xl border border-border shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div className="p-5 border-b border-border flex items-start justify-between gap-3 sticky top-0 bg-card z-10">
                <div className="flex items-center gap-3">
                  <span className="text-3xl">{item.emoji || '🍽️'}</span>
                  <div>
                    <h3 className="font-bold text-foreground text-base">{item.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      {STATION_ICONS[item.station]} {STATION_LABELS[item.station]} · {item.category}
                    </p>
                  </div>
                </div>
                <button onClick={() => setDetailsId(null)} className="size-9 rounded-lg hover:bg-muted flex items-center justify-center">
                  <X className="size-5" />
                </button>
              </div>

              <div className="p-5 space-y-4">
                {/* Big counter */}
                <div className={`rounded-xl p-5 text-center ${
                  (item.preparedQty || 0) === 0 ? 'bg-red-50 border border-red-200'
                  : (item.preparedQty || 0) < 5 ? 'bg-amber-50 border border-amber-200'
                  : 'bg-emerald-50 border border-emerald-200'
                }`}>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Готово сейчас</p>
                  <p className={`text-5xl font-bold ${
                    (item.preparedQty || 0) === 0 ? 'text-red-600'
                    : (item.preparedQty || 0) < 5 ? 'text-amber-600'
                    : 'text-emerald-600'
                  }`}>{item.preparedQty || 0}</p>
                  <p className="text-sm text-muted-foreground mt-1">порций на складе</p>
                </div>

                {/* Today stats */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-muted/30 rounded-lg p-3 text-center">
                    <p className="text-[10px] uppercase text-muted-foreground">Готово сегодня</p>
                    <p className="text-xl font-bold text-emerald-600 mt-1">+{producedTodayQty}</p>
                  </div>
                  <div className="bg-muted/30 rounded-lg p-3 text-center">
                    <p className="text-[10px] uppercase text-muted-foreground">Продано</p>
                    <p className="text-xl font-bold text-blue-600 mt-1">{usedTodayDisplay}</p>
                  </div>
                  <div className="bg-muted/30 rounded-lg p-3 text-center">
                    <p className="text-[10px] uppercase text-muted-foreground">Списано</p>
                    <p className="text-xl font-bold text-red-600 mt-1">−{writtenOffTodayQty}</p>
                  </div>
                </div>

                {/* Last actions */}
                <div className="space-y-2">
                  {lastProduced && (
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30">
                      <ChefHat className="size-4 text-emerald-600 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-foreground">Последнее приготовление</p>
                        <p className="text-[11px] text-muted-foreground">
                          +{lastProduced.qty} порц.
                          {lastProduced.producedBy && ` · ${lastProduced.producedBy}`}
                          {' · '}
                          {new Date(lastProduced.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                  )}
                  {lastWriteoff && (
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30">
                      <Trash2 className="size-4 text-red-600 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-foreground">Последнее списание</p>
                        <p className="text-[11px] text-muted-foreground">
                          {Math.abs(lastWriteoff.qty)} порц.
                          {' · '}
                          {new Date(lastWriteoff.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Recent history for this item */}
                {itemLogs.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">История ({itemLogs.length})</p>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {itemLogs.slice(0, 20).map(log => {
                        const isWriteoff = log.qty < 0
                        return (
                          <div key={log.id} className={`flex items-center justify-between px-3 py-1.5 rounded-md text-xs ${
                            isWriteoff ? 'bg-red-50' : 'bg-emerald-50'
                          }`}>
                            <div className="flex items-center gap-2">
                              {isWriteoff
                                ? <Trash2 className="size-3 text-red-600" />
                                : <ChefHat className="size-3 text-emerald-600" />}
                              <span className={`font-semibold ${isWriteoff ? 'text-red-700' : 'text-emerald-700'}`}>
                                {isWriteoff ? '' : '+'}{log.qty}
                              </span>
                              {log.producedBy && <span className="text-muted-foreground">{log.producedBy}</span>}
                              {isWriteoff && log.reason && <span className="text-red-500/80 italic">— {log.reason}</span>}
                            </div>
                            <span className="text-muted-foreground">
                              {new Date(log.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => { setDetailsId(null); handleStartProduce(item.id) }}
                    className="flex-1 px-4 py-3 bg-primary text-primary-foreground text-sm font-semibold rounded-xl hover:bg-primary/90 active:scale-95 flex items-center justify-center gap-2"
                  >
                    <Flame className="size-4" />
                    Готовить ещё
                  </button>
                  {(item.preparedQty || 0) > 0 && (
                    <button
                      onClick={() => { setDetailsId(null); setWriteoffId(item.id); setWriteoffQty(1); setWriteoffReason('') }}
                      className="px-4 py-3 bg-red-50 text-red-600 border border-red-200 text-sm font-medium rounded-xl hover:bg-red-100 active:scale-95 flex items-center gap-2"
                    >
                      <Trash2 className="size-4" />
                      Списать
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ═══ Production dialog ═══ */}
      {producingId && producingItem && portionCalc && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => !producing && setProducingId(null)}>
          <div className="bg-card rounded-2xl border border-border shadow-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <span className="text-2xl">{producingItem.emoji}</span>
              <div className="flex-1">
                <h3 className="font-bold text-foreground text-base">{producingItem.name}</h3>
                <p className="text-xs text-muted-foreground">{STATION_ICONS[producingItem.station]} {STATION_LABELS[producingItem.station]}</p>
              </div>
            </div>

            {/* Status banner */}
            {portionCalc.ingredients.length === 0 ? (
              <div className="rounded-xl p-3 bg-blue-50 border border-blue-200">
                <p className="text-sm font-semibold text-blue-800 flex items-center gap-2">
                  <AlertTriangle className="size-4" />Нет техкарты
                </p>
                <p className="text-xs text-blue-700 mt-1">
                  У блюда не указаны ингредиенты. Можно добавить порции вручную (без списания со склада).
                </p>
                <Link
                  to="/warehouse/menu"
                  className="text-xs text-blue-600 hover:text-blue-800 underline mt-1.5 inline-block"
                >
                  Добавить техкарту в меню →
                </Link>
              </div>
            ) : (
              <div className={`rounded-xl p-3 ${portionCalc.maxPortions > 0 ? 'bg-emerald-50 border border-emerald-200' : 'bg-red-50 border border-red-200'}`}>
                <p className={`text-sm font-semibold ${portionCalc.maxPortions > 0 ? 'text-emerald-800' : 'text-red-800'}`}>
                  Максимум: {portionCalc.maxPortions} порций
                </p>
                {portionCalc.ingredients.filter(i => i.isBottleneck).map(i => (
                  <p key={i.ingredientId} className="text-xs text-muted-foreground mt-0.5">
                    Ограничение: {i.name} — {i.stockQty.toFixed(1)} {i.unit} на складе
                  </p>
                ))}
              </div>
            )}

            {/* Manual mode (no tech card) — allow any qty */}
            {portionCalc.ingredients.length === 0 ? (
              <>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Сколько порций добавить</label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setQty(Math.max(1, qty - 1))}
                      className="size-11 rounded-lg bg-muted text-foreground font-bold text-xl hover:bg-muted/80 active:scale-95 flex items-center justify-center"
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min={1}
                      value={qty}
                      onChange={e => setQty(Math.max(1, Number(e.target.value) || 1))}
                      className="flex-1 text-center text-xl font-bold py-2.5 rounded-lg border border-border bg-background"
                    />
                    <button
                      onClick={() => setQty(qty + 1)}
                      className="size-11 rounded-lg bg-muted text-foreground font-bold text-xl hover:bg-muted/80 active:scale-95 flex items-center justify-center"
                    >
                      +
                    </button>
                  </div>
                  <div className="flex gap-1.5 mt-2">
                    {[5, 10, 20, 50].map(n => (
                      <button
                        key={n}
                        onClick={() => setQty(n)}
                        className="flex-1 px-2 py-1.5 rounded-lg bg-muted text-xs font-semibold hover:bg-muted/80 active:scale-95"
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => { setProducingId(null); setPortionCalc(null) }}
                    disabled={producing}
                    className="flex-1 px-4 py-3 text-sm font-medium text-foreground bg-muted rounded-xl hover:bg-muted/80 active:scale-95"
                  >
                    Отмена
                  </button>
                  <button
                    onClick={handleProduce}
                    disabled={producing || qty <= 0}
                    className="flex-1 px-4 py-3 text-sm font-semibold text-primary-foreground bg-primary rounded-xl hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2 active:scale-95"
                  >
                    {producing ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                    Добавить {qty} порц.
                  </button>
                </div>
              </>
            ) : portionCalc.maxPortions > 0 ? (
              <>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Количество порций</label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setQty(Math.max(1, qty - 1))}
                      className="size-11 rounded-lg bg-muted text-foreground font-bold text-xl hover:bg-muted/80 active:scale-95 flex items-center justify-center"
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={portionCalc.maxPortions}
                      value={qty}
                      onChange={e => setQty(Math.min(portionCalc.maxPortions, Math.max(1, Number(e.target.value) || 1)))}
                      className="flex-1 text-center text-xl font-bold py-2.5 rounded-lg border border-border bg-background"
                    />
                    <button
                      onClick={() => setQty(Math.min(portionCalc.maxPortions, qty + 1))}
                      className="size-11 rounded-lg bg-muted text-foreground font-bold text-xl hover:bg-muted/80 active:scale-95 flex items-center justify-center"
                    >
                      +
                    </button>
                    <button
                      onClick={() => setQty(portionCalc.maxPortions)}
                      className="px-3 py-2.5 rounded-lg bg-muted text-xs font-semibold text-muted-foreground hover:bg-muted/80 active:scale-95"
                    >
                      Макс
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Будет списано:</p>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {portionCalc.ingredients.map(ing => {
                      // Show deduction in recipe units (г/мл), stock in stock units (кг/л)
                      const deductRecipe = ing.recipeQtyPerPortion * qty
                      // Convert deduction to stock units for proper % calculation
                      const su = ing.unit.toLowerCase().trim()
                      const ru = (ing.recipeUnit || ing.unit).toLowerCase().trim()
                      let deductStock = deductRecipe
                      if ((su === 'кг' || su === 'kg') && (ru === 'г' || ru === 'g' || ru === 'гр')) deductStock = deductRecipe / 1000
                      else if ((su === 'л' || su === 'l') && (ru === 'мл' || ru === 'ml')) deductStock = deductRecipe / 1000
                      else if ((su === 'г' || su === 'g' || su === 'гр') && (ru === 'кг' || ru === 'kg')) deductStock = deductRecipe * 1000
                      else if ((su === 'мл' || su === 'ml') && (ru === 'л' || ru === 'l')) deductStock = deductRecipe * 1000
                      const pct = ing.stockQty > 0 ? Math.round(deductStock / ing.stockQty * 100) : 100
                      return (
                        <div key={ing.ingredientId} className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs ${
                          ing.isBottleneck ? 'bg-amber-50 border border-amber-200' : 'bg-muted/50'
                        }`}>
                          <span className="text-foreground font-medium">{ing.name}</span>
                          <span className={`${pct > 80 ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}>
                            {deductStock % 1 === 0 ? deductStock : deductStock.toFixed(2)} / {ing.stockQty % 1 === 0 ? ing.stockQty : ing.stockQty.toFixed(2)} {ing.unit} ({pct}%)
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => { setProducingId(null); setPortionCalc(null) }}
                    disabled={producing}
                    className="flex-1 px-4 py-3 text-sm font-medium text-foreground bg-muted rounded-xl hover:bg-muted/80 active:scale-95"
                  >
                    Отмена
                  </button>
                  <button
                    onClick={handleProduce}
                    disabled={producing || qty <= 0}
                    className="flex-1 px-4 py-3 text-sm font-semibold text-primary-foreground bg-primary rounded-xl hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2 active:scale-95"
                  >
                    {producing ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                    Приготовить {qty} порц.
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="text-center py-3 space-y-2">
                  <p className="text-sm text-muted-foreground">Не хватает ингредиентов на складе</p>
                  <Link
                    to="/warehouse/inventory"
                    className="text-xs text-primary hover:underline"
                  >
                    Перейти на склад →
                  </Link>
                </div>
                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => { setProducingId(null); setPortionCalc(null) }}
                    className="flex-1 px-4 py-3 text-sm font-medium text-foreground bg-muted rounded-xl hover:bg-muted/80"
                  >
                    Закрыть
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ═══ Writeoff dialog ═══ */}
      {writeoffId && writeoffItem && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => !writingOff && setWriteoffId(null)}>
          <div className="bg-card rounded-2xl border border-border shadow-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <div className="size-12 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center">
                <Trash2 className="size-6 text-red-600" />
              </div>
              <div className="flex-1">
                <h3 className="font-bold text-foreground">Списание порций</h3>
                <p className="text-xs text-muted-foreground">{writeoffItem.name} · доступно {writeoffItem.preparedQty || 0}</p>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Количество</label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setWriteoffQty(Math.max(1, writeoffQty - 1))}
                  className="size-11 rounded-lg bg-muted text-foreground font-bold text-xl hover:bg-muted/80 active:scale-95"
                >
                  −
                </button>
                <input
                  type="number"
                  min={1}
                  max={writeoffItem.preparedQty || 0}
                  value={writeoffQty}
                  onChange={e => setWriteoffQty(Math.min(writeoffItem.preparedQty || 0, Math.max(1, Number(e.target.value) || 1)))}
                  className="flex-1 text-center text-xl font-bold py-2.5 rounded-lg border border-border bg-background"
                />
                <button
                  onClick={() => setWriteoffQty(Math.min(writeoffItem.preparedQty || 0, writeoffQty + 1))}
                  className="size-11 rounded-lg bg-muted text-foreground font-bold text-xl hover:bg-muted/80 active:scale-95"
                >
                  +
                </button>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Причина</label>
              <select
                value={writeoffReason}
                onChange={e => setWriteoffReason(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-border bg-background text-sm"
              >
                <option value="">Выберите...</option>
                <option value="Испортилось">Испортилось</option>
                <option value="Просрочено">Просрочено</option>
                <option value="Бракованная партия">Бракованная партия</option>
                <option value="Дегустация">Дегустация</option>
                <option value="Другое">Другое</option>
              </select>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setWriteoffId(null)}
                disabled={writingOff}
                className="flex-1 px-4 py-3 text-sm font-medium text-foreground bg-muted rounded-xl hover:bg-muted/80"
              >
                Отмена
              </button>
              <button
                onClick={handleWriteoff}
                disabled={writingOff || writeoffQty <= 0 || !writeoffReason}
                className="flex-1 px-4 py-3 text-sm font-semibold text-white bg-red-600 rounded-xl hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2 active:scale-95"
              >
                {writingOff ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                Списать {writeoffQty} порц.
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ History ═══ */}
      {logs.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-5 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Clock className="size-4 text-muted-foreground" />История операций
            </h3>
            <div className="flex gap-1">
              {(['today', 'week', 'all'] as HistoryFilter[]).map(f => (
                <button
                  key={f}
                  onClick={() => setHistoryFilter(f)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    historyFilter === f ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {f === 'today' ? 'Сегодня' : f === 'week' ? 'Неделя' : 'Все'}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5 max-h-80 overflow-y-auto">
            {filteredLogs.length === 0 ? (
              <p className="text-center text-muted-foreground text-xs py-4">Нет операций в этом периоде</p>
            ) : filteredLogs.map(log => {
              const isWriteoff = log.qty < 0
              return (
                <div key={log.id} className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs ${
                  isWriteoff ? 'bg-red-50 border border-red-100' : 'bg-muted/30'
                }`}>
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {isWriteoff
                      ? <Trash2 className="size-3.5 text-red-600 shrink-0" />
                      : <ChefHat className="size-3.5 text-primary shrink-0" />}
                    <span className="font-medium text-foreground truncate">{log.menuItemName}</span>
                    <span className={`shrink-0 font-medium ${isWriteoff ? 'text-red-600' : 'text-emerald-600'}`}>
                      {isWriteoff ? '' : '+'}{log.qty} порц.
                    </span>
                    {log.costTotal > 0 && (
                      <span className="text-muted-foreground hidden sm:inline">({formatCurrency(log.costTotal)})</span>
                    )}
                  </div>
                  <div className="text-muted-foreground flex items-center gap-2 shrink-0 ml-2">
                    {isWriteoff && log.reason && <span className="text-red-500/80 italic hidden sm:inline">— {log.reason}</span>}
                    {log.producedBy && <span className="hidden sm:inline">{log.producedBy}</span>}
                    <span>{new Date(log.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
