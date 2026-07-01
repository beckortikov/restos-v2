'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/lib/auth-store'
import { fetchSyncSettings, saveSyncSettings, type SyncSettings } from '@/lib/queries/sync-settings'
import { RefreshCw, Save, Info } from 'lucide-react'
import { toast } from 'sonner'

export default function SyncSettingsPage() {
  const { restaurantId } = useAuth()
  const [s, setS] = useState<SyncSettings>({ enabled: false, centralUrl: '', token: '', restaurantId: '', intervalSec: 30 })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchSyncSettings()
      .then(v => setS({ ...v, restaurantId: v.restaurantId || restaurantId || '' }))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [restaurantId])

  const set = (patch: Partial<SyncSettings>) => setS(prev => ({ ...prev, ...patch }))

  const onSave = async () => {
    setSaving(true)
    try {
      await saveSyncSettings(s)
      toast.success('Настройки сохранены. Перезапустите приложение для применения.')
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось сохранить')
    } finally {
      setSaving(false)
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
          и получать входящие перемещения. Изменения применяются <b>после перезапуска приложения</b>.
        </span>
      </div>

      <label className="flex items-center justify-between rounded-xl border border-border p-3">
        <div>
          <div className="text-sm font-medium text-foreground">Включить синхронизацию</div>
          <div className="text-xs text-muted-foreground">Выключено = автономный режим (по умолчанию)</div>
        </div>
        <input type="checkbox" checked={s.enabled} onChange={e => set({ enabled: e.target.checked })} className="size-5" />
      </label>

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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-muted-foreground">{label}</label>
      {children}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}
