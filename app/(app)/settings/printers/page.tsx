'use client'

import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Printer, Plus, Trash2, CheckCircle2, ListOrdered, Star, ServerCog, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import {
  listPrinters,
  createPrinter,
  updatePrinter,
  deletePrinter,
} from '@/lib/queries/printers'
import { ALL_STATIONS, STATION_LABELS, type MenuStation } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Label } from '@/components/ui/label'

// Path B printers page. Источник правды для принтеров — таблица `printers`
// на бэке (GET /api/v1/printers). Раньше тут был localStorage-based config
// с прямыми вызовами на legacy print-server по HTTP (Path A) — удалено
// вместе с lib/print-service.ts. Теперь весь pipeline server-side:
// backend создаёт print_jobs row, worker отправляет на driver.

type DBPrinter = {
  id: string
  name: string
  kind: string
  driver: string
  enabled: boolean
  is_default: boolean
  target: string
  station?: string
}

type DriverKind = 'tcp' | 'virtual'
type PrinterKind = 'receipt' | 'station'

interface FormState {
  name: string
  driver: DriverKind
  kind: PrinterKind
  target: string
  station: MenuStation | ''
  enabled: boolean
  is_default: boolean
}

const DEFAULT_FORM: FormState = {
  name: '',
  driver: 'tcp',
  kind: 'receipt',
  target: '',
  station: '',
  enabled: true,
  is_default: false,
}

export default function PrinterSettingsPage() {
  const { canDo } = useAuth()
  const [printers, setPrinters] = useState<DBPrinter[]>([])
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DBPrinter | null>(null)

  const reload = useCallback(async () => {
    try {
      const rows = await listPrinters()
      setPrinters(rows)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось загрузить принтеры')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  const handleCreate = async () => {
    if (!form.name.trim()) {
      toast.error('Укажите название принтера')
      return
    }
    if (form.driver === 'tcp' && !form.target.trim()) {
      toast.error('Укажите адрес принтера (IP:порт)')
      return
    }
    if (form.kind === 'station' && !form.station) {
      toast.error('Выберите станцию')
      return
    }
    setCreating(true)
    try {
      await createPrinter({
        name: form.name.trim(),
        driver: form.driver,
        kind: form.kind,
        target: form.driver === 'virtual' ? '' : form.target.trim(),
        enabled: form.enabled,
        is_default: form.is_default,
        ...(form.kind === 'station' ? { station: form.station as string } : {}),
      })
      toast.success(`Принтер «${form.name.trim()}» создан`)
      setAddOpen(false)
      setForm(DEFAULT_FORM)
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? `Ошибка: ${e.message}` : 'Не удалось создать принтер')
    } finally {
      setCreating(false)
    }
  }

  const handleToggleEnabled = async (p: DBPrinter) => {
    try {
      await updatePrinter(p.id, { enabled: !p.enabled })
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    }
  }

  const handleSetDefault = async (p: DBPrinter) => {
    try {
      await updatePrinter(p.id, { is_default: true })
      toast.success(`«${p.name}» выбран по умолчанию`)
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await deletePrinter(deleteTarget.id)
      toast.success(`Принтер «${deleteTarget.name}» удалён`)
      setDeleteTarget(null)
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка удаления')
    }
  }

  if (!canDo('printers.manage')) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <p className="text-muted-foreground">Нет доступа</p>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-3xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Принтеры</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Принтеры чеков и кухонные runner-принтеры. Печать идёт через backend job-queue.
          </p>
        </div>
        <Link
          to="/settings/printers/queue"
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors bg-white shrink-0"
        >
          <ListOrdered className="size-3.5" />
          Очередь печати
        </Link>
      </div>

      {/* List */}
      <div className="space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : printers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center space-y-2">
            <ServerCog className="size-8 text-muted-foreground/40 mx-auto" />
            <p className="text-sm text-muted-foreground">
              Принтеров пока нет. Добавьте TCP-принтер с IP-адресом или виртуальный
              (запись в файл) для тестов.
            </p>
          </div>
        ) : (
          printers.map(p => (
            <div
              key={p.id}
              className={`rounded-xl border p-4 transition-colors ${
                p.enabled ? 'border-primary/30 bg-primary/5' : 'border-border bg-card'
              }`}
            >
              <div className="flex items-start gap-3 flex-wrap">
                <Printer className={`size-5 shrink-0 mt-0.5 ${p.enabled ? 'text-primary' : 'text-muted-foreground/60'}`} />
                <div className="flex-1 min-w-[200px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm text-foreground">{p.name}</span>
                    {p.is_default && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">
                        <Star className="size-3" />По умолчанию
                      </span>
                    )}
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">
                      {p.kind === 'receipt' ? 'Чек' : 'Станция'}
                    </span>
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">
                      {p.driver}
                    </span>
                    {p.station && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">
                        {STATION_LABELS[p.station as MenuStation] ?? p.station}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 font-mono">
                    {p.driver === 'virtual' ? 'backups/print/' : (p.target || '—')}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {!p.is_default && p.kind === 'receipt' && (
                    <Button size="sm" variant="ghost" onClick={() => handleSetDefault(p)} title="Сделать основным">
                      <Star className="size-4" />
                    </Button>
                  )}
                  <button
                    onClick={() => handleToggleEnabled(p)}
                    className={`size-8 rounded-lg flex items-center justify-center border-2 transition-all ${
                      p.enabled ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-muted/50 border-border text-muted-foreground/30'
                    }`}
                    title={p.enabled ? 'Выключить' : 'Включить'}
                  >
                    {p.enabled && <CheckCircle2 className="size-4" />}
                  </button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(p)} title="Удалить">
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add button */}
      <Button onClick={() => { setForm(DEFAULT_FORM); setAddOpen(true) }} className="w-full">
        <Plus className="size-4" />
        Добавить принтер
      </Button>

      {/* Info */}
      <div className="bg-muted/30 rounded-xl border border-border p-4 space-y-2 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground flex items-center gap-2">
          <Printer className="size-4" />Как работает печать в RestOS v4
        </p>
        <ol className="space-y-1 list-decimal list-inside">
          <li>
            Кассир закрывает заказ или печатает пре-чек → бэкенд создаёт job в очереди печати.
          </li>
          <li>Worker отправляет ESC/POS на драйвер (TCP) или пишет файл (virtual).</li>
          <li>На ошибки — повтор по backoff, после 5 попыток job переходит в «failed».</li>
          <li>Виртуальные принтеры — для тестов: payload падает в <code>backups/print/</code>.</li>
        </ol>
      </div>

      {/* Add dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Добавить принтер</DialogTitle>
            <DialogDescription>
              TCP — сетевой термопринтер по IP. Virtual — пишет в файл вместо реальной печати.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="printer-name">Название</Label>
              <Input
                id="printer-name"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Касса 1 / Кухня бар"
                autoFocus
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label>Тип</Label>
                <div className="flex rounded-lg border border-border bg-card overflow-hidden">
                  {(['receipt', 'station'] as PrinterKind[]).map(k => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, kind: k, station: k === 'receipt' ? '' : f.station }))}
                      className={`flex-1 px-2.5 py-1.5 text-xs font-medium ${
                        form.kind === k ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                      }`}
                    >
                      {k === 'receipt' ? 'Чек' : 'Станция'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Драйвер</Label>
                <div className="flex rounded-lg border border-border bg-card overflow-hidden">
                  {(['tcp', 'virtual'] as DriverKind[]).map(d => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, driver: d }))}
                      className={`flex-1 px-2.5 py-1.5 text-xs font-medium ${
                        form.driver === d ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                      }`}
                    >
                      {d === 'tcp' ? 'TCP' : 'Virtual'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {form.kind === 'station' && (
              <div className="space-y-1.5">
                <Label htmlFor="printer-station">Станция</Label>
                <select
                  id="printer-station"
                  value={form.station}
                  onChange={e => setForm(f => ({ ...f, station: e.target.value as MenuStation }))}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg"
                >
                  <option value="">— Выберите станцию —</option>
                  {ALL_STATIONS.map(s => (
                    <option key={s} value={s}>{STATION_LABELS[s]}</option>
                  ))}
                </select>
              </div>
            )}

            {form.driver === 'tcp' && (
              <div className="space-y-1.5">
                <Label htmlFor="printer-target">Адрес (host:port)</Label>
                <Input
                  id="printer-target"
                  value={form.target}
                  onChange={e => setForm(f => ({ ...f, target: e.target.value }))}
                  placeholder="192.168.1.100:9100"
                />
                <p className="text-[11px] text-muted-foreground">
                  Стандартный порт ESC/POS термопринтеров — 9100.
                </p>
              </div>
            )}

            <div className="flex items-center gap-4 pt-1">
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
                />
                Включён
              </label>
              {form.kind === 'receipt' && (
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.is_default}
                    onChange={e => setForm(f => ({ ...f, is_default: e.target.checked }))}
                  />
                  По умолчанию
                </label>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)} disabled={creating}>
              Отмена
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Создать
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={o => { if (!o) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить принтер?</AlertDialogTitle>
            <AlertDialogDescription>
              «{deleteTarget?.name}» будет удалён. Уже созданные print-job'ы продолжат
              ссылаться на этот id, но новые задания на него не пойдут.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
