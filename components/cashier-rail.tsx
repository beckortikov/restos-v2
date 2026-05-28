'use client'

import { Link, useLocation } from 'react-router-dom'
import {
  Monitor,
  MapPin,
  ClipboardList,
  UtensilsCrossed,
  Clock,
  Settings,
  LogOut,
  RefreshCw,
} from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth-store'
import { type User } from '@/lib/types'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface RailItem {
  href: string
  label: string
  icon: React.ElementType
}

const PRIMARY_ITEMS: RailItem[] = [
  { href: '/operations/pos', label: 'POS', icon: Monitor },
  { href: '/operations/table-map', label: 'Столы', icon: MapPin },
  { href: '/operations/orders', label: 'Заказы', icon: ClipboardList },
  { href: '/operations/showcase', label: 'Витрина', icon: UtensilsCrossed },
  { href: '/operations/shifts', label: 'Смены', icon: Clock },
]

const SETTINGS_ITEM: RailItem = { href: '/cashier/settings', label: 'Настр.', icon: Settings }

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + '/')
}

interface CashierRailProps {
  effectiveUser?: User | null
}

export function CashierRail({ effectiveUser }: CashierRailProps) {
  const { pathname } = useLocation()
  const { hasAccess, logout, user, restaurant } = useAuth()
  const [logoutOpen, setLogoutOpen] = useState(false)

  const visiblePrimary = PRIMARY_ITEMS.filter((it) => hasAccess(it.href))
  const settingsVisible = hasAccess(SETTINGS_ITEM.href)

  const profile = effectiveUser ?? user
  const initials = profile ? profile.name.split(' ').map((n) => n[0]).join('').slice(0, 2) : '??'

  function handleLogout() {
    logout()
    window.location.href = '/login'
  }

  function railItem(item: RailItem) {
    const Icon = item.icon
    const active = isActive(pathname, item.href)
    return (
      <Link
        key={item.href}
        to={item.href}
        className={cn(
          'flex flex-col items-center justify-center gap-1 rounded-xl transition-colors shrink-0',
          'md:w-full md:py-3 md:px-2',
          'flex-1 py-2',
          active
            ? 'bg-primary text-primary-foreground'
            : 'text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent'
        )}
      >
        <Icon className="size-5 shrink-0" />
        <span className="text-[10px] font-medium leading-none">{item.label}</span>
      </Link>
    )
  }

  return (
    <>
      {/* Desktop: left vertical rail */}
      <aside className="hidden md:flex flex-col items-center w-[88px] shrink-0 bg-sidebar border-r border-sidebar-border py-2 px-2">
        <div
          className="size-10 rounded-xl bg-primary flex items-center justify-center shrink-0 mb-2"
          title={restaurant?.name ?? 'RestOS'}
        >
          <UtensilsCrossed className="size-5 text-primary-foreground" />
        </div>

        <div className="flex flex-col gap-1 w-full">
          {visiblePrimary.map((item) => railItem(item))}
        </div>

        {settingsVisible && (
          <>
            <div className="my-1 w-full border-t border-sidebar-border" />
            <div className="w-full">{railItem(SETTINGS_ITEM)}</div>
          </>
        )}

        <div className="flex-1" />

        {/* Refresh page — над профилем */}
        <button
          onClick={() => window.location.reload()}
          title="Обновить страницу"
          className="flex flex-col items-center justify-center gap-1 w-full py-2 rounded-xl text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors mb-1"
        >
          <RefreshCw className="size-5 shrink-0" />
          <span className="text-[10px] font-medium leading-none">Обновить</span>
        </button>

        {/* Profile — only avatar visible; name/role/logout inside popover */}
        <div className="w-full flex justify-center pt-2 border-t border-sidebar-border">
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="size-10 rounded-full bg-primary/15 flex items-center justify-center text-primary text-sm font-bold shrink-0 hover:bg-primary/25 transition-colors"
                title={profile?.name ?? 'Профиль'}
              >
                {initials}
              </button>
            </PopoverTrigger>
            <PopoverContent side="right" align="end" className="w-60 p-2">
              <div className="px-2 pb-2 mb-1 border-b border-border">
                <div className="font-semibold text-sm text-foreground truncate">{profile?.name ?? 'Гость'}</div>
                <div className="text-xs text-muted-foreground">{profile?.roleDisplay ?? 'Кассир'}</div>
              </div>
              <button
                onClick={() => setLogoutOpen(true)}
                className="flex items-center gap-2.5 w-full px-3 py-2 rounded-md text-sm text-destructive hover:bg-destructive/10 transition-colors"
              >
                <LogOut className="size-4 shrink-0" />
                <span>Выйти</span>
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </aside>

      {/* Mobile: bottom bar */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-sidebar border-t border-sidebar-border flex items-stretch px-1 py-1 safe-area-bottom">
        {visiblePrimary.map((item) => railItem(item))}
        {settingsVisible && railItem(SETTINGS_ITEM)}
      </nav>

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
