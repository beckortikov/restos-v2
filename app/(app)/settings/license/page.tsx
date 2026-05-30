'use client'

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy, Check, KeyRound, Wifi, ShieldCheck, AlertCircle, ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import {
  fetchMachineInfo, fetchLicenseStatus, activateLicense,
  type MachineInfo, type LicenseStatus,
} from '@/lib/queries'

// /settings/license — экран активации лицензии.
//
// Tab 1 «Код для активации»: показывает machine_id + restaurant_id.
// Клиент копирует и отправляет админу через Telegram → админ выписывает
// токен в своей панели → присылает обратно.
//
// Tab 2 «Ввести ключ»: текстовое поле для вставки полученного токена.
// При активации backend:
//   • проверяет Ed25519 подпись,
//   • сверяет токен.restaurant_id == текущий,
//   • сверяет токен.machine_id == fingerprint железа.
//
// Внизу — текущий статус лицензии (state, expires, edition).

const TG_LINK = 'https://t.me/restos_support'  // TODO: подставить реальный

export default function ActivateLicensePage() {
  const navigate = useNavigate()
  const [info, setInfo] = useState<MachineInfo | null>(null)
  const [status, setStatus] = useState<LicenseStatus | null>(null)
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [tab, setTab] = useState<'code' | 'paste'>('code')

  useEffect(() => {
    fetchMachineInfo().then(setInfo).catch(e => toast.error('Не удалось получить код машины: ' + e.message))
    fetchLicenseStatus().then(setStatus).catch(() => {})
  }, [])

  function copy(text: string, field: string) {
    navigator.clipboard.writeText(text)
      .then(() => {
        setCopiedField(field)
        setTimeout(() => setCopiedField(null), 2000)
        toast.success('Скопировано')
      })
      .catch(() => toast.error('Не удалось скопировать'))
  }

  async function handleActivate() {
    if (!token.trim()) {
      toast.error('Вставьте ключ лицензии')
      return
    }
    setSubmitting(true)
    try {
      const newStatus = await activateLicense(token.trim())
      setStatus(newStatus)
      setToken('')
      toast.success(`Лицензия активирована! Тариф: ${newStatus.edition ?? '—'}, до ${newStatus.expiresAt ? new Date(newStatus.expiresAt).toLocaleDateString('ru-RU') : '—'}`)
      setTab('code')
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      toast.error('Ошибка активации: ' + msg)
    } finally {
      setSubmitting(false)
    }
  }

  const stateLabel = (s: LicenseStatus['state']) => ({
    none: 'Не активирована',
    active: 'Активна',
    grace: 'Скоро истечёт',
    softLocked: 'Истекла (write-операции скоро будут заблокированы)',
    locked: 'Заблокирована',
  }[s] ?? s)

  const stateColor = (s: LicenseStatus['state']) => ({
    active: 'text-emerald-600 bg-emerald-50 border-emerald-200',
    grace: 'text-amber-600 bg-amber-50 border-amber-200',
    softLocked: 'text-orange-600 bg-orange-50 border-orange-200',
    locked: 'text-red-600 bg-red-50 border-red-200',
    none: 'text-muted-foreground bg-muted/50 border-border',
  }[s] ?? 'text-muted-foreground bg-muted/50 border-border')

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 bg-muted/30">
      <div className="max-w-2xl mx-auto space-y-5">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-4" />
          Назад
        </button>

        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">Лицензия</h1>
          <p className="text-sm text-muted-foreground mt-1">Активация и продление</p>
        </div>

        {/* Статус */}
        {status && (
          <div className={`rounded-xl border p-4 ${stateColor(status.state)}`}>
            <div className="flex items-start gap-3">
              <ShieldCheck className="size-5 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-semibold">{stateLabel(status.state)}</div>
                {status.edition && (
                  <div className="text-xs mt-0.5">Тариф: <span className="font-medium uppercase">{status.edition}</span></div>
                )}
                {status.expiresAt && (
                  <div className="text-xs mt-0.5">
                    Действует до {new Date(status.expiresAt).toLocaleDateString('ru-RU')}
                    {status.daysLeft > 0 && ` (осталось ${status.daysLeft} дн.)`}
                    {status.daysLeft <= 0 && status.daysUntilLock > 0 && ` (grace ${status.daysUntilLock} дн.)`}
                  </div>
                )}
                {status.blockReason && (
                  <div className="text-xs mt-1">Причина: {status.blockReason}</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 bg-muted rounded-xl p-1">
          <button
            onClick={() => setTab('code')}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              tab === 'code' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
            }`}
          >
            1. Получить код
          </button>
          <button
            onClick={() => setTab('paste')}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              tab === 'paste' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
            }`}
          >
            2. Ввести ключ
          </button>
        </div>

        {tab === 'code' && (
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <div className="flex items-start gap-3">
              <KeyRound className="size-5 text-primary mt-0.5 shrink-0" />
              <div className="text-sm text-foreground">
                Отправьте этот код в Telegram <a href={TG_LINK} target="_blank" rel="noopener" className="text-primary font-medium hover:underline">@restos_support</a> или позвоните администратору. В ответ получите ключ лицензии.
              </div>
            </div>

            <div className="space-y-3">
              <FieldRow
                label="Код машины"
                value={info?.machineId ?? '—'}
                onCopy={() => info?.machineId && copy(info.machineId, 'machine')}
                copied={copiedField === 'machine'}
                mono
              />
              <FieldRow
                label="ID ресторана"
                value={info?.restaurantId ?? '—'}
                onCopy={() => info?.restaurantId && copy(info.restaurantId, 'rid')}
                copied={copiedField === 'rid'}
                mono
                small
              />
              {info?.restaurantName && (
                <FieldRow
                  label="Название"
                  value={info.restaurantName}
                  onCopy={() => copy(info.restaurantName!, 'name')}
                  copied={copiedField === 'name'}
                />
              )}
            </div>

            <button
              onClick={() => {
                if (!info) return
                const text = `Код машины: ${info.machineId}\nID ресторана: ${info.restaurantId}${info.restaurantName ? `\nРесторан: ${info.restaurantName}` : ''}`
                copy(text, 'all')
              }}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
            >
              <Copy className="size-4" />
              Скопировать всё
            </button>
          </div>
        )}

        {tab === 'paste' && (
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <div className="flex items-start gap-3">
              <Wifi className="size-5 text-primary mt-0.5 shrink-0" />
              <div className="text-sm text-foreground">
                Вставьте ключ полученный от администратора. Проверка проходит локально (интернет не нужен).
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                Ключ лицензии
              </label>
              <textarea
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder="eyJ2IjoxLCJyaWQiOi..."
                rows={4}
                className="w-full px-3 py-2.5 rounded-lg border border-border bg-background font-mono text-xs focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
              />
            </div>

            <button
              onClick={handleActivate}
              disabled={submitting || !token.trim()}
              className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? 'Активирую…' : 'Активировать'}
            </button>

            <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 rounded-lg p-3">
              <AlertCircle className="size-4 shrink-0 mt-0.5" />
              <span>
                Если получаете «token issued for different machine» — админ выписал ключ для другого компьютера. Перешлите ему обновлённый код машины.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function FieldRow({ label, value, onCopy, copied, mono, small }: {
  label: string
  value: string
  onCopy: () => void
  copied: boolean
  mono?: boolean
  small?: boolean
}) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">{label}</div>
      <div className="flex items-center gap-2">
        <code className={`flex-1 px-3 py-2.5 rounded-lg bg-muted ${mono ? 'font-mono' : ''} ${small ? 'text-xs' : 'text-base font-semibold'} text-foreground break-all`}>
          {value}
        </code>
        <button
          onClick={onCopy}
          className="shrink-0 inline-flex items-center justify-center size-10 rounded-lg bg-muted hover:bg-border transition-colors text-muted-foreground hover:text-foreground"
          title="Скопировать"
        >
          {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
        </button>
      </div>
    </div>
  )
}
