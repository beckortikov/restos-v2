'use client'

// Native-shell first-run gate.
// On Capacitor (Android/iOS) this component renders a "Scan QR" screen until
// the waiter scans the manager's `/connect` QR. Once a server URL is saved,
// we pre-fetch all reference data (menu, tables, zones, users, modifiers) to
// validate connectivity and warm any in-memory caches, then redirect to /login.
//
// On web/desktop builds (window.Capacitor not present), this is a no-op
// pass-through.

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
// Capacitor дропнут — нативный Android в android-kotlin/. React только в Electron.
const Capacitor = { isNativePlatform: () => false }
import * as q from '@/lib/queries'
import { Camera, Loader2, AlertTriangle, X, Keyboard } from 'lucide-react'
import QrScanner from 'qr-scanner'

const PREF_KEY = 'restos.serverUrl'
const LAN_RE = /^https?:\/\/(?:192\.168|10\.|172\.(?:1[6-9]|2\d|3[01])|localhost|127\.)\b[\w.\-]*(?::\d+)?(?:\/.*)?$/i

// Mirror the saved server URL into localStorage so lib/supabase.ts's
// getActiveClient() picks the local mode up. Capacitor.Preferences is the
// native SharedPreferences store — it's invisible to lib code which only
// reads localStorage. Without these flags every REST query falls through to
// the cloud Supabase client, even though the waiter scanned the LAN QR.
function persistLocalServer(url: string) {
  try {
    localStorage.setItem('restos-active-mode', 'local')
    localStorage.setItem('restos-local-server-url', url)
  } catch { /* private mode etc. — ignore */ }
}

// Pre-fetch reference data via supabase-queries — validates LAN reachability
// for each endpoint and lets any in-memory query cache warm up before the
// waiter lands on /login.
const BOOTSTRAP_TASKS: Array<{ table: string; fn: () => Promise<unknown[]> }> = [
  { table: 'menu_items', fn: q.fetchMenuItems },
  { table: 'tables', fn: q.fetchTables },
  { table: 'zones', fn: q.fetchZones },
  { table: 'users', fn: q.fetchUsers },
  { table: 'menu_categories', fn: q.fetchMenuCategoriesFull },
  { table: 'modifier_groups', fn: q.fetchAllModifierGroups },
  { table: 'ingredients', fn: q.fetchIngredients },
]

type Phase = 'checking' | 'idle' | 'scanning' | 'manual' | 'bootstrapping' | 'ready' | 'error'

export function NativeConnectScreen({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [progress, setProgress] = useState({ done: 0, total: BOOTSTRAP_TASKS.length })
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [savedUrl, setSavedUrl] = useState<string | null>(null)
  const [manualUrl, setManualUrl] = useState<string>('http://')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const navigate = useNavigate()
  // Capacitor.isNativePlatform() resolves synchronously through the ESM
  // import — no race with the asynchronous window.Capacitor injection.
  const isNative = Capacitor.isNativePlatform()

  useEffect(() => {
    if (!isNative) { setPhase('ready'); return }
    let cancelled = false
    ;(async () => {
      // Push WebView content BELOW the system status bar (instead of under it)
      // and match its background to our app surface so the seam disappears.
      try {
        const { StatusBar, Style } = await import(/* @vite-ignore */ '@capacitor/status-bar' as any) /* dead branch */
        await StatusBar.setOverlaysWebView({ overlay: false })
        await StatusBar.setStyle({ style: Style.Light })
        await StatusBar.setBackgroundColor({ color: '#ffffff' })
      } catch { /* plugin not registered or not on supported platform */ }
      try {
        const { Preferences } = await import(/* @vite-ignore */ '@capacitor/preferences' as any) /* dead branch */
        const { value } = await Preferences.get({ key: PREF_KEY })
        if (cancelled) return
        if (value && LAN_RE.test(value)) {
          setSavedUrl(value)
          // Make lib/supabase.ts route through the LAN server instead of
          // falling back to cloud Supabase.
          persistLocalServer(stripTrailingSlash(value))
          // Refresh cache on every launch so menu changes since last open
          // are visible immediately, then hand control to /login.
          setPhase('bootstrapping')
          await bootstrap(value, (n, total) => setProgress({ done: n, total }))
          if (cancelled) return
          // Stay inside the bundled WebView (http://localhost) and soft-navigate
          // to /login. Cross-origin navigation to the LAN host gets intercepted
          // as an external Intent and pops the system browser, which is exactly
          // what we don't want. REST calls already route to the LAN server via
          // localStorage flags above — only the SPA stays local.
          navigate('/login', { replace: true })
          setPhase('ready')
        } else {
          setPhase('idle')
        }
      } catch (e) {
        console.warn('[native-connect] init failed:', e)
        setPhase('idle')
      }
    })()
    return () => { cancelled = true }
  }, [isNative])

  // Принять URL (из QR или ручного ввода) и завершить подключение.
  async function acceptUrl(rawUrl: string) {
    const url = rawUrl.trim()
    if (!url || !LAN_RE.test(url)) {
      setErrorMsg('Это не похоже на адрес RestOS. Пример: http://192.168.0.107:3001')
      setPhase('error')
      return
    }
    const cleanUrl = stripTrailingSlash(url).replace(/\/login\/?$/, '').replace(/\/connect.*$/, '')
    try {
      const { Preferences } = await import(/* @vite-ignore */ '@capacitor/preferences' as any) /* dead branch */
      await Preferences.set({ key: PREF_KEY, value: cleanUrl })
    } catch { /* web context — не критично */ }
    persistLocalServer(cleanUrl)
    setSavedUrl(cleanUrl)
    setPhase('bootstrapping')
    try {
      await bootstrap(cleanUrl, (n, total) => setProgress({ done: n, total }))
      navigate('/login', { replace: true })
      setPhase('ready')
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Не удалось загрузить данные с сервера')
      setPhase('error')
    }
  }

  // Камера + JS-декодер QR. Не зависит от Google Play Services, поэтому
  // работает на Android без GMS, на iOS Safari, в любом WebView с
  // navigator.mediaDevices.
  async function scan() {
    setErrorMsg('')
    setPhase('scanning')
    // Дождаться рендера <video>
    await new Promise(r => setTimeout(r, 50))
    const video = videoRef.current
    if (!video) {
      setErrorMsg('Камера не инициализировалась')
      setPhase('error')
      return
    }
    try {
      const hasCam = await QrScanner.hasCamera()
      if (!hasCam) {
        setErrorMsg('Камера не найдена. Введите адрес сервера вручную.')
        setPhase('error')
        return
      }
      const scanner = new QrScanner(
        video,
        result => {
          const text = result?.data?.trim()
          if (!text) return
          scanner.stop()
          scanner.destroy()
          scannerRef.current = null
          acceptUrl(text)
        },
        { highlightScanRegion: true, highlightCodeOutline: true, preferredCamera: 'environment' }
      )
      scannerRef.current = scanner
      await scanner.start()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErrorMsg(msg.includes('Permission') || msg.includes('NotAllowed')
        ? 'Доступ к камере не разрешён. Разрешите в настройках устройства или введите адрес вручную.'
        : `Не удалось открыть камеру: ${msg}`)
      setPhase('error')
    }
  }

  // Остановить и освободить камеру при выходе из фазы scanning.
  useEffect(() => {
    if (phase !== 'scanning' && scannerRef.current) {
      scannerRef.current.stop()
      scannerRef.current.destroy()
      scannerRef.current = null
    }
    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop()
        scannerRef.current.destroy()
        scannerRef.current = null
      }
    }
  }, [phase])

  async function reset() {
    try {
      const { Preferences } = await import(/* @vite-ignore */ '@capacitor/preferences' as any) /* dead branch */
      await Preferences.remove({ key: PREF_KEY })
    } catch {}
    try {
      localStorage.removeItem('restos-active-mode')
      localStorage.removeItem('restos-local-server-url')
    } catch {}
    setSavedUrl(null)
    setPhase('idle')
  }

  if (!isNative || phase === 'ready') return <>{children}</>

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-8 bg-background text-center">
      <img src="/icon-192.png" alt="RestOS" className="size-24 rounded-2xl shadow-md" />
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">RestOS — Официант</h1>
        <p className="text-sm text-muted-foreground">Подключение к серверу ресторана</p>
      </div>

      {phase === 'checking' && (
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      )}

      {phase === 'idle' && (
        <>
          <p className="max-w-xs text-sm text-muted-foreground">
            Отсканируйте QR-код с экрана компьютера ресторана.
          </p>
          <button
            onClick={scan}
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-primary text-primary-foreground px-8 py-4 text-base font-semibold shadow active:scale-[0.98] transition-transform"
          >
            <Camera className="size-5" />
            Сканировать QR
          </button>
          <button
            onClick={() => { setErrorMsg(''); setPhase('manual') }}
            className="inline-flex items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <Keyboard className="size-4" />
            Ввести адрес вручную
          </button>
        </>
      )}

      {phase === 'manual' && (
        <form
          onSubmit={(e) => { e.preventDefault(); acceptUrl(manualUrl) }}
          className="w-full max-w-xs space-y-3"
        >
          <p className="text-sm text-muted-foreground">
            Введите адрес сервера ресторана (см. экран /connect на компьютере).
          </p>
          <input
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            placeholder="http://192.168.0.107:3001"
            className="w-full px-4 py-3 bg-background border-2 border-border rounded-xl text-base font-mono focus:outline-none focus:border-primary"
          />
          <button
            type="submit"
            className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-primary text-primary-foreground py-4 text-base font-semibold shadow active:scale-[0.98]"
          >
            Подключиться
          </button>
          <button
            type="button"
            onClick={() => setPhase('idle')}
            className="w-full text-sm text-muted-foreground"
          >
            Назад
          </button>
        </form>
      )}

      {phase === 'scanning' && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
          <video
            ref={videoRef}
            playsInline
            muted
            className="flex-1 w-full h-full object-cover"
          />
          <div className="absolute top-0 left-0 right-0 px-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-3 flex items-center justify-between">
            <p className="text-white text-sm font-medium drop-shadow">Наведите камеру на QR-код</p>
            <button
              onClick={() => { setPhase('idle'); setErrorMsg('') }}
              aria-label="Закрыть"
              className="size-10 rounded-full bg-white/20 backdrop-blur flex items-center justify-center text-white"
            >
              <X className="size-5" />
            </button>
          </div>
          <div className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+24px)] left-0 right-0 flex justify-center">
            <button
              onClick={() => { setPhase('manual'); setErrorMsg('') }}
              className="inline-flex items-center gap-2 rounded-full bg-white/90 px-5 py-3 text-sm font-medium text-foreground"
            >
              <Keyboard className="size-4" />
              Ввести вручную
            </button>
          </div>
        </div>
      )}

      {phase === 'bootstrapping' && (
        <div className="w-full max-w-xs space-y-3">
          <Loader2 className="size-6 animate-spin text-primary mx-auto" />
          <p className="text-sm text-muted-foreground">
            Подгружаем меню и столы… {progress.done} / {progress.total}
          </p>
          <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-[width] duration-200"
              style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
            />
          </div>
          {savedUrl && <p className="text-xs text-muted-foreground font-mono break-all">{savedUrl}</p>}
        </div>
      )}

      {phase === 'error' && (
        <>
          <AlertTriangle className="size-12 text-amber-500" />
          <p className="max-w-xs text-sm text-foreground">{errorMsg || 'Не удалось подключиться'}</p>
          <div className="flex flex-col gap-2 w-full max-w-xs">
            <button
              onClick={() => { setPhase('idle'); setErrorMsg('') }}
              className="rounded-xl bg-primary text-primary-foreground py-3 text-sm font-semibold"
            >
              Попробовать снова
            </button>
            <button
              onClick={() => { setPhase('manual'); setErrorMsg('') }}
              className="rounded-xl border-2 border-border py-3 text-sm font-medium inline-flex items-center justify-center gap-2"
            >
              <Keyboard className="size-4" />
              Ввести адрес вручную
            </button>
          </div>
        </>
      )}

      {savedUrl && phase !== 'bootstrapping' && (
        <button
          onClick={reset}
          className="mt-6 text-xs text-muted-foreground underline"
        >
          Сбросить подключение
        </button>
      )}
    </div>
  )
}

// ─── helpers ───────────────────────────────────────────────────────────────

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}

async function bootstrap(_serverUrl: string, onProgress: (done: number, total: number) => void) {
  const total = BOOTSTRAP_TASKS.length
  let done = 0

  const tasks = BOOTSTRAP_TASKS.map(async ({ table, fn }) => {
    try {
      await fn()
    } catch (e) {
      console.warn(`[bootstrap] ${table} failed:`, e)
      // Best-effort — a single failed fetch should not block first-run.
    } finally {
      done++
      onProgress(done, total)
    }
  })
  await Promise.allSettled(tasks)

  // Pull printer config from the desktop into the phone's localStorage so
  // the waiter's pre-check works without lazy fallback. Best-effort.
  await bootstrapPrinterConfig(_serverUrl)
}

async function bootstrapPrinterConfig(serverUrl: string): Promise<void> {
  try {
    const res = await fetch(`${serverUrl}/printer-config`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return
    const cfg = await res.json() as { stations?: unknown; receipt?: unknown; virtual?: unknown }
    const stations = Array.isArray(cfg.stations) ? cfg.stations : []
    const receipt = cfg.receipt && typeof cfg.receipt === 'object' ? cfg.receipt : null
    const virtual = !!cfg.virtual
    if (stations.length > 0 || receipt) {
      localStorage.setItem('restos-station-printers', JSON.stringify(stations))
      if (receipt) localStorage.setItem('restos-receipt-printer', JSON.stringify(receipt))
      else localStorage.removeItem('restos-receipt-printer')
    }
    // Sync virtual-printer mode from desktop. Otherwise the phone always
    // tries real printing even when the cashier flipped the test toggle.
    if (virtual) localStorage.setItem('restos.virtualPrinter', 'on')
    else localStorage.removeItem('restos.virtualPrinter')
    console.log('[bootstrap] printer-config synced:', { stations: stations.length, hasReceipt: !!receipt, virtual })
  } catch (e) {
    console.warn('[bootstrap] printer-config failed:', e)
    // Best-effort — don't fail the whole bootstrap.
  }
}
