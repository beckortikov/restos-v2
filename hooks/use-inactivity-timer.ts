import { useEffect, useRef, useCallback } from 'react'

/**
 * Fires `onTimeout` after `timeoutMs` milliseconds of user inactivity.
 * Tracks mousedown, touchstart, keydown events on document.
 * Resets the timer on every interaction.
 */
export function useInactivityTimer(
  timeoutMs: number,
  onTimeout: () => void,
  enabled: boolean,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onTimeoutRef = useRef(onTimeout)
  onTimeoutRef.current = onTimeout

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!enabled) return
    timerRef.current = setTimeout(() => {
      onTimeoutRef.current()
    }, timeoutMs)
  }, [timeoutMs, enabled])

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) clearTimeout(timerRef.current)
      return
    }

    const events = ['mousedown', 'touchstart', 'keydown'] as const
    const handler = () => resetTimer()
    for (const e of events) document.addEventListener(e, handler, { passive: true })

    // Start initial timer
    resetTimer()

    return () => {
      for (const e of events) document.removeEventListener(e, handler)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [enabled, resetTimer])

  return { resetTimer }
}
