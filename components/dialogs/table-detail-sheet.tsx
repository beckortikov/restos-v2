'use client'

/**
 * TableDetailSheet — sidebar для клика по столу на /operations/table-map.
 *
 * До рефакторинга это был дубль `OrderActionsDialog` на 1127 строк, с собственной
 * логикой платежей/скидок/voids, причём кнопка «Закрыть и оплатить» была гейтнута
 * только на `bill_requested` — кассир физически не мог оплатить заказ на других
 * статусах. После — переиспользуем `OrderActionsBody` (тот же, что показывается
 * на /operations/orders при клике на карточку), а здесь оставляем только то, что
 * специфично для зала: переключатель групп, мета стола, бронь, кнопка «создать
 * заказ» / «забронировать» для свободного стола.
 */

import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import {
  BottomSheet as Sheet,
  BottomSheetContent as SheetContent,
  BottomSheetHeader as SheetHeader,
  BottomSheetTitle as SheetTitle,
  BottomSheetDescription as SheetDescription,
} from '@/components/ui/bottom-sheet'
import { formatCurrency, getTimeSince, startOfToday } from '@/lib/helpers'
import {
  STATUS_LABELS,
  ORDER_STATUS_LABELS,
  type Table,
  type TableStatus,
  type PaymentMethod,
  type OrderPayment,
  type Order,
  type User,
  type Zone,
} from '@/lib/types'
import { fetchOrders, fetchUsers, fetchZones, fetchReservationForTable, updateReservationStatus, quickUpdateCapacity } from '@/lib/queries'
import { toast } from 'sonner'
import type { Reservation } from '@/lib/types'
import { ReservationDialog } from '@/components/dialogs/reservation-dialog'
import { OrderActionsBody, type OrderActionData } from './order-actions-body'
import {
  Users,
  User as UserIcon,
  Clock,
  MapPin,
  UtensilsCrossed,
  CreditCard,
  UserCircle,
  X,
  Pencil,
  UserPlus,
  CheckCircle2,
  Minus,
  Plus,
  CalendarClock,
  PhoneCall,
  UserX,
} from 'lucide-react'

interface TableDetailSheetProps {
  table: Table | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Callback родителя для всех экшенов сайдбара. Передаются как старые
   *  table-specific actions (edit_table, assign_waiter, new_tab, refresh,
   *  unmerge_table, cancel_reservation, seat_guest, create_order), так и
   *  заказ-level (close_and_pay, cancel, mark_ready, refresh) — теперь все
   *  через единый `OrderActionsBody`. orderId всегда передаётся через `data`. */
  onAction: (action: string, tableId: string, data?: OrderActionData & { orderId?: string; assignWaiterId?: string; editTable?: boolean }) => void
  hasMergedChildren?: boolean
  externalOrders?: Order[]
}

const CAN_PAY = ['owner', 'manager', 'cashier']

const STATUS_STYLE: Record<TableStatus, { bg: string; text: string; dot: string }> = {
  free: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  occupied: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
  reserved: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500' },
  bill_requested: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
}

export function TableDetailSheet({ table, open, onOpenChange, onAction, hasMergedChildren, externalOrders }: TableDetailSheetProps) {
  const { canAccessRoles, user, canDo } = useAuth()
  const navigate = useNavigate()
  const [orders, setOrders] = useState<Order[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [dataLoaded, setDataLoaded] = useState(false)
  const [showWaiterPicker, setShowWaiterPicker] = useState(false)
  const [showReservation, setShowReservation] = useState(false)
  const [localCapacity, setLocalCapacity] = useState(table?.capacity ?? 0)
  const [reservation, setReservation] = useState<Reservation | null>(null)
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)

  const canEditTables = canDo('tables.edit') || canAccessRoles(['manager', 'owner'])
  const canReserve = canAccessRoles(['manager', 'waiter', 'cashier'])
  const canPay = CAN_PAY.includes(user?.role ?? '')

  // Data load on open.
  useEffect(() => {
    if (open && !dataLoaded) {
      Promise.all([fetchOrders({ from: startOfToday() }), fetchUsers(), fetchZones()])
        .then(async ([o, u, z]) => {
          // Зависший заказ старше суток — догружаем по id, иначе шит остаётся пустым.
          let merged = o
          if (table?.currentOrderId && !o.some(x => x.id === table.currentOrderId)) {
            try {
              const extra = await fetchOrders({ ids: [table.currentOrderId] })
              if (extra.length > 0) merged = [...o, ...extra]
            } catch (e) { console.error('[table-detail-sheet] догрузка заказа стола:', e) }
          }
          setOrders(merged); setUsers(u); setZones(z)
          setDataLoaded(true)
        })
    }
  }, [open, dataLoaded, table?.currentOrderId])

  useEffect(() => {
    if (externalOrders) setOrders(externalOrders)
  }, [externalOrders])

  useEffect(() => {
    if (!open) {
      setReservation(null)
      setDataLoaded(false)
    } else if (table) {
      setLocalCapacity(table.capacity)
    }
  }, [open, table])

  const openOrders = !table
    ? []
    : orders
        .filter(o => o.tableId === table.id && o.status !== 'done' && o.status !== 'cancelled')
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  useEffect(() => {
    if (!open) return
    if (openOrders.length === 0) { setSelectedOrderId(null); return }
    if (!selectedOrderId || !openOrders.some(o => o.id === selectedOrderId)) {
      setSelectedOrderId(openOrders[0].id)
    }
  }, [open, openOrders, selectedOrderId])

  useEffect(() => {
    if (open && table?.status === 'reserved') {
      fetchReservationForTable(table.id).then(setReservation).catch(() => {})
    }
  }, [open, table?.id, table?.status])

  /** «+ Новая группа» — навигация в POS с tableId+newGroup=1.
   *  Раньше открывался примитивный CreateOrderDialog без menu picker — кассир
   *  жаловался что «убогая». Теперь — полноценный POS-композер на тот же стол. */
  const handleNewGroup = useCallback(() => {
    if (!table) return
    onOpenChange(false)
    navigate(`/operations/pos?tableId=${table.id}&newGroup=1`)
  }, [table, onOpenChange, navigate])

  /** Кнопка «Создать заказ» на свободном столе — та же навигация без флага. */
  const handleCreateOrder = useCallback(() => {
    if (!table) return
    onOpenChange(false)
    navigate(`/operations/pos?tableId=${table.id}`)
  }, [table, onOpenChange, navigate])

  /** Переадресует action заказ-level в onAction родителя с orderId стола. */
  const handleOrderAction = useCallback((action: string, data?: OrderActionData) => {
    if (!table) return
    const orderId = selectedOrderId ?? table.currentOrderId
    onAction(action, table.id, { ...data, orderId })
  }, [table, selectedOrderId, onAction])

  if (!table) return null

  const style = STATUS_STYLE[table.status] ?? STATUS_STYLE.free
  const zone = zones.find((z) => z.id === table.zone)
  const order = openOrders.find(o => o.id === selectedOrderId) ?? openOrders[0] ?? null
  const waiter = table.waiterId ? users.find((u) => u.id === table.waiterId) : null
  const waiters = users.filter((u) => u.role === 'waiter')
  const tabLabel = (o: Order, idx: number) => o.tabLabel || `Группа ${idx + 1}`

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="md:h-full h-[95vh] flex flex-col md:!max-w-lg lg:!max-w-xl p-0">
        <SheetHeader className="px-4 pt-4 pb-2 border-b">
          <SheetTitle className="flex items-center gap-3">
            <span>{table.name}</span>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium ${style.bg} ${style.text}`}
            >
              <span className={`size-2 rounded-full ${style.dot}`} />
              {STATUS_LABELS[table.status]}
            </span>
            {canEditTables && (
              <button
                onClick={() => onAction('edit_table', table.id)}
                className="ml-auto mr-12 p-1.5 rounded-lg text-muted-foreground hover:bg-muted transition-colors"
                title="Редактировать"
              >
                <Pencil className="size-4" />
              </button>
            )}
          </SheetTitle>
          <SheetDescription className="sr-only">Информация о столе</SheetDescription>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground mt-1">
            <span className="inline-flex items-center gap-1 min-w-0">
              <MapPin className="size-3 shrink-0" />
              <span className="truncate">{zone?.name ?? '—'}</span>
            </span>
            <span className="inline-flex items-center gap-1 min-w-0">
              <Users className="size-3 shrink-0" />
              <span className="truncate">{localCapacity} мест</span>
              {canAccessRoles(['manager', 'waiter', 'cashier']) && (
                <span className="ml-1 inline-flex items-center gap-0.5">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      if (localCapacity <= 1) return
                      const newCap = localCapacity - 1
                      setLocalCapacity(newCap)
                      quickUpdateCapacity(table.id, newCap).catch(() => setLocalCapacity(localCapacity))
                    }}
                    className="size-4 rounded border border-border flex items-center justify-center hover:bg-muted"
                  ><Minus className="size-2.5" /></button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      const newCap = localCapacity + 1
                      setLocalCapacity(newCap)
                      quickUpdateCapacity(table.id, newCap).catch(() => setLocalCapacity(localCapacity))
                    }}
                    className="size-4 rounded border border-border flex items-center justify-center hover:bg-muted"
                  ><Plus className="size-2.5" /></button>
                </span>
              )}
            </span>
            {table.openedAt && (
              <span className="inline-flex items-center gap-1 min-w-0">
                <Clock className="size-3 shrink-0" />
                <span className="truncate">{getTimeSince(table.openedAt)}</span>
              </span>
            )}
            <span className="inline-flex items-center gap-1 min-w-0">
              <UserCircle className="size-3 shrink-0" />
              <span className="truncate">{waiter?.name ?? '—'}</span>
              {canEditTables && (
                <button
                  onClick={() => setShowWaiterPicker(!showWaiterPicker)}
                  className="ml-1 p-0.5 rounded text-primary hover:bg-primary/10"
                  title="Назначить официанта"
                >
                  <UserPlus className="size-3" />
                </button>
              )}
            </span>
          </div>

          {showWaiterPicker && canEditTables && (
            <div className="mt-2 space-y-1 p-2 bg-muted/30 rounded-lg">
              <p className="text-xs font-medium text-muted-foreground mb-1">Назначить официанта:</p>
              <button
                onClick={() => {
                  onAction('assign_waiter', table.id, { assignWaiterId: '' })
                  setShowWaiterPicker(false)
                }}
                className="w-full text-left text-xs px-2.5 py-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground"
              >
                Снять назначение
              </button>
              {waiters.map((w) => (
                <button
                  key={w.id}
                  onClick={() => {
                    onAction('assign_waiter', table.id, { assignWaiterId: w.id })
                    setShowWaiterPicker(false)
                  }}
                  className={`w-full text-left text-xs px-2.5 py-1.5 rounded-md hover:bg-muted transition-colors ${
                    table.waiterId === w.id ? 'bg-primary/10 text-primary font-medium' : 'text-foreground'
                  }`}
                >
                  {w.name}
                </button>
              ))}
            </div>
          )}

          {canEditTables && hasMergedChildren && (
            <button
              onClick={() => { onAction('unmerge_table', table.id); onOpenChange(false) }}
              className="mt-2 w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors"
            >
              ↔ Разъединить столы
            </button>
          )}
        </SheetHeader>

        {/* Group tabs — переключатель активных групп за столом */}
        {openOrders.length > 0 && (
          <div className="px-4 py-2 border-b flex items-center gap-2 overflow-x-auto">
            {openOrders.map((o, i) => {
              const active = o.id === selectedOrderId
              const ready = o.status === 'ready'
              const bill = o.status === 'bill_requested'
              return (
                <button
                  key={o.id}
                  onClick={() => setSelectedOrderId(o.id)}
                  className={`shrink-0 inline-flex flex-col items-start gap-0.5 rounded-xl border-2 px-3 py-2 text-left transition-all ${
                    active
                      ? 'border-primary bg-primary/5'
                      : ready
                        ? 'border-emerald-200 bg-emerald-50 hover:border-emerald-300'
                        : bill
                          ? 'border-amber-200 bg-amber-50 hover:border-amber-300'
                          : 'border-border hover:border-muted-foreground/30'
                  }`}
                >
                  <span className={`text-xs font-semibold ${active ? 'text-primary' : 'text-foreground'}`}>{tabLabel(o, i)}</span>
                  <span className="text-[11px] text-muted-foreground">{ORDER_STATUS_LABELS[o.status]}</span>
                  <span className="text-xs font-bold">{formatCurrency(o.total)}</span>
                </button>
              )
            })}
            {canAccessRoles(['manager', 'waiter', 'cashier']) && (
              <button
                onClick={handleNewGroup}
                className="shrink-0 inline-flex flex-col items-center justify-center gap-0.5 rounded-xl border-2 border-dashed border-primary/40 px-4 py-2 text-primary hover:bg-primary/5 transition-colors min-h-[68px]"
              >
                <Plus className="size-4" />
                <span className="text-[11px] font-medium">Новая группа</span>
              </button>
            )}
          </div>
        )}

        {/* Body */}
        {order ? (
          <OrderActionsBody
            key={order.id}
            order={order}
            onAction={handleOrderAction}
            onClose={() => onOpenChange(false)}
            onItemsChanged={() => onAction('refresh', table.id)}
            hideMeta
          />
        ) : table.status === 'reserved' ? (
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {reservation && (
              <div className="bg-blue-50 rounded-xl p-4 border border-blue-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-blue-900">Бронь</span>
                  <span className="text-xs text-blue-600">
                    {new Date(reservation.reservedAt).toLocaleDateString('ru', { day: 'numeric', month: 'short' })}
                    {' '}
                    {new Date(reservation.reservedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="space-y-1 text-sm">
                  <div className="flex items-center gap-2 text-blue-800">
                    <UserIcon className="size-3.5 shrink-0" />
                    <span className="font-medium">{reservation.guestName}</span>
                  </div>
                  {reservation.guestPhone && (
                    <div className="flex items-center gap-2">
                      <PhoneCall className="size-3.5 shrink-0 text-blue-600" />
                      <a href={`tel:${reservation.guestPhone}`} className="text-blue-600 hover:underline">{reservation.guestPhone}</a>
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-blue-700">
                    <Users className="size-3.5 shrink-0" />
                    <span>{reservation.guestsCount} гост{reservation.guestsCount === 1 ? 'ь' : reservation.guestsCount < 5 ? 'я' : 'ей'}</span>
                    <span className="text-blue-500">· {reservation.durationMin >= 60 ? `${reservation.durationMin / 60}ч` : `${reservation.durationMin}м`}</span>
                  </div>
                  {reservation.note && (
                    <p className="text-xs text-blue-600 italic">{reservation.note}</p>
                  )}
                </div>
              </div>
            )}

            {canAccessRoles(['manager', 'waiter', 'cashier']) && !reservation && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Запись о брони не найдена</p>
                <button
                  onClick={() => { onAction('cancel_reservation', table.id); onOpenChange(false) }}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border-2 border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-100 transition-colors"
                >
                  <X className="size-4" />
                  Снять резерв
                </button>
              </div>
            )}

            {canAccessRoles(['manager', 'waiter', 'cashier']) && reservation && (
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={async () => {
                    await updateReservationStatus(reservation.id, 'seated', table.id)
                    onAction('seat_guest', table.id)
                  }}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 transition-colors"
                >
                  <CheckCircle2 className="size-4" />
                  Гость пришёл
                </button>
                <button
                  onClick={async () => {
                    await updateReservationStatus(reservation.id, 'cancelled', table.id)
                    onAction('cancel_reservation', table.id)
                  }}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl border-2 border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-100 transition-colors"
                >
                  <X className="size-4" />
                  Отменить
                </button>
                <button
                  onClick={async () => {
                    await updateReservationStatus(reservation.id, 'no_show', table.id)
                    onAction('cancel_reservation', table.id)
                  }}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted transition-colors"
                >
                  <UserX className="size-4" />
                  Не пришёл
                </button>
              </div>
            )}
          </div>
        ) : (
          // Free table — Создать заказ / Забронировать
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {canAccessRoles(['manager', 'waiter', 'cashier']) && (
              <div className="space-y-2">
                <button
                  onClick={handleCreateOrder}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-4 text-base font-medium md:py-3 md:text-sm text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <UtensilsCrossed className="size-4" />
                  Создать заказ
                </button>
                {canReserve && (
                  <button
                    onClick={() => setShowReservation(true)}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-blue-200 bg-blue-50 px-5 py-3.5 text-base font-medium md:py-2.5 md:text-sm text-blue-700 hover:bg-blue-100 transition-colors"
                  >
                    <CalendarClock className="size-4" />
                    Забронировать
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </SheetContent>

      {table && (
        <ReservationDialog
          open={showReservation}
          onOpenChange={setShowReservation}
          tableId={table.id}
          tableName={table.name}
          tableCapacity={table.capacity}
          onSuccess={() => {
            setShowReservation(false)
            onAction('refresh', table.id)
          }}
        />
      )}
    </Sheet>
    </>
  )
}
