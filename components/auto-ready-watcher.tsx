'use client'

import { useEffect, useRef } from 'react'
import { useAuth } from '@/lib/auth-store'
import { checkAutoReadyOrders, fetchOrders, fetchTables } from '@/lib/queries'
import { startOfToday } from '@/lib/helpers'
import { api, unwrap } from '@/lib/api'
import { onDataChange, initRealtime } from '@/lib/realtime'
import { toast } from 'sonner'
// Capacitor дропнут — нативный Android в android-kotlin/. React только в Electron.
const Capacitor = { isNativePlatform: () => false }
import type { Table } from '@/lib/types'

// Plays a soft notification sound (data URI — no external file)
function playReadyChime() {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    const playTone = (freq: number, when: number, duration: number, gainVal = 0.25) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = freq
      osc.type = 'sine'
      gain.gain.setValueAtTime(0, ctx.currentTime + when)
      gain.gain.linearRampToValueAtTime(gainVal, ctx.currentTime + when + 0.05)
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + when + duration)
      osc.start(ctx.currentTime + when)
      osc.stop(ctx.currentTime + when + duration)
    }
    // Bright 3-tone chime
    playTone(880, 0, 0.2)
    playTone(1175, 0.15, 0.22)
    playTone(1568, 0.32, 0.3)
  } catch { /* audio not supported */ }
}

async function fireNativeNotification(orderInfo?: string) {
  // On Capacitor (Android/iOS) use the LocalNotifications plugin — it shows
  // in the system tray, lights up the screen, plays the system notification
  // sound, and survives the WebView being briefly paused. The Web Notification
  // API silently no-ops when the app is backgrounded inside Capacitor's
  // WebView, so it's not a substitute on phone shells.
  try {
    const { LocalNotifications } = await import(/* @vite-ignore */ '@capacitor/local-notifications' as any) /* dead branch, Capacitor dropped */
    await LocalNotifications.schedule({
      notifications: [
        {
          id: Math.floor(Math.random() * 2_000_000_000),
          title: 'Заказ готов!',
          body: orderInfo || 'Заберите блюда с кухни',
          schedule: { at: new Date(Date.now() + 100) },
          sound: undefined, // system default — guaranteed present on every device
          smallIcon: 'ic_stat_icon_config_sample',
          autoCancel: true,
        },
      ],
    })
  } catch (e) {
    console.warn('[ready-watcher] LocalNotifications failed, falling back to Web Notification', e)
  }
}

function fireWebNotification(orderInfo?: string) {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (Notification.permission !== 'granted') return
  try {
    new Notification('Заказ готов!', { body: orderInfo || 'Заберите блюда с кухни', icon: '/icon-192.png' })
  } catch { /* not supported in this WebView */ }
}

function notifyReady(orderInfo?: string) {
  playReadyChime()
  toast.success('🍽️ Заказ готов к подаче!', {
    description: orderInfo || 'Заберите блюда с кухни',
    duration: 8000,
  })
  // Vibration on mobile (web API; Capacitor LocalNotifications also vibrates by default)
  try { navigator.vibrate?.([200, 100, 200]) } catch { /* ignore */ }
  // System tray notification — native on Capacitor, Web Notification on browser
  if (Capacitor.isNativePlatform()) {
    void fireNativeNotification(orderInfo)
  } else {
    fireWebNotification(orderInfo)
  }
}

// Background watcher:
// 1. In autoReadyMode: auto-marks cooking orders past their expected_ready_at as ready
// 2. Waiter gets instant notifications when kitchen marks their order as 'ready':
//    - SSE via the v4 Go-backend (/api/v1/events)
//    - Fallback: slow poll every 30s
export function AutoReadyWatcher() {
  const { restaurant, user } = useAuth()
  const lastNotifiedRef = useRef<Set<string>>(new Set())
  const lastStatusRef = useRef<Map<string, string>>(new Map())
  const tablesRef = useRef<Table[]>([])
  const initializedRef = useRef(false)

  // "Стол 5 · #142" / "Доставка #142" / fallback
  const formatOrderInfo = (o: { orderNumber?: number; tableId?: string; type?: string }): string => {
    const ref = o.orderNumber ? `#${o.orderNumber}` : ''
    const t = o.tableId ? tablesRef.current.find(tt => tt.id === o.tableId) : null
    const place = t?.name
      ? t.name
      : o.type === 'delivery' ? 'Доставка'
      : o.type === 'takeaway' ? 'Самовывоз'
      : ''
    return [place, ref].filter(Boolean).join(' · ') || 'Заберите блюда с кухни'
  }

  useEffect(() => {
    if (!user) return
    const isWaiter = user.role === 'waiter'

    let cancelled = false
    let sseUnsub: (() => void) | null = null

    // Snapshot current orders without notifying (avoids spam on login)
    const snapshot = async () => {
      try {
        const [orders, tables] = await Promise.all([fetchOrders({ from: startOfToday() }), fetchTables()])
        if (cancelled) return
        tablesRef.current = tables
        for (const o of orders) {
          if (isWaiter && o.waiterId !== user.id) continue
          lastStatusRef.current.set(o.id, o.status)
        }
        initializedRef.current = true
      } catch { /* ignore */ }
    }

    // Check for status transitions cooking|new|served → ready.
    // Hits the v4 backend directly (bypassing the stale-while-revalidate
    // Dexie cache) so the SSE-triggered call sees fresh status, not the
    // pre-event snapshot.
    const checkReadyTransitions = async () => {
      if (!isWaiter || cancelled) return
      try {
        const env: any = await unwrap(api.GET('/api/v1/orders', { params: { query: { limit: 200, waiter_id: user.id } } }))
        const rows: any[] = Array.isArray(env?.data) ? env.data : Array.isArray(env) ? env : []
        if (cancelled) return
        for (const row of rows) {
          const id = row.id as string
          const status = row.status as string
          if (status === 'done' || status === 'cancelled') continue
          const prev = lastStatusRef.current.get(id)
          if (prev && prev !== 'ready' && status === 'ready' && !lastNotifiedRef.current.has(id)) {
            lastNotifiedRef.current.add(id)
            notifyReady(formatOrderInfo({
              orderNumber: row.order_number as number | undefined,
              tableId: row.table_id as string | undefined,
              type: row.type as string | undefined,
            }))
          }
          lastStatusRef.current.set(id, status)
        }
      } catch { /* ignore */ }
    }

    // Auto-ready mode (server decides)
    const checkAutoReady = async () => {
      if (!restaurant?.autoReadyMode || cancelled) return
      try {
        const readyIds = await checkAutoReadyOrders()
        if (cancelled || readyIds.length === 0) return
        for (const id of readyIds) {
          if (lastNotifiedRef.current.has(id)) continue
          lastNotifiedRef.current.add(id)
          notifyReady()
        }
      } catch { /* ignore */ }
    }

    // Request notification permission. On Android 13+ (POST_NOTIFICATIONS),
    // Capacitor's LocalNotifications.requestPermissions() shows the system
    // dialog. On web the legacy Notification.requestPermission is used.
    if (Capacitor.isNativePlatform()) {
      void (async () => {
        try {
          const { LocalNotifications } = await import(/* @vite-ignore */ '@capacitor/local-notifications' as any) /* dead branch, Capacitor dropped */
          const status = await LocalNotifications.checkPermissions()
          if (status.display !== 'granted') {
            await LocalNotifications.requestPermissions()
          }
        } catch { /* plugin not registered yet */ }
      })()
    } else if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }

    // Initial snapshot then set up realtime
    ;(async () => {
      await snapshot()
      if (cancelled) return

      if (isWaiter) {
        // v4 has no Supabase realtime; SSE via /api/v1/events is the single path.
        initRealtime()
        sseUnsub = onDataChange((table, _action) => {
          if (table === 'orders') {
            checkReadyTransitions()
          } else if (table === 'tables') {
            fetchTables().then(t => { if (!cancelled) tablesRef.current = t }).catch(() => {})
          }
        })
      }
    })()

    // Fallback slow poll (every 30s) for both auto-ready + status transitions
    const interval = setInterval(() => {
      checkAutoReady()
      checkReadyTransitions()
    }, 30000)

    return () => {
      cancelled = true
      clearInterval(interval)
      if (sseUnsub) sseUnsub()
    }
  }, [restaurant?.autoReadyMode, user])

  return null
}
