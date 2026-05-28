'use client'

import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft, RefreshCw, X, Trash2, Eye, Clock, CheckCircle2, XCircle, AlertCircle,
  ChevronDown, ChevronRight, Printer, FlaskConical, Copy,
} from 'lucide-react'
import { fetchPrintJobs, type PrintJournalEntry } from '@/lib/queries'
import { useDataSync } from '@/hooks/use-data-sync'
import { decodeCP866Hex } from '@/lib/print-service'
import {
  listPendingJobs, cancelJob, cancelAllPending, retryNow,
  subscribeQueue, isVirtualPrinterOn, setVirtualPrinterOn, subscribeVirtualMode,
  getHistoryHiddenBefore, clearHistoryView,
  type PrintJob,
} from '@/lib/print-queue'
import { toast } from 'sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'

type FilterStatus = 'all' | 'success' | 'failed' | 'mock'
type FilterKind = 'all' | 'receipt' | 'runner' | 'cancel'

// Тип job'а в БЕЙДЖЕ. «Заказ» (а не «Кухня») чтобы не путать с
// названием станции «Бар»/«Кухня» в самом тексте задания.
const KIND_LABEL: Record<string, string> = {
  'print.receipt': 'Чек',
  'print.runner': 'Заказ',
  'print.cancel': 'Отмена',
  'receipt': 'Чек',
  'runner': 'Заказ',
  'cancel-runner': 'Отмена',
}

function StatusBadge({ status, virtual }: { status: string; virtual?: boolean }) {
  if (virtual) {
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700"><FlaskConical className="size-3" />Виртуальный</span>
  }
  if (status === 'success') {
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700"><CheckCircle2 className="size-3" />Успех</span>
  }
  if (status === 'failed') {
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-destructive/10 text-destructive"><XCircle className="size-3" />Ошибка</span>
  }
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground"><AlertCircle className="size-3" />Не отправлено</span>
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return 'Сегодня'
  return d.toLocaleDateString('ru', { day: '2-digit', month: 'short' })
}

export default function PrintQueuePage() {
  const [pending, setPending] = useState<PrintJob[]>([])
  const [history, setHistory] = useState<PrintJournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all')
  const [filterKind, setFilterKind] = useState<FilterKind>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [virtual, setVirtual] = useState(isVirtualPrinterOn())
  const [confirmCancelAll, setConfirmCancelAll] = useState(false)

  const reload = useCallback(async () => {
    const [p, h] = await Promise.all([
      listPendingJobs(),
      fetchPrintJobs({ limit: 200, sinceMs: 7 * 24 * 60 * 60 * 1000 }).catch(() => []),
    ])
    setPending(p)
    setHistory(h)
    setLoading(false)
  }, [])

  useEffect(() => {
    reload()
    const unsubQueue = subscribeQueue(reload)
    const unsubVirtual = subscribeVirtualMode(() => setVirtual(isVirtualPrinterOn()))
    // Safety-net poll (60s) — основная live-доставка идёт через
    // useDataSync(['audit_log']) ниже, перехватывающий SSE-инвалидацию кэша.
    const interval = setInterval(reload, 2_000)
    return () => { unsubQueue(); unsubVirtual(); clearInterval(interval) }
  }, [reload])

  // Live: пере-загружаем журнал каждый раз когда audit_log меняется
  // (logPrint пишет именно туда → SSE → invalidateCache → этот хук).
  useDataSync(['audit_log'], reload)

  const hiddenBefore = getHistoryHiddenBefore()
  const filteredHistory = history.filter(h => {
    if (hiddenBefore && new Date(h.createdAt).getTime() < hiddenBefore) return false
    if (filterStatus !== 'all' && h.status !== filterStatus) return false
    if (filterKind !== 'all') {
      const map: Record<FilterKind, string> = { all: '', receipt: 'print.receipt', runner: 'print.runner', cancel: 'print.cancel' }
      if (h.action !== map[filterKind]) return false
    }
    return true
  })

  async function handleToggleVirtual(on: boolean) {
    setVirtualPrinterOn(on)
    setVirtual(on)
    if (on) {
      toast.info('Тестовый режим включён', { description: 'Реальная печать отключена. Все попытки попадают в журнал как «виртуальные».' })
    } else {
      toast.success('Тестовый режим выключен', { description: 'Печать снова идёт на реальные принтеры.' })
    }
  }

  async function handleCancelOne(id?: number) {
    if (!id) return
    await cancelJob(id)
    toast.success('Задание отменено')
  }

  async function handleCancelAll() {
    const n = await cancelAllPending()
    setConfirmCancelAll(false)
    toast.success(`Очередь очищена (${n})`)
  }

  async function handleRetryNow(id?: number) {
    if (!id) return
    await retryNow(id)
    toast.info('Повтор запланирован')
  }

  function handleClearHistory() {
    clearHistoryView()
    setHistory([...history]) // trigger re-filter
    toast.success('История скрыта')
  }

  async function handleCopyText(hex?: string) {
    if (!hex) return
    const text = decodeCP866Hex(hex)
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Скопировано в буфер')
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  if (loading) {
    return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
  }

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to="/settings/printers" className="size-9 flex items-center justify-center rounded-lg bg-muted hover:bg-muted/70 transition-colors">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-foreground">Очередь печати</h1>
          <p className="text-sm text-muted-foreground">Журнал заданий и повтор неудачных печатей</p>
        </div>
      </div>

      {/* Virtual mode toggle */}
      <div className={`rounded-xl border p-3 flex items-center justify-between gap-3 ${virtual ? 'border-purple-300 bg-purple-50' : 'border-border bg-card'}`}>
        <div className="flex items-center gap-3 min-w-0">
          <div className={`size-10 rounded-lg flex items-center justify-center shrink-0 ${virtual ? 'bg-purple-500 text-white' : 'bg-muted text-muted-foreground'}`}>
            <FlaskConical className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="font-medium text-sm text-foreground">Тестовый режим (виртуальный принтер)</div>
            <div className="text-xs text-muted-foreground">Реальная печать отключена. Все чеки и kitchen-runners попадают сюда с расшифрованным текстом.</div>
          </div>
        </div>
        <button
          onClick={() => handleToggleVirtual(!virtual)}
          className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${virtual ? 'bg-purple-500' : 'bg-muted'}`}
        >
          <span className={`absolute top-0.5 size-5 bg-white rounded-full shadow transition-transform ${virtual ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </div>

      {/* Pending */}
      {pending.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50/40 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 bg-amber-100/60 border-b border-amber-200">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-900 flex items-center gap-2">
              <Clock className="size-3.5" />В ожидании повтора ({pending.length})
            </h2>
            <button
              onClick={() => setConfirmCancelAll(true)}
              className="text-xs text-destructive font-medium hover:underline"
            >
              Отменить все
            </button>
          </div>
          <div className="divide-y divide-amber-200/50">
            {pending.map(job => (
              <div key={job.id} className="px-4 py-2.5 flex items-center gap-3">
                <Clock className={`size-4 shrink-0 ${job.status === 'dead' ? 'text-destructive' : 'text-amber-600'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">
                    {KIND_LABEL[job.kind] ?? job.kind} · {job.summary}
                  </div>
                  <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
                    <span>{formatTime(job.createdAt)}</span>
                    {job.printerName && <span>· {job.printerName}{job.printerIP ? ` (${job.printerIP})` : ''}</span>}
                    <span>· попыток: {job.attemptCount}</span>
                    {job.lastError && <span className="text-destructive">· {job.lastError}</span>}
                    {job.status === 'dead' && <span className="text-destructive font-medium">· остановлено</span>}
                  </div>
                </div>
                <button
                  onClick={() => handleRetryNow(job.id)}
                  className="size-8 flex items-center justify-center rounded-lg text-primary hover:bg-primary/10 transition-colors"
                  title="Повторить сейчас"
                >
                  <RefreshCw className="size-4" />
                </button>
                <button
                  onClick={() => handleCancelOne(job.id)}
                  className="size-8 flex items-center justify-center rounded-lg text-destructive hover:bg-destructive/10 transition-colors"
                  title="Отменить"
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter label="Все" active={filterStatus === 'all'} onClick={() => setFilterStatus('all')} />
        <Filter label="✓ Успех" active={filterStatus === 'success'} onClick={() => setFilterStatus('success')} />
        <Filter label="✗ Ошибка" active={filterStatus === 'failed'} onClick={() => setFilterStatus('failed')} />
        <Filter label="⊘ Не отправлено" active={filterStatus === 'mock'} onClick={() => setFilterStatus('mock')} />
        <span className="text-muted-foreground/40 mx-1">·</span>
        <Filter label="Все типы" active={filterKind === 'all'} onClick={() => setFilterKind('all')} />
        <Filter label="Чек" active={filterKind === 'receipt'} onClick={() => setFilterKind('receipt')} />
        <Filter label="Кухня" active={filterKind === 'runner'} onClick={() => setFilterKind('runner')} />
        <Filter label="Отмена" active={filterKind === 'cancel'} onClick={() => setFilterKind('cancel')} />
        <button
          onClick={handleClearHistory}
          className="ml-auto text-xs text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1"
        >
          <Trash2 className="size-3.5" />Очистить историю
        </button>
      </div>

      {/* History */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          История ({filteredHistory.length})
        </h2>
        {filteredHistory.length === 0 ? (
          <div className="text-sm text-muted-foreground italic py-8 text-center bg-muted/20 rounded-xl border border-dashed border-border">
            Нет записей за выбранные фильтры
          </div>
        ) : (
          <div className="space-y-1">
            {filteredHistory.map(entry => {
              const isExpanded = expandedId === entry.id
              const text = entry.contentHex ? decodeCP866Hex(entry.contentHex) : ''
              return (
                <div key={entry.id} className="bg-card border border-border rounded-lg overflow-hidden">
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-muted/30 transition-colors text-left"
                  >
                    {isExpanded ? <ChevronDown className="size-4 text-muted-foreground shrink-0" /> : <ChevronRight className="size-4 text-muted-foreground shrink-0" />}
                    <StatusBadge status={entry.status} virtual={entry.virtual} />
                    <span className="text-xs font-medium px-2 py-0.5 rounded bg-muted text-foreground/70">
                      {KIND_LABEL[entry.action] ?? entry.action}
                    </span>
                    <span className="text-sm text-foreground truncate flex-1">
                      {entry.summary}
                    </span>
                    <span className="text-[11px] text-muted-foreground shrink-0">
                      {formatDate(entry.createdAt)} {formatTime(entry.createdAt)}
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="border-t border-border bg-muted/20 px-3 py-3 space-y-2">
                      <div className="text-[11px] text-muted-foreground flex items-center gap-x-3 gap-y-1 flex-wrap">
                        {entry.printerName && <span><Printer className="size-3 inline mr-1" />{entry.printerName}</span>}
                        {entry.printerIP && <span>· {entry.printerIP}</span>}
                        {entry.station && <span>· станция: {entry.station}</span>}
                        {entry.reason && <span className="text-destructive">· причина: {entry.reason}</span>}
                        {entry.userName && <span>· {entry.userName}</span>}
                      </div>
                      {text ? (
                        <div className="relative">
                          <pre className="font-mono text-[11px] bg-white text-foreground p-3 rounded border border-border overflow-x-auto whitespace-pre">{text}</pre>
                          <button
                            onClick={() => handleCopyText(entry.contentHex)}
                            className="absolute top-2 right-2 px-2 py-1 text-[10px] bg-muted/80 hover:bg-muted rounded text-muted-foreground hover:text-foreground flex items-center gap-1 backdrop-blur-sm"
                          >
                            <Copy className="size-3" />Копировать
                          </button>
                        </div>
                      ) : (
                        <div className="text-[11px] text-muted-foreground italic">
                          Текст недоступен (status=success — сохраняется только для не-успешных, чтобы не раздувать журнал)
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <AlertDialog open={confirmCancelAll} onOpenChange={setConfirmCancelAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отменить всю очередь?</AlertDialogTitle>
            <AlertDialogDescription>
              Все {pending.length} pending-заданий будут удалены. Эти чеки не будут напечатаны.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Назад</AlertDialogCancel>
            <AlertDialogAction onClick={handleCancelAll} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Отменить все
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function Filter({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'}`}
    >
      {label}
    </button>
  )
}
