// Real-time updates via Server-Sent Events (SSE) from v4 Go-backend.
//
// Connects to ${baseURL}/api/v1/events. Auth: EventSource doesn't support
// custom headers, so we pass the Bearer token as a query-string fallback
// (server's auth middleware accepts ?token=<jwt>).
//
// Event format from v4 hub (см. server/internal/transport/sse/hub.go):
//   event: <Type>
//   data: <JSON>
// Where Type is one of: hello, change, ping (implicit `: ping`).
// For "change" events the data JSON has shape {table, action} similar to v1.

import { getBaseURL, getV4Token } from '@/lib/api'

type ChangeHandler = (table: string, action: string) => void
const listeners = new Set<ChangeHandler>()
let eventSource: EventSource | null = null
let visibilityListenerAttached = false
let lastEventAt = 0
let watchdogTimer: ReturnType<typeof setInterval> | null = null
let bailedUnauthorized = false

// Сервер шлёт ping каждые ~2с. Если за 5с не пришло НИЧЕГО (ни ping,
// ни change-event) — соединение зомби. Принудительно переподключаемся.
const STALE_THRESHOLD_MS = 5_000
const WATCHDOG_INTERVAL_MS = 2_000

export function onDataChange(handler: ChangeHandler) {
  listeners.add(handler)
  return () => { listeners.delete(handler) }
}

/** Принудительно закрыть и переподключить SSE. */
export function reconnectRealtime() {
  if (typeof window === 'undefined') return
  if (eventSource) {
    try { eventSource.close() } catch {}
    eventSource = null
  }
  bailedUnauthorized = false
  initRealtime()
}

function dispatchChange(raw: string) {
  try {
    const data = JSON.parse(raw)
    const table = (data.table as string) ?? ''
    const action = (data.action as string) ?? 'change'
    if (!table) return
    for (const handler of listeners) {
      try { handler(table, action) } catch {}
    }
  } catch {}
}

// Backend (server/internal/service/events.go) шлёт типизированные SSE-события
// `event: order.created`, `event: shift.opened` и т.п. EventSource'у нужны
// addEventListener'ы по каждому типу. Здесь мапим backend-имена на «таблицы»,
// которые слушает useDataSync, и фанаутим listeners.
//
// Дополнительный fanout `orders → tables` сделан осознанно: open/close заказа
// меняет `tables.status`, но backend openTableForOrder сейчас не публикует
// table.updated. Этим fanout'ом мы заставляем все экраны, watch'ящие 'tables'
// (включая POS table picker через useOrderData), refetch'ить столы.
const EVENT_FANOUT: Record<string, string[]> = {
  'order.created':     ['orders', 'tables'],
  'order.updated':     ['orders', 'tables'],
  'order.closed':      ['orders', 'tables'],
  'order.cancelled':   ['orders', 'tables'],
  'order.item.added':  ['order_items', 'orders'],
  'order.item.voided': ['order_voids', 'order_items', 'orders'],
  'shift.opened':      ['cash_shifts'],
  'shift.closed':      ['cash_shifts'],
  'stock.movement':    ['ingredients', 'stock_movements'],
  'license.updated':   ['license'],
}

function fanout(eventType: string) {
  const tables = EVENT_FANOUT[eventType]
  if (!tables) return
  const action = eventType.split('.').slice(1).join('.') || 'change'
  for (const t of tables) {
    for (const handler of listeners) {
      try { handler(t, action) } catch {}
    }
  }
}

export function initRealtime() {
  if (typeof window === 'undefined') return
  if (bailedUnauthorized) return
  if (eventSource && eventSource.readyState !== 2 /* CLOSED */) return

  const baseURL = getBaseURL()
  if (!baseURL) return

  const token = getV4Token()
  if (!token) {
    // No token — silently bail. UI will trigger reconnect after login.
    bailedUnauthorized = true
    return
  }

  const url = `${baseURL}/api/v1/events?token=${encodeURIComponent(token)}`
  eventSource = new EventSource(url)
  lastEventAt = Date.now()

  eventSource.onopen = () => { lastEventAt = Date.now() }

  // Generic `message` events (untyped). v4 currently uses named `event: change`
  // so we attach a typed listener too.
  eventSource.onmessage = (event) => {
    lastEventAt = Date.now()
    if (event.data) dispatchChange(event.data)
  }

  eventSource.addEventListener('change', (event: MessageEvent) => {
    lastEventAt = Date.now()
    if (event.data) dispatchChange(event.data)
  })

  eventSource.addEventListener('hello', () => { lastEventAt = Date.now() })
  eventSource.addEventListener('ping', () => { lastEventAt = Date.now() })

  // Типизированные backend-события — фанаутим в listeners через `EVENT_FANOUT`.
  // Без этого ни одно бизнес-событие не превращается в `restos-data-updated`
  // DOM-event, и useDataSync(...) молча не срабатывает.
  for (const eventType of Object.keys(EVENT_FANOUT)) {
    eventSource.addEventListener(eventType, () => {
      lastEventAt = Date.now()
      fanout(eventType)
    })
  }

  eventSource.onerror = () => {
    // EventSource doesn't expose status codes. If readyState becomes CLOSED
    // permanently right after open, most likely auth was rejected — back off.
    const wasClosed = eventSource?.readyState === 2
    try { eventSource?.close() } catch {}
    eventSource = null
    if (wasClosed && Date.now() - lastEventAt < 1000) {
      // Connection died immediately — likely 401. Don't loop forever.
      bailedUnauthorized = true
      return
    }
    setTimeout(initRealtime, 1000)
  }

  // Watchdog: если поток «замёрз» (нет ping >5с) — переподключаемся.
  if (!watchdogTimer) {
    watchdogTimer = setInterval(() => {
      if (!eventSource) return
      const stale = Date.now() - lastEventAt > STALE_THRESHOLD_MS
      if (stale) {
        if (typeof console !== 'undefined') {
          console.info('[sse] stale (no events), reconnecting via watchdog')
        }
        reconnectRealtime()
      }
    }, WATCHDOG_INTERVAL_MS)
  }

  // Capacitor/мобильные WebView'ы «замораживают» EventSource в фоне —
  // при возврате в фронт принудительно переподключаемся.
  if (!visibilityListenerAttached) {
    visibilityListenerAttached = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (!eventSource || eventSource.readyState === 2) {
          reconnectRealtime()
        }
      }
    })
    window.addEventListener('focus', () => {
      if (!eventSource || eventSource.readyState === 2) {
        reconnectRealtime()
      }
    })
  }
}
