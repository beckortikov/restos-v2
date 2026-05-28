// Экспорт списка заказов в Excel — лист «Заказы» (одна строка на заказ) и лист
// «Позиции» (строки по каждой позиции для детальной выгрузки). Имена столов,
// зон и пользователей резолвятся через переданные коллекции — чтобы экспорт
// был самодостаточным и быстрым (без повторных fetch).
import * as XLSX from 'xlsx'
import type { Order, OrderVoid, Table, Zone, User } from './types'
import { voidedItemFlags } from './helpers'

function fmtDate(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('ru', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtDuration(openedAt?: string | null, closedAt?: string | null): string {
  if (!openedAt) return ''
  const start = new Date(openedAt).getTime()
  const end = closedAt ? new Date(closedAt).getTime() : Date.now()
  if (isNaN(start) || isNaN(end)) return ''
  const mins = Math.max(0, Math.floor((end - start) / 60000))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}ч ${m}м`
}

function num(n: number): number {
  return Math.round(n * 100) / 100
}

const TYPE_LABEL: Record<string, string> = {
  hall: 'Зал',
  takeaway: 'Самовывоз',
  delivery: 'Доставка',
}

const STATUS_LABEL: Record<string, string> = {
  new: 'Новый',
  cooking: 'Готовится',
  ready: 'К выдаче',
  served: 'Подано',
  bill_requested: 'Счёт',
  done: 'Оплачен',
  cancelled: 'Отменён',
}

const PAY_LABEL: Record<string, string> = {
  cash: 'Наличные',
  card: 'Карта',
  transfer: 'Перевод',
}

function autosize(rows: Record<string, unknown>[], headers: string[]): XLSX.ColInfo[] {
  return headers.map(h => {
    let max = h.length
    for (const r of rows) {
      const v = String(r[h] ?? '')
      if (v.length > max) max = v.length
    }
    return { wch: Math.min(max + 2, 40) }
  })
}

function appendSheet(wb: XLSX.WorkBook, name: string, rows: Record<string, unknown>[], headers: string[]) {
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers })
  ws['!cols'] = autosize(rows, headers)
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31))
}

export interface ExportOrdersContext {
  tables: Table[]
  zones?: Zone[]
  users: User[]
  /** voids по order_id — для корректного исключения списанных позиций
   *  из счётчика «Позиций» и пометки в листе «Позиции». Без него экспорт
   *  считает воиднутые блюда как живые (отчёт расходится с чеком). */
  voidsByOrderId?: Map<string, OrderVoid[]>
  filenameSuffix?: string
}

export function exportOrdersToXlsx(orders: Order[], ctx: ExportOrdersContext): void {
  const tableById = new Map(ctx.tables.map(t => [t.id, t]))
  const zoneById = new Map((ctx.zones ?? []).map(z => [z.id, z]))
  const userById = new Map(ctx.users.map(u => [u.id, u]))
  const userName = (id?: string) => (id ? (userById.get(id)?.name ?? '—') : '')
  const tableLabel = (id?: string) => (id ? (tableById.get(id)?.name ?? '') : '')
  const zoneLabel = (id?: string) => {
    if (!id) return ''
    const t = tableById.get(id)
    if (!t) return ''
    return zoneById.get(t.zone)?.name ?? ''
  }

  const wb = XLSX.utils.book_new()

  // Лист 1: Заказы — одна строка на заказ.
  const orderHeaders = [
    '#', 'Создан', 'Закрыт', 'Длительность', 'Тип', 'Стол', 'Зона', 'Статус',
    'Гостей', 'Официант', 'Кассир',
    'Способ оплаты', 'Счёт',
    'Позиций', 'Отменено позиций', 'Списано позиций',
    'Подытог', 'Скидка', 'Скидка %', 'Скидка причина',
    'Обсл. %', 'Обсл. сумма', 'Чаевые', 'Итого',
    'Причина отмены', 'Комментарий',
  ]
  const orderRows = orders.map(o => {
    const orderVoids = ctx.voidsByOrderId?.get(o.id)
    const voidedFlags = voidedItemFlags(o.items, orderVoids)
    const items = o.items.filter((i, idx) => !i.cancelledAt && !voidedFlags[idx])
    const cancelled = o.items.filter(i => !!i.cancelledAt)
    const voidedCount = voidedFlags.reduce((s, f, idx) => s + (f && !o.items[idx].cancelledAt ? 1 : 0), 0)
    const accountName = o.payments && o.payments[0]?.accountName ? o.payments[0].accountName : ''
    return {
      '#': o.orderNumber ?? o.id.slice(0, 8),
      'Создан': fmtDate(o.createdAt),
      'Закрыт': fmtDate(o.closedAt ?? null),
      'Длительность': fmtDuration(o.createdAt, o.closedAt),
      'Тип': TYPE_LABEL[o.type] ?? o.type,
      'Стол': tableLabel(o.tableId),
      'Зона': zoneLabel(o.tableId),
      'Статус': STATUS_LABEL[o.status] ?? o.status,
      'Гостей': o.guestsCount ?? 1,
      'Официант': userName(o.waiterId),
      'Кассир': userName(o.cashierId),
      'Способ оплаты': o.paymentMethod ? (PAY_LABEL[o.paymentMethod] ?? o.paymentMethod) : '',
      'Счёт': accountName,
      'Позиций': items.length,
      'Отменено позиций': cancelled.length,
      'Списано позиций': voidedCount,
      'Подытог': num(o.total),
      'Скидка': num(o.discountAmount ?? 0),
      'Скидка %': o.discountType === 'percent' ? (o.discountValue ?? 0) : '',
      'Скидка причина': o.discountReason ?? '',
      'Обсл. %': o.servicePercent ?? 0,
      'Обсл. сумма': num(o.serviceAmount ?? 0),
      'Чаевые': num(o.tipAmount ?? 0),
      'Итого': num(o.totalWithService ?? o.total),
      'Причина отмены': o.cancelReason ?? '',
      'Комментарий': o.comment ?? '',
    }
  })
  appendSheet(wb, 'Заказы', orderRows, orderHeaders)

  // Лист 2: Позиции — детально, по строке на каждую позицию (включая отменённые
  // — отмечены в колонке «Отменена»). Удобно для аналитики продаж по блюдам.
  const itemHeaders = [
    '# Заказа', 'Создан', 'Стол', 'Тип', 'Статус заказа',
    'Блюдо', 'Кол-во', 'Ед.', 'Размер',
    'Цена', 'Сумма', 'Себестоимость', 'Маржа',
    'Отменена', 'Списана', 'Причина отмены позиции',
  ]
  const itemRows: Record<string, unknown>[] = []
  for (const o of orders) {
    const orderVoids = ctx.voidsByOrderId?.get(o.id)
    const voidedFlags = voidedItemFlags(o.items, orderVoids)
    o.items.forEach((it, idx) => {
      const isVoided = !it.cancelledAt && voidedFlags[idx]
      const lineTotal = (it.unit === 'piece' || !it.unit)
        ? num(Number(it.price) * Number(it.qty))
        : num(Number(it.price) * (Number(it.qty) / (it.unitSize && it.unitSize > 0 ? it.unitSize : 1)))
      const cogsTotal = num((Number(it.cogs ?? 0)) *
        (it.unit === 'piece' || !it.unit ? Number(it.qty) : Number(it.qty) / (it.unitSize && it.unitSize > 0 ? it.unitSize : 1)))
      itemRows.push({
        '# Заказа': o.orderNumber ?? o.id.slice(0, 8),
        'Создан': fmtDate(o.createdAt),
        'Стол': tableLabel(o.tableId),
        'Тип': TYPE_LABEL[o.type] ?? o.type,
        'Статус заказа': STATUS_LABEL[o.status] ?? o.status,
        'Блюдо': it.name,
        'Кол-во': it.qty,
        'Ед.': it.unit ?? 'piece',
        'Размер': it.unitSize ?? '',
        'Цена': num(Number(it.price)),
        'Сумма': lineTotal,
        'Себестоимость': cogsTotal,
        'Маржа': num(lineTotal - cogsTotal),
        'Отменена': it.cancelledAt ? 'Да' : '',
        'Списана': isVoided ? 'Да' : '',
        'Причина отмены позиции': it.cancelReason ?? '',
      })
    })
  }
  appendSheet(wb, 'Позиции', itemRows, itemHeaders)

  const dateLabel = new Date().toLocaleDateString('ru', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\./g, '-')
  const suffix = ctx.filenameSuffix ? `_${ctx.filenameSuffix}` : ''
  XLSX.writeFile(wb, `Заказы_${dateLabel}${suffix}.xlsx`)
}
