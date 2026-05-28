'use client'

import type { Order, MenuItem, User, Table, MenuStation, Zone } from './types'
import { STATION_LABELS } from './types'
import { type RunnerData } from '@/components/print-runner'
import { logAction } from './queries'
import { dLineTotal } from './decimal'
import { enqueuePrintJob, isVirtualPrinterOn } from './print-queue'

// ─── Print Journal — record every print attempt to audit_log ────────────────
// status='mock' is fired when no printer is configured/reachable; the hex
// payload is stored so devs can see exactly what would have been printed.

type PrintStatus = 'success' | 'failed' | 'mock'
type PrintAction = 'print.runner' | 'print.receipt' | 'print.cancel'

function logPrint(opts: {
  action: PrintAction
  status: PrintStatus
  printerName?: string
  printerIP?: string
  orderId?: string
  summary: string
  hex?: string
  extra?: Record<string, unknown>
}) {
  // Skip hex on success to avoid bloating audit rows (1–3 KB per receipt).
  const includeHex = opts.status !== 'success' && opts.hex
  void logAction(opts.action, 'print', opts.orderId, opts.summary, {
    status: opts.status,
    printer_name: opts.printerName || null,
    printer_ip: opts.printerIP || null,
    ...(includeHex ? { content_hex: opts.hex } : {}),
    ...opts.extra,
  })
}

// ─── CP866 encoding for Cyrillic on thermal printers ────────────────────────

const CP866_MAP: Record<string, number> = {}
// А-П (0x80-0x8F)
'АБВГДЕЖЗИЙКЛМНОП'.split('').forEach((c, i) => { CP866_MAP[c] = 0x80 + i })
// Р-Я (0x90-0x9F)
'РСТУФХЦЧШЩЪЫЬЭЮЯ'.split('').forEach((c, i) => { CP866_MAP[c] = 0x90 + i })
// а-п (0xA0-0xAF)
'абвгдежзийклмноп'.split('').forEach((c, i) => { CP866_MAP[c] = 0xA0 + i })
// р-я (0xE0-0xEF)
'рстуфхцчшщъыьэюя'.split('').forEach((c, i) => { CP866_MAP[c] = 0xE0 + i })
// Ё/ё
CP866_MAP['Ё'] = 0xF0
CP866_MAP['ё'] = 0xF1
// Misc CP866 typography chars that appear in our receipts/runners
CP866_MAP['·'] = 0xFA  // middle dot
CP866_MAP['№'] = 0xFC  // numero sign
CP866_MAP['°'] = 0xF8  // degree
CP866_MAP['¤'] = 0xFD  // currency
// Approximations for chars not in CP866 — fall back to ASCII look-alikes
CP866_MAP['—'] = 0x2D  // em dash → -
CP866_MAP['–'] = 0x2D  // en dash → -
CP866_MAP['«'] = 0x22  // left guillemet → "
CP866_MAP['»'] = 0x22  // right guillemet → "
CP866_MAP['“'] = 0x22
CP866_MAP['”'] = 0x22
CP866_MAP['„'] = 0x22
CP866_MAP['…'] = 0x2E  // ellipsis → .

function toCP866Hex(str: string): string {
  let hex = ''
  for (const ch of str) {
    if (CP866_MAP[ch] !== undefined) {
      hex += CP866_MAP[ch].toString(16).padStart(2, '0')
    } else {
      const code = ch.charCodeAt(0)
      if (code < 128) {
        hex += code.toString(16).padStart(2, '0')
      } else {
        hex += '3F' // ? for unknown chars
      }
    }
  }
  return hex
}

function hexCmd(cmd: string): string {
  return cmd.replace(/\s/g, '')
}

function buildEscPosRunner(data: RunnerData): { type: string; format: string; data: string }[] {
  const d = new Date(data.createdAt)
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
  const dateStr = `${d.getDate()} ${months[d.getMonth()]} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  const station = STATION_LABELS[data.station]
  const typeLabel = data.orderType === 'hall' ? 'Зал' : data.orderType === 'delivery' ? 'Доставка' : 'Самовывоз'

  const tableLabel = data.tableName
    ? (String(data.tableName).toLowerCase().startsWith('стол') ? String(data.tableName) : `Стол ${data.tableName}`)
    : ''
  const zoneLabel = data.zoneName || (data.orderType === 'hall' ? '' : typeLabel)
  const guestsLabel = data.guestsCount ? `${data.guestsCount} гост.` : ''
  const infoParts = [tableLabel, zoneLabel, guestsLabel].filter(Boolean).join(', ')

  let hex = ''

  // Reset printer
  hex += hexCmd('1B 40')

  // Disable Chinese/Kanji mode (CRITICAL for XPrinter — defaults to Chinese)
  hex += hexCmd('1C 2E')

  // Set CP866 code page (code page 17 = Cyrillic)
  hex += hexCmd('1B 74 11')

  // Station header — centered, bold, double height only (compact)
  hex += hexCmd('1B 61 01')     // center
  hex += hexCmd('1B 45 01')     // bold on
  hex += hexCmd('1D 21 01')     // double height, single width
  hex += toCP866Hex(station.toUpperCase())
  hex += hexCmd('0A')           // newline
  hex += hexCmd('1D 21 00')     // normal size
  hex += hexCmd('1B 45 00')     // bold off

  // Большая пометка «САМОВЫВОЗ» / «ДОСТАВКА» сразу под станцией — чтобы
  // повар СРАЗУ видел: это не зал, готовим/упаковываем по-другому.
  if (data.orderType !== 'hall') {
    hex += hexCmd('1B 45 01')    // bold on
    hex += hexCmd('1D 21 11')    // double width + height (★ внимание)
    hex += toCP866Hex(`★ ${typeLabel.toUpperCase()} ★`)
    hex += hexCmd('0A')
    hex += hexCmd('1D 21 00')
    hex += hexCmd('1B 45 00')
  }

  hex += toCP866Hex('________________________________')
  hex += hexCmd('0A')

  // Order info — left align
  hex += hexCmd('1B 61 00')     // left
  hex += toCP866Hex(`${dateStr} Зак: ${data.orderNumber}`)
  if (data.waiterName) hex += toCP866Hex(` ${data.waiterName}`)
  hex += hexCmd('0A')

  // Table + zone + guests — bold
  hex += hexCmd('1B 45 01')
  hex += toCP866Hex(infoParts)
  hex += hexCmd('0A')
  hex += hexCmd('1B 45 00')
  hex += toCP866Hex('--------------------------------')
  hex += hexCmd('0A')

  // Items — bold, double height
  hex += hexCmd('1D 21 01')     // double height
  hex += hexCmd('1B 45 01')     // bold
  for (const item of data.items) {
    const name = item.name
    // Format qty: "×2" for piece, "250г" / "1.5кг" for weight
    const qty = item.unit === 'g'
      ? `${Math.round(item.qty)}г`
      : item.unit === 'kg'
        ? `${Number(item.qty).toFixed(item.qty < 10 ? 2 : 1).replace(/\.?0+$/, '')}кг`
        : `x${item.qty}`
    const pad = Math.max(0, 20 - name.length - qty.length)
    hex += toCP866Hex(name + ' '.repeat(pad) + qty)
    hex += hexCmd('0A')
    if (item.modifiers?.length) {
      hex += hexCmd('1D 21 00') // normal for modifiers
      for (const m of item.modifiers) {
        hex += toCP866Hex(`  + ${m}`)
        hex += hexCmd('0A')
      }
      hex += hexCmd('1D 21 01') // back to double height
    }
  }
  hex += hexCmd('1B 45 00')     // bold off
  hex += hexCmd('1D 21 00')     // normal size

  // Comment
  if (data.comment) {
    hex += toCP866Hex('--------------------------------')
    hex += hexCmd('0A')
    hex += toCP866Hex(`! ${data.comment}`)
    hex += hexCmd('0A')
  }

  // Minimal feed + partial cut
  hex += hexCmd('0A')
  hex += hexCmd('1D 56 42 03')  // GS V 66 3: partial cut

  return [{ type: 'raw', format: 'hex', data: hex }]
}

// ─── ESC/POS receipt (guest check / pre-check) ─────────────────────────────

// 80mm thermal printers fit 42 chars per line at Font A (12x24 dots).
// Was 32 before — that's 58mm width, leaving the right ~25% of the paper
// empty on 80mm models (Epson TM-T20/T88, XPrinter XP-T80, Star TSP143…).
const RECEIPT_WIDTH = 42
const HR_HEAVY = '='.repeat(RECEIPT_WIDTH)
const HR_LIGHT = '-'.repeat(RECEIPT_WIDTH)

function padRight(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width)
  return s + ' '.repeat(width - s.length)
}

function padBetween(left: string, right: string, width: number = RECEIPT_WIDTH): string {
  const space = Math.max(1, width - left.length - right.length)
  return left + ' '.repeat(space) + right
}

function center(s: string, width: number = RECEIPT_WIDTH): string {
  if (s.length >= width) return s.slice(0, width)
  const pad = Math.floor((width - s.length) / 2)
  return ' '.repeat(pad) + s
}

// Remove emoji / non-CP866-renderable characters that would otherwise print as `?`.
function stripEmoji(s: string): string {
  return s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{1F300}-\u{1F9FF}]/gu, '').trim()
}

export interface ReceiptPrintData {
  orderId: string
  orderNumber?: number | string
  orderType: 'hall' | 'delivery' | 'takeaway'
  restaurantName?: string
  restaurantAddress?: string
  tableName?: string
  zoneName?: string
  waiterName?: string
  cashierName?: string
  items: { name: string; qty: number; price: number; unit?: 'piece' | 'g' | 'kg'; unitSize?: number; modifiers?: { name: string; price: number }[] }[]
  subtotal: number
  discountAmount?: number
  discountReason?: string
  servicePercent: number
  serviceAmount: number
  tipAmount?: number
  guestsCount?: number
  total: number
  paymentMethod?: 'cash' | 'card' | 'transfer'
  accountName?: string
  createdAt: string
  closedAt: string
  isPreCheck?: boolean
}

function buildEscPosReceipt(data: ReceiptPrintData): { type: string; format: string; data: string }[] {
  const d = new Date(data.closedAt)
  const dateStr = `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear().toString().slice(-2)} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  const typeLabel = data.orderType === 'hall' ? (data.zoneName || 'Зал') : data.orderType === 'delivery' ? 'Доставка' : 'Самовывоз'
  const tableLine = [typeLabel, data.tableName ? (String(data.tableName).toLowerCase().startsWith('стол') ? String(data.tableName) : `Стол ${data.tableName}`) : null].filter(Boolean).join(' · ')

  const fmtMoney = (n: number) => n.toFixed(2).replace('.', ',')
  const fmtQty = (item: ReceiptPrintData['items'][number]) => {
    if (item.unit === 'g') return `${Math.round(item.qty)}г`
    if (item.unit === 'kg') return `${Number(item.qty).toFixed(item.qty < 10 ? 2 : 1).replace(/\.?0+$/, '')}кг`
    return `x${item.qty}`
  }

  let hex = ''

  // Reset + CP866
  hex += hexCmd('1B 40')
  hex += hexCmd('1C 2E')         // disable Chinese mode (XPrinter)
  hex += hexCmd('1B 74 11')      // CP866

  // Bold ON for the whole receipt — non-bold prints faded on most thermal heads.
  // iiko also prints everything in emphasized mode for consistent darkness.
  hex += hexCmd('1B 45 01')

  // Top border
  hex += hexCmd('1B 61 01')      // center
  hex += toCP866Hex(HR_HEAVY)
  hex += hexCmd('0A')

  // Restaurant name — double height
  hex += hexCmd('1D 21 01')
  hex += toCP866Hex(stripEmoji(data.restaurantName || 'RestOS').toUpperCase())
  hex += hexCmd('0A')
  hex += hexCmd('1D 21 00')

  if (data.restaurantAddress) {
    hex += toCP866Hex(data.restaurantAddress)
    hex += hexCmd('0A')
  }

  hex += toCP866Hex(HR_HEAVY)
  hex += hexCmd('0A')

  // Document title — double size
  hex += hexCmd('1D 21 01')
  hex += toCP866Hex(data.isPreCheck ? 'ПРЕДВАРИТЕЛЬНЫЙ СЧЁТ' : 'ГОСТЕВОЙ СЧЁТ')
  hex += hexCmd('0A')
  hex += hexCmd('1D 21 00')

  // Body — keep centered alignment so standalone lines (tableLine, dashes,
  // footer) sit in the middle. Full-width padBetween rows fill RECEIPT_WIDTH
  // chars and therefore look identical under center vs left.
  hex += hexCmd('1B 61 01')      // center
  hex += toCP866Hex(HR_LIGHT)
  hex += hexCmd('0A')

  const orderRef = data.orderNumber ? `#${data.orderNumber}` : data.orderId.slice(0, 8).toUpperCase()
  const lines: Array<[string, string | undefined]> = [
    ['Чек №', orderRef],
    ['Дата', dateStr],
    ['', tableLine || undefined],
    ['Официант', data.waiterName],
    ['Кассир', data.cashierName],
    ['Гостей', data.guestsCount ? String(data.guestsCount) : undefined],
  ]
  for (const [k, v] of lines) {
    if (!v) continue
    hex += toCP866Hex(k ? padBetween(k, v) : v)
    hex += hexCmd('0A')
  }

  // Items header
  hex += toCP866Hex(HR_LIGHT)
  hex += hexCmd('0A')
  hex += toCP866Hex(padBetween('Наименование', 'Сумма'))
  hex += hexCmd('0A')
  hex += toCP866Hex(HR_LIGHT)
  hex += hexCmd('0A')

  // Items — name + qty + price on a single line for compactness.
  // 30 chars for left part leaves 12 for "XXXXX,XX TJS" + space.
  const ITEM_LEFT_MAX = 30
  for (const item of data.items) {
    const lineTotal = dLineTotal(item.price, item.qty, item.unit, item.unitSize)
    const qtyStr = fmtQty(item)
    const totalStr = `${fmtMoney(lineTotal)} TJS`
    const nameWithQty = `${item.name} ${qtyStr}`
    const left = nameWithQty.length > ITEM_LEFT_MAX ? nameWithQty.slice(0, ITEM_LEFT_MAX) : nameWithQty
    hex += toCP866Hex(padBetween(left, totalStr))
    hex += hexCmd('0A')
    if (item.modifiers?.length) {
      for (const m of item.modifiers) {
        hex += toCP866Hex(`  + ${m.name}${m.price > 0 ? ` (+${fmtMoney(m.price)})` : ''}`)
        hex += hexCmd('0A')
      }
    }
  }

  hex += toCP866Hex(HR_LIGHT)
  hex += hexCmd('0A')

  // Subtotal / discount / service
  hex += toCP866Hex(padBetween('Подытог', `${fmtMoney(data.subtotal)} TJS`))
  hex += hexCmd('0A')
  if (data.discountAmount && data.discountAmount > 0) {
    const lbl = data.discountReason ? `Скидка (${data.discountReason})` : 'Скидка'
    hex += toCP866Hex(padBetween(lbl.slice(0, ITEM_LEFT_MAX), `-${fmtMoney(data.discountAmount)} TJS`))
    hex += hexCmd('0A')
  }
  if (data.servicePercent > 0) {
    hex += toCP866Hex(padBetween(`Обслуживание (${data.servicePercent}%)`, `${fmtMoney(data.serviceAmount)} TJS`))
    hex += hexCmd('0A')
  }
  if (data.tipAmount && data.tipAmount > 0) {
    hex += toCP866Hex(padBetween('Чаевые', `${fmtMoney(data.tipAmount)} TJS`))
    hex += hexCmd('0A')
  }

  // Total — double size, bold
  hex += toCP866Hex(HR_HEAVY)
  hex += hexCmd('0A')
  hex += hexCmd('1B 45 01')
  hex += hexCmd('1D 21 11')      // double width + height
  // Double-width chars are 2× wide so the budget for padBetween halves.
  hex += toCP866Hex(padBetween('ИТОГО', `${fmtMoney(data.total)} TJS`, Math.floor(RECEIPT_WIDTH / 2)))
  hex += hexCmd('0A')
  hex += hexCmd('1D 21 00')
  hex += toCP866Hex(HR_HEAVY)
  hex += hexCmd('0A')

  // Payment info (skip on pre-check)
  if (!data.isPreCheck && data.paymentMethod) {
    const pmLbl = data.paymentMethod === 'cash' ? 'Наличные' : 'Безналичные'
    hex += toCP866Hex(padBetween('Оплата', pmLbl))
    hex += hexCmd('0A')
    if (data.accountName) {
      hex += toCP866Hex(padBetween('Счёт', data.accountName))
      hex += hexCmd('0A')
    }
  }

  // Footer (still bold from the global setting at the top)
  hex += hexCmd('0A')
  hex += hexCmd('1B 61 01')      // center
  if (data.isPreCheck) {
    hex += toCP866Hex('Не является фискальным документом')
  } else {
    hex += toCP866Hex('СПАСИБО! ЖДЁМ ВАС СНОВА!')
  }
  hex += hexCmd('0A')
  hex += toCP866Hex('Powered by RestOS')
  hex += hexCmd('0A')
  hex += hexCmd('0A')

  // Bold off + cut
  hex += hexCmd('1B 45 00')
  hex += hexCmd('1D 56 42 03')

  return [{ type: 'raw', format: 'hex', data: hex }]
}

// ─── Printer settings (stored in localStorage) ──────────────────────────────

export interface StationPrinter {
  station: MenuStation
  printerName: string  // Display label for printer (server matches by IP)
  printerIP?: string   // IP address for network printing via print server
  enabled: boolean
}

// Cashier (receipt) printer — separate from station printers because every
// restaurant prints guest receipts to a dedicated thermal printer at the
// cashier station, not a kitchen station printer.
const RECEIPT_PRINTER_KEY = 'restos-receipt-printer'

export interface ReceiptPrinter {
  printerName: string
  printerIP?: string
  enabled: boolean
}

export function getReceiptPrinter(): ReceiptPrinter | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = localStorage.getItem(RECEIPT_PRINTER_KEY)
    if (!stored) return null
    const p = JSON.parse(stored) as ReceiptPrinter
    return p.enabled ? p : null
  } catch { return null }
}

export function saveReceiptPrinter(p: ReceiptPrinter | null) {
  if (p == null) localStorage.removeItem(RECEIPT_PRINTER_KEY)
  else localStorage.setItem(RECEIPT_PRINTER_KEY, JSON.stringify(p))
  // Mirror config to the desktop's printer-config.json so phones
  // (Capacitor APK / PWA without local config) can fetch it.
  void mirrorConfigToDesktop()
}

// Public alias for AutoPrintRunner to call at boot — mirrors current
// localStorage to the desktop's printer-config.json file even if the user
// hasn't re-clicked "Save" on Settings → Printers.
export async function syncPrinterConfigToDesktop(): Promise<void> {
  return mirrorConfigToDesktop()
}

// Mirror local printer settings to the desktop's printer-config.json so
// phones (Capacitor APK / PWA without their own localStorage config) can
// fetch them via GET /printer-config. No-op outside Electron desktop —
// only the desktop has authority to write the file.
async function mirrorConfigToDesktop(): Promise<void> {
  if (typeof window === 'undefined') return
  const isDesktop = !!(window as any).restosDesktop?.isDesktop
  if (!isDesktop) return
  const stations = (() => {
    try {
      const s = localStorage.getItem(PRINTERS_KEY)
      return s ? (JSON.parse(s) as StationPrinter[]) : []
    } catch { return [] }
  })()
  const receipt = (() => {
    try {
      const r = localStorage.getItem(RECEIPT_PRINTER_KEY)
      return r ? (JSON.parse(r) as ReceiptPrinter) : null
    } catch { return null }
  })()
  // Preserve virtual flag from desktop's localStorage so saving printer
  // settings doesn't accidentally turn the test toggle off in the file.
  const virtual = localStorage.getItem('restos.virtualPrinter') === 'on'
  try {
    const url = (window as any).restosDesktop?.printServerUrl as string | undefined
    if (!url) return
    await fetch(`${url}/printer-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stations, receipt, virtual }),
    })
  } catch (e) {
    console.warn('[print] mirror config to desktop failed:', e)
  }
}

// Pull the desktop's printer config and write it to local localStorage.
// Used by waiter PWA on phones the first time they need to print and have
// no local config. Best-effort — silently no-op on failure.
async function pullConfigFromDesktop(): Promise<boolean> {
  if (typeof window === 'undefined') return false
  try {
    const url = getPrintServerUrl()
    if (!url) return false
    const res = await fetch(`${url}/printer-config`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return false
    const cfg = await res.json() as { stations?: StationPrinter[]; receipt?: ReceiptPrinter | null }
    const stations = Array.isArray(cfg.stations) ? cfg.stations : []
    const receipt = cfg.receipt && typeof cfg.receipt === 'object' ? cfg.receipt : null
    if (stations.length === 0 && !receipt) return false
    localStorage.setItem(PRINTERS_KEY, JSON.stringify(stations))
    if (receipt) localStorage.setItem(RECEIPT_PRINTER_KEY, JSON.stringify(receipt))
    else localStorage.removeItem(RECEIPT_PRINTER_KEY)
    return true
  } catch (e) {
    console.warn('[print] pull config from desktop failed:', e)
    return false
  }
}

// Last failure reason for diagnostics (read by waiter UI to show meaningful toast).
export type ReceiptPrintFailReason =
  | 'no_printer_configured'
  | 'no_transport_available'
  | 'transport_error'
let _lastReceiptError: { reason: ReceiptPrintFailReason; printerIP?: string; details?: string } | null = null

export function getLastReceiptError() { return _lastReceiptError }

// Print a guest receipt directly via ESC/POS. Returns true on success.
// Falls back to false if no receipt printer is configured or the print
// server is unavailable — caller should check getLastReceiptError() for the
// reason and show a meaningful message.
export async function printReceiptDirect(data: ReceiptPrintData): Promise<boolean> {
  _lastReceiptError = null
  // Virtual printer mode: skip real transport, log as mock with `virtual` flag.
  if (isVirtualPrinterOn()) {
    const escpos = buildEscPosReceipt(data)
    logPrint({
      action: 'print.receipt', status: 'mock',
      orderId: data.orderId, summary: receiptSummary(data), hex: escpos[0]?.data,
      extra: { virtual: true, items_count: data.items.length, total: data.total },
    })
    return true
  }
  let cfg = getReceiptPrinter()
  let printerName = cfg?.printerName
  let printerIP = cfg?.printerIP
  let fallback = !printerName && !printerIP
    ? getStationPrinters().find(p => p.enabled && (p.printerName || p.printerIP))
    : null
  // Cache empty (e.g., waiter PWA on a phone with no local config). Pull
  // from the desktop's printer-config.json and retry once before declaring
  // "no printer".
  if (!printerName && !printerIP && !fallback) {
    const pulled = await pullConfigFromDesktop()
    if (pulled) {
      cfg = getReceiptPrinter()
      printerName = cfg?.printerName
      printerIP = cfg?.printerIP
      fallback = !printerName && !printerIP
        ? getStationPrinters().find(p => p.enabled && (p.printerName || p.printerIP))
        : null
    }
  }
  if (!printerName && !printerIP) {
    if (!fallback) {
      const escpos = buildEscPosReceipt(data)
      logPrint({
        action: 'print.receipt',
        status: 'mock',
        orderId: data.orderId,
        summary: receiptSummary(data),
        hex: escpos[0]?.data,
        extra: { reason: 'no_printer_configured', items_count: data.items.length, total: data.total },
      })
      _lastReceiptError = { reason: 'no_printer_configured' }
      return false
    }
    printerName = fallback.printerName
    printerIP = fallback.printerIP
  }

  const escpos = buildEscPosReceipt(data)
  const hexData = escpos[0]?.data || ''

  // Try print server first (Electron desktop has localhost:3001)
  if (printerIP) {
    const ok = await printViaPrintServer(printerIP, hexData)
    if (ok) {
      logPrint({
        action: 'print.receipt', status: 'success', printerName, printerIP,
        orderId: data.orderId, summary: receiptSummary(data),
        extra: { items_count: data.items.length, total: data.total, transport: 'print_server' },
      })
      return true
    }
  }

  // No print server available → log as mock; queue for retry once printer is back.
  logPrint({
    action: 'print.receipt', status: 'mock', printerName, printerIP,
    orderId: data.orderId, summary: receiptSummary(data), hex: hexData,
    extra: { reason: 'no_transport_available', items_count: data.items.length, total: data.total },
  })
  _lastReceiptError = { reason: 'no_transport_available', printerIP }
  // Enqueue retry: this is a network/transport issue, not a config issue.
  if (printerIP) {
    void enqueuePrintJob('receipt', data, receiptSummary(data), {
      printerName, printerIP, lastError: 'no_transport_available',
    })
  }
  return false
}

function receiptSummary(data: ReceiptPrintData): string {
  const ref = data.orderNumber ? `#${data.orderNumber}` : data.orderId.slice(0, 8)
  const kind = data.isPreCheck ? 'Пред-чек' : 'Чек'
  return `${kind} ${ref} · ${data.items.length} поз.`
}

// ─── Print Server (RestOS Print Server) ─────────────────────────────────────

const PRINT_SERVER_KEY = 'restos-print-server-url'

export function getPrintServerUrl(): string {
  if (typeof window === 'undefined') return ''
  // Electron desktop: built-in print server at the desktop's API URL.
  const desktopUrl = (window as any).restosDesktop?.printServerUrl as string | undefined
  if (desktopUrl) return desktopUrl
  const lanUrl = localStorage.getItem('restos-local-server-url')
  const mode = localStorage.getItem('restos-active-mode')
  const override = localStorage.getItem(PRINT_SERVER_KEY)
  // Manual override is honored only if it points to a non-localhost host.
  // On a phone (Capacitor APK / PWA) `localhost` is the phone itself, not
  // the desktop. A legacy override pointing to localhost would silently
  // break printing — skip it in that case and fall through to LAN URL.
  const overrideIsLocalhost = !!override && /\/\/(localhost|127\.)/i.test(override)
  if (override && !overrideIsLocalhost) return override
  if (lanUrl && mode === 'local') return lanUrl
  if (override) return override
  return 'http://localhost:3001'
}

export function savePrintServerUrl(url: string) {
  localStorage.setItem(PRINT_SERVER_KEY, url)
}

async function printViaPrintServer(printerIP: string, hexData: string): Promise<boolean> {
  const serverUrl = getPrintServerUrl()
  try {
    const res = await fetch(`${serverUrl}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerIP, data: hexData }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[print] /print failed: HTTP ${res.status} via ${serverUrl} → ${printerIP}: ${text.slice(0, 200)}`)
    }
    return res.ok
  } catch (e) {
    console.warn(`[print] /print fetch error via ${serverUrl} → ${printerIP}:`, e)
    return false
  }
}

// Cache the /status probe — at peak time AutoPrintRunner on 6 devices polls
// many times per minute and each probe is a network round-trip. The status
// rarely flips, so a 10s TTL collapses the chatter without hurting recovery
// time when the server actually goes down. On failure we cache the negative
// result for half the TTL so the next poll re-probes sooner.
let _printServerAvailableAt = 0
let _printServerAvailable = false
const PRINT_SERVER_AVAILABLE_TTL_OK = 10_000
const PRINT_SERVER_AVAILABLE_TTL_FAIL = 5_000

export async function isPrintServerAvailable(): Promise<boolean> {
  const now = Date.now()
  const ttl = _printServerAvailable ? PRINT_SERVER_AVAILABLE_TTL_OK : PRINT_SERVER_AVAILABLE_TTL_FAIL
  if (now - _printServerAvailableAt < ttl) return _printServerAvailable
  try {
    const serverUrl = getPrintServerUrl()
    const res = await fetch(`${serverUrl}/status`, { signal: AbortSignal.timeout(2000) })
    _printServerAvailable = res.ok
  } catch {
    _printServerAvailable = false
  }
  _printServerAvailableAt = Date.now()
  return _printServerAvailable
}

const PRINTERS_KEY = 'restos-station-printers'

export function getStationPrinters(): StationPrinter[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(PRINTERS_KEY)
    return stored ? JSON.parse(stored) : []
  } catch { return [] }
}

export function saveStationPrinters(printers: StationPrinter[]) {
  localStorage.setItem(PRINTERS_KEY, JSON.stringify(printers))
  void mirrorConfigToDesktop()
}

export function getPrinterForStation(station: MenuStation): { name: string; ip?: string } | null {
  const printers = getStationPrinters()
  const found = printers.find(p => p.station === station && p.enabled && (p.printerName || p.printerIP))
  if (!found) return null
  return { name: found.printerName || found.printerIP || '', ip: found.printerIP }
}

// ─── Retry helpers — used by print-queue background runner ─────────────────

export async function retryReceiptJob(data: ReceiptPrintData, printerIP?: string): Promise<boolean> {
  if (!printerIP) return false
  const escpos = buildEscPosReceipt(data)
  const hexData = escpos[0]?.data || ''
  return printViaPrintServer(printerIP, hexData)
}

export async function retryRunnerJob(runner: RunnerData, printerIP?: string): Promise<boolean> {
  if (!printerIP) return false
  const escpos = buildEscPosRunner(runner)
  const hexData = escpos[0]?.data || ''
  return printViaPrintServer(printerIP, hexData)
}

export async function retryCancellationJob(runner: CancellationRunnerData, printerIP?: string): Promise<boolean> {
  if (!printerIP) return false
  const escpos = buildEscPosCancellation(runner)
  const hexData = escpos[0]?.data || ''
  return printViaPrintServer(printerIP, hexData)
}

// ─── CP866-hex → text decoder (inverse of toCP866Hex) ──────────────────────

const CP866_REVERSE: Record<number, string> = {}
for (const [ch, code] of Object.entries(CP866_MAP)) CP866_REVERSE[code] = ch

export function decodeCP866Hex(hex: string): string {
  if (!hex) return ''
  // Strip control bytes (ESC, GS commands) so output is human-readable.
  // Real ESC/POS streams have GS/ESC sequences that aren't text.
  let out = ''
  let i = 0
  while (i < hex.length) {
    const byte = parseInt(hex.slice(i, i + 2), 16)
    if (Number.isNaN(byte)) break
    if (byte === 0x1B || byte === 0x1D) {
      // Skip ESC (1B) / GS (1D) commands; their length varies, hard to parse generically.
      // Heuristic: skip the next 2 bytes as command identifier; safer than parsing each opcode.
      i += 6
      continue
    }
    if (byte === 0x0A) { out += '\n'; i += 2; continue } // LF
    if (byte === 0x0D) { i += 2; continue } // CR — ignore
    if (byte === 0x09) { out += '\t'; i += 2; continue }
    if (byte === 0x00) { i += 2; continue }
    if (byte < 0x80) {
      out += String.fromCharCode(byte)
    } else if (CP866_REVERSE[byte]) {
      out += CP866_REVERSE[byte]
    } else {
      out += '·' // placeholder for unknown bytes
    }
    i += 2
  }
  return out
}

// ─── Print runner to station printer ─────────────────────────────────────────

async function printRunnerRaw(_printerName: string, runner: RunnerData, printerIP?: string): Promise<boolean> {
  if (!printerIP) return false
  const escpos = buildEscPosRunner(runner)
  const hexData = escpos[0]?.data || ''
  return printViaPrintServer(printerIP, hexData)
}

// ─── Auto-print runners for an order ─────────────────────────────────────────

export interface PrintOrderParams {
  order: Order
  menuItems: MenuItem[]
  tables: Table[]
  users: User[]
  zones?: { id: string; name: string }[]
}

export function buildRunnersByStation(params: PrintOrderParams): RunnerData[] {
  const { order, menuItems, tables, users, zones } = params
  const table = order.tableId ? tables.find(t => t.id === order.tableId) : null
  const zone = table?.zone ? zones?.find(z => z.id === table.zone) : null
  const waiter = order.waiterId ? users.find(u => u.id === order.waiterId) : null

  // Group items by station
  const stationItems = new Map<MenuStation, RunnerData['items']>()

  for (const item of order.items) {
    const mi = menuItems.find(m => m.id === item.menuItemId)
    const station = mi?.station || 'hot_kitchen'

    if (!stationItems.has(station)) stationItems.set(station, [])
    stationItems.get(station)!.push({
      name: item.name,
      qty: item.qty,
      modifiers: item.modifiers?.map(m => m.name),
      unit: item.unit,
      unitSize: item.unitSize,
    })
  }

  const runners: RunnerData[] = []
  for (const [station, items] of stationItems) {
    runners.push({
      orderId: order.id,
      orderNumber: order.orderNumber ? String(order.orderNumber) : order.id.slice(-6),
      station,
      tableName: table?.name,
      zoneName: zone?.name,
      guestsCount: order.guestsCount,
      orderType: order.type,
      waiterName: waiter?.name,
      items,
      createdAt: order.createdAt,
      comment: order.comment,
    })
  }

  return runners
}

// ─── Cancellation runner — printed when previously-printed items are cancelled ──

export interface CancellationRunnerData extends RunnerData {
  reason: string
  cancelledAt: string
}

function buildEscPosCancellation(data: CancellationRunnerData): { type: string; format: string; data: string }[] {
  const d = new Date(data.cancelledAt)
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
  const dateStr = `${d.getDate()} ${months[d.getMonth()]} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  const station = STATION_LABELS[data.station]
  const typeLabel = data.orderType === 'hall' ? 'Зал' : data.orderType === 'delivery' ? 'Доставка' : 'Самовывоз'

  const tableLabel = data.tableName
    ? (String(data.tableName).toLowerCase().startsWith('стол') ? String(data.tableName) : `Стол ${data.tableName}`)
    : ''
  const zoneLabel = data.zoneName || (data.orderType === 'hall' ? '' : typeLabel)
  const infoParts = [tableLabel, zoneLabel].filter(Boolean).join(', ')

  let hex = ''
  hex += hexCmd('1B 40')
  hex += hexCmd('1C 2E')
  hex += hexCmd('1B 74 11')

  // Banner — *** ОТМЕНА *** centered, bold, double size
  hex += hexCmd('1B 61 01')
  hex += hexCmd('1B 45 01')
  hex += hexCmd('1D 21 11')        // double width + double height
  hex += toCP866Hex('*** ОТМЕНА ***')
  hex += hexCmd('0A')
  hex += hexCmd('1D 21 00')
  hex += toCP866Hex(`(${station.toUpperCase()})`)
  hex += hexCmd('0A')
  // Тип заказа крупно если не зал — кухня видит контекст отмены.
  if (data.orderType !== 'hall') {
    hex += hexCmd('1D 21 11')
    hex += toCP866Hex(`★ ${typeLabel.toUpperCase()} ★`)
    hex += hexCmd('0A')
    hex += hexCmd('1D 21 00')
  }
  hex += hexCmd('1B 45 00')
  hex += toCP866Hex('================================')
  hex += hexCmd('0A')

  // Order info
  hex += hexCmd('1B 61 00')
  hex += toCP866Hex(`${dateStr} Зак: ${data.orderNumber}`)
  if (data.waiterName) hex += toCP866Hex(` ${data.waiterName}`)
  hex += hexCmd('0A')
  if (infoParts) {
    hex += hexCmd('1B 45 01')
    hex += toCP866Hex(infoParts)
    hex += hexCmd('0A')
    hex += hexCmd('1B 45 00')
  }
  hex += toCP866Hex('--------------------------------')
  hex += hexCmd('0A')

  // Items — bold, double height, prefixed with ✕
  hex += hexCmd('1D 21 01')
  hex += hexCmd('1B 45 01')
  for (const item of data.items) {
    const qty = item.unit === 'g'
      ? `${Math.round(item.qty)}г`
      : item.unit === 'kg'
        ? `${Number(item.qty).toFixed(item.qty < 10 ? 2 : 1).replace(/\.?0+$/, '')}кг`
        : `x${item.qty}`
    const name = `X ${item.name}`
    const pad = Math.max(0, 20 - name.length - qty.length)
    hex += toCP866Hex(name + ' '.repeat(pad) + qty)
    hex += hexCmd('0A')
  }
  hex += hexCmd('1B 45 00')
  hex += hexCmd('1D 21 00')

  // Reason
  hex += toCP866Hex('--------------------------------')
  hex += hexCmd('0A')
  hex += toCP866Hex('Причина:')
  hex += hexCmd('0A')
  hex += hexCmd('1B 45 01')
  hex += toCP866Hex(data.reason)
  hex += hexCmd('0A')
  hex += hexCmd('1B 45 00')

  hex += hexCmd('0A')
  hex += hexCmd('1D 56 42 03')
  return [{ type: 'raw', format: 'hex', data: hex }]
}

async function printCancellationRaw(_printerName: string, runner: CancellationRunnerData, printerIP?: string): Promise<boolean> {
  if (!printerIP) return false
  const escpos = buildEscPosCancellation(runner)
  const hexData = escpos[0]?.data || ''
  return printViaPrintServer(printerIP, hexData)
}

export interface PrintCancellationParams extends PrintOrderParams {
  /** Items to mark as cancelled (must already be filtered to those that were previously printed). */
  cancelledItems: import('./types').OrderItem[]
  reason: string
  cancelledAt?: string
}

export async function printOrderCancellation(params: PrintCancellationParams): Promise<{ printed: string[]; failed: string[]; noPrinter: string[]; enqueued: string[] }> {
  const { order, menuItems, tables, users, zones, cancelledItems, reason, cancelledAt } = params
  const result = { printed: [] as string[], failed: [] as string[], noPrinter: [] as string[], enqueued: [] as string[] }

  if (!cancelledItems.length) return result

  // Build a partial order containing only cancelled items, then group by station
  const partial: Order = { ...order, items: cancelledItems }
  const runners = buildRunnersByStation({ order: partial, menuItems, tables, users, zones })

  // Virtual printer mode: log all cancellations as mock(virtual).
  if (isVirtualPrinterOn()) {
    for (const r of runners) {
      const stationLabel = STATION_LABELS[r.station]
      const summary = `Отмена #${r.orderNumber} · ${stationLabel}`
      const cancellationRunner: CancellationRunnerData = { ...r, reason, cancelledAt: cancelledAt ?? new Date().toISOString() }
      const hex = buildEscPosCancellation(cancellationRunner)[0]?.data
      logPrint({
        action: 'print.cancel', status: 'mock',
        orderId: r.orderId, summary, hex,
        extra: { virtual: true, station: r.station, items_count: r.items.length, reason },
      })
      result.printed.push(stationLabel)
    }
    return result
  }

  const printServerOk = await isPrintServerAvailable()

  for (const r of runners) {
    const printer = getPrinterForStation(r.station)
    const stationLabel = STATION_LABELS[r.station]
    const summary = `Отмена #${r.orderNumber} · ${stationLabel}`
    const extraBase = { station: r.station, items_count: r.items.length, reason }

    if (!printer) {
      result.noPrinter.push(stationLabel)
      // No log: nothing to do, station has no configured printer here. Keep audit_log clean.
      continue
    }
    const cancellationRunner: CancellationRunnerData = {
      ...r,
      reason,
      cancelledAt: cancelledAt ?? new Date().toISOString(),
    }
    if (!printServerOk) {
      const hex = buildEscPosCancellation(cancellationRunner)[0]?.data
      const enqId = await enqueuePrintJob('cancel-runner', cancellationRunner, summary, {
        printerName: printer.name, printerIP: printer.ip, lastError: 'no_transport_available',
      })
      if (enqId !== null) {
        logPrint({ action: 'print.cancel', status: 'mock', printerName: printer.name, printerIP: printer.ip, orderId: r.orderId, summary, hex, extra: { ...extraBase, reason_no_print: 'no_transport_available' } })
      }
      result.enqueued.push(stationLabel)
      continue
    }
    const ok = await printCancellationRaw(printer.name, cancellationRunner, printer.ip)
    if (ok) {
      result.printed.push(stationLabel)
      logPrint({ action: 'print.cancel', status: 'success', printerName: printer.name, printerIP: printer.ip, orderId: r.orderId, summary, extra: extraBase })
    } else {
      const hex = buildEscPosCancellation(cancellationRunner)[0]?.data
      const enqId = await enqueuePrintJob('cancel-runner', cancellationRunner, summary, {
        printerName: printer.name, printerIP: printer.ip, lastError: 'transport_failed',
      })
      if (enqId !== null) {
        logPrint({ action: 'print.cancel', status: 'failed', printerName: printer.name, printerIP: printer.ip, orderId: r.orderId, summary, hex, extra: extraBase })
        result.failed.push(stationLabel)
      } else {
        result.enqueued.push(stationLabel)
      }
    }
  }

  return result
}

export async function printOrderRunners(params: PrintOrderParams): Promise<{ printed: string[]; failed: string[]; noPrinter: string[]; enqueued: string[] }> {
  const runners = buildRunnersByStation(params)
  const result = { printed: [] as string[], failed: [] as string[], noPrinter: [] as string[], enqueued: [] as string[] }

  // Virtual printer mode: log all runners as mock(virtual), no transport.
  if (isVirtualPrinterOn()) {
    for (const runner of runners) {
      const stationLabel = STATION_LABELS[runner.station]
      const summary = `Заказ #${runner.orderNumber} · ${stationLabel}`
      const hex = buildEscPosRunner(runner)[0]?.data
      logPrint({
        action: 'print.runner', status: 'mock',
        orderId: runner.orderId, summary, hex,
        extra: { virtual: true, station: runner.station, items_count: runner.items.length },
      })
      result.printed.push(stationLabel)
    }
    return result
  }

  const printServerOk = await isPrintServerAvailable()

  for (const runner of runners) {
    const printer = getPrinterForStation(runner.station)
    const stationLabel = STATION_LABELS[runner.station]
    const summary = `Заказ #${runner.orderNumber} · ${stationLabel}`
    const extraBase = { station: runner.station, items_count: runner.items.length }

    if (!printer) {
      result.noPrinter.push(stationLabel)
      // No log: station has no printer configured here — not actionable, would only spam audit_log.
      continue
    }

    if (!printServerOk) {
      const hex = buildEscPosRunner(runner)[0]?.data
      const enqId = await enqueuePrintJob('runner', runner, summary, {
        printerName: printer.name, printerIP: printer.ip, lastError: 'no_transport_available',
      })
      // Only log mock if it's a NEW enqueue (avoid spam in audit_log).
      if (enqId !== null) {
        logPrint({ action: 'print.runner', status: 'mock', printerName: printer.name, printerIP: printer.ip, orderId: runner.orderId, summary, hex, extra: { ...extraBase, reason_no_print: 'no_transport_available' } })
      }
      result.enqueued.push(stationLabel)
      continue
    }

    const success = await printRunnerRaw(printer.name, runner, printer.ip)

    if (success) {
      result.printed.push(stationLabel)
      logPrint({ action: 'print.runner', status: 'success', printerName: printer.name, printerIP: printer.ip, orderId: runner.orderId, summary, extra: extraBase })
    } else {
      const hex = buildEscPosRunner(runner)[0]?.data
      const enqId = await enqueuePrintJob('runner', runner, summary, {
        printerName: printer.name, printerIP: printer.ip, lastError: 'transport_failed',
      })
      if (enqId !== null) {
        logPrint({ action: 'print.runner', status: 'failed', printerName: printer.name, printerIP: printer.ip, orderId: runner.orderId, summary, hex, extra: extraBase })
        result.failed.push(stationLabel)
      } else {
        // Already in queue from a previous attempt — treat as enqueued for caller-side dedup.
        result.enqueued.push(stationLabel)
      }
    }
  }

  return result
}
