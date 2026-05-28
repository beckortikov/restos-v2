'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/lib/auth-store'
import { Download, X, Share } from 'lucide-react'

const DISMISSED_KEY = 'restos-install-dismissed-v1'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function InstallPwaPrompt() {
  const { user } = useAuth()
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIosHint, setShowIosHint] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (localStorage.getItem(DISMISSED_KEY) === '1') { setDismissed(true); return }

    const isMobile = window.matchMedia('(max-width: 768px)').matches
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as { standalone?: boolean }).standalone === true
    if (!isMobile || isStandalone) return

    const handler = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handler)

    const ua = window.navigator.userAgent
    const isIos = /iPhone|iPad|iPod/i.test(ua) && !/CriOS|FxiOS/.test(ua)
    if (isIos) setShowIosHint(true)

    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  if (dismissed) return null
  if (user?.role !== 'waiter') return null
  if (!deferred && !showIosHint) return null

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, '1')
    setDismissed(true)
  }

  const install = async () => {
    if (!deferred) return
    await deferred.prompt()
    const { outcome } = await deferred.userChoice
    if (outcome === 'accepted' || outcome === 'dismissed') dismiss()
    setDeferred(null)
  }

  return (
    <div className="fixed inset-x-3 bottom-3 z-50 md:hidden">
      <div className="rounded-2xl border-2 border-primary/20 bg-background shadow-lg p-3 flex items-center gap-3">
        <div className="size-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          {deferred ? <Download className="size-4 text-primary" /> : <Share className="size-4 text-primary" />}
        </div>
        <div className="flex-1 min-w-0 text-sm">
          <p className="font-semibold leading-tight">Установить RestOS</p>
          <p className="text-xs text-muted-foreground leading-tight">
            {deferred ? 'Добавить на главный экран для быстрого доступа.' : 'Поделиться → На экран «Домой».'}
          </p>
        </div>
        {deferred && (
          <button
            onClick={install}
            className="px-3 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold whitespace-nowrap"
          >
            Установить
          </button>
        )}
        <button onClick={dismiss} className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted">
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
