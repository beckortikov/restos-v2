'use client'

import { Link } from 'react-router-dom'
import {
  ScrollText, Undo2, Trash2, PackageMinus,
  ClipboardCheck, PackagePlus, History,
  FlaskConical, BookOpen, ChevronRight,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Хаб операций склада (редизайн). Редкие документы и справочники, которые
// раньше висели плоским рядом в сайдбаре, собраны сюда и сгруппированы —
// ежедневное (приёмка/списание/инвентаризация) вынесено на «Обзор».

type Op = { to: string; label: string; hint?: string; icon: LucideIcon; tone?: 'brand' | 'warn' | 'danger' }
type Group = { title: string; items: Op[] }

const GROUPS: Group[] = [
  {
    title: 'Документы',
    items: [
      { to: '/warehouse/receipts', label: 'Накладные', hint: 'приход от поставщиков', icon: ScrollText, tone: 'brand' },
      { to: '/warehouse/returns', label: 'Возвраты', hint: 'оформить · история', icon: Undo2, tone: 'danger' },
      { to: '/warehouse/writeoffs', label: 'Списания', hint: 'брак · порча', icon: Trash2, tone: 'warn' },
      { to: '/warehouse/supply-expenses', label: 'Расход хозтоваров', hint: 'выдать со склада', icon: PackageMinus },
    ],
  },
  {
    title: 'Учёт',
    items: [
      { to: '/warehouse/inventory-check', label: 'Инвентаризация', hint: 'факт vs учёт', icon: ClipboardCheck },
      { to: '/warehouse/opening-balance', label: 'Начальный остаток', hint: 'первичный ввод', icon: PackagePlus },
      { to: '/warehouse/history', label: 'История движений', hint: 'все операции склада', icon: History },
    ],
  },
  {
    title: 'Справочники',
    items: [
      { to: '/warehouse/semi', label: 'Полуфабрикаты', hint: 'рецептуры и производство', icon: FlaskConical },
      { to: '/warehouse/menu', label: 'Меню / Техкарты', hint: 'блюда и себестоимость', icon: BookOpen },
    ],
  },
]

const TONE: Record<string, string> = {
  brand: 'bg-primary/10 text-primary',
  warn: 'bg-amber-100 dark:bg-amber-500/15 text-amber-600',
  danger: 'bg-red-100 dark:bg-red-500/15 text-destructive',
  default: 'bg-muted text-foreground/70',
}

export default function WarehouseOperationsPage() {
  return (
    <div className="p-4 md:p-6 space-y-5 max-w-3xl mx-auto">
      <div>
        <h1 className="text-xl font-bold text-foreground">Операции</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Документы и справочники склада</p>
      </div>

      {GROUPS.map(group => (
        <div key={group.title} className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-1">{group.title}</p>
          <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
            {group.items.map(({ to, label, hint, icon: Icon, tone }) => (
              <Link key={to} to={to} className="flex items-center gap-3 px-4 py-3.5 hover:bg-muted/40 transition-colors">
                <span className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${TONE[tone ?? 'default']}`}>
                  <Icon className="size-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{label}</p>
                  {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
                </div>
                <ChevronRight className="size-5 text-muted-foreground shrink-0" />
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
