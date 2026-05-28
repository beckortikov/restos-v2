import { Outlet } from 'react-router-dom'
import { AuthProvider } from '@/lib/auth-store'

export function AuthLayout() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  )
}
