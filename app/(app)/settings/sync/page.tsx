'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/lib/auth-store'
import {
  fetchSyncSettings, saveSyncSettings, joinNetwork, fetchSyncQueueStats, backfillSync,
  type SyncSettings, type SyncQueueStats,
} from '@/lib/queries/sync-settings'
import { RefreshCw, Save, Info, Ticket, CloudUpload, CheckCircle2, AlertTriangle, History } from 'lucide-react'
import { toast } from 'sonner'

// Русские подписи для сущностей backfill'а — только те, что реально хоть
// раз были ненулевыми на практике; остальное сворачивается в «и другие».
const BACKFILL_LABELS: Record<string, string> = {
  users: 'сотрудников',
  orders: 'заказов',
  menu_items: 'позиций меню',
  ingredients: 'ингредиентов',
  financial_operations: 'финансовых операций',
}

export default function SyncSettingsPage() {
  const { restaurantId, user } = useAuth()
  const isOwner = user?.role === 'owner'
  const [backfilling, setBackfilling] = useState(false)
  const [s, setS] = useState<SyncSettings>({ enabled: false, centralUrl: '', token: '', restaurantId: '', intervalSec: 30 })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [pairingCode, setPairingCode] = useState('')
  const [joining, setJoining] = useState(false)
  const [queue, setQueue] = useState<SyncQueueStats | null>(null)

  const reloadSettings = () =>
    fetchSyncSettings().then(v => setS({ ...v, restaurantId: v.restaurantId || restaurantId || '' }))

  const reloadQueue = () => fetchSyncQueueStats().then(setQueue).catch(() => setQueue(null))

  useEffect(() => {
    reloadSettings().catch(() => {}).finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId])

  // Очередь опрашивается сама: оператор смотрит на этот экран именно тогда,
  // когда ждёт, что накопленное уедет — цифра обязана меняться на глазах,
  // без ручного обновления страницы.
  useEffect(() => {
    reloadQueue()
    const id = setInterval(reloadQueue, 10_000)
    return () => clearInterval(id)
  }, [])

  const set = (patch: Partial<SyncSettings>) => setS(prev => ({ ...prev, ...patch }))

  const onSave = async () => {
    setSaving(true)
    try {
      await saveSyncSettings(s)
      toast.success('Настройки сохранены и уже применяются. Изменение интервала вступит в силу после следующего перезапуска.')
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  // «Отправить историю» — для данных, заведённых до включения синка или
  // мимо него (напр. массовый импорт сотрудников): обычный пушер шлёт только
  // изменения ВПЕРЁД, а этот заказ/сотрудник/etc уже существовал. Кнопка
  // ставит текущее состояние всех таблиц в очередь заново — идемпотентно,
  // central просто upsert'нет то, что уже видел.
  const onBackfill = async () => {
    setBackfilling(true)
    try {
      const { entities } = await backfillSync()
      const total = Object.values(entities).reduce((a, b) => a + b, 0)
      if (total === 0) {
        toast.success('Отправлять нечего — central уже видел всю историю этого филиала.')
      } else {
        const parts = Object.entries(entities)
          .filter(([k, n]) => n > 0 && BACKFILL_LABELS[k])
          .map(([k, n]) => `${n} ${BACKFILL_LABELS[k]}`)
        const detail = parts.length ? ` (в т.ч. ${parts.join(', ')})` : ''
        toast.success(`Отправлено ${total} записей на central${detail} — досчитается на ближайших циклах синхронизации.`)
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось отправить историю')
    } finally {
      setBackfilling(false)
    }
  }

  const onJoin = async () => {
    if (!pairingCode.trim()) return
    setJoining(true)
    try {
      const { centralName } = await joinNetwork(pairingCode.trim())
      toast.success(`Подключено к сети «${centralName}» — уже работает, перезапуск не нужен.`)
      setPairingCode('')
      await reloadSettings()
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось подключиться по коду')
    } finally {
      setJoining(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-2xl">
      <div className="flex items-center gap-2">
        <RefreshCw className="size-5 text-primary" />
        <h1 className="text-xl font-bold text-foreground">Синхронизация сети</h1>
      </div>

      <div className="flex items-start gap-2 rounded-lg bg-blue-500/10 px-3 py-2 text-sm text-blue-700">
        <Info className="size-4 mt-0.5 shrink-0" />
        <span>
          Настройка для <b>филиала</b>: касса будет в фоне отправлять свои данные на центральный узел сети
          и получать входящие перемещения. Изменения применяются <b>сразу, без перезапуска</b> (кроме интервала —
          он вступит в силу со следующего запуска).
        </span>
      </div>

      <div className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
        <div className="flex items-center gap-1.5">
          <Ticket className="size-4 text-primary" />
          <div className="text-sm font-medium text-foreground">Код приглашения</div>
        </div>
        <p className="text-xs text-muted-foreground">
          Получите код от владельца центрального узла (Настройки → Филиалы сети → Приглашения) и вставьте сюда —
          адрес, секрет и сеть подставятся сами.
        </p>
        <div className="flex items-end gap-2">
          <input
            value={pairingCode}
            onChange={e => setPairingCode(e.target.value)}
            placeholder="https://central.example.com/pair/ABCD1234"
            className="input flex-1"
          />
          <button
            onClick={onJoin}
            disabled={joining || !pairingCode.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 shrink-0"
          >
            {joining ? 'Подключение...' : 'Подключиться'}
          </button>
        </div>
      </div>

      <label className="flex items-center justify-between rounded-xl border border-border p-3">
        <div>
          <div className="text-sm font-medium text-foreground">Включить синхронизацию</div>
          <div className="text-xs text-muted-foreground">Выключено = автономный режим (по умолчанию)</div>
        </div>
        <input type="checkbox" checked={s.enabled} onChange={e => set({ enabled: e.target.checked })} className="size-5" />
      </label>

      {s.enabled && queue && <QueueStatus q={queue} />}

      {s.enabled && isOwner && (
        <div className="space-y-2 rounded-xl border border-border p-3">
          <div className="flex items-center gap-1.5">
            <History className="size-4 text-muted-foreground" />
            <div className="text-sm font-medium text-foreground">Отправить историю на central</div>
          </div>
          <p className="text-xs text-muted-foreground">
            Обычная синхронизация шлёт только новые изменения. Если данные заведены до включения
            синхронизации — или сотрудник добавлен массовым импортом, а не вручную — central мог их
            не увидеть. Эта кнопка досылает текущее состояние заново; повторный клик безопасен.
          </p>
          <button
            onClick={onBackfill}
            disabled={backfilling}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            <History className="size-4" /> {backfilling ? 'Отправка...' : 'Отправить историю'}
          </button>
        </div>
      )}

      <p className="text-xs text-muted-foreground -mt-2">Поля ниже — ручной способ (например, для подключения через туннель без публичного адреса).</p>

      <div className={s.enabled ? 'space-y-4' : 'space-y-4 opacity-50 pointer-events-none'}>
        <Field label="Адрес центрального узла" hint="напр. https://central.moyaset.ru">
          <input value={s.centralUrl} onChange={e => set({ centralUrl: e.target.value })} className="input" placeholder="https://central.moyaset.ru" />
        </Field>
        <Field label="Секрет сети" hint="общий токен, тот же на центральном узле">
          <input value={s.token} onChange={e => set({ token: e.target.value })} className="input" placeholder="RESTOS_SYNC_TOKEN" />
        </Field>
        <Field label="ID этого филиала" hint="для получения входящих перемещений (обычно — текущий ресторан)">
          <input value={s.restaurantId} onChange={e => set({ restaurantId: e.target.value })} className="input font-mono text-xs" />
        </Field>
        <Field label="Интервал, сек" hint="как часто отправлять/тянуть (по умолчанию 30)">
          <input type="number" value={s.intervalSec} onChange={e => set({ intervalSec: Number(e.target.value) || 30 })} className="input w-28" />
        </Field>
      </div>

      <button onClick={onSave} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
        <Save className="size-4" /> Сохранить
      </button>

      <style>{`.input{width:100%;border-radius:.5rem;border:1px solid hsl(var(--border));background:hsl(var(--background));padding:.5rem .75rem;font-size:.875rem}`}</style>
    </div>
  )
}

// humanizeSyncError — типовые сетевые сбои словами кассира. Сырой текст от Go
// («dial tcp …: connect: connection refused») точен, но человеку за кассой не
// говорит ничего и выглядит как поломка программы, хотя это просто нет связи.
// Всё, что не распознали, показываем как есть — лучше непонятное, чем ничего.
function humanizeSyncError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes('connection refused') || m.includes('no such host') || m.includes('dial tcp')) {
    return 'нет связи с центральным узлом'
  }
  if (m.includes('timeout') || m.includes('deadline exceeded')) {
    return 'центральный узел не отвечает'
  }
  if (m.includes('401') || m.includes('unauthorized')) {
    return 'центральный узел отклонил секрет сети — проверьте настройки'
  }
  return msg
}

function fmtWhen(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const mins = Math.floor((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'только что'
  if (mins < 60) return `${mins} мин назад`
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/**
 * QueueStatus — что сейчас с отправкой данных на центральный узел.
 *
 * Касса работает автономно и копит изменения, пока нет связи; когда связь
 * появляется, очередь уходит сама. Но до Фазы О у оператора не было НИ ОДНОЙ
 * цифры об этом: после дня без интернета убедиться, что всё доехало, можно
 * было только по логам бэка. Здесь — три вещи, которые реально отвечают на
 * вопрос «всё ли уехало»: размер очереди, возраст её головы (растёт → синк
 * стоит) и время последней успешной отправки.
 */
function QueueStatus({ q }: { q: SyncQueueStats }) {
  const stuck = q.pending > 0 && !!q.lastError
  const tone = q.failed > 0 || stuck
    ? 'border-amber-500/40 bg-amber-500/5'
    : q.pending > 0
      ? 'border-border'
      : 'border-emerald-500/40 bg-emerald-500/5'

  return (
    <div className={`rounded-xl border p-3 space-y-2 ${tone}`}>
      <div className="flex items-center gap-2">
        {q.pending === 0 && q.failed === 0
          ? <CheckCircle2 className="size-4 text-emerald-600" />
          : <CloudUpload className="size-4 text-muted-foreground" />}
        <div className="text-sm font-medium text-foreground">
          {q.pending === 0
            ? 'Всё отправлено на центральный узел'
            : `Ожидает отправки: ${q.pending}`}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Последняя отправка: {fmtWhen(q.lastSyncedAt)}</span>
        {q.pending > 0 && <span>Самая старая в очереди: {fmtWhen(q.oldestPendingAt)}</span>}
      </div>

      {stuck && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Последняя попытка не удалась: {humanizeSyncError(q.lastError!)}. Данные копятся
          на кассе и уедут сами, как только связь появится — работать можно как обычно.
        </p>
      )}

      {q.failed > 0 && (
        <div className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
          <span>
            {q.failed} записей центральный узел не принял — они отложены, чтобы не блокировать
            остальные, и сохранены для разбора. Сообщите в поддержку.
          </span>
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-muted-foreground">{label}</label>
      {children}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}
