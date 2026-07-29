'use client'

import { useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { AlertCircle, X } from 'lucide-react'

// BranchDataUnavailableBanner — «эти данные филиала сюда ещё не доехали»
// (ADR-003 Фаза 5). lib/api/v4-typed.ts (branchDataScopeMiddleware) шлёт
// событие на каждый GET-ответ с заголовком X-Branch-Data-Scope: unavailable —
// вместо тихих нулей на графике/таблице владелец видит честную причину.
// Смонтирован рядом с <BranchSelector /> в app/(app)/layout.tsx.
export function BranchDataUnavailableBanner() {
  const [visible, setVisible] = useState(false)
  const location = useLocation()

  useEffect(() => {
    const onUnavailable = () => setVisible(true)
    window.addEventListener('restos:branch-data:unavailable', onUnavailable)
    return () => window.removeEventListener('restos:branch-data:unavailable', onUnavailable)
  }, [])

  // Переход на другую страницу — баннер относится к прошлому запросу, прячем.
  useEffect(() => { setVisible(false) }, [location.pathname])

  if (!visible) return null

  return (
    <div className="shrink-0 flex items-center gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300 text-xs">
      <AlertCircle className="size-3.5 shrink-0" />
      <span className="flex-1">
        Данные этого филиала по этому разделу ещё не синхронизируются — загляните в кассу филиала напрямую.
      </span>
      <button
        type="button"
        onClick={() => setVisible(false)}
        className="shrink-0 opacity-60 hover:opacity-100"
        aria-label="Скрыть"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
