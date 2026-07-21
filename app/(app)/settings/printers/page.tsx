'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Printer, Plus, Trash2, CheckCircle2, ListOrdered, Star, ServerCog, Loader2, Pencil, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'
import { useAuth } from '@/lib/auth-store'
import {
  listPrinters,
  createPrinter,
  updatePrinter,
  deletePrinter,
  testPrinter,
  listSystemQueues,
  type PrinterFormPayload,
  type SystemQueue,
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

// v2.0.93: переписана под полный CRUD + тестовая печать + paper width + content flags.
// Path B: источник правды для принтеров — таблица `printers` на бэке.

type DBPrinter = {
  id: string
  name: string
  kind: string
  driver: string
  enabled: boolean
  is_default: boolean
  target: string
  station?: string | null
  stations?: string[]
  cols?: number
  print_logo?: boolean
  print_discount?: boolean
  print_service?: boolean
  print_tip?: boolean
  print_qr_feedback?: boolean
}

// system — печать через очередь ОС кассы (встроенный USB-принтер моноблока).
type DriverKind = 'tcp' | 'system' | 'virtual'
type PrinterKind = 'receipt' | 'station'

const DRIVER_LABELS: Record<DriverKind, string> = {
  tcp: 'Сетевой',
  system: 'USB',
  virtual: 'Virtual',
}

interface FormState {
  name: string
  driver: DriverKind
  kind: PrinterKind
  host: string
  port: string
  // Имя очереди печати ОС — target для driver=system.
  queue: string
  // Цехи станционного принтера: их позиции печатаются одним бегунком.
  stations: MenuStation[]
  enabled: boolean
  is_default: boolean
  cols: number // 32 | 42 | 48
  print_logo: boolean
  print_discount: boolean
  print_service: boolean
  print_tip: boolean
  print_qr_feedback: boolean
}

const DEFAULT_FORM: FormState = {
  name: '',
  driver: 'tcp',
  kind: 'receipt',
  host: '',
  port: '',
  queue: '',
  stations: [],
  enabled: true,
  is_default: false,
  cols: 48,
  print_logo: true,
  print_discount: true,
  print_service: true,
  print_tip: false,
  print_qr_feedback: false,
}

// Разбирает target вида "host:port" / "host" / IPv6 "[::1]:9100".
function splitTarget(target: string): { host: string; port: string } {
  const t = (target || '').trim()
  if (!t) return { host: '', port: '' }
  // IPv6 [::1]:9100
  if (t.startsWith('[')) {
    const close = t.indexOf(']')
    if (close > 0) {
      const host = t.slice(1, close)
      const rest = t.slice(close + 1)
      const port = rest.startsWith(':') ? rest.slice(1) : ''
      return { host, port }
    }
  }
  const i = t.lastIndexOf(':')
  if (i < 0) return { host: t, port: '' }
  // если перед двоеточием цифр и точек > 0 — IPv4/host:port
  return { host: t.slice(0, i), port: t.slice(i + 1) }
}

function joinTarget(host: string, port: string): string {
  const h = host.trim()
  const p = port.trim()
  if (!h) return ''
  if (!p) return h // backend сам подставит :9100
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]:${p}`
  return `${h}:${p}`
}

// Драйверы, которые умеет редактировать эта форма. Незнакомый драйвер (usb по
// vid:pid, mock) в форму не подставляем — см. isEditableDriver ниже.
const EDITABLE_DRIVERS: DriverKind[] = ['tcp', 'system', 'virtual']

function isEditableDriver(d: string): d is DriverKind {
  return (EDITABLE_DRIVERS as string[]).includes(d)
}

// printerStations — цехи принтера; legacy-фолбэк на station для строк,
// которые бэк ещё не отдаёт со списком (до 053).
function printerStations(p: DBPrinter): MenuStation[] {
  if (p.stations && p.stations.length > 0) return p.stations as MenuStation[]
  return p.station ? [p.station as MenuStation] : []
}

function fromPrinter(p: DBPrinter): FormState {
  const { host, port } = p.driver === 'tcp' ? splitTarget(p.target) : { host: '', port: '' }
  return {
    name: p.name,
    // Раньше здесь незнакомый драйвер молча приводился к 'tcp': открыть
    // такой принтер просто чтобы переименовать → сохранение перезаписывало
    // driver на tcp с пустым адресом, и принтер тихо переставал печатать.
    // Теперь драйвер проходит насквозь, а переключатель для нередактируемых
    // драйверов заменяется на бейдж — затереть его случайно нельзя.
    driver: p.driver as DriverKind,
    queue: p.driver === 'system' ? p.target : '',
    kind: (p.kind === 'station' ? 'station' : 'receipt') as PrinterKind,
    host,
    port,
    stations: printerStations(p),
    enabled: p.enabled,
    is_default: p.is_default,
    cols: p.cols ?? 48,
    print_logo: p.print_logo ?? true,
    print_discount: p.print_discount ?? true,
    print_service: p.print_service ?? true,
    print_tip: p.print_tip ?? false,
    print_qr_feedback: p.print_qr_feedback ?? false,
  }
}

// targetFor — target зависит от драйвера: host:port для сетевого, имя очереди
// ОС для system, пусто для virtual. Для незнакомых драйверов (usb/mock) target
// не трогаем вообще — вернём undefined, и PATCH оставит значение как есть.
function targetFor(form: FormState): string | undefined {
  switch (form.driver) {
    case 'tcp':
      return joinTarget(form.host, form.port)
    case 'system':
      return form.queue.trim()
    case 'virtual':
      return ''
    default:
      return undefined
  }
}

function toPayload(form: FormState, editing: boolean): PrinterFormPayload {
  const target = targetFor(form)
  const payload: PrinterFormPayload = {
    name: form.name.trim(),
    driver: form.driver,
    kind: form.kind,
    ...(target === undefined ? {} : { target }),
    enabled: form.enabled,
    is_default: form.kind === 'receipt' ? form.is_default : false,
    cols: form.cols,
    print_logo: form.print_logo,
    print_discount: form.print_discount,
    print_service: form.print_service,
    print_tip: form.print_tip,
    print_qr_feedback: form.print_qr_feedback,
  }
  if (form.kind === 'station' && form.stations.length > 0) {
    // Полный список цехов; бэк заменяет привязки целиком (printer_stations).
    payload.stations = form.stations as string[]
  }
  // Для kind=receipt цехи не передаём: бэк сам снимает привязки при смене
  // station→receipt, а PATCH без поля ничего не трогает.
  return payload
}

export default function PrinterSettingsPage() {
  const { canDo } = useAuth()
  const [printers, setPrinters] = useState<DBPrinter[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<DBPrinter | null>(null)
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DBPrinter | null>(null)

  // Цехи без печати: есть станционные принтеры, но цех не входит ни в один
  // ВКЛЮЧЁННЫЙ. Пока станционных принтеров нет вовсе — не пугаем (legacy-режим:
  // бегунки уходят на первый настроенный станционный принтер).
  const paperlessStations = useMemo(() => {
    const stationPrinters = printers.filter(p => p.kind === 'station')
    if (stationPrinters.length === 0) return []
    const covered = new Set<string>()
    for (const p of stationPrinters) {
      if (!p.enabled) continue
      for (const s of printerStations(p)) covered.add(s)
    }
    return ALL_STATIONS.filter(s => !covered.has(s))
  }, [printers])
  const [sysQueues, setSysQueues] = useState<SystemQueue[]>([])
  const [queuesLoading, setQueuesLoading] = useState(false)
  const [queuesError, setQueuesError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const rows = await listPrinters()
      setPrinters(rows)
    } catch (e) {
      toast.error(humanizeError(e, 'Не удалось загрузить принтеры'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  // Очереди печати ОС тянем лениво — только когда кассир реально выбрал
  // USB-драйвер. На кассе с десятком установленных принтеров EnumPrinters
  // не бесплатен, а на большинстве экранов список не нужен вовсе.
  const loadQueues = useCallback(async () => {
    setQueuesLoading(true)
    setQueuesError(null)
    try {
      setSysQueues(await listSystemQueues())
    } catch (e) {
      setQueuesError(humanizeError(e, 'Не удалось получить список принтеров ОС'))
    } finally {
      setQueuesLoading(false)
    }
  }, [])

  const selectDriver = useCallback((d: DriverKind) => {
    setForm(f => ({ ...f, driver: d }))
    if (d === 'system') loadQueues()
  }, [loadQueues])

  const openCreate = () => {
    setEditing(null)
    setForm(DEFAULT_FORM)
    setDialogOpen(true)
  }

  const openEdit = (p: DBPrinter) => {
    setEditing(p)
    setForm(fromPrinter(p))
    setDialogOpen(true)
    if (p.driver === 'system') loadQueues()
  }

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error('Укажите название принтера')
      return
    }
    if (form.driver === 'tcp' && !form.host.trim()) {
      toast.error('Укажите IP или хост принтера')
      return
    }
    if (form.driver === 'system' && !form.queue.trim()) {
      toast.error('Выберите принтер из списка очередей ОС')
      return
    }
    if (form.kind === 'station' && form.stations.length === 0) {
      toast.error('Выберите хотя бы один цех')
      return
    }
    setSaving(true)
    try {
      const payload = toPayload(form, !!editing)
      if (editing) {
        await updatePrinter(editing.id, payload)
        toast.success(`«${form.name.trim()}» сохранён`)
      } else {
        await createPrinter(payload)
        toast.success(`Принтер «${form.name.trim()}» создан`)
      }
      setDialogOpen(false)
      setEditing(null)
      setForm(DEFAULT_FORM)
      await reload()
    } catch (e) {
      const msg = humanizeError(e, 'Ошибка')
      toast.error(`Ошибка: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  const handleToggleEnabled = async (p: DBPrinter) => {
    try {
      await updatePrinter(p.id, { enabled: !p.enabled })
      await reload()
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка'))
    }
  }

  const handleSetDefault = async (p: DBPrinter) => {
    try {
      await updatePrinter(p.id, { is_default: true })
      toast.success(`«${p.name}» выбран по умолчанию`)
      await reload()
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка'))
    }
  }

  const handleTest = async (p: DBPrinter) => {
    setTesting(p.id)
    try {
      await testPrinter(p.id)
      toast.success(`Тест отправлен на «${p.name}» — смотри очередь печати`)
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка тестовой печати'))
    } finally {
      setTesting(null)
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
      toast.error(humanizeError(e, 'Ошибка удаления'))
    }
  }

  if (!canDo('printers.manage')) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <p className="text-muted-foreground">Нет доступа</p>
      </div>
    )
  }

  const colsLabel = (cols?: number): string => {
    if (!cols) return ''
    if (cols <= 32) return '58мм'
    if (cols <= 42) return '80мм узкий'
    return '80мм'
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
                      {isEditableDriver(p.driver) ? DRIVER_LABELS[p.driver] : p.driver}
                    </span>
                    {colsLabel(p.cols) && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">
                        {colsLabel(p.cols)}
                      </span>
                    )}
                    {printerStations(p).map(s => (
                      <span key={s} className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">
                        {STATION_LABELS[s] ?? s}
                      </span>
                    ))}
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
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleTest(p)}
                    disabled={testing === p.id || !p.enabled}
                    title="Тестовая печать"
                  >
                    {testing === p.id
                      ? <Loader2 className="size-4 animate-spin" />
                      : <FileText className="size-4" />}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => openEdit(p)} title="Редактировать">
                    <Pencil className="size-4" />
                  </Button>
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
      <Button onClick={openCreate} className="w-full">
        <Plus className="size-4" />
        Добавить принтер
      </Button>

      {/* Бесбумажные цехи: привязаны только к отключённым принтерам или не
          привязаны никуда — их бегунки не печатаются. Показываем явно, чтобы
          это было осознанным решением, а не сюрпризом на кухне. */}
      {paperlessStations.length > 0 && (
        <div className="bg-muted/30 rounded-xl border border-border p-4 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Без печати: </span>
          {paperlessStations.map(s => STATION_LABELS[s] ?? s).join(', ')} — бегунки этих
          цехов не печатаются; позиции видны на кухонном экране и в чеке гостя.
          Чтобы печатать, добавьте цех в один из принтеров-станций.
        </div>
      )}

      {/* Info */}
      <div className="bg-muted/30 rounded-xl border border-border p-4 space-y-2 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground flex items-center gap-2">
          <Printer className="size-4" />Как работает печать в RestOS v4
        </p>
        <ol className="space-y-1 list-decimal list-inside">
          <li>Кассир закрывает заказ или печатает пре-чек → бэкенд создаёт job в очереди печати.</li>
          <li>Worker отправляет ESC/POS по сети, в очередь печати ОС или пишет файл (virtual).</li>
          <li>На ошибки — повтор по backoff, после 5 попыток job переходит в «failed».</li>
          <li>Порт не указан — backend сам подставит :9100 (стандартный ESC/POS).</li>
          <li>USB-принтер моноблока подключается через очередь печати Windows, отдельный драйвер не нужен.</li>
        </ol>
      </div>

      {/* Create / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) setEditing(null) }}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Редактировать принтер' : 'Добавить принтер'}</DialogTitle>
            <DialogDescription>
              Сетевой — принтер с IP (Wi-Fi или Ethernet). USB — принтер, встроенный
              в кассу или воткнутый в неё кабелем. Virtual — пишет в файл, для тестов без железа.
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
                      onClick={() => setForm(f => ({ ...f, kind: k, stations: k === 'receipt' ? [] : f.stations }))}
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
                <Label>Подключение</Label>
                {isEditableDriver(form.driver) ? (
                  <div className="flex rounded-lg border border-border bg-card overflow-hidden">
                    {EDITABLE_DRIVERS.map(d => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => selectDriver(d)}
                        className={`flex-1 px-2.5 py-1.5 text-xs font-medium ${
                          form.driver === d ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                        }`}
                      >
                        {DRIVER_LABELS[d]}
                      </button>
                    ))}
                  </div>
                ) : (
                  // Драйвер, которого нет в форме (usb по vid:pid, mock).
                  // Показываем как есть и не даём затереть — менять такой
                  // принтер нужно осознанно, а не побочным эффектом.
                  <div className="px-2.5 py-1.5 rounded-lg border border-border bg-muted/50 text-xs font-mono text-muted-foreground">
                    {form.driver}
                  </div>
                )}
              </div>
            </div>

            {form.kind === 'station' && (
              <div className="space-y-1.5">
                <Label>Цехи</Label>
                <div className="flex flex-wrap gap-1.5">
                  {ALL_STATIONS.map(s => {
                    const active = form.stations.includes(s)
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setForm(f => ({
                          ...f,
                          stations: active ? f.stations.filter(x => x !== s) : [...f.stations, s],
                        }))}
                        className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                          active
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-background border-border text-foreground hover:bg-muted'
                        }`}
                      >
                        {STATION_LABELS[s]}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Позиции всех выбранных цехов печатаются одним бегунком. Цех, не привязанный
                  ни к одному принтеру, не печатается вовсе — его позиции видны на кухонном
                  экране и в чеке гостя.
                </p>
              </div>
            )}

            {form.driver === 'tcp' && (
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2 space-y-1.5">
                  <Label htmlFor="printer-host">IP или хост</Label>
                  <Input
                    id="printer-host"
                    value={form.host}
                    onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
                    placeholder="192.168.1.100"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="printer-port">Порт</Label>
                  <Input
                    id="printer-port"
                    value={form.port}
                    onChange={e => setForm(f => ({ ...f, port: e.target.value.replace(/[^0-9]/g, '') }))}
                    placeholder="9100"
                  />
                </div>
                <p className="col-span-3 text-[11px] text-muted-foreground -mt-1">
                  Порт можно не указывать — backend сам подставит 9100.
                </p>
              </div>
            )}

            {form.driver === 'system' && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="printer-queue">Принтер в системе</Label>
                  <button
                    type="button"
                    onClick={loadQueues}
                    disabled={queuesLoading}
                    className="text-[11px] text-primary hover:underline disabled:opacity-50"
                  >
                    {queuesLoading ? 'Обновляю…' : 'Обновить список'}
                  </button>
                </div>
                <select
                  id="printer-queue"
                  value={form.queue}
                  onChange={e => setForm(f => ({ ...f, queue: e.target.value }))}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg"
                >
                  <option value="">
                    {queuesLoading ? '— Загружаю принтеры —' : '— Выберите принтер —'}
                  </option>
                  {sysQueues.map(q => (
                    <option key={q.name} value={q.name}>
                      {q.name}
                      {q.is_default ? ' (по умолчанию)' : ''}
                      {q.status ? ` — ${q.status}` : ''}
                    </option>
                  ))}
                  {/* Очередь могла исчезнуть из ОС (принтер отключили), но она
                      прописана у принтера — показываем, чтобы её не затёрло
                      молча при сохранении. */}
                  {form.queue && !sysQueues.some(q => q.name === form.queue) && (
                    <option value={form.queue}>{form.queue} — не найден в системе</option>
                  )}
                </select>
                {queuesError ? (
                  <p className="text-[11px] text-destructive">{queuesError}</p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    Список принтеров кассы, а не того устройства, с которого открыты настройки.
                    Подходит для принтера, встроенного в моноблок.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Ширина бумаги</Label>
              <div className="flex rounded-lg border border-border bg-card overflow-hidden">
                {[
                  { v: 32, label: '58мм (32)' },
                  { v: 42, label: '80мм узкий (42)' },
                  { v: 48, label: '80мм (48)' },
                ].map(opt => (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, cols: opt.v }))}
                    className={`flex-1 px-2 py-1.5 text-xs font-medium ${
                      form.cols === opt.v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {form.kind === 'receipt' && (
              <div className="space-y-2 rounded-lg border border-border p-3 bg-card">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Содержимое чека
                </Label>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {([
                    ['print_logo', 'Логотип / адрес'],
                    ['print_discount', 'Строка скидки'],
                    ['print_service', 'Строка сервиса'],
                    ['print_tip', 'Чаевые'],
                    ['print_qr_feedback', 'QR-фидбэк'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={form[key]}
                        onChange={e => setForm(f => ({ ...f, [key]: e.target.checked }))}
                      />
                      {label}
                    </label>
                  ))}
                </div>
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

          <DialogFooter className="flex-wrap gap-2">
            {editing && (
              <Button
                variant="outline"
                onClick={() => handleTest(editing)}
                disabled={saving || testing === editing.id || !form.enabled}
              >
                {testing === editing.id
                  ? <Loader2 className="size-4 animate-spin" />
                  : <FileText className="size-4" />}
                Тест
              </Button>
            )}
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              Отмена
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving
                ? <Loader2 className="size-4 animate-spin" />
                : (editing ? <CheckCircle2 className="size-4" /> : <Plus className="size-4" />)}
              {editing ? 'Сохранить' : 'Создать'}
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
