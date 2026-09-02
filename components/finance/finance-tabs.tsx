'use client'

import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'

// Группы раздела «Финансы». Экраны логически связаны, поэтому показываются
// вкладками внутри группы, а в меню — одним пунктом.
//
// ВАЖНО: URL-ы страниц НЕ меняются. Права ролей привязаны к конкретным путям
// (PERMISSION_NAV_MAP: finance.view → /finance/cashflow, /finance/pnl, …), и
// перенос страниц на новые адреса отобрал бы доступ у бухгалтера. Группировка
// здесь — чисто навигационная: вкладки ссылаются на существующие маршруты.

export interface FinanceTab {
  label: string
  href: string
}

export interface FinanceGroup {
  key: string
  label: string
  tabs: FinanceTab[]
}

export const FINANCE_GROUPS: FinanceGroup[] = [
  {
    key: 'reports',
    label: 'Отчёты',
    tabs: [
      { label: 'ДДС', href: '/finance/cashflow' },
      { label: 'ОПиУ', href: '/finance/pnl' },
      { label: 'Баланс', href: '/finance/balance' },
    ],
  },
  {
    key: 'money',
    label: 'Деньги',
    tabs: [
      { label: 'Счета и касса', href: '/finance/accounts' },
      { label: 'Платежи', href: '/finance/payments' },
      { label: 'Переводы в сети', href: '/finance/network-transfers' },
    ],
  },
  {
    key: 'costs',
    label: 'Расходы и бюджет',
    tabs: [
      { label: 'Расходы по статьям', href: '/finance/expenses' },
      { label: 'Бюджет', href: '/finance/budget' },
    ],
  },
  {
    key: 'staff',
    label: 'Персонал',
    tabs: [
      { label: 'Зарплата', href: '/finance/payroll' },
      { label: 'Учёт времени', href: '/finance/schedule' },
      { label: 'Обслуживание', href: '/finance/service-report' },
    ],
  },
]

/** Группа, которой принадлежит путь (для подсветки пункта меню и вкладок). */
export function financeGroupOf(pathname: string): FinanceGroup | undefined {
  return FINANCE_GROUPS.find((g) => g.tabs.some((t) => pathname === t.href || pathname.startsWith(t.href + '/')))
}

/**
 * Полоса вкладок группы. Рендерится вверху каждой страницы группы; вкладки,
 * недоступные роли, скрываются. Если доступна одна вкладка — полосу не
 * показываем (переключать не между чем).
 */
export function FinanceTabs() {
  const { pathname } = useLocation()
  const { hasAccess } = useAuth()
  const group = financeGroupOf(pathname)
  if (!group) return null

  const tabs = group.tabs.filter((t) => hasAccess(t.href))
  if (tabs.length < 2) return null

  return (
    <div className="flex gap-1 bg-muted/50 p-1 rounded-xl w-fit max-w-full overflow-x-auto">
      {tabs.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + '/')
        return (
          <Link
            key={t.href}
            to={t.href}
            className={`px-3.5 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              active ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
