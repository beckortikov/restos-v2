'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { X, Loader2, FileDown } from 'lucide-react'
import {
  BottomSheet as Dialog,
  BottomSheetContent as DialogContent,
  BottomSheetHeader as DialogHeader,
  BottomSheetTitle as DialogTitle,
  BottomSheetDescription as DialogDescription,
} from '@/components/ui/bottom-sheet'
import { fetchOrders, fetchVoidsForOrders } from '@/lib/queries'
import { exportOrdersToXlsx } from '@/lib/orders-export'
import { startOfDay, endOfDay } from '@/lib/helpers'
import type { Table, User } from '@/lib/types'

type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'custom'

const PRESETS: { value: Preset; label: string }[] = [
  { value: 'today', label: 'Сегодня' },
  { value: 'yesterday', label: 'Вчера' },
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
  { value: 'custom', label: 'Произвольный' },
]

function toInputValue(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function rangeForPreset(preset: Preset): { from: Date; to: Date } {
  const now = new Date()
  if (preset === 'today') return { from: startOfDay(now), to: endOfDay(now) }
  if (preset === 'yesterday') {
    const y = new Date(now); y.setDate(y.getDate() - 1)
    return { from: startOfDay(y), to: endOfDay(y) }
  }
  if (preset === '7d') {
    const f = new Date(now); f.setDate(f.getDate() - 6)
    return { from: startOfDay(f), to: endOfDay(now) }
  }
  if (preset === '30d') {
    const f = new Date(now); f.setDate(f.getDate() - 29)
    return { from: startOfDay(f), to: endOfDay(now) }
  }
  return { from: startOfDay(now), to: endOfDay(now) }
}

interface ExportOrdersDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tables: Table[]
  users: User[]
}

export function ExportOrdersDialog({ open, onOpenChange, tables, users }: ExportOrdersDialogProps) {
  const [preset, setPreset] = useState<Preset>('yesterday')
  const initial = useMemo(() => rangeForPreset('yesterday'), [])
  const [fromStr, setFromStr] = useState(toInputValue(initial.from))
  const [toStr, setToStr] = useState(toInputValue(initial.to))
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setPreset('yesterday')
    const r = rangeForPreset('yesterday')
    setFromStr(toInputValue(r.from))
    setToStr(toInputValue(r.to))
  }, [open])

  const applyPreset = (p: Preset) => {
    setPreset(p)
    if (p !== 'custom') {
      const r = rangeForPreset(p)
      setFromStr(toInputValue(r.from))
      setToStr(toInputValue(r.to))
    }
  }

  const onCustomChange = (kind: 'from' | 'to', value: string) => {
    setPreset('custom')
    if (kind === 'from') setFromStr(value)
    else setToStr(value)
  }

  const handleExport = async () => {
    const fromDate = new Date(fromStr)
    const toDate = new Date(toStr)
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      toast.error('Неверный диапазон дат')
      return
    }
    if (startOfDay(fromDate).getTime() > startOfDay(toDate).getTime()) {
      toast.error('«С» должно быть раньше или равно «По»')
      return
    }
    setLoading(true)
    try {
      const orders = await fetchOrders({ from: startOfDay(fromDate), to: endOfDay(toDate) })
      if (orders.length === 0) {
        toast.info('Нет заказов за выбранный период')
        return
      }
      const suffix = preset === 'custom' ? `${fromStr}_${toStr}` : preset
      // Подгружаем voids одним батч-запросом — без них экспорт считает
      // воиднутые позиции как живые (счётчик «Позиций» и лист «Позиции»
      // расходятся с фактическим чеком).
      const voidsByOrderId = await fetchVoidsForOrders(orders.map(o => o.id)).catch(() => new Map())
      exportOrdersToXlsx(orders, { tables, users, voidsByOrderId, filenameSuffix: suffix })
      toast.success(`Выгружено заказов: ${orders.length}`)
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка экспорта')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-screen md:w-auto md:max-w-md rounded-none md:rounded-lg p-0 gap-0 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <DialogHeader className="space-y-0 flex-1 min-w-0">
            <DialogTitle className="text-base font-semibold">Экспорт заказов в Excel</DialogTitle>
            <DialogDescription className="sr-only">Выберите период для выгрузки заказов</DialogDescription>
          </DialogHeader>
          <button
            onClick={() => onOpenChange(false)}
            aria-label="Закрыть"
            className="size-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Период</p>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => applyPreset(p.value)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                    preset === p.value
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card text-muted-foreground border-border hover:text-foreground'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">С</span>
              <input
                type="date"
                value={fromStr}
                onChange={(e) => onCustomChange('from', e.target.value)}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">По</span>
              <input
                type="date"
                value={toStr}
                onChange={(e) => onCustomChange('to', e.target.value)}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </label>
          </div>

          <button
            onClick={handleExport}
            disabled={loading}
            className="w-full inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <FileDown className="size-4" />}
            {loading ? 'Загрузка…' : 'Скачать Excel'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
