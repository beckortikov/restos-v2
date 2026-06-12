'use client'

// Карточка активного заказа для card-grid в табах «Все/Зал/С собой» страницы
// /operations/orders. Высокая плотность, левая цветная полоса по типу, краткий
// состав, бейдж статуса, имя официанта, сумма, две кнопки (Оплатить/Отменить).
// Клик по самой карточке (не по кнопкам) тоже открывает OrderActionsDialog.

import { memo } from 'react'
import {
  formatCurrency, calcOrderDisplayTotal, voidedItemFlags,
} from '@/lib/helpers'
import type { Order, OrderStatus, OrderVoid, Table, User } from '@/lib/types'
import { ordersEqualShallow } from './order-row'

const STATUS_BADGE: Record<OrderStatus, { label: string; cls: string }> = {
  new: { label: 'Новый', cls: 'bg-status-cooking-soft text-status-cooking-text' },
  cooking: { label: 'Готовится', cls: 'bg-status-cooking-soft text-status-cooking-text' },
  ready: { label: 'Готов', cls: 'bg-status-ready-soft text-status-ready-text' },
  served: { label: 'Готов', cls: 'bg-status-ready-soft text-status-ready-text' },
  bill_requested: { label: 'Запрошен счёт', cls: 'bg-status-new-soft text-status-new-text' },
  done: { label: 'Оплачен', cls: 'bg-muted text-muted-foreground' },
  cancelled: { label: 'Отменён', cls: 'bg-muted text-muted-foreground' },
}

const TYPE_BADGE: Record<string, { label: string; cls: string; stripe: string }> = {
  hall: { label: 'Зал', cls: 'bg-orange-100 text-orange-800', stripe: 'bg-orange-500' },
  takeaway: { label: 'С собой', cls: 'bg-emerald-100 text-emerald-800', stripe: 'bg-emerald-500' },
  delivery: { label: 'Доставка', cls: 'bg-sky-100 text-sky-800', stripe: 'bg-sky-500' },
}

function formatHHMM(iso: string): string {
  try {
    const d = new Date(iso)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  } catch {
    return ''
  }
}

function summarizeItems(order: Order, voids?: OrderVoid[]): string {
  const voidedFlags = voidedItemFlags(order.items, voids)
  const live = order.items
    .map((it, idx) => ({ it, voided: voidedFlags[idx] }))
    .filter(x => !x.it.cancelledAt && !x.voided)
    .map(x => x.it)

  if (live.length === 0) return '—'

  const top = live.slice(0, 3).map(it => {
    const qty = it.qty ?? 1
    return qty > 1 ? `${it.name} ×${qty}` : it.name
  })
  const rest = live.length - top.length
  return rest > 0 ? `${top.join(', ')}, ещё ${rest}` : top.join(', ')
}

interface Props {
  order: Order
  tablesData: Table[]
  usersData: User[]
  voids?: OrderVoid[]
  servicePercent?: number
  onOpen: (order: Order) => void
  onPay: (order: Order) => void
  onCancel: (order: Order) => void
}

function ActiveOrderCardInner({ order, tablesData, usersData, voids, servicePercent, onOpen, onPay, onCancel }: Props) {
  const typeKey = order.type === 'takeaway' || order.type === 'delivery' ? 'takeaway' : 'hall'
  const typeMeta = TYPE_BADGE[typeKey]
  const statusMeta = STATUS_BADGE[order.status] ?? STATUS_BADGE.new
  const table = order.tableId ? tablesData.find(t => t.id === order.tableId) : null
  const waiter = order.waiterId ? usersData.find(u => u.id === order.waiterId) : null
  const total = calcOrderDisplayTotal(order, servicePercent)
  const guests = order.guestsCount && order.guestsCount > 0 ? order.guestsCount : null

  // Локация / тип строки
  let location: string
  if (typeKey === 'hall') {
    const tableName = table?.name ?? (table ? `Стол #${(table as { number?: number }).number ?? ''}`.trim() : 'Стол')
    location = guests ? `${tableName} · ${guests} ${guestsWord(guests)}` : tableName
  } else {
    location = guests ? `С собой · ${guests} ${guestsWord(guests)}` : 'С собой'
  }

  const items = summarizeItems(order, voids)

  return (
    <div
      onClick={() => onOpen(order)}
      className="relative bg-card rounded-xl border border-border overflow-hidden cursor-pointer hover:shadow-sm transition-shadow"
    >
      {/* Left color stripe */}
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${typeMeta.stripe}`} />

      <div className="pl-4 pr-3 py-3 space-y-2">
        {/* Header: # + type badge | time */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-bold text-sm text-foreground">
              #{order.orderNumber ?? order.id.slice(0, 6)}
            </span>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${typeMeta.cls}`}>
              {typeMeta.label}
            </span>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">{formatHHMM(order.createdAt)}</span>
        </div>

        {/* Location / guests */}
        <div className="text-xs text-muted-foreground">{location}</div>

        {/* Items summary */}
        <div className="text-xs text-foreground/90 line-clamp-2 min-h-[2.25rem]">{items}</div>

        {/* Status badge */}
        <div>
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${statusMeta.cls}`}>
            {statusMeta.label}
          </span>
        </div>

        {/* Waiter + total */}
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted-foreground truncate">{waiter?.name.split(' ')[0] ?? '—'}</span>
          <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(total)}</span>
        </div>

        {/* Buttons */}
        <div className="grid grid-cols-2 gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => onPay(order)}
            className="px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
          >
            Оплатить
          </button>
          <button
            onClick={() => onCancel(order)}
            className="px-3 py-2 text-xs font-medium rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors"
          >
            Отменить
          </button>
        </div>
      </div>
    </div>
  )
}

function guestsWord(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return 'гостей'
  if (mod10 === 1) return 'гость'
  if (mod10 >= 2 && mod10 <= 4) return 'гостя'
  return 'гостей'
}

export const ActiveOrderCard = memo(ActiveOrderCardInner, (prev, next) => {
  if (prev.tablesData !== next.tablesData) return false
  if (prev.usersData !== next.usersData) return false
  if (prev.servicePercent !== next.servicePercent) return false
  if (prev.voids !== next.voids) return false
  if (prev.onOpen !== next.onOpen) return false
  if (prev.onPay !== next.onPay) return false
  if (prev.onCancel !== next.onCancel) return false
  return ordersEqualShallow(prev.order, next.order)
})
