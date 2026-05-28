// POS «часто используемые» — РУЧНОЙ список ids menu_items, который кассир
// курирует через context-menu (как и pos-favorites). Раньше тут был
// авто-трекинг по addToCart-кликам — убран по запросу: предпочтительнее
// предсказуемый shortlist, а не плавающий рейтинг.
//
// Per-device, per-restaurant. Хранится в localStorage без облачного sync'а.
// Структура и API намеренно зеркалят pos-favorites, чтобы не размножать
// поведения — две похожие фичи, два одинаковых интерфейса.

import { useEffect, useState } from 'react'

const KEY_PREFIX = 'restos-pos-frequent:'
const EVENT_NAME = 'restos-pos-frequent-updated'

const keyFor = (restaurantId: string) => `${KEY_PREFIX}${restaurantId}`

function safeRead(restaurantId: string): string[] {
  if (!restaurantId || typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(keyFor(restaurantId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

function safeWrite(restaurantId: string, ids: string[]): void {
  if (!restaurantId || typeof window === 'undefined') return
  try {
    localStorage.setItem(keyFor(restaurantId), JSON.stringify(ids))
  } catch { /* quota / private mode */ }
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { restaurantId } }))
  } catch {}
}

export function getFrequent(restaurantId: string): string[] {
  return safeRead(restaurantId)
}

export function isFrequent(restaurantId: string, itemId: string): boolean {
  return safeRead(restaurantId).includes(itemId)
}

/** Returns true if the item is now in the list, false if it was removed. */
export function toggleFrequent(restaurantId: string, itemId: string): boolean {
  const list = safeRead(restaurantId)
  const idx = list.indexOf(itemId)
  if (idx >= 0) {
    list.splice(idx, 1)
    safeWrite(restaurantId, list)
    return false
  }
  list.push(itemId)
  safeWrite(restaurantId, list)
  return true
}

/** Live list — reacts to local writes (same tab) and storage events (cross-tab). */
export function useFrequent(restaurantId: string): string[] {
  const [ids, setIds] = useState<string[]>(() => safeRead(restaurantId))
  useEffect(() => {
    setIds(safeRead(restaurantId))
    if (typeof window === 'undefined') return
    const onLocal = (e: Event) => {
      const detail = (e as CustomEvent).detail as { restaurantId?: string } | undefined
      if (!detail || detail.restaurantId === restaurantId) {
        setIds(safeRead(restaurantId))
      }
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === keyFor(restaurantId)) setIds(safeRead(restaurantId))
    }
    window.addEventListener(EVENT_NAME, onLocal)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT_NAME, onLocal)
      window.removeEventListener('storage', onStorage)
    }
  }, [restaurantId])
  return ids
}
