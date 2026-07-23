import { useEffect, useState } from 'react'

// Обновление Electron-приложения кассы. Мост в desktop/preload.js
// (window.restosDesktop): getUpdateStatus / onUpdateStatus / checkForUpdate /
// installUpdate. В браузере (LAN, не Electron) isDesktop=false — UI обновления
// не показываем.

export type DesktopUpdateState = {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'not-available' | 'error'
  version: string | null
  percent: number
}

export function useDesktopUpdate() {
  const isDesktop = typeof window !== 'undefined' && !!(window as any).restosDesktop?.isDesktop
  const [state, setState] = useState<DesktopUpdateState>({ status: 'idle', version: null, percent: 0 })

  useEffect(() => {
    if (!isDesktop) return
    const d = (window as any).restosDesktop
    let cancelled = false
    if (typeof d?.getUpdateStatus === 'function') {
      d.getUpdateStatus().then((s: DesktopUpdateState) => { if (!cancelled) setState(s) }).catch(() => {})
    }
    if (typeof d?.onUpdateStatus === 'function') {
      d.onUpdateStatus((s: DesktopUpdateState) => { if (!cancelled) setState(s) })
    }
    return () => { cancelled = true }
  }, [isDesktop])

  return { isDesktop, ...state }
}

// Действие по кнопке обновления: готово → установить (перезапуск), иначе — проверить.
export async function triggerDesktopUpdate(status: DesktopUpdateState['status']) {
  const d = typeof window !== 'undefined' ? (window as any).restosDesktop : undefined
  if (!d) return
  if (status === 'ready') {
    try { d?.installUpdate?.() } catch {}
    return
  }
  try { await d?.checkForUpdate?.() } catch {}
}

// Русская подпись статуса обновления.
export function desktopUpdateLabel(s: DesktopUpdateState): string {
  return s.status === 'ready' ? 'Перезапустить для установки'
    : s.status === 'downloading' ? `Загрузка ${s.percent}%`
    : s.status === 'available' ? 'Доступно обновление'
    : s.status === 'checking' ? 'Проверка…'
    : s.status === 'not-available' ? 'Установлена последняя версия'
    : 'Проверить обновления'
}

// Обновление скачано/доступно — стоит подсветить (бейдж на лаунчере).
export function desktopUpdatePending(s: DesktopUpdateState): boolean {
  return s.status === 'ready' || s.status === 'available'
}
