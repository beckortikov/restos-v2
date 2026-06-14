import { Outlet } from 'react-router-dom'

// AuthProvider живёт в корне (src/main.tsx). Здесь — просто Outlet.
export function AuthLayout() {
  return <Outlet />
}
