'use client'

import { Link, useLocation } from 'react-router-dom'
import { LayoutGrid, ClipboardList } from 'lucide-react'
import { cn } from '@/lib/utils'

const TABS = [
  { href: '/waiter/tables', label: 'Столы', icon: LayoutGrid },
  { href: '/waiter/orders', label: 'Заказы', icon: ClipboardList },
]

export function WaiterBottomNav() {
  const { pathname } = useLocation()

  return (
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
      </div>
    </nav>
  )
}
