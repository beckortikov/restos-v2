'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { onDataChange } from '@/lib/realtime'

/**
 * useLiveData — fetch + auto-refetch on SSE table changes.
 *
 * @param fetchFn — async function that returns the data
 * @param watchTables — array of table names to listen for (e.g. ['orders', 'order_items'])
 *                      Empty array = no SSE listening (just initial fetch).
 *
 * Usage:
 *   const { data, loading, refetch } = useLiveData(
 *     () => fetchOrders({ slim: true }),
 *     ['orders', 'order_items']
 *   )
 *
 * Notes:
 *   - fetchFn должна быть stable (useCallback в caller или wrapped в useRef).
 *   - При SSE event refetch триггерится с debounce 300мс (на случай burst'а events
 *     в одной транзакции — несколько таблиц меняются вместе, делаем 1 запрос).
 */
export function useLiveData<T>(
  fetchFn: () => Promise<T>,
  watchTables: string[] = [],
): { data: T | null; loading: boolean; error: Error | null; refetch: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const fetchRef = useRef(fetchFn)
  fetchRef.current = fetchFn

  const refetch = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchRef.current()
      .then((result) => { setData(result); setLoading(false) })
      .catch((e) => { setError(e); setLoading(false) })
  }, [])

  useEffect(() => {
    refetch()
  }, [refetch])

  useEffect(() => {
    if (watchTables.length === 0) return
    const watchSet = new Set(watchTables)
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = onDataChange((table) => {
      if (!watchSet.has(table)) return
      // Debounce: подождать 300мс в случае burst'а events.
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        refetch()
      }, 300)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchTables.join('|'), refetch])

  return { data, loading, error, refetch }
}
