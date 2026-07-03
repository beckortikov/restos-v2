'use client'

// Общие компоненты строки/карточки заказа — используются и в Active-, и в
// History-табе на странице «Заказы». Вынесены из старого монолитного page.tsx
// чтобы убрать дублирование между двумя табами.

import { useState, memo, type ReactNode } from 'react'
import { Clock, MapPin, ChevronDown, ChevronUp } from 'lucide-react'
import {
  formatCurrency, getTimeSince, calcLineTotal, calcOrderDisplayTotal,
  formatQty, voidedItemFlags,
} from '@/lib/helpers'
import {
  ORDER_STATUS_LABELS,
  type Order, type OrderStatus, type OrderVoid, type Table, type User,
} from '@/lib/types'

export const STATUS_STYLE: Record<OrderStatus, string> = {
  new: 'bg-status-new-soft text-status-new-text',
  cooking: 'bg-status-cooking-soft text-status-cooking-text',
  ready: 'bg-status-ready-soft text-status-ready-text',
  served: 'bg-status-ready-soft text-status-ready-text',
  bill_requested: 'bg-status-bill-soft text-status-bill-text',
  done: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground',
}

export const TYPE_LABELS: Record<string, string> = {
  hall: 'Зал',
  delivery: 'Доставка',
  takeaway: 'Самовывоз',
}

export const TYPE_BADGE_STYLE: Record<string, string> = {
  takeaway: 'bg-orange-100 text-orange-700 border border-orange-200 dark:bg-orange-950/50 dark:text-orange-300 dark:border-orange-900',
  delivery: 'bg-sky-100 text-sky-700 border border-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:border-sky-900',
}

export const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Наличные',
  card: 'Карта',
  transfer: 'Перевод',
}

export const isTogo = (t?: string) => t === 'delivery' || t === 'takeaway'

// Shallow equality для memo() — сравниваем только поля, реально влияющие на
// отрисовку карточки/строки. Без этого React-React.memo ререндерит все заказы
// при любом обновлении массива из SSE.
export function ordersEqualShallow(prev: Order, next: Order): boolean {
  if (
    prev.id !== next.id ||
    prev.status !== next.status ||
    prev.total !== next.total ||
    prev.totalWithService !== next.totalWithService ||
    prev.servicePercent !== next.servicePercent ||
    prev.paymentMethod !== next.paymentMethod ||
    prev.closedAt !== next.closedAt ||
    prev.waiterId !== next.waiterId ||
    prev.tableId !== next.tableId ||
    prev.type !== next.type ||
    prev.orderNumber !== next.orderNumber ||
    prev.guestsCount !== next.guestsCount ||
    prev.readyAt !== next.readyAt ||
    prev.items.length !== next.items.length
  ) return false
  // Сравним items по cancelledAt — одно прохождение вместо двух filter'ов.
  let prevCancelled = 0
  let nextCancelled = 0
  for (let i = 0; i < prev.items.length; i++) {
    if (prev.items[i].cancelledAt) prevCancelled++
    if (next.items[i].cancelledAt) nextCancelled++
  }
  return prevCancelled === nextCancelled
}

interface RowProps {
  order: Order
  tablesData: Table[]
  usersData: User[]
  voids?: OrderVoid[]
  servicePercent?: number
  onOpen?: (order: Order) => void
  /** Optional inline actions slot — rendered to the right of the row content. */
  renderActions?: (order: Order) => React.ReactNode
}

function OrderCardInner({ order, tablesData, usersData, voids, servicePercent, onOpen, renderActions }: RowProps) {
  const table = order.tableId ? tablesData.find((t) => t.id === order.tableId) : null
  const waiter = order.waiterId ? usersData.find((u) => u.id === order.waiterId) : null
  const [expanded, setExpanded] = useState(false)
  const voidedFlags = voidedItemFlags(order.items, voids)
  const liveCount = (order.items.length > 0 ? order.items.reduce((s, it, idx) => s + (!it.cancelledAt && !voidedFlags[idx] ? 1 : 0), 0) : (order.aliveItemsCount ?? 0))
  const cancelledCount = order.items.reduce((s, it) => s + (it.cancelledAt ? 1 : 0), 0)
  const voidedCount = voidedFlags.reduce((s, f, idx) => s + (f && !order.items[idx].cancelledAt ? 1 : 0), 0)

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3 cursor-pointer" onClick={() => onOpen?.(order)}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium ${STATUS_STYLE[order.status]}`}>
            {ORDER_STATUS_LABELS[order.status]}
          </span>
          <span className="text-xs font-mono text-muted-foreground">#{order.orderNumber ?? order.id.slice(0, 8)}</span>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="size-3.5" />{getTimeSince(order.createdAt, order.status === 'done' ? order.closedAt : null)}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm">
          {table ? (
            <><MapPin className="size-3.5 text-muted-foreground" /><span className="font-medium">{table.name}</span></>
          ) : (
            <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${TYPE_BADGE_STYLE[order.type] ?? 'text-muted-foreground'}`}>
              {TYPE_LABELS[order.type]}
            </span>
          )}
        </div>
        <span className="text-sm font-bold text-foreground">{formatCurrency(calcOrderDisplayTotal(order, servicePercent))}</span>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {liveCount} позиций
          {cancelledCount > 0 && <span className="ml-1 text-zinc-500">· отм. {cancelledCount}</span>}
          {voidedCount > 0 && <span className="ml-1 text-rose-500">· списано {voidedCount}</span>}
        </span>
        <span>{waiter?.name.split(' ')[0] ?? '—'} {order.paymentMethod ? `· ${PAYMENT_LABELS[order.paymentMethod]}` : ''}</span>
      </div>

      {order.cancelReason && (
        <div className="text-[11px] text-zinc-600 italic">Причина: {order.cancelReason}</div>
      )}

      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
        className="flex items-center gap-1 text-xs text-primary font-medium"
      >
        {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        {expanded ? 'Скрыть состав' : 'Показать состав'}
      </button>

      {renderActions && (
        <div className="pt-2 border-t border-border flex items-center gap-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
          {renderActions(order)}
        </div>
      )}

      {expanded && (
        <div className="pt-2 border-t border-border space-y-1.5">
          {order.items.map((item, idx) => {
            const isCancelled = !!item.cancelledAt
            const isVoided = !isCancelled && voidedFlags[idx]
            const muted = isCancelled || isVoided
            return (
              <div key={item.id ?? `${item.menuItemId}-${idx}`} className={`flex items-center justify-between text-sm ${muted ? 'opacity-50' : ''}`}>
                <span className={`text-foreground ${muted ? 'line-through' : ''}`}>
                  {item.name}
                  {isVoided && <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-50 text-red-600 no-underline">Списано</span>}
                </span>
                <span className={`text-muted-foreground ${muted ? 'line-through' : ''}`}>{item.unit && item.unit !== 'piece' ? formatQty(item.qty, item.unit) : `x${item.qty}`} · {formatCurrency(calcLineTotal(item.price, item.qty, item.unit, item.unitSize))}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export const OrderCard = memo(OrderCardInner, (prev, next) => {
  if (prev.tablesData !== next.tablesData) return false
  if (prev.usersData !== next.usersData) return false
  if (prev.servicePercent !== next.servicePercent) return false
  if (prev.onOpen !== next.onOpen) return false
  if (prev.voids !== next.voids) return false
  if (prev.renderActions !== next.renderActions) return false
  return ordersEqualShallow(prev.order, next.order)
})

function OrderRowInner({ order, tablesData, usersData, voids, servicePercent, onOpen, renderActions }: RowProps) {
  const table = order.tableId ? tablesData.find((t) => t.id === order.tableId) : null
  const waiter = order.waiterId ? usersData.find((u) => u.id === order.waiterId) : null
  const voidedFlags = voidedItemFlags(order.items, voids)
  const liveCount = (order.items.length > 0 ? order.items.reduce((s, it, idx) => s + (!it.cancelledAt && !voidedFlags[idx] ? 1 : 0), 0) : (order.aliveItemsCount ?? 0))
  const cancelledCount = order.items.reduce((s, it) => s + (it.cancelledAt ? 1 : 0), 0)
  const voidedCount = voidedFlags.reduce((s, f, idx) => s + (f && !order.items[idx].cancelledAt ? 1 : 0), 0)

  return (
    <tr
      className="border-b border-border hover:bg-muted/50 cursor-pointer transition-colors"
      onClick={() => onOpen?.(order)}
    >
      <td className="px-4 py-3">
        <span className="text-xs font-mono text-muted-foreground">#{order.orderNumber ?? order.id.slice(0, 8)}</span>
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium ${STATUS_STYLE[order.status]}`}>
          {ORDER_STATUS_LABELS[order.status]}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          {table
            ? <><MapPin className="size-3.5 text-muted-foreground" />{table.name}</>
            : (
              <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${TYPE_BADGE_STYLE[order.type] ?? 'text-muted-foreground'}`}>
                {TYPE_LABELS[order.type]}
              </span>
            )}
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-foreground">
        {liveCount} поз.
        {cancelledCount > 0 && <span className="ml-1 text-xs text-zinc-500">· отм. {cancelledCount}</span>}
        {voidedCount > 0 && <span className="ml-1 text-xs text-rose-500">· сп. {voidedCount}</span>}
      </td>
      <td className="px-4 py-3 text-sm font-semibold text-foreground">{formatCurrency(calcOrderDisplayTotal(order, servicePercent))}</td>
      <td className="px-4 py-3">
        <span className="text-xs text-muted-foreground">{waiter?.name.split(' ')[0] ?? '—'}</span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="size-3.5" />{getTimeSince(order.createdAt, order.status === 'done' ? order.closedAt : null)}
        </div>
      </td>
      <td className="px-4 py-3">
        <span className="text-xs text-muted-foreground">{order.paymentMethod ? PAYMENT_LABELS[order.paymentMethod] : '—'}</span>
      </td>
      {renderActions && (
        <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
          {renderActions(order)}
        </td>
      )}
    </tr>
  )
}

export const OrderRow = memo(OrderRowInner, (prev, next) => {
  if (prev.tablesData !== next.tablesData) return false
  if (prev.usersData !== next.usersData) return false
  if (prev.servicePercent !== next.servicePercent) return false
  if (prev.onOpen !== next.onOpen) return false
  if (prev.voids !== next.voids) return false
  if (prev.renderActions !== next.renderActions) return false
  return ordersEqualShallow(prev.order, next.order)
})

// ─── Virtualized variants ───────────────────────────────────────────────

import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

interface VirtualProps {
  orders: Order[]
  tablesData: Table[]
  usersData: User[]
  voidsByOrderId: Map<string, OrderVoid[]>
  servicePercent?: number
  onOpen: (order: Order) => void
  renderActions?: (order: Order) => ReactNode
}

export function VirtualOrderCards({ orders, tablesData, usersData, voidsByOrderId, servicePercent, onOpen, renderActions }: VirtualProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: orders.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 180,
    overscan: 5,
  })
  return (
    <div ref={parentRef} className="overflow-auto h-[calc(100vh-220px)]">
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {rowVirtualizer.getVirtualItems().map(v => {
          const order = orders[v.index]
          return (
            <div
              key={order.id}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)`, paddingBottom: 12 }}
            >
              <OrderCard order={order} tablesData={tablesData} usersData={usersData} voids={voidsByOrderId.get(order.id)} servicePercent={servicePercent} onOpen={onOpen} renderActions={renderActions} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function VirtualOrderRows({ orders, tablesData, usersData, voidsByOrderId, servicePercent, onOpen, renderActions, headers, cols }: VirtualProps & { headers?: string[]; cols?: string }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: orders.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 8,
  })
  const defaultCols = renderActions
    ? 'grid-cols-[80px_140px_minmax(120px,1fr)_120px_120px_120px_120px_120px_180px]'
    : 'grid-cols-[80px_140px_minmax(120px,1fr)_120px_120px_120px_120px_120px]'
  const colsClass = cols ?? defaultCols
  const defaultHeaders = renderActions
    ? ['#', 'Статус', 'Стол/Тип', 'Позиций', 'Сумма', 'Официант', 'Время', 'Оплата', '']
    : ['#', 'Статус', 'Стол/Тип', 'Позиций', 'Сумма', 'Официант', 'Время', 'Оплата']
  const cells = headers ?? defaultHeaders
  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className={`grid ${colsClass} bg-muted/40 border-b border-border`}>
        {cells.map((h) => (
          <div key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">{h}</div>
        ))}
      </div>
      <div ref={parentRef} className="overflow-auto h-[calc(100vh-280px)]">
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {rowVirtualizer.getVirtualItems().map(v => {
            const order = orders[v.index]
            const table = order.tableId ? tablesData.find((t) => t.id === order.tableId) : null
            const waiter = order.waiterId ? usersData.find((u) => u.id === order.waiterId) : null
            const voids = voidsByOrderId.get(order.id)
            const voidedFlags = voidedItemFlags(order.items, voids)
            const liveCount = (order.items.length > 0 ? order.items.reduce((s, it, idx) => s + (!it.cancelledAt && !voidedFlags[idx] ? 1 : 0), 0) : (order.aliveItemsCount ?? 0))
            const cancelledCount = order.items.reduce((s, it) => s + (it.cancelledAt ? 1 : 0), 0)
            const voidedCount = voidedFlags.reduce((s, f, idx) => s + (f && !order.items[idx].cancelledAt ? 1 : 0), 0)
            return (
              <div
                key={order.id}
                onClick={() => onOpen(order)}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
                className={`grid ${colsClass} border-b border-border hover:bg-muted/50 cursor-pointer transition-colors items-center`}
              >
                <div className="px-4 py-3"><span className="text-xs font-mono text-muted-foreground">#{order.orderNumber ?? order.id.slice(0, 8)}</span></div>
                <div className="px-4 py-3">
                  <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium ${STATUS_STYLE[order.status]}`}>{ORDER_STATUS_LABELS[order.status]}</span>
                </div>
                <div className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    {table
                      ? <><MapPin className="size-3.5 text-muted-foreground" />{table.name}</>
                      : <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${TYPE_BADGE_STYLE[order.type] ?? 'text-muted-foreground'}`}>{TYPE_LABELS[order.type]}</span>}
                  </div>
                </div>
                <div className="px-4 py-3 text-sm text-foreground">
                  {liveCount} поз.
                  {cancelledCount > 0 && <span className="ml-1 text-xs text-zinc-500">· отм. {cancelledCount}</span>}
                  {voidedCount > 0 && <span className="ml-1 text-xs text-rose-500">· сп. {voidedCount}</span>}
                </div>
                <div className="px-4 py-3 text-sm font-semibold text-foreground">{formatCurrency(calcOrderDisplayTotal(order, servicePercent))}</div>
                <div className="px-4 py-3"><span className="text-xs text-muted-foreground">{waiter?.name.split(' ')[0] ?? '—'}</span></div>
                <div className="px-4 py-3">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="size-3.5" />{getTimeSince(order.createdAt, order.status === 'done' ? order.closedAt : null)}
                  </div>
                </div>
                <div className="px-4 py-3"><span className="text-xs text-muted-foreground">{order.paymentMethod ? PAYMENT_LABELS[order.paymentMethod] : '—'}</span></div>
                {renderActions && (
                  <div className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>{renderActions(order)}</div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
