'use client'

/**
 * TransferTableDialog — перенос заказа на другой стол.
 *
 * Backend orders_split.go::Transfer: атомарно обновляет orders.table_id,
 * освобождает старый стол (если на нём не осталось активных заказов),
 * занимает новый, emit'ит SSE table.updated + order.updated.
 *
 * UX: центрированный mini-dialog, не overlay sheet поверх sidebar'а.
 * Открывается из DropdownMenu «Дополнительно» в OrderActionsPanel.
 */

import { useState, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { ArrowRight } from 'lucide-react'
import { fetchTables, transferOrder } from '@/lib/queries'
import type { Order, Table } from '@/lib/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface TransferTableDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  order: Order
  /** Опц. — список уже загруженных столов (TableDetailSheet передаёт свой кэш). */
  tables?: Table[]
  onSuccess?: () => void
}

export function TransferTableDialog({
  open,
  onOpenChange,
  order,
  tables: externalTables,
  onSuccess,
}: TransferTableDialogProps) {
  const [tables, setTables] = useState<Table[]>(externalTables ?? [])
  const [submitting, setSubmitting] = useState(false)
  const [targetTableId, setTargetTableId] = useState<string>('')

  // Подгрузить столы если не передали извне.
  useEffect(() => {
    if (!open) return
    if (externalTables && externalTables.length > 0) {
      setTables(externalTables)
      return
    }
    fetchTables().then(setTables).catch(() => {
      toast.error('Не удалось загрузить столы')
    })
  }, [open, externalTables])

  // Сбрасываем выбор при открытии.
  useEffect(() => { if (open) setTargetTableId('') }, [open])

  // Только СВОБОДНЫЕ столы (как в официанте). Перенос на занятый стол бэк
  // отклоняет (две заказа на столе = потеря) — поэтому занятые не показываем,
  // чтобы кассир не наткнулся на ошибку. Текущий стол исключаем.
  const eligibleTables = useMemo(() => {
    return tables
      .filter(t => t.id !== order.tableId && t.status === 'free')
      .sort((a, b) => Number(a.number ?? 0) - Number(b.number ?? 0))
  }, [tables, order.tableId])

  const currentTable = order.tableId ? tables.find(t => t.id === order.tableId) : null

  const handleTransfer = async () => {
    if (!targetTableId) return
    setSubmitting(true)
    try {
      await transferOrder(order.id, { tableId: targetTableId })
      const target = tables.find(t => t.id === targetTableId)
      toast.success(`Заказ #${order.orderNumber ?? ''} перенесён на ${target?.name ?? 'другой стол'}`)
      onOpenChange(false)
      onSuccess?.()
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось перенести заказ')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Перенести на другой стол</DialogTitle>
          <DialogDescription>
            {currentTable ? (
              <>Сейчас: <strong>{currentTable.name}</strong>. Выберите куда перенести.</>
            ) : (
              <>Выберите целевой стол.</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[400px] overflow-y-auto space-y-1.5 py-2">
          {eligibleTables.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              Нет доступных столов для переноса
            </p>
          ) : (
            eligibleTables.map(t => {
              const isFree = t.status === 'free'
              return (
                <button
                  key={t.id}
                  onClick={() => setTargetTableId(t.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border-2 text-left transition-colors ${
                    targetTableId === t.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${isFree ? 'bg-emerald-500' : 'bg-red-500'}`} />
                    <span className="font-medium text-sm">{t.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {t.capacity} мест · {isFree ? 'Свободен' : 'Занят'}
                    </span>
                  </div>
                  {targetTableId === t.id && <ArrowRight className="size-4 text-primary" />}
                </button>
              )
            })
          )}
        </div>

        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-border hover:bg-muted disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            onClick={handleTransfer}
            disabled={!targetTableId || submitting}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <ArrowRight className="size-4" />
            {submitting ? 'Перенос...' : 'Перенести'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
