'use client'

import { useEffect, useState } from 'react'
import { Copy, Check, KeyRound, Wifi, ShieldAlert, ArrowRight } from 'lucide-react'
import { toast } from 'sonner'
import {
  fetchMachineInfo, fetchLicenseStatus, activateLicense,
  type MachineInfo, type LicenseStatus,
} from '@/lib/queries'

const TG_LINK = 'https://t.me/restos_support' // TODO: реальный канал

// LicenseGate — full-screen блокер. Пока лицензия не активна (state =
// 'none' | 'locked' | 'softLocked') — закрывает весь UI кассы и показывает
// единственный экран активации: machine_id для отправки админу + поле
// для ввода полученного токена.
//
// state === 'active' | 'grace' → рендерит children (обычный UI).
// Loading → blank (быстрая проверка, ~100мс к локальному бэку).
//
// v2.0.29+: бэкенд блокирует writes при `license_expires_at IS NULL`.
// Read'ы свободны → этот gate работает на их основе.
export function LicenseGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<LicenseStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    fetchLicenseStatus()
      .then(s => { if (mounted) { setStatus(s); setLoading(false) } })
      .catch(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [])

  const onActivated = (s: LicenseStatus) => setStatus(s)

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  const blocked = !status
    || status.state === 'none'
    || status.state === 'locked'
    || status.state === 'softLocked'
    || status.isBlocked

  if (!blocked) {
    return <>{children}</>
  }

  return <ActivationScreen status={status} onActivated={onActivated} />
}

function ActivationScreen({
  status, onActivated,
}: {
  status: LicenseStatus | null
  onActivated: (s: LicenseStatus) => void
}) {
  const [info, setInfo] = useState<MachineInfo | null>(null)
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)

  useEffect(() => {
    fetchMachineInfo()
      .then(setInfo)
      .catch(e => toast.error('Не удалось получить код машины: ' + e.message))
  }, [])

  function copy(text: string, field: string) {
    navigator.clipboard.writeText(text).then(
      () => { setCopiedField(field); setTimeout(() => setCopiedField(null), 1500); toast.success('Скопировано') },
      () => toast.error('Не удалось скопировать'),
    )
  }

  async function handleActivate() {
    if (!token.trim()) {
      toast.error('Вставьте ключ лицензии')
      return
    }
    setSubmitting(true)
    try {
      const s = await activateLicense(token.trim())
      onActivated(s)
      toast.success(`Лицензия активирована! Тариф: ${s.edition ?? '—'}`)
    } catch (e: any) {
      toast.error('Ошибка активации: ' + (e?.message ?? String(e)))
    } finally {
      setSubmitting(false)
    }
  }

  const headline = status?.state === 'locked'
    ? 'Лицензия истекла'
    : status?.isBlocked
      ? 'Доступ заблокирован'
      : 'Активация лицензии'

  const subline = status?.state === 'locked'
    ? 'Срок действия закончился. Продлите чтобы продолжить работу.'
    : status?.isBlocked
      ? (status.blockReason || 'Ресторан заблокирован администратором')
      : 'Без активации работа кассы недоступна'

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-primary/5 via-background to-primary/5">
      <div className="max-w-2xl w-full space-y-4">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex size-14 rounded-2xl bg-amber-500/10 text-amber-600 items-center justify-center">
            <ShieldAlert className="size-7" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">{headline}</h1>
          <p className="text-sm text-muted-foreground">{subline}</p>
        </div>

        {/* Step 1 */}
        <div className="bg-card border border-border rounded-2xl p-5 space-y-4 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="size-7 rounded-full bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center shrink-0">1</div>
            <div className="flex-1">
              <div className="font-semibold text-foreground">Отправьте код админу</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Перешлите в Telegram <a href={TG_LINK} target="_blank" rel="noopener" className="text-primary font-medium hover:underline">@restos_support</a> — в ответ получите ключ.
              </div>
            </div>
          </div>

          <div className="space-y-2.5">
            <FieldRow
              label="Код машины"
              value={info?.machineId ?? '…'}
              onCopy={() => info?.machineId && copy(info.machineId, 'machine')}
              copied={copiedField === 'machine'}
              big
            />
            <FieldRow
              label="ID ресторана"
              value={info?.restaurantId ?? '…'}
              onCopy={() => info?.restaurantId && copy(info.restaurantId, 'rid')}
              copied={copiedField === 'rid'}
            />
            {info?.restaurantName && (
              <FieldRow
                label="Название"
                value={info.restaurantName}
                onCopy={() => copy(info.restaurantName!, 'name')}
                copied={copiedField === 'name'}
                plain
              />
            )}
          </div>

          {info && (
            <button
              onClick={() => copy(
                `Код машины: ${info.machineId}\nID ресторана: ${info.restaurantId}${info.restaurantName ? `\nРесторан: ${info.restaurantName}` : ''}`,
                'all',
              )}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
            >
              {copiedField === 'all' ? <Check className="size-4" /> : <Copy className="size-4" />}
              Скопировать всё для админа
            </button>
          )}
        </div>

        {/* Step 2 */}
        <div className="bg-card border border-border rounded-2xl p-5 space-y-4 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="size-7 rounded-full bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center shrink-0">2</div>
            <div className="flex-1">
              <div className="font-semibold text-foreground">Вставьте полученный ключ</div>
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                <Wifi className="size-3" />
                Проверка проходит локально, интернет не нужен
              </div>
            </div>
          </div>

          <textarea
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="eyJ2IjoxLCJyaWQiOi..."
            rows={3}
            className="w-full px-3 py-2.5 rounded-lg border border-border bg-background font-mono text-xs focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
          />

          <button
            onClick={handleActivate}
            disabled={submitting || !token.trim()}
            className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-lg bg-foreground text-background text-sm font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            {submitting ? 'Активирую…' : (<>Активировать <ArrowRight className="size-4" /></>)}
          </button>
        </div>

        <div className="text-center">
          <a href={TG_LINK} target="_blank" rel="noopener" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5">
            <KeyRound className="size-3" />
            Нужна помощь? @restos_support
          </a>
        </div>
      </div>
    </div>
  )
}

function FieldRow({ label, value, onCopy, copied, big, plain }: {
  label: string; value: string; onCopy: () => void; copied: boolean
  big?: boolean; plain?: boolean
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <code className={`flex-1 px-3 py-2 rounded-lg bg-muted ${plain ? '' : 'font-mono'} ${big ? 'text-lg font-bold tracking-wider' : 'text-xs'} text-foreground break-all`}>
          {value}
        </code>
        <button
          onClick={onCopy}
          className="shrink-0 inline-flex items-center justify-center size-9 rounded-lg bg-muted hover:bg-border transition-colors text-muted-foreground hover:text-foreground"
          title="Скопировать"
        >
          {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
        </button>
      </div>
    </div>
  )
}
