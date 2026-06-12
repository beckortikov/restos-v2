'use client'

import { useCallback, useEffect, useState } from 'react'
import { LogOut, Wifi, WifiOff, Loader2, LayoutGrid, List, Star, ClipboardList, BookOpen, RefreshCw } from 'lucide-react'
import { useAuth } from '@/lib/auth-store'
import { isLanReachable, onLanReachableChange, probeLan } from '@/lib/waiter/lan-guard'
import { useWaiterViewMode } from '@/lib/waiter/view-mode'
import { useWaiterHomeScreen } from '@/lib/waiter/home-screen'
import { fetchWaiterTodayStats } from '@/lib/queries'
import { useDataSync } from '@/hooks/use-data-sync'
import { formatCurrency } from '@/lib/helpers'
import { toast } from 'sonner'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export function WaiterHeader() {
  const { user, restaurant, logout } = useAuth()
  const [profileOpen, setProfileOpen] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [reachable, setReachable] = useState<boolean | null>(null)
  const [viewMode, setViewMode] = useWaiterViewMode()
  const [homeScreen, setHomeScreen] = useWaiterHomeScreen()
  const [stats, setStats] = useState<{ ordersCount: number; serviceEarned: number } | null>(null)

  const reloadStats = useCallback(() => {
    if (!user?.id) return
    fetchWaiterTodayStats(user.id).then(setStats).catch(() => setStats(null))
  }, [user?.id])

  // Подгружаем статистику при открытии шторки
  useEffect(() => {
    if (profileOpen) reloadStats()
  }, [profileOpen, reloadStats])

  // Live-обновление: SSE-event на orders → cache refresh → restos-data-updated
  // → перезапрос статистики (только когда шторка открыта).
  useDataSync(['orders'], () => { if (profileOpen) reloadStats() })

  // Connection dot reflects local-server health.
  useEffect(() => {
    let cancelled = false
    probeLan().then(ok => { if (!cancelled) setReachable(ok) }).catch(() => { if (!cancelled) setReachable(false) })
    setReachable(isLanReachable())
    return onLanReachableChange(ok => { if (!cancelled) setReachable(ok) })
  }, [])

  const initials = user ? user.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() : '??'

  function handleLogout() {
    logout()
    window.location.href = '/login'
  }

  // Ручное обновление данных. Обычно SSE/poll/visibility-change подтягивают
  // свежие orders сами, но на слабой мобильной сети SSE может «замирать» —
  // тогда официант жмёт эту кнопку, и мы рассылаем событие 'restos-data-updated'
  // для каждой ключевой таблицы; useDataSync на каждой странице делает свой load().
  const [refreshing, setRefreshing] = useState(false)
  async function handleRefresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      for (const table of ['orders', 'order_items', 'tables', 'zones', 'users', 'menu_items']) {
        window.dispatchEvent(new CustomEvent('restos-data-updated', { detail: { table } }))
      }
      toast.success('Обновлено')
    } catch {
      toast.error('Не удалось обновить')
    } finally {
      setTimeout(() => setRefreshing(false), 400)
    }
  }

  return (
    <>
      <header className="sticky top-0 z-40 bg-background border-b border-border safe-area-top">
        <div className="relative flex items-center h-14 px-4">
          {/* Restaurant name centered */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="font-semibold text-base text-foreground truncate max-w-[60%]">
              {restaurant?.name ?? 'RestOS'}
            </div>
          </div>

          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="size-10 rounded-full bg-muted/40 text-foreground flex items-center justify-center active:bg-muted/60 transition-colors shrink-0 disabled:opacity-50"
            aria-label="Обновить"
          >
            <RefreshCw className={`size-5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>

          <div className="flex-1" />

          <button
            onClick={() => setProfileOpen(true)}
            className="relative size-10 rounded-full bg-primary/15 text-primary text-sm font-bold flex items-center justify-center active:bg-primary/25 transition-colors shrink-0"
            aria-label="Профиль"
          >
            {initials}
            <span
              className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-background ${
                reachable === null
                  ? 'bg-amber-400'
                  : reachable
                    ? 'bg-emerald-500'
                    : 'bg-red-500'
              }`}
              aria-hidden
            />
          </button>
        </div>
      </header>

      <Sheet open={profileOpen} onOpenChange={setProfileOpen}>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl pb-[calc(env(safe-area-inset-bottom,0px)+12px)]"
        >
          <SheetHeader className="text-left">
            <SheetTitle>Профиль</SheetTitle>
          </SheetHeader>

          <div className="px-4 pb-4 space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/40">
              <div className="size-12 rounded-full bg-primary/15 flex items-center justify-center text-primary text-base font-bold">
                {initials}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-base truncate">{user?.name ?? 'Гость'}</div>
                <div className="text-sm text-muted-foreground truncate">{user?.roleDisplay ?? 'Официант'}</div>
                {restaurant?.name && (
                  <div className="text-xs text-muted-foreground/70 truncate mt-0.5">{restaurant.name}</div>
                )}
              </div>
            </div>

            {/* Сегодняшняя статистика */}
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">Сегодня</div>
              <div className="grid grid-cols-2 gap-2">
                <div className="p-3 rounded-xl bg-muted/40 flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <ClipboardList className="size-3.5" />
                    Заказов
                  </div>
                  <div className="text-lg font-bold text-foreground">{stats ? stats.ordersCount : '—'}</div>
                </div>
                <div className="p-3 rounded-xl bg-amber-50 flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-[11px] text-amber-700/80">
                    <Star className="size-3.5" />
                    Обслуживание
                  </div>
                  <div className="text-lg font-bold text-amber-900">
                    {stats ? formatCurrency(stats.serviceEarned) : '—'}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 p-3 rounded-xl bg-muted/40 text-sm">
              {reachable === null ? (
                <>
                  <Loader2 className="size-4 animate-spin text-amber-500" />
                  <span>Проверка соединения...</span>
                </>
              ) : reachable ? (
                <>
                  <Wifi className="size-4 text-emerald-600" />
                  <span>Сервер заведения на связи</span>
                </>
              ) : (
                <>
                  <WifiOff className="size-4 text-red-600" />
                  <span>Нет связи с сервером заведения</span>
                </>
              )}
            </div>

            {/* View mode toggle */}
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">Вид списка</div>
              <div className="flex gap-1 bg-muted/40 p-1 rounded-xl">
                <button
                  onClick={() => setViewMode('list')}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 h-10 rounded-lg text-sm font-medium transition-colors ${
                    viewMode === 'list' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
                  }`}
                >
                  <List className="size-4" /> Список
                </button>
                <button
                  onClick={() => setViewMode('grid')}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 h-10 rounded-lg text-sm font-medium transition-colors ${
                    viewMode === 'grid' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
                  }`}
                >
                  <LayoutGrid className="size-4" /> Сетка
                </button>
              </div>
            </div>

            {/* Home screen — куда попадать после логина / по умолчанию */}
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">Начинать с</div>
              <div className="flex gap-1 bg-muted/40 p-1 rounded-xl">
                <button
                  onClick={() => setHomeScreen('tables')}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 h-10 rounded-lg text-sm font-medium transition-colors ${
                    homeScreen === 'tables' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
                  }`}
                >
                  <LayoutGrid className="size-4" /> Столы
                </button>
                <button
                  onClick={() => setHomeScreen('menu')}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 h-10 rounded-lg text-sm font-medium transition-colors ${
                    homeScreen === 'menu' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
                  }`}
                >
                  <BookOpen className="size-4" /> Меню
                </button>
              </div>
            </div>

            <button
              onClick={() => {
                setProfileOpen(false)
                setLogoutOpen(true)
              }}
              className="w-full flex items-center justify-center gap-2 h-12 rounded-xl bg-destructive/10 text-destructive font-medium active:bg-destructive/20 transition-colors"
            >
              <LogOut className="size-5" />
              Выйти
            </button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={logoutOpen} onOpenChange={setLogoutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Выйти из аккаунта?</AlertDialogTitle>
            <AlertDialogDescription>
              Вам потребуется снова войти, чтобы продолжить работу.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={handleLogout}>Выйти</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
