'use client'

import { Link, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  MapPin,
  ClipboardList,
  ChefHat,
  UtensilsCrossed,
  Package,
  Truck,
  ScrollText,
  FlaskConical,
  BookOpen,
  Users,
  ClipboardCheck,
  History,
  TrendingDown,
  PieChart,
  TrendingUp,
  Scale,
  Wallet,
  CalendarClock,
  DollarSign,
  BarChart3,
  LineChart,
  CalendarDays,
  Smartphone,
  Target,
  Clock,
  ChevronDown,
  ChevronRight,
  Menu,
  X,
  LogOut,
  Building2,
  Trash2,
  Undo2,
  Monitor,
  Printer,
  Shield,
  Upload,
  DatabaseBackup,
  CookingPot,
  PackageMinus,
  PackagePlus,
  Bug,
  HandCoins,
  Receipt,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Minus,
  ShieldCheck,
  ArrowLeftRight,
  Boxes,
  Network,
  RefreshCw,
  ListChecks,
  Tags,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth-store'
import { useState, createContext, useContext, useEffect } from 'react'
import { DesktopUpdateButton } from '@/components/desktop-update-button'
import { BugReportDialog } from '@/components/bug-report-dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

// ─── Sidebar context for mobile toggle ────────────────────────────────────────

interface SidebarContextValue {
  open: boolean
  setOpen: (v: boolean) => void
  collapsed: boolean
  setCollapsed: (v: boolean) => void
}

const COLLAPSED_KEY = 'restos.sidebar.collapsed'

// ─── App zoom (per-device UI scale) ───────────────────────────────────────────
// Ported из v1 (../restos/components/app-sidebar.tsx:113). Кассир может
// увеличить/уменьшить весь интерфейс под свой экран/зрение. Стейт хранится
// в localStorage на устройство — другие кассиры за тем же ПК увидят свою
// настройку при логине, потому что ключ общий per-device. Применяется
// scaling root font-size (rem-based Tailwind классы масштабируются, но
// vh/vw/media queries остаются якорными к реальному viewport).

const ZOOM_KEY = 'restos.zoom'
const ZOOM_MIN = 50
const ZOOM_MAX = 200
const ZOOM_STEP = 10

function clampZoom(n: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n / ZOOM_STEP) * ZOOM_STEP))
}

function readZoom(): number {
  if (typeof window === 'undefined') return 100
  const saved = window.localStorage.getItem(ZOOM_KEY)
  const n = saved ? parseInt(saved, 10) : 100
  return Number.isFinite(n) ? clampZoom(n) : 100
}

function applyZoom(n: number) {
  if (typeof document === 'undefined') return
  document.documentElement.style.fontSize = `${n}%`
}

export function useAppZoom() {
  const [zoom, setZoomState] = useState<number>(() => readZoom())

  useEffect(() => {
    applyZoom(zoom)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ZOOM_KEY, String(zoom))
    }
  }, [zoom])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (e: StorageEvent) => {
      if (e.key === ZOOM_KEY && e.newValue) {
        const n = parseInt(e.newValue, 10)
        if (Number.isFinite(n)) setZoomState(clampZoom(n))
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return {
    zoom,
    increase: () => setZoomState((z) => clampZoom(z + ZOOM_STEP)),
    decrease: () => setZoomState((z) => clampZoom(z - ZOOM_STEP)),
    reset: () => setZoomState(100),
  }
}

export function ZoomControls() {
  const { zoom, increase, decrease, reset } = useAppZoom()
  return (
    <div className="mt-2 px-2 pt-2 border-t border-sidebar-border">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={decrease}
          disabled={zoom <= ZOOM_MIN}
          title="Уменьшить"
          className="size-8 rounded-md flex items-center justify-center text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Minus className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={reset}
          title="Сбросить (100%)"
          className="flex-1 h-8 rounded-md text-xs font-medium tabular-nums text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        >
          {zoom}%
        </button>
        <button
          type="button"
          onClick={increase}
          disabled={zoom >= ZOOM_MAX}
          title="Увеличить"
          className="size-8 rounded-md flex items-center justify-center text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

const SidebarContext = createContext<SidebarContextValue>({
  open: false,
  setOpen: () => {},
  collapsed: false,
  setCollapsed: () => {},
})

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(COLLAPSED_KEY) === '1'
  })

  const setCollapsed = (v: boolean) => {
    setCollapsedState(v)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0')
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (e: StorageEvent) => {
      if (e.key === COLLAPSED_KEY) setCollapsedState(e.newValue === '1')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return (
    <SidebarContext.Provider value={{ open, setOpen, collapsed, setCollapsed }}>
      {children}
    </SidebarContext.Provider>
  )
}

export function useSidebar() {
  return useContext(SidebarContext)
}

// ─── Nav data ─────────────────────────────────────────────────────────────────

interface NavItem {
  label: string
  href?: string
  icon?: React.ElementType
  children?: NavItem[]
  /**
   * Пункт-группа: внутри страницы переключаются вкладками (см. FinanceTabs).
   * Показываем пункт, если доступна ЛЮБАЯ из вкладок, и ведём на первую
   * доступную — иначе роль с частичным доступом теряла бы весь раздел.
   */
  group?: string[]
}

const NAV: NavItem[] = [
  { label: 'Дашборд', href: '/dashboard', icon: LayoutDashboard },
  {
    label: 'Операции',
    icon: UtensilsCrossed,
    children: [
      { label: 'POS-терминал', href: '/operations/pos', icon: Monitor },
      { label: 'Карта зала', href: '/operations/table-map', icon: MapPin },
      { label: 'Заказы', href: '/operations/orders', icon: ClipboardList },
      { label: 'Кухня', href: '/operations/kitchen', icon: ChefHat },
      { label: 'Приготовление', href: '/operations/batch-cooking', icon: CookingPot },
      { label: 'Витрина', href: '/operations/showcase', icon: UtensilsCrossed },
      { label: 'Смены', href: '/operations/shifts', icon: Clock },
    ],
  },
  {
    label: 'Склад',
    icon: Package,
    children: [
      // Редизайн: 4 раздела вместо 11 плоских пунктов. Частые действия — на
      // «Обзоре», редкие документы/справочники — в «Операциях».
      { label: 'Обзор', href: '/warehouse', icon: Boxes },
      { label: 'Остатки', href: '/warehouse/inventory', icon: Package },
      { label: 'Поставщики', href: '/warehouse/suppliers', icon: Truck },
      { label: 'Операции', href: '/warehouse/operations', icon: ListChecks },
      { label: 'Перемещения', href: '/warehouse/transfers', icon: ArrowLeftRight },
      { label: 'Номенклатура сети', href: '/warehouse/nomenclature', icon: Tags },
      { label: 'Меню сети', href: '/network/menu', icon: BookOpen },
    ],
  },
  {
    label: 'Финансы',
    icon: DollarSign,
    children: [
      // 5 пунктов вместо 9: связанные экраны собраны в группы и переключаются
      // вкладками внутри (FINANCE_GROUPS). URL страниц не менялись.
      { label: 'Обзор', href: '/finance/overview', icon: LayoutDashboard },
      {
        label: 'Отчёты', href: '/finance/cashflow', icon: TrendingUp,
        group: ['/finance/cashflow', '/finance/pnl', '/finance/balance'],
      },
      {
        label: 'Деньги', href: '/finance/accounts', icon: Wallet,
        group: ['/finance/accounts', '/finance/payments'],
      },
      {
        label: 'Расходы и бюджет', href: '/finance/expenses', icon: PieChart,
        group: ['/finance/expenses', '/finance/budget'],
      },
      {
        label: 'Персонал', href: '/finance/payroll', icon: Users,
        group: ['/finance/payroll', '/finance/service-report'],
      },
      { label: 'Сводка по сети', href: '/network/summary', icon: Network },
    ],
  },
  {
    label: 'Аналитика',
    icon: BarChart3,
    children: [
      { label: 'Продажи', href: '/analytics/sales-report', icon: Receipt },
      { label: 'Динамика', href: '/analytics/trends', icon: LineChart },
      { label: 'Дни недели', href: '/analytics/weekday', icon: CalendarDays },
      { label: 'ABC — Меню', href: '/analytics/abc-menu', icon: BarChart3 },
      { label: 'ABC — Склад', href: '/analytics/abc-inventory', icon: BarChart3 },
      { label: 'Аналитика столов', href: '/analytics/tables', icon: MapPin },
      { label: 'Аналитика официантов', href: '/analytics/waiters', icon: Users },
      { label: 'Пиковые часы', href: '/analytics/peak-hours', icon: Clock },
      { label: 'Себестоимость', href: '/analytics/food-cost', icon: TrendingDown },
      { label: 'Прогноз', href: '/analytics/forecast', icon: Target },
    ],
  },
  {
    label: 'Настройки',
    icon: Building2,
    children: [
      { label: 'Ресторан', href: '/settings', icon: Building2 },
      { label: 'Права доступа', href: '/settings/users', icon: Shield },
      { label: 'Филиалы сети', href: '/settings/branches', icon: Network },
      { label: 'Синхронизация', href: '/settings/sync', icon: RefreshCw },
      { label: 'Клиенты', href: '/settings/customers', icon: Users },
      { label: 'Импорт', href: '/settings/import', icon: Upload },
      { label: 'Приложение официанта', href: '/settings/waiter-app', icon: Smartphone },
      { label: 'Бэкап', href: '/settings/backup', icon: DatabaseBackup },
      { label: 'Принтеры', href: '/settings/printers', icon: Monitor },
      { label: 'Очередь печати', href: '/settings/printers/queue', icon: Printer },
      { label: 'История изменений', href: '/settings/audit', icon: History },
      { label: 'Лицензия', href: '/settings/license', icon: ShieldCheck },
    ],
  },
]

// ─── Nav item component ───────────────────────────────────────────────────────

function NavGroup({
  item,
  level = 0,
  onNavigate,
  collapsed = false,
  onExpandSidebar,
}: {
  item: NavItem
  level?: number
  onNavigate?: () => void
  collapsed?: boolean
  onExpandSidebar?: () => void
}) {
  const { pathname } = useLocation()
  // Exact match for leaf items that have sibling routes (e.g. /settings vs /settings/users)
  const hasChildren = item.children && item.children.length > 0
  // Пункт-группа активен на любой своей вкладке (на /finance/pnl горит «Отчёты»).
  const inGroup = (it: NavItem) =>
    !!it.group?.some((p) => pathname === p || pathname.startsWith(p + '/'))
  const isActive = inGroup(item)
    || (item.href ? (hasChildren ? pathname.startsWith(item.href) : pathname === item.href) : false)
  const hasActiveChild = item.children?.some(
    (c) => inGroup(c) || (c.href && (pathname === c.href || pathname.startsWith(c.href + '/')))
  )
  const [open, setOpen] = useState(hasActiveChild || false)

  if (item.href) {
    const Icon = item.icon
    return (
      <Link
        to={item.href || '/'}
        onClick={onNavigate}
        title={collapsed ? item.label : undefined}
        className={cn(
          'flex items-center gap-2.5 rounded-lg text-sm transition-colors',
          collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2.5',
          level === 0
            ? 'text-sidebar-foreground/80 hover:text-sidebar-foreground hover:bg-sidebar-accent'
            : 'text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60',
          isActive && 'bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary hover:text-sidebar-primary-foreground font-medium'
        )}
      >
        {Icon && <Icon className="size-4 shrink-0" />}
        {!collapsed && <span>{item.label}</span>}
      </Link>
    )
  }

  const Icon = item.icon

  if (collapsed) {
    return (
      <button
        onClick={() => onExpandSidebar?.()}
        title={item.label}
        className={cn(
          'flex items-center justify-center w-full px-2 py-2.5 rounded-lg transition-colors',
          hasActiveChild
            ? 'bg-sidebar-accent text-sidebar-foreground'
            : 'text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent'
        )}
      >
        {Icon && <Icon className="size-4 shrink-0" />}
      </button>
    )
  }

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full px-3 py-2.5 rounded-lg text-sm text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
      >
        <span className="flex items-center gap-2.5">
          {Icon && <Icon className="size-4 shrink-0" />}
          <span className="font-medium tracking-wide uppercase text-xs">{item.label}</span>
        </span>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
      {open && (
        <div className="mt-0.5 ml-2 pl-3 border-l border-sidebar-border space-y-0.5">
          {item.children?.map((child) => (
            <NavGroup key={child.href || child.label} item={child} level={level + 1} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Sidebar content (shared between desktop and mobile) ──────────────────────

function SidebarContent({
  onNavigate,
  collapsed = false,
  onToggleCollapsed,
}: {
  onNavigate?: () => void
  collapsed?: boolean
  onToggleCollapsed?: () => void
}) {
  const { user, restaurant, logout, hasAccess } = useAuth()
  const [logoutOpen, setLogoutOpen] = useState(false)

  // Filter nav items by user's access
  // Пункт-группа доступен, если открыта ХОТЯ БЫ одна вкладка; ведёт на первую
  // доступную. Обычный пункт — по своему href, как раньше.
  const resolveItem = (item: NavItem): NavItem | null => {
    if (item.group) {
      const firstAllowed = item.group.find((p) => hasAccess(p))
      return firstAllowed ? { ...item, href: firstAllowed } : null
    }
    if (item.href) return hasAccess(item.href) ? item : null
    return item
  }

  const filteredNav = NAV.map((item) => {
    if (item.children) {
      const children = item.children.map(resolveItem).filter(Boolean) as NavItem[]
      if (children.length === 0) return null
      return { ...item, children }
    }
    return resolveItem(item)
  }).filter(Boolean) as NavItem[]

  const initials = user ? user.name.split(' ').map(n => n[0]).join('') : '??'

  function handleLogout() {
    logout()
    window.location.href = '/login'
  }

  return (
    <>
      {/* Logo */}
      <div
        className={cn(
          'flex items-center gap-2.5 border-b border-sidebar-border',
          collapsed ? 'justify-center px-2 py-4' : 'px-4 py-4'
        )}
      >
        <div className="size-8 rounded-lg bg-sidebar-primary flex items-center justify-center shrink-0">
          <UtensilsCrossed className="size-4.5 text-sidebar-primary-foreground" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sidebar-foreground font-bold text-base leading-none">RestOS</span>
              {typeof window !== 'undefined' && (window as any).restosDesktop?.version && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sidebar-primary/15 text-sidebar-primary leading-none">
                  v{(window as any).restosDesktop.version}
                </span>
              )}
            </div>
            <div className="text-sidebar-foreground/40 text-xs mt-1 truncate">{restaurant?.name || 'Ресторан'}</div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {filteredNav.map((item) => (
          <NavGroup
            key={item.href || item.label}
            item={item}
            onNavigate={onNavigate}
            collapsed={collapsed}
            onExpandSidebar={() => onToggleCollapsed?.()}
          />
        ))}
        {!collapsed && <ZoomControls />}
      </nav>

      {!collapsed && (
        <>
          {/* Desktop-only: update check + waiter connect */}
          <DesktopUpdateButton />
          {typeof window !== 'undefined' && (window as any).restosDesktop?.connectUrl && (
            <div className="px-3 pb-1">
              <button
                onClick={() => {
                  // Открываем /show-qr внутри HashRouter'а — там QRCode.toDataURL
                  // с LAN-адресом этой кассы. Раньше тут было window.open() на
                  // http://localhost:3001/connect — v1 Express endpoint, которого
                  // в v4 Go-бэке нет → 404 в новом окне.
                  window.location.hash = '#/show-qr'
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-sidebar-primary/10 hover:bg-sidebar-primary/20 transition-colors text-sm text-sidebar-primary font-medium"
              >
                <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><path d="M14 14h4v4h-4z"/><path d="M18 18h4v4"/><path d="M14 22h4"/><path d="M22 14v4"/></svg>
                Подключить официантов
              </button>
            </div>
          )}

          {/* Bug Report */}
          <BugReportButton />
        </>
      )}

      {/* User */}
      <div
        className={cn(
          'border-t border-sidebar-border',
          collapsed ? 'px-2 py-3' : 'px-3 py-3'
        )}
      >
        {collapsed ? (
          <div className="flex flex-col items-center gap-1.5">
            <div
              className="size-8 rounded-full bg-sidebar-primary/20 flex items-center justify-center text-sidebar-primary text-xs font-bold"
              title={user?.name ?? 'Гость'}
            >
              {initials}
            </div>
            <button
              onClick={() => setLogoutOpen(true)}
              title="Выйти"
              className="p-1.5 rounded hover:bg-sidebar-accent transition-colors"
            >
              <LogOut className="size-4 text-sidebar-foreground/40 hover:text-sidebar-foreground/70 transition-colors" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-sidebar-accent transition-colors cursor-pointer">
            <div className="size-8 rounded-full bg-sidebar-primary/20 flex items-center justify-center text-sidebar-primary text-xs font-bold">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sidebar-foreground text-sm font-medium">{user?.name ?? 'Гость'}</div>
              <div className="text-sidebar-foreground/40 text-xs">{user?.roleDisplay ?? ''}</div>
            </div>
            <button onClick={() => setLogoutOpen(true)} className="p-1 rounded hover:bg-sidebar-accent transition-colors">
              <LogOut className="size-4 text-sidebar-foreground/30 hover:text-sidebar-foreground/60 transition-colors shrink-0" />
            </button>
          </div>
        )}
      </div>

      {/* Logout confirmation */}
      <AlertDialog open={logoutOpen} onOpenChange={setLogoutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Выйти из аккаунта?</AlertDialogTitle>
            <AlertDialogDescription>
              Вам потребуется снова войти, чтобы продолжить работу.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={handleLogout}>Выйти</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Collapse / expand toggle (desktop only) */}
      {onToggleCollapsed && (
        <div className="hidden md:block border-t border-sidebar-border">
          <button
            onClick={onToggleCollapsed}
            title={collapsed ? 'Развернуть' : 'Свернуть'}
            className={cn(
              'flex items-center gap-2 w-full text-xs text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors',
              collapsed ? 'justify-center px-2 py-3' : 'justify-end px-4 py-2.5'
            )}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : (
              <>
                <span>Свернуть</span>
                <PanelLeftClose className="size-4" />
              </>
            )}
          </button>
        </div>
      )}
    </>
  )
}

function BugReportButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="px-3 pb-1">
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 w-full px-3 py-2 text-xs text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent rounded-lg transition-colors"
        >
          <Bug className="size-3.5" />
          Сообщить об ошибке
        </button>
      </div>
      <BugReportDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}

// ─── Mobile header ────────────────────────────────────────────────────────────

export function MobileHeader() {
  const { open, setOpen } = useSidebar()
  const { user } = useAuth()
  const { pathname } = useLocation()

  // Get current page title from nav
  let pageTitle = 'RestOS'
  for (const item of NAV) {
    if (item.href === pathname) { pageTitle = item.label; break }
    if (item.children) {
      const child = item.children.find(c => c.href === pathname)
      if (child) { pageTitle = child.label; break }
    }
  }

  const initials = user ? user.name.split(' ').map(n => n[0]).join('') : '??'

  return (
    <header className="md:hidden flex items-center justify-between px-4 py-3 bg-sidebar border-b border-sidebar-border sticky top-0 z-40">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setOpen(!open)}
          className="size-9 rounded-lg bg-sidebar-accent flex items-center justify-center text-sidebar-foreground"
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
        <div className="flex items-center gap-2">
          <div className="size-7 rounded-md bg-sidebar-primary flex items-center justify-center">
            <UtensilsCrossed className="size-3.5 text-sidebar-primary-foreground" />
          </div>
          <span className="text-sidebar-foreground font-semibold text-sm">{pageTitle}</span>
        </div>
      </div>
      <div className="size-7 rounded-full bg-sidebar-primary/20 flex items-center justify-center text-sidebar-primary text-xs font-bold">
        {initials}
      </div>
    </header>
  )
}

// ─── Mobile drawer ────────────────────────────────────────────────────────────

export function MobileSidebar() {
  const { open, setOpen } = useSidebar()

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="md:hidden fixed inset-0 bg-black/50 z-40"
        onClick={() => setOpen(false)}
      />
      {/* Drawer */}
      <aside className="md:hidden fixed inset-y-0 left-0 w-72 bg-sidebar z-50 flex flex-col shadow-2xl animate-in slide-in-from-left duration-200">
        <SidebarContent onNavigate={() => setOpen(false)} />
      </aside>
    </>
  )
}

// ─── Desktop sidebar ──────────────────────────────────────────────────────────

export function AppSidebar() {
  const { collapsed, setCollapsed } = useSidebar()
  return (
    <aside
      className={cn(
        'hidden md:flex flex-col shrink-0 bg-sidebar border-r border-sidebar-border h-screen sticky top-0 transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-60'
      )}
    >
      <SidebarContent collapsed={collapsed} onToggleCollapsed={() => setCollapsed(!collapsed)} />
    </aside>
  )
}
