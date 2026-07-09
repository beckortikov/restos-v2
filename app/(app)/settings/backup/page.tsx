'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '@/lib/auth-store'
import { getBaseURL } from '@/lib/api'
import { randomId } from '@/lib/random-id'
import {
  DatabaseBackup, Download, Trash2, Upload, RotateCcw, Loader2,
  CheckCircle2, AlertTriangle, HardDrive, Clock,
} from 'lucide-react'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'

type BackupFile = {
  name: string
  size_bytes: number
  created_at: string
  tier: string
}

const TIER_LABELS: Record<string, string> = {
  manual: 'Ручной',
  shift: 'Закрытие смены',
  daily: 'Ежедневный',
  weekly: 'Недельный',
  monthly: 'Месячный',
  other: '—',
}

const TIER_COLORS: Record<string, string> = {
  manual: 'bg-primary/10 text-primary',
  shift: 'bg-violet-100 text-violet-600',
  daily: 'bg-blue-100 text-blue-600',
  weekly: 'bg-amber-100 text-amber-600',
  monthly: 'bg-emerald-100 text-emerald-600',
  other: 'bg-muted text-muted-foreground',
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

// Общий raw-fetch helper (openapi-fetch не годится для multipart/binary).
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = localStorage.getItem('restos-v4-token')
  const h: Record<string, string> = { ...extra }
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

export default function BackupPage() {
  const { canDo } = useAuth()
  const [files, setFiles] = useState<BackupFile[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreConfirm, setRestoreConfirm] = useState<{ kind: 'upload'; file: File } | { kind: 'existing'; name: string } | null>(null)
  const uploadRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(getBaseURL() + '/api/v1/backup/list', { headers: authHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      setFiles(Array.isArray(body?.data) ? body.data : [])
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const res = await fetch(getBaseURL() + '/api/v1/backup/create', {
        method: 'POST',
        headers: authHeaders({ 'Idempotency-Key': randomId() }),
      })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(txt.slice(0, 200))
      }
      toast.success('Бэкап создан')
      await load()
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setCreating(false)
    }
  }

  const handleDownload = (name: string) => {
    // Download через временную ссылку с auth-токеном в query невозможно
    // (бэк ждёт Bearer header). Делаем fetch → blob → объект-URL.
    ;(async () => {
      try {
        const res = await fetch(getBaseURL() + `/api/v1/backup/download/${encodeURIComponent(name)}`, {
          headers: authHeaders(),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        a.click()
        URL.revokeObjectURL(url)
      } catch (e) {
        toast.error(humanizeError(e))
      }
    })()
  }

  const handleDelete = async (name: string) => {
    if (!confirm(`Удалить бэкап «${name}»?`)) return
    try {
      const res = await fetch(getBaseURL() + `/api/v1/backup/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: authHeaders({ 'Idempotency-Key': randomId() }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success('Бэкап удалён')
      await load()
    } catch (e) {
      toast.error(humanizeError(e))
    }
  }

  const handleUploadSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    if (!f.name.endsWith('.dump')) {
      toast.error('Нужен файл .dump (созданный этой кассой)')
      return
    }
    setRestoreConfirm({ kind: 'upload', file: f })
  }

  const doRestore = async () => {
    if (!restoreConfirm) return
    setRestoring(true)
    try {
      let res: Response
      if (restoreConfirm.kind === 'upload') {
        const fd = new FormData()
        fd.append('file', restoreConfirm.file)
        res = await fetch(getBaseURL() + '/api/v1/backup/restore', {
          method: 'POST',
          headers: authHeaders({ 'Idempotency-Key': randomId() }),
          body: fd,
        })
      } else {
        res = await fetch(getBaseURL() + `/api/v1/backup/${encodeURIComponent(restoreConfirm.name)}/restore`, {
          method: 'POST',
          headers: authHeaders({ 'Idempotency-Key': randomId() }),
        })
      }
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(txt.slice(0, 300))
      }
      toast.success('Восстановление завершено. Перезагрузите страницу.')
      setRestoreConfirm(null)
      // Перезагружаем — данные изменились кардинально.
      setTimeout(() => window.location.reload(), 1500)
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setRestoring(false)
    }
  }

  // Бэкап доступен кассиру (shifts.manage) и владельцу/менеджеру (data.import).
  if (!canDo('shifts.manage') && !canDo('data.import')) {
    return <div className="p-6 flex items-center justify-center h-64"><p className="text-muted-foreground">Нет доступа</p></div>
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-4xl">
      <div>
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
          <DatabaseBackup className="size-6 text-primary" />
          Резервные копии
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Создавайте копии базы данных и восстанавливайте из них при необходимости
        </p>
      </div>

      {/* Действия */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          onClick={handleCreate}
          disabled={creating}
          className="flex items-center justify-center gap-2 px-4 py-3 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 disabled:opacity-60 transition-colors"
        >
          {creating ? <Loader2 className="size-4 animate-spin" /> : <HardDrive className="size-4" />}
          {creating ? 'Создаём…' : 'Создать бэкап сейчас'}
        </button>
        <button
          onClick={() => uploadRef.current?.click()}
          disabled={restoring}
          className="flex items-center justify-center gap-2 px-4 py-3 bg-card border border-border rounded-xl text-sm font-medium hover:bg-muted disabled:opacity-60 transition-colors"
        >
          <Upload className="size-4" />
          Восстановить из файла
        </button>
        <input ref={uploadRef} type="file" accept=".dump" onChange={handleUploadSelect} className="hidden" />
      </div>

      {/* Список */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold">Сохранённые копии ({files.length})</h3>
        </div>
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="size-6 text-primary animate-spin" />
          </div>
        ) : files.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            Бэкапов пока нет. Нажмите «Создать бэкап сейчас».
          </div>
        ) : (
          <div className="divide-y divide-border">
            {files.map((f) => (
              <div key={f.name} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${TIER_COLORS[f.tier] || TIER_COLORS.other}`}>
                      {TIER_LABELS[f.tier] || f.tier}
                    </span>
                    <span className="text-sm font-medium truncate">{f.name}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                    <span className="flex items-center gap-1"><Clock className="size-3" />{fmtDate(f.created_at)}</span>
                    <span>{fmtSize(f.size_bytes)}</span>
                  </div>
                </div>
                <button
                  onClick={() => handleDownload(f.name)}
                  title="Скачать"
                  className="p-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                >
                  <Download className="size-4" />
                </button>
                <button
                  onClick={() => setRestoreConfirm({ kind: 'existing', name: f.name })}
                  title="Восстановить из этой копии"
                  className="p-2 rounded-lg text-amber-600 hover:bg-amber-50 transition-colors"
                >
                  <RotateCcw className="size-4" />
                </button>
                <button
                  onClick={() => handleDelete(f.name)}
                  title="Удалить"
                  className="p-2 rounded-lg text-destructive hover:bg-destructive/10 transition-colors"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Инфо */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-1.5">
        <p className="text-xs text-blue-800 flex items-start gap-2">
          <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
          <span>Касса автоматически делает копию <strong>при каждом закрытии смены</strong> и дополнительно ежедневно в 3:00. Здесь можно создать копию вручную перед важными изменениями.</span>
        </p>
        <p className="text-xs text-blue-800 flex items-start gap-2">
          <Download className="size-4 shrink-0 mt-0.5" />
          <span>Копия каждого бэкапа также сохраняется в папку <strong>«RestOS-Backups» на Рабочем столе</strong> — оттуда легко скинуть на USB-флешку.</span>
        </p>
      </div>

      {/* Restore confirm modal */}
      {restoreConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !restoring && setRestoreConfirm(null)}>
          <div className="bg-card rounded-2xl border border-border shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="p-5 space-y-4">
              <div className="flex items-center gap-3">
                <div className="size-11 rounded-xl bg-destructive/10 flex items-center justify-center shrink-0">
                  <AlertTriangle className="size-6 text-destructive" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-foreground">Восстановить базу?</h2>
                  <p className="text-xs text-muted-foreground">
                    {restoreConfirm.kind === 'upload' ? restoreConfirm.file.name : restoreConfirm.name}
                  </p>
                </div>
              </div>
              <div className="bg-destructive/5 border border-destructive/20 rounded-lg p-3 text-xs text-destructive space-y-1.5">
                <p className="font-semibold">⚠ Это перезапишет ВСЮ текущую базу данных.</p>
                <p>Все заказы, смены, изменения сделанные ПОСЛЕ этого бэкапа — будут потеряны безвозвратно.</p>
                <p>Убедитесь что все смены закрыты и никто не работает с кассой.</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setRestoreConfirm(null)}
                  disabled={restoring}
                  className="flex-1 px-4 py-2.5 text-sm font-medium border border-border rounded-xl hover:bg-muted disabled:opacity-50"
                >
                  Отмена
                </button>
                <button
                  onClick={doRestore}
                  disabled={restoring}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-destructive rounded-xl hover:bg-destructive/90 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {restoring ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                  {restoring ? 'Восстановление…' : 'Да, восстановить'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
