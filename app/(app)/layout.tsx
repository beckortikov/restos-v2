'use client'

import { useEffect } from 'react'
import { AuthProvider, AuthGuard, useAuth } from '@/lib/auth-store'
import { AppSidebar, MobileHeader, MobileSidebar, SidebarProvider } from '@/components/app-sidebar'
import { CashierShell } from '@/components/cashier-shell'
import { Toaster } from '@/components/ui/sonner'
import { AutoPrintRunner } from '@/components/auto-print-runner'
import { PwaUpdater } from '@/components/pwa-updater'
import { InstallPwaPrompt } from '@/components/install-pwa-prompt'
import { LocalServerGuard } from '@/components/local-server-guard'
import { startLocalServerHealthProbe, stopLocalServerHealthProbe } from '@/lib/local-server-health'

function LocalServerHealth() {
  useEffect(() => {
    startLocalServerHealthProbe()
    return () => stopLocalServerHealthProbe()
  }, [])
  return null
}

function RoleAwareChrome({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()

  if (user?.role === 'cashier') {
    return (
      <LocalServerGuard>
        <CashierShell>{children}</CashierShell>
      </LocalServerGuard>
    )
  }

  return (
    <LocalServerGuard>
      <div className="flex h-[100dvh] bg-background overflow-hidden safe-area-x safe-area-top">
        <AppSidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <MobileHeader />
          <MobileSidebar />
          <main className="flex-1 overflow-y-auto">
            {children}
          </main>
        </div>
      </div>
    </LocalServerGuard>
  )
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AuthGuard>
        <SidebarProvider>
          <RoleAwareChrome>{children}</RoleAwareChrome>
          <Toaster richColors position="top-center" />
          <LocalServerHealth />
          <PwaUpdater />
          <InstallPwaPrompt />
          <AutoPrintRunner />
        </SidebarProvider>
      </AuthGuard>
    </AuthProvider>
  )
}
