'use client'

import { AuthProvider, useAuth } from '@/lib/auth-store'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { useEffect } from 'react'
import { Building2, Users, LayoutDashboard, LogOut, UtensilsCrossed } from 'lucide-react'

const ADMIN_NAV = [
  { label: 'Дашборд', href: '/admin', icon: LayoutDashboard },
  { label: 'Рестораны', href: '/admin/restaurants', icon: Building2 },
  { label: 'Пользователи', href: '/admin/users', icon: Users },
]

function AdminLayoutInner({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  useEffect(() => {
    if (loading) return
    if (!user) {
      navigate('/login', { replace: true })
      return
    }
    if (user.role !== 'superadmin') {
      navigate('/dashboard', { replace: true })
    }
  }, [user, loading, navigate])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  if (!user || user.role !== 'superadmin') return null

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-64 bg-sidebar border-r border-sidebar-border flex flex-col shrink-0">
        <div className="p-4 flex items-center gap-3 border-b border-sidebar-border">
          <div className="size-9 rounded-xl bg-sidebar-primary flex items-center justify-center">
            <UtensilsCrossed className="size-4.5 text-sidebar-primary-foreground" />
          </div>
          <div>
            <div className="text-sidebar-foreground font-bold text-base leading-none">RestOS</div>
            <div className="text-sidebar-foreground/40 text-xs mt-0.5">Супер-админ</div>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {ADMIN_NAV.map((item) => {
            const isActive = pathname === item.href || (item.href !== '/admin' && pathname.startsWith(item.href))
            return (
              <Link
                key={item.href}
                to={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50'
                }`}
              >
                <item.icon className="size-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="p-3 border-t border-sidebar-border">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="size-8 rounded-full bg-sidebar-accent flex items-center justify-center text-xs font-bold text-sidebar-accent-foreground">
              SA
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sidebar-foreground truncate">{user.name}</p>
              <p className="text-xs text-sidebar-foreground/50">Супер-админ</p>
            </div>
            <button onClick={logout} className="text-sidebar-foreground/40 hover:text-sidebar-foreground">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  )
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AdminLayoutInner>{children}</AdminLayoutInner>
    </AuthProvider>
  )
}
