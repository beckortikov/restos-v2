'use client'

import { useEffect, useRef, useCallback } from 'react'
import { fetchOrders, fetchMenuItems, fetchTables, fetchZones, fetchUsers, claimItemPrint, releaseItemPrint, claimItemCancelPrint, releaseItemCancelPrint } from '@/lib/queries'
import { startOfToday } from '@/lib/helpers'
import { getStationPrinters, getPrinterForStation, isPrintServerAvailable } from '@/lib/print-service'
import { isVirtualPrinterOn } from '@/lib/print-queue'
import { STATION_LABELS, type Order, type MenuItem, type MenuStation, type Table, type User, type OrderItem } from '@/lib/types'
import { onDataChange } from '@/lib/realtime'

// Safety-net poll: if SSE drops between order create and reconnect we still
// want to catch up eventually. SSE-driven trigger handles the hot path; this
// is a slow rescue interval, not the primary path.
const POLL_INTERVAL = 30_000
const SSE_DEBOUNCE_MS = 20

// Backward-compat shims — old callers (pos/page.tsx, table-map/page.tsx) used
// to mark orders/items locally. Dedup is now via DB (printed_at column on
// order_items), so these are no-ops.
export function markOrderPrinted(_orderId: string) {}
export function markItemsPrinted(_itemIds: string[]) {}
export function markCancellationsPrinted(_itemIds: string[]) {}

export function AutoPrintRunner() {
  const menuItemsRef = useRef<MenuItem[]>([])
  const tablesRef = useRef<Table[]>([])
  const zonesRef = useRef<{ id: string; name: string }[]>([])
  const usersRef = useRef<User[]>([])
  const dataLoaded = useRef(false)
  const polling = useRef(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadData = useCallback(async () => {
    if (dataLoaded.current) return
    try {
      const [mi, t, z, u] = await Promise.all([fetchMenuItems(), fetchTables(), fetchZones(), fetchUsers()])
      menuItemsRef.current = mi
      tablesRef.current = t
      zonesRef.current = z
      usersRef.current = u
      dataLoaded.current = true
    } catch { /* retry next poll */ }
  }, [])

  useEffect(() => {
    // Don't gate AutoPrintRunner mount on configured printers — virtual mode
    // needs to capture every order even on devices without real printers.
    // Per-station filtering happens INSIDE poll() based on virtual flag.

    // Auto-mirror printer config from desktop's localStorage to the
    // /printer-config file once at boot, so phone clients (Capacitor APK)
    // can pull it. No-op on non-desktop devices.
    void (async () => {
      const isDesktop = !!(window as { restosDesktop?: { isDesktop?: boolean } }).restosDesktop?.isDesktop
      if (!isDesktop) return
      const { syncPrinterConfigToDesktop } = await import('@/lib/print-service')
      try { await syncPrinterConfigToDesktop() } catch { /* ignore */ }
    })()

    const poll = async () => {
      if (polling.current) return
      polling.current = true

      try {
        const virtual = isVirtualPrinterOn()
        // In virtual mode we don't talk to the real print-server at all,
        // so skip availability check (it's localhost:3001 and may be down).
        if (!virtual) {
          const serverOk = await isPrintServerAvailable()
          if (!serverOk) return
          // Real-print mode requires at least one configured printer.
          const printers = getStationPrinters()
          const hasConfigured = printers.some(p => p.enabled && (p.printerName || p.printerIP))
          if (!hasConfigured) return
        }

        await loadData()
        const orders = await fetchOrders({ from: startOfToday() })
        const activeStatuses: Order['status'][] = ['new', 'cooking', 'ready', 'served']

        const { printOrderRunners, printOrderCancellation } = await import('@/lib/print-service')

        const stationByMenuItemId = new Map<string, MenuStation>()
        for (const m of menuItemsRef.current) stationByMenuItemId.set(m.id, m.station)
        const stationOfItem = (it: OrderItem): MenuStation | null =>
          stationByMenuItemId.get(it.menuItemId) || null
        // In virtual mode every station is "configured" (no real printer needed).
        const isStationUnconfigured = (s: MenuStation) => !virtual && getPrinterForStation(s) == null

        for (const order of orders) {
          const considerForNew = activeStatuses.includes(order.status)

          // 1. Cancellation prints — items printed before, now cancelled, not yet cancel-printed.
          //    Atomically claim cancel_printed_at so only one device prints the cancellation.
          const candidatesCancel = order.items.filter((i: OrderItem) =>
            !!i.id && i.cancelledAt && i.printedAt && !i.cancelPrintedAt
          )
          if (candidatesCancel.length > 0) {
            const claimed: OrderItem[] = []
            for (const it of candidatesCancel) {
              // Skip items whose station has no printer here (other device handles).
              const st = stationOfItem(it)
              if (st && isStationUnconfigured(st)) continue
              if (await claimItemCancelPrint(it.id!)) claimed.push(it)
            }
            if (claimed.length > 0) {
              const byReason = new Map<string, OrderItem[]>()
              for (const it of claimed) {
                const key = it.cancelReason || 'Без причины'
                if (!byReason.has(key)) byReason.set(key, [])
                byReason.get(key)!.push(it)
              }
              for (const [reason, items] of byReason) {
                try {
                  const result = await printOrderCancellation({
                    order,
                    cancelledItems: items,
                    reason,
                    cancelledAt: items[0].cancelledAt,
                    menuItems: menuItemsRef.current,
                    tables: tablesRef.current,
                    users: usersRef.current,
                    zones: zonesRef.current,
                  })
                  // Release claims for stations that didn't actually print or queue.
                  const handledLabels = new Set([...(result.printed ?? []), ...(result.enqueued ?? [])])
                  for (const it of items) {
                    const st = stationOfItem(it)
                    if (!st) continue
                    if (!handledLabels.has(STATION_LABELS[st]) && !isStationUnconfigured(st)) {
                      await releaseItemCancelPrint(it.id!).catch(() => {})
                    }
                  }
                } catch {
                  for (const it of items) await releaseItemCancelPrint(it.id!).catch(() => {})
                }
              }
            }
          }

          if (!considerForNew) continue

          // 2. New runner prints — items not yet printed.
          const candidatesNew = order.items.filter((i: OrderItem) =>
            !!i.id && !i.cancelledAt && !i.printedAt
          )
          if (candidatesNew.length === 0) continue

          // Try to claim each item; only print the ones we won.
          const claimedItems: OrderItem[] = []
          for (const it of candidatesNew) {
            const st = stationOfItem(it)
            if (st && isStationUnconfigured(st)) continue
            if (await claimItemPrint(it.id!)) claimedItems.push(it)
          }
          if (claimedItems.length === 0) continue

          const partialOrder: Order = { ...order, items: claimedItems }
          try {
            const result = await printOrderRunners({
              order: partialOrder,
              menuItems: menuItemsRef.current,
              tables: tablesRef.current,
              users: usersRef.current,
              zones: zonesRef.current,
            })
            // For stations that neither printed nor were enqueued — release so retry can happen.
            const handledLabels = new Set([...(result.printed ?? []), ...(result.enqueued ?? [])])
            for (const it of claimedItems) {
              const st = stationOfItem(it)
              if (!st) continue
              if (!handledLabels.has(STATION_LABELS[st]) && !isStationUnconfigured(st)) {
                await releaseItemPrint(it.id!).catch(() => {})
              }
            }
          } catch {
            for (const it of claimedItems) await releaseItemPrint(it.id!).catch(() => {})
          }
        }
      } catch { /* fetch error — next tick */ } finally {
        polling.current = false
      }
    }

    const schedulePoll = () => {
      if (debounceRef.current) return
      debounceRef.current = setTimeout(() => { debounceRef.current = null; void poll() }, SSE_DEBOUNCE_MS)
    }

    // Hot path: SSE-driven instant trigger.
    const unsubscribe = onDataChange((table) => {
      if (table === 'orders' || table === 'order_items') schedulePoll()
    })

    // First poll on mount (some events may have happened before subscribe).
    const initialTimer = setTimeout(poll, 1000)

    // Safety-net interval — only catches edge cases (SSE drops, subscribe race).
    const interval = setInterval(poll, POLL_INTERVAL)

    return () => {
      unsubscribe()
      clearTimeout(initialTimer)
      clearInterval(interval)
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [loadData])

  return null
}
