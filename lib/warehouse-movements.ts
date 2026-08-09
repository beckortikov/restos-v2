// Общие хелперы движений склада — используются и лентой (history/page), и
// карточкой товара (item-stock-card). Раньше тип/подпись жили только в
// history/page.tsx; вынесены, чтобы карточка не дублировала логику.

import type { StockMovement, StockMovementType } from '@/lib/types'
import {
  ArrowDownToLine, ArrowUpFromLine, FlaskConical, ClipboardCheck,
  SlidersHorizontal, CookingPot, Undo2, type LucideIcon,
} from 'lucide-react'

export const MOVEMENT_TYPE_META: Record<StockMovementType, { label: string; color: string; bg: string; Icon: LucideIcon }> = {
  in:     { label: 'Приход',         color: 'text-emerald-600',      bg: 'bg-emerald-100 dark:bg-emerald-500/15', Icon: ArrowDownToLine },
  out:    { label: 'Списание',       color: 'text-destructive',      bg: 'bg-red-100 dark:bg-red-500/15',        Icon: ArrowUpFromLine },
  return: { label: 'Возврат',        color: 'text-orange-600',       bg: 'bg-orange-100 dark:bg-orange-500/15',  Icon: Undo2 },
  batch:  { label: 'Приготовление',  color: 'text-purple-600',       bg: 'bg-purple-100 dark:bg-purple-500/15',  Icon: CookingPot },
  semi:   { label: 'Производство',   color: 'text-blue-600',         bg: 'bg-blue-100 dark:bg-blue-500/15',      Icon: FlaskConical },
  audit:  { label: 'Инвентаризация', color: 'text-amber-600',        bg: 'bg-amber-100 dark:bg-amber-500/15',    Icon: ClipboardCheck },
  adj:    { label: 'Корректировка',  color: 'text-muted-foreground', bg: 'bg-muted',                             Icon: SlidersHorizontal },
}

// Описание движения в БД — сырой source-ref «prefix:<uuid>». Показывать UUID
// бессмысленно; подпись из префикса уточняет источник (бейдж типа схлопывает
// разные источники в один).
const REF_LABELS: Record<string, string> = {
  receipt: 'Приход от поставщика',
  writeoff: 'Списание (брак / порча)',
  supply_expense: 'Расход хозтоваров',
  return: 'Возврат поставщику',
  order: 'Списание на заказ',
  order_refund: 'Возврат по заказу',
  batch: 'Приготовление блюда',
  batch_out: 'Приготовление блюда',
  batch_in: 'Готовое блюдо',
  semi: 'Производство п/ф',
  semi_out: 'Производство п/ф',
  semi_in: 'Производство п/ф',
  semi_consume: 'Расход на п/ф',
  inventory: 'Инвентаризация',
  inventory_correction: 'Инвентаризация',
  adj: 'Корректировка',
}

export function movementRefPrefix(desc: string): string {
  if (!desc) return ''
  const i = desc.indexOf(':')
  if (i <= 0) return ''
  const rest = desc.slice(i + 1)
  // «сырой» ref = prefix:id без пробелов; рукописные заметки — не ref.
  return rest.length > 0 && !/\s/.test(rest) ? desc.slice(0, i) : ''
}

export function movementRefId(desc: string): string {
  const i = desc.indexOf(':')
  return movementRefPrefix(desc) ? desc.slice(i + 1) : ''
}

export function movementSubtitle(desc: string): string {
  if (!desc) return ''
  const prefix = movementRefPrefix(desc)
  if (!prefix) return desc // рукописная заметка — как есть
  return REF_LABELS[prefix] ?? desc
}

// Крупная категория движения для сводки карточки: куплено / продано / списано /
// инвентаризация / прочее. Приход всегда «куплено», расход делим по источнику.
export type MovementKind = 'receipt' | 'sale' | 'writeoff' | 'audit' | 'return' | 'production' | 'other'

export function movementKind(m: StockMovement): MovementKind {
  const p = movementRefPrefix(m.description)
  if (m.type === 'audit') return 'audit'
  if (m.type === 'return' || p === 'order_refund' || p === 'return') return 'return'
  if (m.type === 'batch' || m.type === 'semi') return 'production'
  if (p === 'writeoff' || p === 'supply_expense') return 'writeoff'
  if (p === 'order') return 'sale'
  if (p === 'receipt' || m.qty > 0) return 'receipt'
  return 'other'
}
