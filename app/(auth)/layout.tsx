'use client'

import { AuthProvider } from '@/lib/auth-store'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}
