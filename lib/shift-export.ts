// Экспорт смены в Excel. Тянем сводку, операции, расходы, заказы смены и
// агрегаты по обслуживанию официантов — каждый раздел на отдельный лист.
import * as XLSX from 'xlsx'
import {
  fetchOrders,
  fetchShiftOperations,
  fetchFinancialOperations,
  fetchUsers,
  fetchTables,
  fetchVoidsForOrders,
} from './queries'
import type { CashShift, Order } from './types'
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

/** Округление до 2 знаков для денежных значений в Excel. */
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
  // Excel ограничивает имя листа 31 символом.
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31))
}

export async function exportShiftToXlsx(shift: CashShift): Promise<void> {
  // Параллельно тянем всё нужное.
  const [ops, orders, allOps, users, tables] = await Promise.all([
    fetchShiftOperations(shift.id).catch(() => []),
    fetchOrders({ shiftId: shift.id }).catch(() => [] as Order[]),
    fetchFinancialOperations().catch(() => []),
    fetchUsers().catch(() => []),
    fetchTables().catch(() => []),
  ])

  // Voids нужны, чтобы счётчик «Позиций» в листе «Заказы» не включал
  // воиднутые блюда (иначе расходится с чеком/выручкой смены).
  const voidsByOrderId = await fetchVoidsForOrders(orders.map(o => o.id)).catch(() => new Map())

  // Расходы за смену = financial_operations с этим shiftId и type=out (исключаем
  // системные operations, тут категория не «Выплата обслуживания»).
  const expenses = allOps.filter(o => o.shiftId === shift.id && o.type === 'out' && o.category !== 'Выплата обслуживания')

  const userById = new Map(users.map(u => [u.id, u]))
  const tableById = new Map(tables.map(t => [t.id, t]))
  const waiterName = (id?: string) => (id ? (userById.get(id)?.name ?? '—') : '—')
  const tableName = (id?: string) => (id ? (tableById.get(id)?.name ?? '') : '')

  // Агрегаты по официантам — обслуживание (service_amount по done заказам смены).
  const accrualMap = new Map<string, { name: string; accrued: number; ordersCount: number }>()
  for (const o of orders) {
    if (o.status !== 'done') continue
    const amt = Number(o.serviceAmount ?? 0)
    if (amt <= 0) continue
    const wid = o.waiterId ?? '—'
    const cur = accrualMap.get(wid) ?? { name: waiterName(o.waiterId), accrued: 0, ordersCount: 0 }
    cur.accrued += amt
    cur.ordersCount += 1
    accrualMap.set(wid, cur)
  }
  const payoutsByWaiter = new Map<string, number>()
  for (const op of allOps) {
    if (op.category !== 'Выплата обслуживания' || op.type !== 'out') continue
    if (op.shiftId !== shift.id) continue
    const wid = op.sourceRef ?? ''
    payoutsByWaiter.set(wid, (payoutsByWaiter.get(wid) ?? 0) + Number(op.amount))
  }

  const cashIn = num(ops.filter(o => o.type === 'cash_in').reduce((s, o) => s + o.amount, 0))
  const cashOut = num(ops.filter(o => o.type === 'cash_out').reduce((s, o) => s + o.amount, 0))
  const expensesTotal = num(expenses.reduce((s, o) => s + o.amount, 0))
  const totalRevenue = num(shift.cashRevenue + shift.cardRevenue)
  const diff = shift.closingBalance != null && shift.expectedCash != null
    ? num(shift.closingBalance - shift.expectedCash)
    : null

  const wb = XLSX.utils.book_new()

  // Лист 1: Сводка
  const summaryPairs: Array<[string, string | number]> = [
    ['Смена', `#${shift.id.slice(0, 8)}`],
    ['Открыта', fmtDate(shift.openedAt)],
    ['Закрыта', shift.closedAt ? fmtDate(shift.closedAt) : '— активна —'],
    ['Длительность', fmtDuration(shift.openedAt, shift.closedAt)],
    ['Открыл', shift.openedByName ?? '—'],
    ['Закрыл', shift.closedByName ?? '—'],
    ['Счёт кассы', shift.accountName ?? '—'],
    ['', ''],
    ['Начальный остаток', num(shift.openingBalance)],
    ['Внесения', cashIn],
    ['Изъятия', cashOut],
    ['Расходы из смены', expensesTotal],
    ['', ''],
    ['Выручка наличные', num(shift.cashRevenue)],
    ['Выручка безнал', num(shift.cardRevenue)],
    ['Итого выручка', totalRevenue],
    ['Заказов', shift.ordersCount],
    ['Средний чек', num(shift.avgCheck)],
    ['', ''],
    ['Ожидалось в кассе', num(shift.expectedCash ?? 0)],
    ['Фактический остаток', shift.closingBalance != null ? num(shift.closingBalance) : ''],
    ['Разница', diff ?? ''],
  ]
  const summary = summaryPairs.map(([k, v]) => ({ Параметр: k, Значение: v }))
  appendSheet(wb, 'Сводка', summary, ['Параметр', 'Значение'])

  // Лист 2: Операции (внесения/изъятия)
  const opsRows = ops.map(o => ({
    'Время': fmtDate(o.createdAt),
    'Тип': o.type === 'cash_in' ? 'Внесение' : 'Изъятие',
    'Сумма': num(o.amount),
    'Описание': o.description ?? '',
    'Кто': o.createdByName ?? '',
  }))
  appendSheet(wb, 'Операции', opsRows, ['Время', 'Тип', 'Сумма', 'Описание', 'Кто'])

  // Лист 3: Расходы
  const expRows = expenses.map(e => ({
    'Дата': fmtDate(e.date),
    'Категория': e.category,
    'Сумма': num(e.amount),
    'Счёт': e.accountName ?? '',
    'Описание': e.description ?? '',
    'Контрагент': e.counterparty ?? '',
  }))
  appendSheet(wb, 'Расходы', expRows, ['Дата', 'Категория', 'Сумма', 'Счёт', 'Описание', 'Контрагент'])

  // Лист 4: Заказы
  const orderRows = orders.map(o => {
    const orderVoids = voidsByOrderId.get(o.id)
    const voidedFlags = voidedItemFlags(o.items, orderVoids)
    const items = o.items.filter((i, idx) => !i.cancelledAt && !voidedFlags[idx])
    const voidedCount = voidedFlags.reduce((s, f, idx) => s + (f && !o.items[idx].cancelledAt ? 1 : 0), 0)
    return {
      '#': o.orderNumber ?? o.id.slice(0, 8),
      'Создан': fmtDate(o.createdAt),
      'Закрыт': fmtDate(o.closedAt ?? null),
      'Тип': TYPE_LABEL[o.type] ?? o.type,
      'Стол': tableName(o.tableId),
      'Статус': STATUS_LABEL[o.status] ?? o.status,
      'Гостей': o.guestsCount ?? 1,
      'Официант': waiterName(o.waiterId),
      'Способ оплаты': o.paymentMethod ? (PAY_LABEL[o.paymentMethod] ?? o.paymentMethod) : '',
      'Позиций': items.length,
      'Списано': voidedCount,
      'Подытог': num(o.total),
      'Скидка': num(o.discountAmount ?? 0),
      'Обсл. %': o.servicePercent ?? 0,
      'Обсл. сумма': num(o.serviceAmount ?? 0),
      'Чаевые': num(o.tipAmount ?? 0),
      'Итого': num(o.totalWithService ?? o.total),
      'Причина отмены': o.cancelReason ?? '',
    }
  })
  appendSheet(wb, 'Заказы', orderRows, [
    '#', 'Создан', 'Закрыт', 'Тип', 'Стол', 'Статус', 'Гостей', 'Официант',
    'Способ оплаты', 'Позиций', 'Списано', 'Подытог', 'Скидка', 'Обсл. %', 'Обсл. сумма',
    'Чаевые', 'Итого', 'Причина отмены',
  ])

  // Лист 5: Обслуживание
  const accrualRows = Array.from(accrualMap.entries()).map(([wid, v]) => {
    const paid = payoutsByWaiter.get(wid) ?? 0
    return {
      'Официант': v.name,
      'Заказов': v.ordersCount,
      'Начислено': num(v.accrued),
      'Выплачено': num(paid),
      'К выплате': num(Math.max(0, v.accrued - paid)),
    }
  })
  appendSheet(wb, 'Обслуживание', accrualRows, ['Официант', 'Заказов', 'Начислено', 'Выплачено', 'К выплате'])

  // Имя файла: Смена_2026-05-01_abcdef12.xlsx
  const dateLabel = (shift.closedAt ? new Date(shift.closedAt) : new Date(shift.openedAt))
    .toLocaleDateString('ru', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\./g, '-')
  XLSX.writeFile(wb, `Смена_${dateLabel}_${shift.id.slice(0, 8)}.xlsx`)
}
