'use client'

import { useEffect, useState } from 'react'
import { setLocalServerUrl } from '@/lib/server-mode'
import { CheckCircle2, AlertTriangle, Download, ArrowRight } from 'lucide-react'

const PRIVATE_LAN_RE = /^https?:\/\/(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|127\.|localhost)[\w.\-]*:\d+$/i

export default function ConnectPage() {
  const [status, setStatus] = useState<'pending' | 'ok' | 'invalid' | 'missing'>('pending')
  const [target, setTarget] = useState<string>('')
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null)
  const [isIOS, setIsIOS] = useState(false)
  const [isStandalone, setIsStandalone] = useState(false)

  useEffect(() => {
    // Detect iOS and standalone mode
    const ua = window.navigator.userAgent.toLowerCase()
    setIsIOS(/iphone|ipad|ipod/.test(ua))
    setIsStandalone(window.matchMedia('(display-mode: standalone)').matches || (window.navigator as any).standalone)

    const handler = (e: any) => {
      e.preventDefault()
      setDeferredPrompt(e)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const local = params.get('local')
    if (!local) { setStatus('missing'); return }
    if (!PRIVATE_LAN_RE.test(local)) { setStatus('invalid'); setTarget(local); return }
    
    setTarget(local)
    // Pass true to avoid infinite reload
    setLocalServerUrl(local, true)
    setStatus('ok')
  }, [])

  const handleInstall = async () => {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') {
      setDeferredPrompt(null)
    }
  }

  const handleContinue = () => {
    window.location.replace('/login')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full rounded-2xl border border-border bg-card p-8 text-center space-y-6 shadow-sm">
        {status === 'pending' && <p className="text-sm text-muted-foreground animate-pulse">Подключаемся…</p>}
        
        {status === 'ok' && (
          <div className="space-y-6 animate-in fade-in zoom-in duration-300">
            <div className="mx-auto w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mb-2">
              <CheckCircle2 className="size-8 text-emerald-500" />
            </div>
            
            <div className="space-y-2">
              <h1 className="text-xl font-bold tracking-tight">Подключение установлено</h1>
              <p className="text-sm text-muted-foreground">
                Устройство успешно привязано к локальному серверу ресторана.
              </p>
            </div>

            <div className="pt-4 space-y-3">
              {deferredPrompt && !isStandalone && (
                <button
                  onClick={handleInstall}
                  className="w-full flex items-center justify-center gap-2 h-12 rounded-xl bg-primary text-primary-foreground font-medium hover:bg-primary/90 active:scale-[0.98] transition-all shadow-sm"
                >
                  <Download className="size-5" />
                  Установить приложение
                </button>
              )}

              {isIOS && !isStandalone && (
                <div className="text-left text-sm text-muted-foreground bg-muted/50 p-4 rounded-xl border border-border/50">
                  <p className="font-medium text-foreground mb-1">Рекомендуем установить приложение:</p>
                  <ol className="list-decimal pl-4 space-y-1">
                    <li>Нажмите иконку <b>Поделиться</b> в меню браузера</li>
                    <li>Выберите <b>«На экран Домой»</b></li>
                  </ol>
                </div>
              )}

              <button
                onClick={handleContinue}
                className="w-full flex items-center justify-center gap-2 h-12 rounded-xl bg-secondary text-secondary-foreground font-medium hover:bg-secondary/80 active:scale-[0.98] transition-all"
              >
                Открыть RestOS
                <ArrowRight className="size-4" />
              </button>
            </div>
          </div>
        )}

        {status === 'invalid' && (
          <div className="space-y-4 animate-in fade-in zoom-in duration-300">
            <div className="mx-auto w-16 h-16 bg-amber-500/10 rounded-full flex items-center justify-center mb-2">
              <AlertTriangle className="size-8 text-amber-500" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">Недопустимый адрес</h1>
            <div className="bg-muted p-3 rounded-lg border border-border/50">
              <p className="text-sm font-mono text-muted-foreground break-all">{target}</p>
            </div>
            <p className="text-sm text-muted-foreground">
              Адрес должен быть локальным (например, 192.168.x.x).
            </p>
          </div>
        )}

        {status === 'missing' && (
          <div className="space-y-4 animate-in fade-in zoom-in duration-300">
            <div className="mx-auto w-16 h-16 bg-amber-500/10 rounded-full flex items-center justify-center mb-2">
              <AlertTriangle className="size-8 text-amber-500" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">Ошибка подключения</h1>
            <p className="text-sm text-muted-foreground">
              Параметр подключения отсутствует. Пожалуйста, отсканируйте QR-код с экрана терминала.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
