'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAuth } from '@/lib/auth-store'
import { type AuditLogEntry, fetchAuditLog } from '@/lib/queries'
import { History, Search, User, ShoppingBag, Package, DollarSign, ChefHat, Settings, Filter, Printer, X } from 'lucide-react'

const ACTION_LABELS: Record<string, string> = {
  'order.create': 'Создал заказ',
  'order.close': 'Закрыл заказ',
  'order.cancel': 'Удалил заказ',
  'order.status': 'Изменил статус заказа',
  'order.cooking': 'Отправил в готовку',
  'order.ready': 'Отметил готовым',
  'menu.create': 'Добавил блюдо',
  'menu.edit': 'Изменил блюдо',
  'menu.delete': 'Удалил блюдо',
  'ingredient.create': 'Добавил ингредиент',
  'ingredient.edit': 'Изменил ингредиент',
  'supplier.create': 'Добавил поставщика',
  'supplier.edit': 'Изменил поставщика',
  'supplier.delete': 'Удалил поставщика',
  'supplier.pay': 'Оплатил поставщику',
  'receipt.create': 'Создал накладную',
  'receipt.confirm': 'Подтвердил накладную',
  'writeoff.create': 'Оформил списание',
  'shift.open': 'Открыл смену',
  'shift.close': 'Закрыл смену',
  'shift.cash_in': 'Внёс наличные',
  'shift.cash_out': 'Изъял наличные',
  'payroll.pay': 'Выплатил зарплату',
  'finance.create': 'Создал операцию',
  'finance.transfer': 'Перевёл между счетами',
  'table.create': 'Создал стол',
  'table.edit': 'Изменил стол',
  'table.delete': 'Удалил стол',
  'table.assign_waiter': 'Назначил официанта',
  'zone.create': 'Создал зону',
  'zone.edit': 'Изменил зону',
  'zone.delete': 'Удалил зону',
  'reservation.create': 'Забронировал стол',
  'reservation.cancel': 'Отменил бронь',
  'reservation.seated': 'Посадил гостя',
  'reservation.no_show': 'Гость не пришёл',
  'user.create': 'Добавил сотрудника',
  'user.edit': 'Изменил сотрудника',
  'user.delete': 'Удалил сотрудника',
  'user.permissions': 'Изменил права доступа',
  'settings.update': 'Обновил настройки',
  'semi.create': 'Создал полуфабрикат',
  'semi.delete': 'Удалил полуфабрикат',
  'semi.produce': 'Произвёл полуфабрикат',
  'budget.create': 'Добавил строку бюджета',
  'budget.edit': 'Изменил бюджет',
  'budget.delete': 'Удалил строку бюджета',
  'asset.create': 'Добавил актив',
  'asset.delete': 'Удалил актив',
  'liability.create': 'Добавил обязательство',
  'liability.delete': 'Удалил обязательство',
  'equity.create': 'Добавил капитал',
  'equity.delete': 'Удалил капитал',
  'customer.create': 'Добавил клиента',
  'customer.edit': 'Изменил клиента',
  'customer.delete': 'Удалил клиента',
  'timetrack.clock_in': 'Начал смену',
  'timetrack.clock_out': 'Завершил смену',
  'order.void': 'Отменил позицию',
  'batch.produce': 'Приготовил партию',
  'batch.decrement': 'Продал из заготовки',
  'order.add_items': 'Дозаказ',
  'supply.expense': 'Расход хозтовара',
  'print.runner': 'Печать на кухню',
  'print.receipt': 'Печать чека',
  'print.cancel': 'Печать отмены',
}

const ENTITY_ICONS: Record<string, React.ReactNode> = {
  order: <ShoppingBag className="size-4" />,
  menu_item: <ChefHat className="size-4" />,
  ingredient: <Package className="size-4" />,
  supplier: <Package className="size-4" />,
  receipt: <Package className="size-4" />,
  writeoff: <Package className="size-4" />,
  shift: <DollarSign className="size-4" />,
  payroll: <DollarSign className="size-4" />,
  finance: <DollarSign className="size-4" />,
  table: <Settings className="size-4" />,
  zone: <Settings className="size-4" />,
  reservation: <Settings className="size-4" />,
  user: <User className="size-4" />,
  settings: <Settings className="size-4" />,
  semi: <Package className="size-4" />,
  budget: <DollarSign className="size-4" />,
  asset: <DollarSign className="size-4" />,
  liability: <DollarSign className="size-4" />,
  equity: <DollarSign className="size-4" />,
  customer: <User className="size-4" />,
  print: <Printer className="size-4" />,
}

const ENTITY_COLORS: Record<string, string> = {
  order: 'bg-blue-100 text-blue-600',
  menu_item: 'bg-primary/10 text-primary',
  ingredient: 'bg-emerald-100 text-emerald-600',
  supplier: 'bg-amber-100 text-amber-600',
  receipt: 'bg-emerald-100 text-emerald-600',
  writeoff: 'bg-red-100 text-red-600',
  shift: 'bg-purple-100 text-purple-600',
  payroll: 'bg-purple-100 text-purple-600',
  finance: 'bg-purple-100 text-purple-600',
  table: 'bg-muted text-muted-foreground',
  zone: 'bg-muted text-muted-foreground',
  reservation: 'bg-blue-100 text-blue-600',
  user: 'bg-amber-100 text-amber-600',
  settings: 'bg-muted text-muted-foreground',
  semi: 'bg-emerald-100 text-emerald-600',
  budget: 'bg-purple-100 text-purple-600',
  asset: 'bg-purple-100 text-purple-600',
  liability: 'bg-red-100 text-red-600',
  equity: 'bg-purple-100 text-purple-600',
  customer: 'bg-blue-100 text-blue-600',
  print: 'bg-cyan-100 text-cyan-600',
}

const PRINT_STATUS_BADGE: Record<string, string> = {
  success: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  mock: 'bg-amber-100 text-amber-700',
}

const PRINT_STATUS_LABEL: Record<string, string> = {
  success: 'Напечатано',
  failed: 'Ошибка',
  mock: 'Без принтера',
}

type FilterType = 'all' | 'operations' | 'warehouse' | 'finance' | 'settings' | 'print'

const FILTER_ENTITY_MAP: Record<FilterType, string[]> = {
  all: [],
  operations: ['order', 'table', 'zone', 'reservation', 'shift'],
  warehouse: ['menu_item', 'ingredient', 'supplier', 'receipt', 'writeoff', 'semi'],
  finance: ['finance', 'payroll', 'budget', 'asset', 'liability', 'equity'],
  settings: ['user', 'settings', 'customer'],
  print: ['print'],
}

type FlatRow =
  | { type: 'header'; key: string; date: string }
  | { type: 'entry'; key: string; entry: AuditLogEntry }

function AuditEntryRow({ entry, onPreview }: { entry: AuditLogEntry; onPreview: (e: AuditLogEntry) => void }) {
  const color = ENTITY_COLORS[entry.entityType] || 'bg-muted text-muted-foreground'
  const icon = ENTITY_ICONS[entry.entityType] || <History className="size-4" />
  const label = ACTION_LABELS[entry.action] || entry.action
  const time = new Date(entry.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
  const rawDetails = entry.details
  const details: Record<string, unknown> = typeof rawDetails === 'string'
    ? (() => { try { return JSON.parse(rawDetails) } catch { return {} } })()
    : (rawDetails && typeof rawDetails === 'object' ? rawDetails as Record<string, unknown> : {})
  const isPrint = entry.entityType === 'print'
  const printStatus = isPrint ? String(details.status ?? '') : ''
  const hasHex = isPrint && typeof details.content_hex === 'string'
  const printerName = isPrint ? (details.printer_name as string | null) : null
  const clickable = hasHex
  const Row: any = clickable ? 'button' : 'div'

  return (
    <Row
      {...(clickable ? { onClick: () => onPreview(entry), type: 'button' } : {})}
      className={`w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/30 transition-colors ${clickable ? 'cursor-pointer' : ''}`}
    >
      <div className={`size-8 rounded-lg flex items-center justify-center shrink-0 ${color}`}>{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground">
          <span className="font-medium">{entry.userName || 'Система'}</span>
          {' '}
          <span className="text-muted-foreground">{label}</span>
          {entry.entityName && (<span className="font-medium"> {entry.entityName}</span>)}
          {isPrint && printStatus && (
            <span className={`ml-2 inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${PRINT_STATUS_BADGE[printStatus] || 'bg-muted text-muted-foreground'}`}>
              {PRINT_STATUS_LABEL[printStatus] || printStatus}
            </span>
          )}
        </p>
        {isPrint ? (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {[printerName || 'Принтер не настроен', details.printer_ip, details.error || details.reason_no_print]
              .filter(Boolean).join(' · ')}
          </p>
        ) : Object.keys(details).length > 0 && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {Object.entries(details).map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '')}`).join(' · ')}
          </p>
        )}
      </div>
      <span className="text-xs text-muted-foreground shrink-0">{time}</span>
    </Row>
  )
}

function AuditTimeline({ grouped, onPreview }: { grouped: Record<string, AuditLogEntry[]>; onPreview: (e: AuditLogEntry) => void }) {
  const flat = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = []
    for (const [date, items] of Object.entries(grouped)) {
      out.push({ type: 'header', key: `h:${date}`, date })
      for (const entry of items) out.push({ type: 'entry', key: `e:${entry.id}`, entry })
    }
    return out
  }, [grouped])

  // Skip virtualization for short lists — overhead doesn't pay off.
  if (flat.length <= 50) {
    return (
      <>
        {Object.entries(grouped).map(([date, items]) => (
          <div key={date}>
            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 sticky top-0 bg-background py-1">{date}</h3>
            <div className="space-y-1">
              {items.map(entry => <AuditEntryRow key={entry.id} entry={entry} onPreview={onPreview} />)}
            </div>
          </div>
        ))}
      </>
    )
  }

  return <VirtualAuditTimeline rows={flat} onPreview={onPreview} />
}

function VirtualAuditTimeline({ rows, onPreview }: { rows: FlatRow[]; onPreview: (e: AuditLogEntry) => void }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => rows[i].type === 'header' ? 36 : 56,
    overscan: 10,
  })
  return (
    <div ref={parentRef} className="overflow-auto h-[calc(100vh-220px)]">
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {rowVirtualizer.getVirtualItems().map(v => {
          const row = rows[v.index]
          return (
            <div
              key={row.key}
              ref={rowVirtualizer.measureElement}
              data-index={v.index}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
            >
              {row.type === 'header' ? (
                <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 mt-2 bg-background py-1">{row.date}</h3>
              ) : (
                <AuditEntryRow entry={row.entry} onPreview={onPreview} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function AuditLogPage() {
  const { canDo } = useAuth()
  const [entries, setEntries] = useState<AuditLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterType>('all')
  const [search, setSearch] = useState('')
  const [previewEntry, setPreviewEntry] = useState<AuditLogEntry | null>(null)

  useEffect(() => {
    fetchAuditLog(200)
      .then(setEntries)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (!canDo('audit.view')) {
    return <div className="p-6 flex items-center justify-center h-64"><p className="text-muted-foreground">Нет доступа</p></div>
  }

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  const filtered = entries.filter(e => {
    if (filter !== 'all' && !FILTER_ENTITY_MAP[filter].includes(e.entityType)) return false
    if (search.trim()) {
      const q = search.toLowerCase()
      return (e.userName?.toLowerCase().includes(q) || e.entityName?.toLowerCase().includes(q) || e.action.toLowerCase().includes(q) || ACTION_LABELS[e.action]?.toLowerCase().includes(q))
    }
    return true
  })

  // Group by date
  const grouped: Record<string, AuditLogEntry[]> = {}
  for (const entry of filtered) {
    const date = new Date(entry.createdAt).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' })
    if (!grouped[date]) grouped[date] = []
    grouped[date].push(entry)
  }

  const FILTERS: { value: FilterType; label: string }[] = [
    { value: 'all', label: 'Все' },
    { value: 'operations', label: 'Операции' },
    { value: 'warehouse', label: 'Склад' },
    { value: 'finance', label: 'Финансы' },
    { value: 'settings', label: 'Настройки' },
    { value: 'print', label: 'Печать' },
  ]

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-xl font-bold text-foreground">История изменений</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Все действия сотрудников в системе</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-1 bg-muted/50 p-1 rounded-xl">
          {FILTERS.map(f => (
            <button key={f.value} onClick={() => setFilter(f.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${filter === f.value ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по сотруднику, действию..."
            className="w-full pl-9 pr-3 py-2 bg-card border border-border rounded-xl text-sm" />
        </div>
      </div>

      {/* Empty */}
      {filtered.length === 0 && (
        <div className="bg-card rounded-xl border border-border p-12 text-center">
          <History className="size-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="font-medium text-foreground">{entries.length === 0 ? 'Нет записей' : 'Ничего не найдено'}</p>
          <p className="text-sm text-muted-foreground mt-1">
            {entries.length === 0 ? 'Действия сотрудников будут записываться автоматически' : 'Попробуйте другой фильтр'}
          </p>
        </div>
      )}

      {/* Timeline */}
      <AuditTimeline grouped={grouped} onPreview={setPreviewEntry} />

      {previewEntry && (
        <PrintPreviewModal entry={previewEntry} onClose={() => setPreviewEntry(null)} />
      )}
    </div>
  )
}

function PrintPreviewModal({ entry, onClose }: { entry: AuditLogEntry; onClose: () => void }) {
  const raw = entry.details
  const details: Record<string, unknown> = typeof raw === 'string'
    ? (() => { try { return JSON.parse(raw) } catch { return {} } })()
    : (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {})
  const hex = String(details.content_hex ?? '')
  const printerName = (details.printer_name as string | null) || 'Принтер не настроен'
  const printerIP = details.printer_ip as string | null
  const status = String(details.status ?? '')
  const text = decodeCP866Text(hex)

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card rounded-2xl border border-border w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="min-w-0">
            <h2 className="font-bold text-foreground truncate">{entry.entityName || 'Печать'}</h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {printerName}{printerIP ? ` · ${printerIP}` : ''}
              <span className={`ml-2 inline-flex text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${PRINT_STATUS_BADGE[status] || 'bg-muted'}`}>
                {PRINT_STATUS_LABEL[status] || status}
              </span>
            </p>
          </div>
          <button onClick={onClose} className="size-8 rounded-lg hover:bg-muted flex items-center justify-center shrink-0">
            <X className="size-4" />
          </button>
        </div>

        <div className="overflow-auto p-5 space-y-4">
          <div>
            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">Превью чека</h3>
            <pre className="bg-muted/40 rounded-lg p-4 text-xs font-mono whitespace-pre-wrap break-words border border-border">{text || '(пусто)'}</pre>
          </div>
          <div>
            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">ESC/POS hex ({hex.length / 2} байт)</h3>
            <pre className="bg-muted/40 rounded-lg p-4 text-[10px] font-mono whitespace-pre-wrap break-all border border-border max-h-48 overflow-auto">{hex.match(/.{1,2}/g)?.join(' ') || ''}</pre>
          </div>
        </div>
      </div>
    </div>
  )
}

// Decode the printable text out of an ESC/POS hex stream so devs can read what
// would have been printed. Skips command bytes (ESC/GS/FS sequences) and
// reverses the CP866 mapping for Cyrillic.
function decodeCP866Text(hex: string): string {
  const CP866_REV: Record<number, string> = {}
  'АБВГДЕЖЗИЙКЛМНОП'.split('').forEach((c, i) => { CP866_REV[0x80 + i] = c })
  'РСТУФХЦЧШЩЪЫЬЭЮЯ'.split('').forEach((c, i) => { CP866_REV[0x90 + i] = c })
  'абвгдежзийклмноп'.split('').forEach((c, i) => { CP866_REV[0xA0 + i] = c })
  'рстуфхцчшщъыьэюя'.split('').forEach((c, i) => { CP866_REV[0xE0 + i] = c })
  CP866_REV[0xF0] = 'Ё'
  CP866_REV[0xF1] = 'ё'

  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))

  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b === 0x1B) { // ESC + variable command — skip 1 cmd byte + sometimes 1 arg
      const cmd = bytes[i + 1]
      i += 1
      if (cmd === 0x74 || cmd === 0x61 || cmd === 0x45 || cmd === 0x21) i += 1
      continue
    }
    if (b === 0x1D) { // GS + cmd + 1-3 args (we cover the ones used)
      const cmd = bytes[i + 1]
      i += 1
      if (cmd === 0x21) i += 1
      else if (cmd === 0x56) i += 2
      continue
    }
    if (b === 0x1C) { i += 1; continue } // FS
    if (b === 0x0A) { out += '\n'; continue }
    if (b === 0x0D) continue
    if (b < 0x20) continue
    if (b < 0x80) out += String.fromCharCode(b)
    else out += CP866_REV[b] || '·'
  }
  return out
}
