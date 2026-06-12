'use client'

import { useEffect, useState } from 'react'

export type WaiterViewMode = 'list' | 'grid'

const KEY = 'restos-waiter-view-mode'
const EVT = 'restos-waiter-view-mode'

export function getWaiterViewMode(): WaiterViewMode {
  if (typeof window === 'undefined') return 'grid'
  try {
    const v = localStorage.getItem(KEY)
    return v === 'list' ? 'list' : 'grid'
  } catch { return 'grid' }
}

export function setWaiterViewMode(mode: WaiterViewMode) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(KEY, mode)
    window.dispatchEvent(new CustomEvent(EVT))
  } catch {}
}

export function useWaiterViewMode(): [WaiterViewMode, (m: WaiterViewMode) => void] {
  const [mode, setModeState] = useState<WaiterViewMode>(() => getWaiterViewMode())

  useEffect(() => {
    const handler = () => setModeState(getWaiterViewMode())
    window.addEventListener(EVT, handler)
    return () => window.removeEventListener(EVT, handler)
  }, [])

  const set = (m: WaiterViewMode) => {
    setWaiterViewMode(m)
    setModeState(m)
  }
  return [mode, set]
}
