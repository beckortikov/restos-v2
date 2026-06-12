'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { WifiOff, RefreshCw, Loader2 } from 'lucide-react'
import { WaiterHeader } from './waiter-header'
import { WaiterBottomNav } from './waiter-bottom-nav'
import { isLanReachable, onLanReachableChange, probeLan } from '@/lib/waiter/lan-guard'

export function WaiterShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const [reachable, setReachable] = useState<boolean>(true)
  const [retrying, setRetrying] = useState(false)

  // На экранах "Новый заказ" и "Деталь заказа" прячем глобальный header и
  // нижнюю навигацию — у этих страниц свой back-button и они занимают всю
  // высоту экрана (видна корзина / итоговая сумма).
  const isFlowScreen = /^\/waiter\/order\//.test(pathname)

  useEffect(() => {
    let cancelled = false
    setReachable(isLanReachable())
    probeLan().then(ok => { if (!cancelled) setReachable(ok) }).catch(() => { if (!cancelled) setReachable(false) })
    const off = onLanReachableChange(ok => { if (!cancelled) setReachable(ok) })
    return () => { cancelled = true; off() }
  }, [])

  async function retry() {
    setRetrying(true)
    try {
      const ok = await probeLan()
      setReachable(ok)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div
      className={`flex h-[100dvh] flex-col bg-background ${
        isFlowScreen ? '' : 'pb-[calc(68px+env(safe-area-inset-bottom,0px))]'
      }`}
    >
      {!reachable && <OfflineBanner retrying={retrying} onRetry={retry} />}
      {!isFlowScreen && <WaiterHeader />}

      <main className="flex-1 overflow-y-auto">
        {reachable ? (
          children
        ) : isFlowScreen ? (
          // На flow-экранах (новый заказ / детали) НЕ скрываем контент:
          // официант видит свою корзину и может ждать восстановления связи.
          // Баннер сверху сообщает что отправка пока невозможна.
          children
        ) : (
          <LanGateScreen retrying={retrying} onRetry={retry} />
        )}
      </main>

      {!isFlowScreen && <WaiterBottomNav />}
    </div>
  )
}

function OfflineBanner({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <div className="bg-red-600 text-white px-3 py-2 flex items-center gap-2 text-sm shrink-0">
      <WifiOff className="size-4 shrink-0" />
      <span className="flex-1 font-medium">Нет связи с заведением — подключитесь к Wi-Fi</span>
      <button
        onClick={onRetry}
        disabled={retrying}
        className="flex items-center gap-1 px-2 py-1 rounded-md bg-white/20 hover:bg-white/30 disabled:opacity-60 transition-colors text-xs"
      >
        {retrying ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
        {retrying ? 'Проверка' : 'Проверить'}
      </button>
    </div>
  )
}

function LanGateScreen({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center min-h-[60dvh]">
      <div className="size-20 rounded-full bg-red-50 flex items-center justify-center mb-6">
        <WifiOff className="size-10 text-red-600" />
      </div>
      <h2 className="text-xl font-semibold text-foreground mb-2">Нет связи с сервером заведения</h2>
      <p className="text-sm text-muted-foreground mb-8 max-w-xs">
        Подключитесь к Wi-Fi заведения и дождитесь восстановления соединения. Заказы оформляются только в локальной сети.
      </p>
      <button
        onClick={onRetry}
        disabled={retrying}
        className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground font-medium active:bg-primary/90 transition-colors disabled:opacity-60"
      >
        {retrying ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        {retrying ? 'Проверка...' : 'Повторить'}
      </button>
    </div>
  )
}
