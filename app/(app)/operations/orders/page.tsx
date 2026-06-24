'use client'

// Главная страница «Заказы» — 4 таба в одну строку:
//   [Все заказы] [Зал] [С собой] [Закрытые]
// Первые три — card-grid активных заказов текущей смены, фильтруются по type.
// Четвёртый — отчёт по закрытым/отменённым/возвратам за период (lazy load).
// URL: /operations/orders?tab=active|hall|takeaway|closed (default: active).

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, X } from 'lucide-react'

import { useAuth } from '@/lib/auth-store'
import { fetchActiveShift } from '@/lib/queries'
import type { CashShift } from '@/lib/types'
import { ActiveOrdersTab, type ActiveTypeFilter } from '@/components/orders/active-orders-tab'
import { HistoryOrdersTab } from '@/components/orders/history-orders-tab'
import { OwnerPinGate } from '@/components/owner-pin-gate'

type Tab = 'active' | 'hall' | 'takeaway' | 'closed'

const TAB_DEFS: { value: Tab; label: string }[] = [
  { value: 'active', label: 'Все заказы' },
  { value: 'hall', label: 'Зал' },
  { value: 'takeaway', label: 'С собой' },
  { value: 'closed', label: 'Закрытые' },
]

function parseTab(value: string | null): Tab {
  if (value === 'hall' || value === 'takeaway' || value === 'closed') return value
  return 'active'
}

function tabToTypeFilter(tab: Tab): ActiveTypeFilter {
  if (tab === 'hall') return 'hall'
  if (tab === 'takeaway') return 'takeaway'
  return 'all'
}

function formatHHMM(iso: string | undefined | null): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  } catch {
    return ''
  }
}

export default function OrdersPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = parseTab(searchParams.get('tab'))
  const { user, restaurantId } = useAuth()
  // Раздел «Закрытые» — под ПИН владельца (как раздел «Смены»).
  // owner/superadmin заходят без запроса.
  const isOwnerRole = user?.role === 'owner' || user?.role === 'superadmin'
  const [closedUnlocked, setClosedUnlocked] = useState(false)

  const setTab = useCallback((next: Tab) => {
    const sp = new URLSearchParams(searchParams)
    if (next === 'active') sp.delete('tab')
    else sp.set('tab', next)
    setSearchParams(sp, { replace: true })
  }, [searchParams, setSearchParams])

  // Текущая смена — для строки «Смена · открыта HH:MM» в header'е.
  // Грузим один раз на mount и не SSE-обновляем — для шапки этого достаточно.
  const [shift, setShift] = useState<CashShift | null>(null)
  useEffect(() => {
    let alive = true
    fetchActiveShift().then(s => { if (alive) setShift(s) }).catch(() => {})
    return () => { alive = false }
  }, [])

  // Поиск (используется только для табов 1-3).
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)

  // Счётчик очереди для header'а (поднимается из ActiveOrdersTab).
  const [queueCount, setQueueCount] = useState<number>(0)
  // Lazy-mount для таба «Закрытые» — отдельный flag, чтобы не fetch'ить
  // history на mount страницы, только при первом клике на таб.
  const [closedMounted, setClosedMounted] = useState(tab === 'closed')
  useEffect(() => {
    if (tab === 'closed') setClosedMounted(true)
  }, [tab])

  const isActiveTab = tab !== 'closed'
  const typeFilter = useMemo(() => tabToTypeFilter(tab), [tab])

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      {/* Sticky tabs row + header */}
      <div className="sticky top-0 z-20 -mx-4 -mt-4 px-4 pt-4 pb-2 md:-mx-6 md:-mt-6 md:px-6 md:pt-6 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap">
            {TAB_DEFS.map(t => (
              <button
                key={t.value}
                onClick={() => setTab(t.value)}
                className={`px-3 md:px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  tab === t.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {isActiveTab && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {/* Поиск: icon-only -> разворачивается в input */}
              {searchOpen ? (
                <div className="relative">
                  <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    autoFocus
                    type="text"
                    placeholder="№ или стол..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-7 pr-7 py-1.5 text-xs bg-card border border-border rounded-lg w-44 focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button
                    onClick={() => { setSearch(''); setSearchOpen(false) }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setSearchOpen(true)}
                  className="p-1.5 rounded-md hover:bg-muted text-muted-foreground"
                  title="Поиск"
                >
                  <Search className="size-4" />
                </button>
              )}

              <span className="whitespace-nowrap">
                {queueCount} {queueWord(queueCount)} в очереди
              </span>
              <span className="text-border">|</span>
              <span className="whitespace-nowrap">
                {user?.name?.split(' ')[0] ?? '—'}
                {shift?.openedAt && ` · Смена с ${formatHHMM(shift.openedAt)}`}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Active tabs — card-grid. ActiveOrdersTab монтируется один и
          переключение между Все/Зал/С собой передаётся prop'ом typeFilter
          (один SSE-стрим, нет лишних refetch'ей). */}
      {isActiveTab && (
        <ActiveOrdersTab
          typeFilter={typeFilter}
          search={search}
          onQueueCountChange={setQueueCount}
        />
      )}

      {/* History — lazy mount. После первого открытия остаётся в DOM,
          скрываем через CSS, чтобы фильтры/скролл сохранялись. */}
      {closedMounted && (
        <div className={tab === 'closed' ? '' : 'hidden'}>
          {(!isOwnerRole && !closedUnlocked) ? (
            <OwnerPinGate
              restaurantId={restaurantId ?? ''}
              sectionLabel="Закрытые заказы"
              onSuccess={() => setClosedUnlocked(true)}
              onBack={() => setTab('active')}
            />
          ) : (
            <HistoryOrdersTab />
          )}
        </div>
      )}
    </div>
  )
}

function queueWord(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return 'заказов'
  if (mod10 === 1) return 'заказ'
  if (mod10 >= 2 && mod10 <= 4) return 'заказа'
  return 'заказов'
}
