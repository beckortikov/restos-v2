'use client'

import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import {
  Users, Printer, Link2, RefreshCw, Lock, ChevronRight, Trash2, CookingPot,
  ChefHat, BookOpen, FlaskConical, Package, ScrollText, ClipboardCheck, History,
  Truck, TrendingDown, TrendingUp, Scale, Wallet, Target, HandCoins,
  BarChart3, Upload, FileClock,
} from 'lucide-react'
import { useAuth } from '@/lib/auth-store'
import type { PermissionKey } from '@/lib/types'

type DesktopUpdateState = {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'not-available' | 'error'
  version: string | null
  percent: number
}

function useDesktopUpdate() {
  const isDesktop = typeof window !== 'undefined' && !!(window as any).restosDesktop?.isDesktop
  const [state, setState] = useState<DesktopUpdateState>({ status: 'idle', version: null, percent: 0 })

  useEffect(() => {
    if (!isDesktop) return
    const d = (window as any).restosDesktop
    let cancelled = false
    if (typeof d?.getUpdateStatus === 'function') {
      d.getUpdateStatus().then((s: DesktopUpdateState) => { if (!cancelled) setState(s) }).catch(() => {})
    }
    if (typeof d?.onUpdateStatus === 'function') {
      d.onUpdateStatus((s: DesktopUpdateState) => { if (!cancelled) setState(s) })
    }
    return () => { cancelled = true }
  }, [isDesktop])

  return { isDesktop, ...state }
}

type SectionId =
  | 'cash' | 'clients' | 'kitchen' | 'warehouse' | 'finance' | 'reports' | 'system'

const SECTION_LABELS: Record<SectionId, string> = {
  cash: 'Касса',
  clients: 'Клиенты',
  kitchen: 'Кухня и заготовки',
  warehouse: 'Склад',
  finance: 'Финансы',
  reports: 'Отчёты',
  system: 'Система',
}

interface CardItem {
  section: SectionId
  href?: string
  onClick?: () => void
  icon: React.ElementType
  label: string
  description: string
  badge?: string
  badgeIconSpin?: boolean
}

export default function CashierSettingsPage() {
  const { canDo, restaurant } = useAuth()
  const update = useDesktopUpdate()
  const desktopVersion = typeof window !== 'undefined' ? (window as any).restosDesktop?.version : undefined
  const connectUrl = typeof window !== 'undefined' ? (window as any).restosDesktop?.connectUrl : undefined
  const pinEnabled = restaurant?.pinLockEnabled ?? false

  function handleConnectWaiters() {
    // Кассир показывает QR официантам — отдельная страница /show-qr,
    // которая генерирует QR с LAN-адресом этой кассы.
    void connectUrl
    window.location.hash = '#/show-qr'
  }

  async function handleUpdate() {
    if (!update.isDesktop) return
    const d = (window as any).restosDesktop
    if (update.status === 'ready') {
      try { d?.installUpdate?.() } catch {}
      return
    }
    try { await d?.checkForUpdate?.() } catch {}
  }

  function handleLockSwitch() {
    window.dispatchEvent(new CustomEvent('cashier:lock-request'))
  }

  const updateLabel =
    update.status === 'ready' ? 'Перезапустить для установки' :
    update.status === 'downloading' ? `Загрузка ${update.percent}%` :
    update.status === 'available' ? 'Доступно обновление' :
    update.status === 'checking' ? 'Проверка…' :
    update.status === 'not-available' ? 'Установлена последняя версия' :
    'Проверить обновления'

  // Declarative card list. `gate()` returns whether this card is visible.
  const items: CardItem[] = [
    // Касса
    pinEnabled && {
      section: 'cash', icon: Lock, label: 'Сменить пользователя',
      description: 'Заблокировать экран и войти по PIN',
      onClick: handleLockSwitch,
    },
    canDo('printers.manage') && {
      section: 'cash', icon: Printer, href: '/settings/printers',
      label: 'Принтеры', description: 'Чеки и кухонные станции',
    },

    // Клиенты
    canDo('customers.manage') && {
      section: 'clients', icon: Users, href: '/settings/customers',
      label: 'Клиенты', description: 'База постоянных гостей и скидки',
    },

    // Кухня и заготовки
    canDo('kitchen.cooking') && {
      section: 'kitchen', icon: ChefHat, href: '/operations/kitchen',
      label: 'Кухня', description: 'Заказы на приготовление по станциям',
    },
    canDo('batch_cooking.manage') && {
      section: 'kitchen', icon: CookingPot, href: '/operations/batch-cooking',
      label: 'Приготовление', description: 'Заготовки и партии блюд',
    },
    canDo('writeoffs.create') && {
      section: 'kitchen', icon: Trash2, href: '/warehouse/writeoffs',
      label: 'Списания', description: 'Списать продукты по причине',
    },

    // Склад
    canDo('menu.view') && {
      section: 'warehouse', icon: BookOpen, href: '/warehouse/menu',
      label: 'Меню', description: 'Блюда, цены и техкарты',
    },
    canDo('menu.edit') && {
      section: 'warehouse', icon: FlaskConical, href: '/warehouse/semi',
      label: 'Полуфабрикаты', description: 'Производство и составы',
    },
    canDo('inventory.view') && {
      section: 'warehouse', icon: Package, href: '/warehouse/inventory',
      label: 'Остатки', description: 'Складские позиции и количества',
    },
    canDo('inventory.manage') && {
      section: 'warehouse', icon: ScrollText, href: '/warehouse/receipts',
      label: 'Накладные', description: 'Поступление товара',
    },
    canDo('inventory.manage') && {
      section: 'warehouse', icon: ClipboardCheck, href: '/warehouse/inventory-check',
      label: 'Инвентаризация', description: 'Сверка фактических остатков',
    },
    canDo('inventory.manage') && {
      section: 'warehouse', icon: History, href: '/warehouse/history',
      label: 'История движений', description: 'Все операции со складом',
    },
    canDo('suppliers.manage') && {
      section: 'warehouse', icon: Truck, href: '/warehouse/suppliers',
      label: 'Поставщики', description: 'База контрагентов',
    },

    // Финансы
    canDo('finance.view') && {
      section: 'finance', icon: TrendingDown, href: '/finance/cashflow',
      label: 'ДДС', description: 'Движение денежных средств',
    },
    canDo('finance.view') && {
      section: 'finance', icon: TrendingUp, href: '/finance/pnl',
      label: 'ОПиУ', description: 'Отчёт о прибылях и убытках',
    },
    canDo('finance.view') && {
      section: 'finance', icon: Scale, href: '/finance/balance',
      label: 'Баланс', description: 'Активы, обязательства, капитал',
    },
    canDo('finance.manage') && {
      section: 'finance', icon: Wallet, href: '/finance/accounts',
      label: 'Счета и касса', description: 'Управление счетами',
    },
    canDo('finance.manage') && {
      section: 'finance', icon: Target, href: '/finance/budget',
      label: 'Бюджет', description: 'План и факт по статьям',
    },
    canDo('payroll.manage') && {
      section: 'finance', icon: HandCoins, href: '/finance/payroll',
      label: 'Зарплата', description: 'Начисления и выплаты',
    },

    // Отчёты
    canDo('analytics.view') && {
      section: 'reports', icon: BarChart3, href: '/analytics/abc-menu',
      label: 'Аналитика', description: 'ABC-анализ, столы, официанты, прогноз',
    },
    canDo('audit.view') && {
      section: 'reports', icon: FileClock, href: '/settings/audit',
      label: 'История изменений', description: 'Журнал действий пользователей',
    },

    // Система
    !!connectUrl && {
      section: 'system', icon: Link2, label: 'Подключить официантов',
      description: 'QR-код для входа с телефона',
      onClick: handleConnectWaiters,
    },
    update.isDesktop && {
      section: 'system', icon: RefreshCw, label: 'Обновление',
      description: `${updateLabel}${desktopVersion ? ` · v${desktopVersion}` : ''}`,
      onClick: handleUpdate,
      badgeIconSpin: update.status === 'checking' || update.status === 'downloading',
    },
    canDo('data.import') && {
      section: 'system', icon: Upload, href: '/settings/import',
      label: 'Импорт данных', description: 'Меню, остатки, клиенты',
    },
  ].filter(Boolean) as CardItem[]

  // Group by section preserving insertion order.
  const sectionsInOrder: SectionId[] = ['cash', 'clients', 'kitchen', 'warehouse', 'finance', 'reports', 'system']
  const grouped = sectionsInOrder
    .map(id => ({ id, label: SECTION_LABELS[id], items: items.filter(it => it.section === id) }))
    .filter(g => g.items.length > 0)

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 bg-muted/30">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-xl md:text-2xl font-bold text-foreground mb-1">Настройки</h1>
        <p className="text-sm text-muted-foreground mb-5">Доступные разделы зависят от выданных вам прав</p>

        <div className="space-y-6">
          {grouped.map(group => (
            <section key={group.id}>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">
                {group.label}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {group.items.map((item, idx) => {
                  const Icon = item.icon
                  const content = (
                    <>
                      <div className="size-11 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                        <Icon className={`size-5 ${item.badgeIconSpin ? 'animate-spin' : ''}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm text-foreground">{item.label}</div>
                        <div className="text-xs text-muted-foreground">{item.description}</div>
                      </div>
                      <ChevronRight className="size-4 text-muted-foreground/50 group-hover:text-foreground transition-colors" />
                    </>
                  )
                  const cls = 'group flex items-center gap-3 p-4 rounded-xl bg-card border border-border hover:border-primary/40 hover:shadow-sm transition-all text-left'
                  if (item.href) {
                    return <Link key={`${group.id}-${idx}`} to={item.href} className={cls}>{content}</Link>
                  }
                  return <button key={`${group.id}-${idx}`} onClick={item.onClick} className={cls}>{content}</button>
                })}
              </div>
            </section>
          ))}
        </div>

        {grouped.length === 0 && (
          <div className="text-center text-muted-foreground text-sm py-12">
            Нет доступных разделов настроек
          </div>
        )}
      </div>
    </div>
  )
}
