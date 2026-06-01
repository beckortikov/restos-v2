'use client'

import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft, Trash2, Clock, CheckCircle2, XCircle, AlertCircle,
  ChevronDown, ChevronRight, Printer, FlaskConical, Copy,
} from 'lucide-react'
import { fetchPrintJobs, type PrintJournalEntry } from '@/lib/queries'
import {
  ensureBackendVirtualPrinters,
  disableBackendVirtualPrinters,
  isVirtualPrinterOn,
  setVirtualPrinterOn,
  subscribeVirtualMode,
  getHistoryHiddenBefore,
  clearHistoryView,
} from '@/lib/queries/printers'
import { useDataSync } from '@/hooks/use-data-sync'
import { decodeCP866Hex } from '@/lib/cp866'
import { toast } from 'sonner'

// Path B queue page. Журнал заданий читается из audit_log через
// fetchPrintJobs. Pending-очередь (с retry/cancel) теперь живёт на бэке:
// внутренний worker сам ретраит print_jobs с backoff и при превышении
// MAX_ATTEMPTS переводит job в status=failed (тут отобразится как
// «Ошибка»). Управление виртуальным режимом — через backend
// ensureBackendVirtualPrinters / disableBackendVirtualPrinters.

type FilterStatus = 'all' | 'success' | 'failed' | 'mock'
type FilterKind = 'all' | 'receipt' | 'runner' | 'cancel'

const KIND_LABEL: Record<string, string> = {
  'print.receipt': 'Чек',
  'print.runner': 'Заказ',
  'print.cancel': 'Отмена',
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
  const [history, setHistory] = useState<PrintJournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all')
  const [filterKind, setFilterKind] = useState<FilterKind>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [virtual, setVirtual] = useState(isVirtualPrinterOn())

  const reload = useCallback(async () => {
    const h = await fetchPrintJobs({ limit: 200, sinceMs: 7 * 24 * 60 * 60 * 1000 }).catch(() => [])
    setHistory(h)
    setLoading(false)
  }, [])

  useEffect(() => {
    reload()
    const unsubVirtual = subscribeVirtualMode(() => setVirtual(isVirtualPrinterOn()))
    return () => { unsubVirtual() }
  }, [reload])

  // Live: пере-загружаем журнал каждый раз когда audit_log меняется
  // (печать пишет в audit_log → SSE → invalidateCache → этот хук).
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
    try {
      if (on) {
        await ensureBackendVirtualPrinters()
        toast.info('Тестовый режим включён', {
          description: 'Все чеки (включая авто-runner и close-order) пишутся как файлы в backups/print/. Реальные принтеры не используются.',
        })
      } else {
        await disableBackendVirtualPrinters()
        toast.success('Тестовый режим выключен', { description: 'Печать снова идёт на настроенные принтеры.' })
      }
    } catch (e) {
      console.error('[virtual-toggle] backend sync failed:', e)
      toast.error('Виртуальные принтеры на сервере не обновились', {
        description: 'Возможно, нет связи с сидекаром.',
      })
    }
  }

  function handleClearHistory() {
    clearHistoryView()
    setHistory([...history])
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
          <p className="text-sm text-muted-foreground">Журнал заданий печати за последние 7 дней</p>
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

      {/* Info banner about pending */}
      <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 flex items-start gap-3">
        <Clock className="size-4 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground">
          Pending-задания и retry-логика обрабатываются worker'ом на бэке. После
          5 неудачных попыток job переходит в статус «Ошибка» и появляется ниже.
          Поднимите принтер в сети и нажмите Retry на конкретной строке — или
          используйте /api/v1/print/jobs/&#123;id&#125;/retry.
        </p>
      </div>

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
                          <pre className="font-mono text-[11px] bg-white text-foreground p-3 rounded border border-border overflow-auto whitespace-pre max-h-96">{text}</pre>
                          <button
                            onClick={() => handleCopyText(entry.contentHex)}
                            className="absolute top-2 right-2 px-2 py-1 text-[10px] bg-muted/80 hover:bg-muted rounded text-muted-foreground hover:text-foreground flex items-center gap-1 backdrop-blur-sm"
                          >
                            <Copy className="size-3" />Копировать
                          </button>
                        </div>
                      ) : (
                        <div className="text-[11px] text-muted-foreground italic">
                          Текст недоступен (status=success — payload сохраняется только для не-успешных, чтобы не раздувать журнал)
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
