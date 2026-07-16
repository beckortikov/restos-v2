'use client'

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  ROLE_DEFAULT_PERMISSIONS,
  buildNavFromPermissions,
  type User, type UserRole, type UserPermissions, type Restaurant, type PermissionKey,
} from '@/lib/types'
import { api, unwrap, setV4Token, clearV4Token, getV4Token, getV4RestaurantId, clearV4RestaurantId, v4ErrorMessage } from '@/lib/api'
import { mapRestaurantRow } from '@/lib/queries/_mappers'
import * as Sentry from '@sentry/react'
import { queryClient } from '@/lib/query-client'

// Default redirect after login per role
const ROLE_HOME: Record<UserRole, string> = {
  superadmin: '/admin',
  owner: '/dashboard',
  manager: '/dashboard',
  waiter: '/waiter/tables',
  cashier: '/operations/pos',
  cook: '/operations/kitchen',
  storekeeper: '/warehouse/inventory',
  accountant: '/finance/cashflow',
  other: '/dashboard',
}

// ─── Context ─────────────────────────────────────────────────────────────────

interface AuthContextValue {
  user: User | null
  restaurant: Restaurant | null
  restaurantId: string | null
  loading: boolean
  /** PIN-based login: restaurant_id берётся из localStorage (после bootstrap). */
  login: (pin: string) => Promise<{ ok: boolean; error?: string }>
  logout: () => void
  updateRestaurant: (r: Restaurant) => void
  hasAccess: (path: string) => boolean
  canAccessRoles: (roles: UserRole[]) => boolean
  canDo: (action: PermissionKey) => boolean
  homeRoute: string
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  restaurant: null,
  restaurantId: null,
  loading: true,
  login: async () => ({ ok: false }),
  logout: () => {},
  updateRestaurant: () => {},
  hasAccess: () => false,
  canAccessRoles: () => false,
  canDo: () => false,
  homeRoute: '/dashboard',
})

export function useAuth() {
  return useContext(AuthContext)
}

// ─── Auth Guard ──────────────────────────────────────────────────────────────

export function AuthGuard({ children }: { children: ReactNode }) {
  const { user, loading, hasAccess, homeRoute } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  useEffect(() => {
    if (loading) return
    if (!user) {
      navigate('/login', { replace: true })
      return
    }
    if (!hasAccess(pathname)) {
      navigate(homeRoute || '/dashboard', { replace: true })
    }
  }, [user, loading, pathname, navigate, hasAccess, homeRoute])

  if (loading || !user) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  return <>{children}</>
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getUserPermissions(user: User): UserPermissions {
  const roleDefaults = ROLE_DEFAULT_PERMISSIONS[user.role] || { nav: [], actions: {} }
  const custom = user.permissions
  if (custom && Object.keys(custom.actions || {}).length > 0) {
    // Merge: дефолты роли — подложкой, персональные оверрайды — сверху.
    // Иначе права, добавленные в ALL_PERMISSIONS ПОСЛЕ сохранения сотрудника,
    // молча выключались бы (старый кастом-набор их не содержит) — из-за чего
    // «возврат / другая фича не работает» у кастомизированных пользователей.
    // Явный false в кастоме по-прежнему перекрывает дефолтный true.
    return {
      nav: custom.nav && custom.nav.length > 0 ? custom.nav : roleDefaults.nav,
      actions: { ...roleDefaults.actions, ...custom.actions },
    }
  }
  return roleDefaults
}

// ─── Provider ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'restos-auth-user'
const RESTAURANT_STORAGE_KEY = 'restos-restaurant'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null)
  const [loading, setLoading] = useState(true)

  // Restore from localStorage on mount; токен валидируется первым же API-вызовом.
  useEffect(() => {
    let storedRid: string | undefined
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      const storedRestaurant = localStorage.getItem(RESTAURANT_STORAGE_KEY)
      const tok = getV4Token()
      if (stored && tok) {
        const parsed = JSON.parse(stored) as User
        if (parsed?.id) setUser(parsed)
      }
      if (storedRestaurant) {
        const parsed = JSON.parse(storedRestaurant) as Restaurant
        if (parsed?.id) { setRestaurant(parsed); storedRid = parsed.id }
      }
    } catch {}
    setLoading(false)

    // Освежаем ресторан из БД в фоне. localStorage может быть устаревшим:
    // настройки (tech_cards_enabled, service_percent, …) могли изменить на
    // другом терминале или в прошлой сессии — без рефетча useAuth().restaurant
    // врёт (баг: create-menu-item-dialog показывал техкарту, хотя она выключена
    // в настройках; settings-страница грузит свежее из БД и расходилась).
    try {
      const tok = getV4Token()
      const rid = storedRid || getV4RestaurantId()
      if (tok && rid) {
        void (async () => {
          try {
            const restResp: any = await unwrap(api.GET('/api/v1/restaurants/{id}', { params: { path: { id: rid } }, headers: { 'X-Skip-Auth-Expire': '1' } }))
            if (restResp) {
              const rest = mapResponseRestaurant(restResp)
              setRestaurant(rest)
              localStorage.setItem(RESTAURANT_STORAGE_KEY, JSON.stringify(rest))
            }
          } catch {}
        })()
      }
    } catch {}
  }, [])

  // Глобальный слушатель: при 401 от любого v4-вызова — выкидываем пользователя.
  useEffect(() => {
    function onExpired() {
      logout()
    }
    window.addEventListener('restos:auth:expired', onExpired)
    return () => window.removeEventListener('restos:auth:expired', onExpired)
  }, [])

  async function login(pin: string) {
    const rid = getV4RestaurantId()
    if (!rid) {
      return { ok: false, error: 'Ресторан не инициализирован. Откройте /bootstrap.' }
    }
    try {
      const r: any = await unwrap(api.POST('/api/v1/auth/login', {
        body: { restaurant_id: rid, pin } as any,
      }))
      setV4Token(r.token)

      // Маппинг session → User (минимально-необходимая форма).
      const mapped: User = {
        id: r.session.user_id,
        name: r.session.user_name || '',
        username: r.session.user_name || '',
        role: (r.session.role as UserRole) || 'other',
        restaurantId: r.session.restaurant_id,
        permissions: undefined,
        // Прочие поля заполняются после /users/{id} ниже (lazy).
      } as User

      setUser(mapped)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mapped))
      Sentry.setUser({ id: mapped.id, username: mapped.name, extra: { role: mapped.role, restaurantId: mapped.restaurantId } })

      // Подтянуть детальный профиль (permissions) + ресторан в фоне.
      // X-Skip-Auth-Expire: транзиентный 401 этих фоновых дозагрузок не должен
      // выкидывать только что вошедшего кассира обратно на PIN.
      const bg = { headers: { 'X-Skip-Auth-Expire': '1' } }
      void (async () => {
        try {
          const userResp: any = await unwrap(api.GET('/api/v1/users/{id}', { params: { path: { id: mapped.id } }, ...bg }))
          if (userResp) {
            const full = { ...mapped, ...mapResponseUser(userResp) }
            setUser(full)
            localStorage.setItem(STORAGE_KEY, JSON.stringify(full))
          }
        } catch {}
        try {
          const restResp: any = await unwrap(api.GET('/api/v1/restaurants/{id}', { params: { path: { id: rid } }, ...bg }))
          if (restResp) {
            const rest = mapResponseRestaurant(restResp)
            setRestaurant(rest)
            localStorage.setItem(RESTAURANT_STORAGE_KEY, JSON.stringify(rest))
          }
        } catch {}
      })()

      return { ok: true }
    } catch (e) {
      return { ok: false, error: v4ErrorMessage(e) || 'Неверный PIN' }
    }
  }

  function logout() {
    const token = getV4Token()
    setUser(null)
    setRestaurant(null)
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(RESTAURANT_STORAGE_KEY)
    clearV4Token()
    Sentry.setUser(null)
    try {
      queryClient.cancelQueries()
      queryClient.clear()
    } catch {}
    if (token) {
      void api.POST('/api/v1/auth/logout', {
        body: undefined as any,
        headers: { Authorization: `Bearer ${token}`, 'X-Skip-Auth-Expire': '1' },
      }).catch(() => {})
    }
  }

  function updateRestaurant(r: Restaurant) {
    setRestaurant(r)
    localStorage.setItem(RESTAURANT_STORAGE_KEY, JSON.stringify(r))
  }

  // ─── Permission checks ──────────────────────────────────────────────────────

  function canDo(action: PermissionKey): boolean {
    if (!user) return false
    if (user.role === 'owner') return true
    const perms = getUserPermissions(user)
    return perms.actions[action] === true
  }

  function hasAccess(path: string): boolean {
    if (!user) return false
    if (user.role === 'owner' || user.role === 'manager') return true
    if (user.role === 'superadmin') return path.startsWith('/admin')

    const perms = getUserPermissions(user)
    const navPaths = buildNavFromPermissions(perms)
    if (navPaths.includes('*')) return true

    return navPaths.some(p => path === p || path.startsWith(p + '/'))
  }

  function canAccessRoles(roles: UserRole[]): boolean {
    if (!user) return false
    if (user.role === 'owner') return true
    return roles.includes(user.role)
  }

  let homeRoute = user ? ROLE_HOME[user.role] : '/login'
  if (user?.role === 'waiter' && typeof window !== 'undefined') {
    try {
      const pref = localStorage.getItem('restos-waiter-home-screen')
      if (pref === 'menu') homeRoute = '/waiter/order/new'
    } catch {}
  }
  const restaurantId = user?.restaurantId || getV4RestaurantId() || null

  return (
    <AuthContext.Provider value={{ user, restaurant, restaurantId, loading, login, logout, updateRestaurant, hasAccess, canAccessRoles, canDo, homeRoute }}>
      {children}
    </AuthContext.Provider>
  )
}

// ─── Mappers (v4 snake_case → frontend camelCase) ───────────────────────────

function mapResponseUser(row: any): Partial<User> {
  return {
    id: row.id,
    name: row.name,
    username: row.name,
    role: row.role,
    restaurantId: row.restaurant_id,
    permissions: row.permissions,
    avatarUrl: row.avatar_url,
    phone: row.phone,
    email: row.email,
  } as Partial<User>
}

// Единый маппер из lib/queries/_mappers — свой локальный дубликат уже дважды
// терял поля (tech_cards_enabled → false; pin_lock_enabled вообще не мапился,
// из-за чего фоновый рефетч ресторана стирал флаг и PIN-автоблокировка POS
// молча выключалась).
function mapResponseRestaurant(row: any): Restaurant {
  return mapRestaurantRow(row)
}
