'use client'

import { useEffect, useState } from 'react'
import { RefreshCw, Download, CheckCircle2, AlertCircle } from 'lucide-react'

type UpdateStatus = {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'not-available' | 'error'
  version: string | null
  percent: number
  error: string | null
}

const STORAGE_KEY = 'restos-update-toast'

export function DesktopUpdateButton() {
  const isDesktop = typeof window !== 'undefined' && !!(window as any).restosDesktop?.isDesktop
  const [state, setState] = useState<UpdateStatus>({ status: 'idle', version: null, percent: 0, error: null })
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!isDesktop) return
    const d = (window as any).restosDesktop
    let cancelled = false
    // 1) Pull текущее состояние при mount.
    if (typeof d?.getUpdateStatus === 'function') {
      d.getUpdateStatus().then((s: UpdateStatus) => { if (!cancelled) setState(s) }).catch(() => {})
    }
    // 2) Подписка на push-уведомления от main process (event 'update-status').
    if (typeof d?.onUpdateStatus === 'function') {
      d.onUpdateStatus((s: UpdateStatus) => { if (!cancelled) setState(s) })
    }
    return () => { cancelled = true }
  }, [isDesktop])

  if (!isDesktop) return null

  async function handleClick() {
    const d = (window as any).restosDesktop
    if (state.status === 'ready') {
      try {
        d?.installUpdate?.()
        setToast('Перезагрузка...')
      } catch (e: any) {
        setToast('Ошибка: ' + e.message)
      }
      return
    }
    if (busy || state.status === 'checking' || state.status === 'downloading') return
    setBusy(true)
    setToast(null)
    try {
      const next = await d?.checkForUpdate?.()
      if (next) setState(next)
    } catch (e: any) {
      setToast('Ошибка: ' + (e?.message || 'unknown'))
    } finally {
      setBusy(false)
      setTimeout(() => setToast(null), 4000)
    }
  }

  // Determine label, icon, color
  let label = 'Проверить обновление'
  let icon = <RefreshCw className="size-4" />
  let cls = 'bg-sidebar-accent/40 hover:bg-sidebar-accent/70 text-sidebar-foreground/80'
  let spinning = false

  if (state.status === 'checking') {
    label = 'Проверка...'
    spinning = true
    cls = 'bg-sidebar-accent/40 text-sidebar-foreground/60 cursor-wait'
  } else if (state.status === 'available' || state.status === 'downloading') {
    label = state.status === 'downloading' && state.percent > 0
      ? `Загрузка ${state.percent}%`
      : `Загрузка v${state.version || ''}`
    icon = <Download className="size-4" />
    cls = 'bg-blue-500/15 text-blue-400 cursor-wait'
  } else if (state.status === 'ready') {
    label = `Установить v${state.version || ''}`
    icon = <CheckCircle2 className="size-4" />
    cls = 'bg-green-500/15 hover:bg-green-500/25 text-green-400 font-semibold ring-1 ring-green-500/30'
  } else if (state.status === 'not-available') {
    label = 'Актуальная версия'
    icon = <CheckCircle2 className="size-4" />
    cls = 'bg-sidebar-accent/30 text-sidebar-foreground/60'
  } else if (state.status === 'error') {
    label = 'Проверить ещё раз'
    icon = <AlertCircle className="size-4" />
    cls = 'bg-orange-500/15 hover:bg-orange-500/25 text-orange-400'
  }

  const disabled = busy || state.status === 'checking' || state.status === 'downloading' || state.status === 'available'

  return (
    <div className="px-3 pb-1">
      <button
        onClick={handleClick}
        disabled={disabled}
        title={state.error || label}
        className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-sm ${cls} disabled:opacity-90`}
      >
        <span className={spinning ? 'animate-spin' : ''}>{icon}</span>
        <span className="truncate">{label}</span>
      </button>
      {toast && (
        <div className="mt-1 text-[11px] text-sidebar-foreground/60 px-1">{toast}</div>
      )}
    </div>
  )
}
