'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Printer, RefreshCw, ExternalLink, Clock, X } from 'lucide-react'
import { toast } from 'sonner'
import { fetchPrintJobs, type PrintJournalEntry } from '@/lib/queries'
import { decodeCP866Hex } from '@/lib/cp866'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'

// POS-topbar shortcut to surface kitchen prints that the server-side worker
// gave up on (status='failed' after MAX_ATTEMPTS retries) AND mock entries
// from days where no printer was configured. Live count badge so the
// cashier notices without opening /settings/printers/queue.
//
// What "failed" means in this context: the desktop print-worker attempted
// 5 times with the configured backoff (3s/5s/10s/30s) and the printer
// never accepted the payload. Manual intervention required — usually
// printer is offline, IP wrong, or paper out.

const POLL_INTERVAL_MS = 10_000
const SINCE_MS = 24 * 60 * 60 * 1000 // last 24h
const FETCH_LIMIT = 50

function getApiUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:3001'
  const w = window as { restosDesktop?: { apiUrl?: string } }
  if (w.restosDesktop?.apiUrl) return w.restosDesktop.apiUrl
  const lan = localStorage.getItem('restos-local-server-url')
  const mode = localStorage.getItem('restos-active-mode')
  if (lan && mode === 'local') return lan
  return 'http://localhost:3001'
}

function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
}

const KIND_LABEL: Record<string, string> = {
  'print.runner': 'Заказ',
  'print.cancel': 'Отмена',
}

export function FailedPrintsButton() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<PrintJournalEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  // Double-tap state for dismiss: first click puts the row into "armed"
  // mode (button text + colour change), second click within DISMISS_ARM_MS
  // actually dismisses. Tap-anywhere-else / timeout reverts.
  const [armedDismissId, setArmedDismissId] = useState<string | null>(null)
  const armResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const DISMISS_ARM_MS = 3000

  const reload = useCallback(async () => {
    try {
      const jobs = await fetchPrintJobs({ limit: FETCH_LIMIT, sinceMs: SINCE_MS })
      // Show kitchen prints (runner / cancellation) the cashier should look
      // at: anything that didn't successfully print and isn't a virtual-mode
      // log entry. This includes:
      //   - 'failed'  → terminal, gave up after 5 attempts
      //   - 'mock' with no_printer_configured / transport error → either no
      //     printer set up or printer offline, won't auto-resolve
      // 'mock' with virtual=true is intentional (test mode) — hide it so
      // the badge doesn't paint red on a healthy virtual-printer setup.
      const stuck = jobs.filter(j =>
        (j.action === 'print.runner' || j.action === 'print.cancel')
        && j.status !== 'success'
        && !j.virtual
        && !j.dismissed
      )
      setItems(stuck)
    } catch {
      // network hiccup — keep last known list, badge stays as-is
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    reload().finally(() => setLoading(false))
    const iv = setInterval(reload, POLL_INTERVAL_MS)
    return () => clearInterval(iv)
  }, [reload])

  // Re-poll the moment drawer opens so the cashier always sees fresh data
  useEffect(() => {
    if (open) reload()
  }, [open, reload])

  const failedCount = items.length

  async function handleRetry(logId: string) {
    setRetryingId(logId)
    try {
      const res = await fetch(`${getApiUrl()}/print/retry-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      toast.success('Повтор печати запущен')
      // Optimistic: remove from the local list. Worker will UPDATE the row
      // back to 'mock' on the next attempt; if it succeeds, the row stays
      // out; if it fails again, our next poll picks it up.
      setItems(prev => prev.filter(j => j.id !== logId))
      setTimeout(reload, 2000)
    } catch (e) {
      toast.error(`Не удалось: ${e instanceof Error ? e.message : 'ошибка'}`)
    } finally {
      setRetryingId(null)
    }
  }

  function clearArmTimer() {
    if (armResetTimer.current) {
      clearTimeout(armResetTimer.current)
      armResetTimer.current = null
    }
  }

  function handleDismissTap(logId: string) {
    if (armedDismissId === logId) {
      // Second tap → confirm dismiss
      clearArmTimer()
      setArmedDismissId(null)
      void doDismiss(logId)
    } else {
      // First tap → arm. Auto-revert after timeout.
      clearArmTimer()
      setArmedDismissId(logId)
      armResetTimer.current = setTimeout(() => {
        armResetTimer.current = null
        setArmedDismissId(null)
      }, DISMISS_ARM_MS)
    }
  }

  async function doDismiss(logId: string) {
    try {
      const res = await fetch(`${getApiUrl()}/print/dismiss-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      // Optimistic remove. Server-side this also marks order_items printed
      // so the worker won't re-create the entry.
      setItems(prev => prev.filter(j => j.id !== logId))
      setTimeout(reload, 1500)
    } catch (e) {
      toast.error(`Не удалось: ${e instanceof Error ? e.message : 'ошибка'}`)
    }
  }

  // Cleanup on unmount
  useEffect(() => () => clearArmTimer(), [])

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`relative shrink-0 inline-flex items-center justify-center size-11 rounded-xl text-sm font-medium transition-colors ${
          failedCount > 0
            ? 'bg-destructive/10 text-destructive hover:bg-destructive/20'
            : 'bg-muted text-foreground hover:bg-border'
        }`}
        title={failedCount > 0 ? `Не напечатано: ${failedCount}` : 'Печать'}
        aria-label="Состояние печати"
      >
        <Printer className="size-5" />
        {failedCount > 0 && (
          <span
            className="absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center tabular-nums shadow-sm"
            aria-hidden
          >
            {failedCount > 99 ? '99+' : failedCount}
          </span>
        )}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
          <SheetHeader className="px-5 py-4 border-b border-border">
            <SheetTitle className="flex items-center gap-2">
              <Printer className="size-5 text-destructive" />
              Печать кухни — внимание
              {failedCount > 0 && (
                <span className="text-xs font-medium px-2 py-0.5 rounded bg-destructive/10 text-destructive tabular-nums">
                  {failedCount}
                </span>
              )}
            </SheetTitle>
            <SheetDescription className="text-xs">
              Заказы, которые не дошли до принтера. Нажмите «Повторить» или проверьте, что принтер настроен и онлайн.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
            {loading && items.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-8">Загрузка…</div>
            ) : items.length === 0 ? (
              <div className="text-sm text-muted-foreground italic py-12 text-center bg-muted/20 rounded-xl border border-dashed border-border">
                Все печати прошли успешно
              </div>
            ) : (
              items.map(entry => {
                const text = entry.contentHex ? decodeCP866Hex(entry.contentHex) : ''
                return (
                  <div key={entry.id} className="bg-card border border-border rounded-lg overflow-hidden">
                    <div className="px-3 py-2.5 flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-muted text-foreground/70">
                            {KIND_LABEL[entry.action] ?? entry.action}
                          </span>
                          <span className="text-sm font-medium text-foreground truncate">
                            {entry.summary}
                          </span>
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-1 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
                          <Clock className="size-3 inline" />
                          <span>{formatTime(entry.createdAt)}</span>
                          {entry.printerIP && <span>· {entry.printerIP}</span>}
                          {entry.attempts && entry.maxAttempts && (
                            <span className="text-destructive">
                              · {entry.attempts}/{entry.maxAttempts} попыток
                            </span>
                          )}
                          {entry.reason && (
                            <span className="text-destructive">· {entry.reason}</span>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 flex flex-col gap-1">
                        <button
                          onClick={() => handleRetry(entry.id)}
                          disabled={retryingId === entry.id}
                          className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                        >
                          <RefreshCw className={`size-3.5 ${retryingId === entry.id ? 'animate-spin' : ''}`} />
                          Повторить
                        </button>
                        <button
                          onClick={() => handleDismissTap(entry.id)}
                          className={`inline-flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
                            armedDismissId === entry.id
                              ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                              : 'bg-muted text-muted-foreground hover:bg-border hover:text-foreground'
                          }`}
                          title={armedDismissId === entry.id ? 'Нажмите ещё раз для отмены' : 'Скрыть из списка (двойной тап)'}
                        >
                          <X className="size-3.5" />
                          {armedDismissId === entry.id ? 'Точно?' : 'Не актуально'}
                        </button>
                      </div>
                    </div>
                    {text && (
                      <details className="border-t border-border bg-muted/20">
                        <summary className="px-3 py-1.5 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground select-none">
                          Содержимое чека
                        </summary>
                        <pre className="font-mono text-[10px] bg-white text-foreground p-3 mx-2 mb-2 rounded border border-border overflow-x-auto whitespace-pre">{text}</pre>
                      </details>
                    )}
                  </div>
                )
              })
            )}
          </div>

          <div className="border-t border-border px-5 py-3">
            <Link
              to="/settings/printers/queue"
              onClick={() => setOpen(false)}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ExternalLink className="size-3.5" />
              Полная история и настройки печати
            </Link>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
