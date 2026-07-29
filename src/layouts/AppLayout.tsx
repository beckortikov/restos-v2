import { Outlet, useLocation } from 'react-router-dom'
import { AuthGuard, useAuth } from '@/lib/auth-store'
import { AppSidebar, MobileHeader, MobileSidebar, SidebarProvider } from '@/components/app-sidebar'
import { WaiterShell } from '@/components/waiter/waiter-shell'
import { CashierShell } from '@/components/cashier-shell'
import { MobileNewOrderFab } from '@/components/mobile-new-order-fab'
import { Toaster } from '@/components/ui/sonner'
import { AutoReadyWatcher } from '@/components/auto-ready-watcher'
import { RealtimeCacheBridge } from '@/components/realtime-cache-bridge'
import { LicenseGate } from '@/components/license-gate'
import { LicenseWarningBanner } from '@/components/license-warning-banner'
import { BranchSelector } from '@/components/branch-selector'
import { BranchDataUnavailableBanner } from '@/components/branch-data-unavailable-banner'
import { useQuerySseBridge } from '@/hooks/use-query-sse-bridge'

function AppContent() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  // SSE → точечная инвалидация React Query кэшей (для мигрированных экранов).
  // Старые экраны на use-data-sync работают параллельно.
  useQuerySseBridge()
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
          {/* Селектор филиала для владельца сети (self-hides → empty:hidden). */}
          <div className="shrink-0 flex justify-end px-4 py-1.5 border-b border-border empty:hidden">
            <BranchSelector />
          </div>
          <BranchDataUnavailableBanner />
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
  // AuthProvider — в корне (src/main.tsx), здесь только guard + лицензия.
  return (
    <AuthGuard>
      <LicenseGate>
        {/* Sticky warning banner — показывается только при state=grace|softLocked. */}
        <LicenseWarningBanner />
        <AppContent />
      </LicenseGate>
    </AuthGuard>
  )
}
