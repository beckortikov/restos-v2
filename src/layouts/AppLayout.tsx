import { Outlet, useLocation } from 'react-router-dom'
import { AuthProvider, AuthGuard, useAuth } from '@/lib/auth-store'
import { AppSidebar, MobileHeader, MobileSidebar, SidebarProvider } from '@/components/app-sidebar'
import { WaiterShell } from '@/components/waiter/waiter-shell'
import { CashierShell } from '@/components/cashier-shell'
import { MobileNewOrderFab } from '@/components/mobile-new-order-fab'
import { Toaster } from '@/components/ui/sonner'
import { AutoReadyWatcher } from '@/components/auto-ready-watcher'
import { RealtimeCacheBridge } from '@/components/realtime-cache-bridge'
import { LicenseGate } from '@/components/license-gate'

function AppContent() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  const isWaiterRoute = pathname.startsWith('/waiter')
  const isWaiterUser = user?.role === 'waiter'
  // Waiter UI replaces the admin shell entirely on /waiter/* and for waiter
  // role on any path (so that a misnav still lands on a waiter-friendly screen).
  const useWaiterShell = isWaiterRoute || isWaiterUser
  const useCashierShell = user?.role === 'cashier'

  if (useWaiterShell) {
    return (
      <>
        <WaiterShell>
          <Outlet />
        </WaiterShell>
        <Toaster richColors position="top-center" />
        <RealtimeCacheBridge />
        <AutoReadyWatcher />
      </>
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
          <AppContent />
        </LicenseGate>
      </AuthGuard>
    </AuthProvider>
  )
}
