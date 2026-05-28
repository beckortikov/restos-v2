'use client'

import { useEffect, useState } from 'react'
import { isLocalMode } from '@/lib/server-mode'
import { checkLocalServer, onLocalServerHealthChange, isLocalServerReachable } from '@/lib/local-server-health'
import { ServerCrash, RefreshCw } from 'lucide-react'

export function LocalServerGuard({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState(false)
  const [reachable, setReachable] = useState(true)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    setActive(isLocalMode())
    setReachable(isLocalServerReachable())
    const unsub = onLocalServerHealthChange(setReachable)
    return unsub
  }, [])

  const retry = async () => {
    setRetrying(true)
    const ok = await checkLocalServer()
    setReachable(ok)
    setRetrying(false)
  }

  if (!active || reachable) return <>{children}</>

  return (
    <div className="fixed inset-0 z-[100] bg-background/95 backdrop-blur flex items-center justify-center p-4">
      <div className="max-w-sm w-full rounded-2xl border-2 border-border bg-card p-6 text-center space-y-4">
        <ServerCrash className="size-12 text-red-500 mx-auto" />
        <h1 className="text-lg font-semibold">Нет связи с сервером ресторана</h1>
        <p className="text-sm text-muted-foreground">
          Подключитесь к Wi-Fi заведения. Работа без локального сервера недоступна.
        </p>
        <button
          onClick={retry}
          disabled={retrying}
          className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-primary text-primary-foreground px-4 py-3 text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          <RefreshCw className={`size-4 ${retrying ? 'animate-spin' : ''}`} />
          Проверить подключение
        </button>
      </div>
    </div>
  )
}
