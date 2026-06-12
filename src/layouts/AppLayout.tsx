import { Outlet } from 'react-router-dom'
import { AuthProvider, AuthGuard, useAuth } from '@/lib/auth-store'
import { AppSidebar, MobileHeader, MobileSidebar, SidebarProvider } from '@/components/app-sidebar'
import { CashierShell } from '@/components/cashier-shell'
import { MobileNewOrderFab } from '@/components/mobile-new-order-fab'
import { Toaster } from '@/components/ui/sonner'
import { AutoReadyWatcher } from '@/components/auto-ready-watcher'
import { RealtimeCacheBridge } from '@/components/realtime-cache-bridge'
import { LicenseGate } from '@/components/license-gate'
import { LicenseWarningBanner } from '@/components/license-warning-banner'
import { useQuerySseBridge } from '@/hooks/use-query-sse-bridge'

function AppContent() {
  const { user, logout } = useAuth()
  // SSE → точечная инвалидация React Query кэшей (для мигрированных экранов).
  // Старые экраны на use-data-sync работают параллельно.
  useQuerySseBridge()
  const useCashierShell = user?.role === 'cashier'

  // v3.9.19: web-waiter удалён — официант работает только в Kotlin-приложении.
  // Если официант случайно залогинился в вебе — показываем подсказку, а не
  // пускаем в админ-оболочку (у роли нет nav-доступа → был бы редирект-цикл).
  if (user?.role === 'waiter') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center bg-background">
        <h1 className="text-xl font-bold text-foreground">Официант работает через приложение</h1>
        <p className="text-sm text-muted-foreground max-w-sm">
          Используйте приложение RestOS на телефоне (Android). Веб-версия для официанта не предназначена.
        </p>
        <button
          onClick={logout}
          className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted"
        >
          Выйти
        </button>
        <Toaster richColors position="top-center" />
      </div>
    )
  }

  if (useCashierShell) {
    return (
      <>
        <CashierShell>
          <Outlet />
        </CashierShell>
        <Toaster richColors position="top-center" />
        <RealtimeCacheBridge />
        <AutoReadyWatcher />
      </>
    )
  }

  return (
    <SidebarProvider>
      <div className="flex h-screen bg-background overflow-hidden">
        <AppSidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <MobileHeader />
          <MobileSidebar />
          <main className="flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
      <MobileNewOrderFab />
      <Toaster richColors position="top-center" />
      <RealtimeCacheBridge />
      <AutoReadyWatcher />
    </SidebarProvider>
  )
}

export function AppLayout() {
  return (
    <AuthProvider>
      <AuthGuard>
        <LicenseGate>
          {/* Sticky warning banner — показывается только при state=grace|softLocked. */}
          <LicenseWarningBanner />
          <AppContent />
        </LicenseGate>
      </AuthGuard>
    </AuthProvider>
  )
}
