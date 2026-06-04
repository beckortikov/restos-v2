'use client'

/**
 * LicenseWarningBanner — sticky top-баннер с уведомлением о скором истечении
 * лицензии. Появляется когда state === 'grace' (между expires_at и +grace_days),
 * а также softLocked (но в softLocked LicenseGate обычно уже блокирует — баннер
 * для краткого момента пока статус ещё в кэше).
 *
 * Поведение:
 *  - Поллинг статуса каждые 5 минут (на случай если licence_watcher или
 *    activate сменили state без полной перезагрузки UI).
 *  - Localstorage `restos.license-banner-dismissed-until` — кассир скрыл,
 *    возвращается через 1 час.
 *  - Клик → `/settings/license` для активации.
 *
 * v2.1.4.
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldAlert, X } from 'lucide-react'
import { fetchLicenseStatus, type LicenseStatus } from '@/lib/queries'

const POLL_MS = 5 * 60 * 1000 // 5 минут
const DISMISS_MS = 60 * 60 * 1000 // 1 час
const DISMISS_KEY = 'restos.license-banner-dismissed-until'

export function LicenseWarningBanner() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<LicenseStatus | null>(null)
  const [dismissedUntil, setDismissedUntil] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(DISMISS_KEY)
      return raw ? Number(raw) : 0
    } catch { return 0 }
  })

  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetchLicenseStatus()
        .then(s => { if (!cancelled) setStatus(s) })
        .catch(() => { /* ignore — banner просто не покажется */ })
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (!status) return null
  if (status.state !== 'grace' && status.state !== 'softLocked') return null
  if (Date.now() < dismissedUntil) return null

  const handleDismiss = () => {
    const until = Date.now() + DISMISS_MS
    try { localStorage.setItem(DISMISS_KEY, String(until)) } catch { /* noop */ }
    setDismissedUntil(until)
  }

  const handleRenew = () => {
    navigate('/settings/license')
  }

  // Сколько дней осталось до lock'а — даём конкретику.
  const daysUntilLock = status.daysUntilLock ?? 0
  const daysLeftToExpiry = status.daysLeft ?? 0

  let msg: string
  if (status.state === 'grace' && daysLeftToExpiry > 0) {
    msg = `Лицензия истекает через ${daysLeftToExpiry} дн. — продлите чтобы избежать блокировки.`
  } else if (daysLeftToExpiry <= 0 && daysUntilLock > 0) {
    msg = `Лицензия истекла. Софт заблокируется через ${daysUntilLock} дн. — продлите срочно.`
  } else {
    msg = 'Лицензия скоро будет заблокирована — продлите.'
  }

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-200"
    >
      <div className="max-w-screen-2xl mx-auto px-3 py-2 flex items-center gap-3">
        <ShieldAlert className="size-4 shrink-0" />
        <p className="text-xs font-medium flex-1 min-w-0">{msg}</p>
        <button
          onClick={handleRenew}
          className="text-xs font-semibold px-3 py-1 rounded-md bg-amber-600 text-white hover:bg-amber-700 transition-colors shrink-0"
        >
          Продлить
        </button>
        <button
          onClick={handleDismiss}
          aria-label="Скрыть до перезапуска"
          title="Скрыть на 1 час"
          className="p-1 rounded hover:bg-amber-100 dark:hover:bg-amber-900/60 transition-colors shrink-0"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
