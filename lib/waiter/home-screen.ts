'use client'

import { useEffect, useState } from 'react'

// «Начинать с» — куда официант попадает после логина (и какой root таб
// дефолтный). 'tables' = карточки столов, 'menu' = сразу OrderComposer.
export type WaiterHomeScreen = 'tables' | 'menu'

const KEY = 'restos-waiter-home-screen'
const EVT = 'restos-waiter-home-screen'

export function getWaiterHomeScreen(): WaiterHomeScreen {
  if (typeof window === 'undefined') return 'tables'
  try {
    const v = localStorage.getItem(KEY)
    return v === 'menu' ? 'menu' : 'tables'
  } catch { return 'tables' }
}

export function setWaiterHomeScreen(screen: WaiterHomeScreen) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(KEY, screen)
    window.dispatchEvent(new CustomEvent(EVT))
  } catch {}
}

export function getWaiterHomeRoute(): string {
  return getWaiterHomeScreen() === 'menu' ? '/waiter/order/new' : '/waiter/tables'
}

export function useWaiterHomeScreen(): [WaiterHomeScreen, (s: WaiterHomeScreen) => void] {
  const [screen, setScreenState] = useState<WaiterHomeScreen>(() => getWaiterHomeScreen())

  useEffect(() => {
    const handler = () => setScreenState(getWaiterHomeScreen())
    window.addEventListener(EVT, handler)
    return () => window.removeEventListener(EVT, handler)
  }, [])

  const set = (s: WaiterHomeScreen) => {
    setWaiterHomeScreen(s)
    setScreenState(s)
  }
  return [screen, set]
}
