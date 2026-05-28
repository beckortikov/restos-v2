import { useEffect } from 'react'

/**
 * Re-runs `loader` whenever an SSE change-event for one of the watched
 * tables arrives. Events are emitted by RealtimeCacheBridge (which forwards
 * the Go backend's SSE notifications as `restos-data-updated` DOM events).
 */
export function useDataSync(tables: string[], loader: () => void | Promise<void>) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    // Debounce 600мс: при пачке событий (кухня помечает 5 блюд готовыми
    // за секунду) делаем один refetchAll вместо N параллельных.
    const handler = (e: Event) => {
      const t = (e as CustomEvent<{ table: string }>).detail?.table
      if (t && tables.includes(t)) {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => { timer = null; loader() }, 600)
      }
    }
    window.addEventListener('restos-data-updated', handler as EventListener)
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('restos-data-updated', handler as EventListener)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.join(','), loader])
}
