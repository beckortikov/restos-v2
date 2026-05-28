'use client'

import { Link, useLocation } from 'react-router-dom'
import { MapPin, ClipboardList, UtensilsCrossed, User, LogOut } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth-store'
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

const TABS = [
  { href: '/operations/pos', label: 'Меню', icon: UtensilsCrossed },
  { href: '/operations/orders', label: 'Заказы', icon: ClipboardList },
  { href: '/operations/table-map', label: 'Столы', icon: MapPin },
]

export function WaiterBottomNav() {
  const { pathname } = useLocation()
  const { user, restaurant, logout } = useAuth()
  const [profileOpen, setProfileOpen] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)

  const initials = user ? user.name.split(' ').map(n => n[0]).join('').slice(0, 2) : '??'

  function handleLogout() {
    logout()
    window.location.href = '/login'
  }

  return (
    <>
      <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-background border-t border-border pb-[env(safe-area-inset-bottom,0px)]">
        <div className="flex h-[68px]">
          {TABS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/')
            return (
              <Link
                key={href}
                to={href}
                className={cn(
                  'flex-1 flex flex-col items-center justify-center gap-1 transition-colors active:bg-muted/50',
                  active ? 'text-primary' : 'text-muted-foreground'
                )}
              >
                <Icon className="size-6" strokeWidth={active ? 2.5 : 1.5} />
                <span className={cn('text-[11px] leading-none', active && 'font-semibold')}>{label}</span>
              </Link>
            )
          })}
          <button
            onClick={() => setProfileOpen(true)}
            className={cn(
              'flex-1 flex flex-col items-center justify-center gap-1 transition-colors active:bg-muted/50',
              profileOpen ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            <User className="size-6" strokeWidth={profileOpen ? 2.5 : 1.5} />
            <span className={cn('text-[11px] leading-none', profileOpen && 'font-semibold')}>Профиль</span>
          </button>
        </div>
      </nav>

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
                <div className="text-sm text-muted-foreground truncate">{user?.roleDisplay ?? ''}</div>
                {restaurant?.name && (
                  <div className="text-xs text-muted-foreground/70 truncate mt-0.5">{restaurant.name}</div>
                )}
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
