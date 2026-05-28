// POS favorites — список ids menu_items, отмеченных кассиром как «частые»
// (long-press / right-click на карточке блюда). Per-device, per-restaurant.
// Намеренно вне облачного sync'а и без миграций схемы — это рабочий
// шорт-лист конкретного кассира.

import { useEffect, useState } from 'react'

const KEY_PREFIX = 'restos-pos-favorites:'
const EVENT_NAME = 'restos-pos-favorites-updated'

const keyFor = (restaurantId: string) => `${KEY_PREFIX}${restaurantId}`

function safeRead(restaurantId: string): string[] {
  if (!restaurantId || typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(keyFor(restaurantId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Жёсткий filter под string — чтобы случайный мусор не падал поднимая
    // потребителя.
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

function safeWrite(restaurantId: string, ids: string[]): void {
  if (!restaurantId || typeof window === 'undefined') return
  try {
    localStorage.setItem(keyFor(restaurantId), JSON.stringify(ids))
  } catch { /* quota / private mode — пускай молча */ }
  // Локальный broadcast для useFavorites, который в этом же документе
  // не получит storage-эвент (он только cross-tab).
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { restaurantId } }))
  } catch {}
}

export function getFavorites(restaurantId: string): string[] {
  return safeRead(restaurantId)
}

export function isFavorite(restaurantId: string, itemId: string): boolean {
  return safeRead(restaurantId).includes(itemId)
}

/** Returns true if the item is now favorited, false if it was removed. */
export function toggleFavorite(restaurantId: string, itemId: string): boolean {
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

/** Live list of favorite ids — reacts to local writes and cross-tab storage. */
export function useFavorites(restaurantId: string): string[] {
  const [favs, setFavs] = useState<string[]>(() => safeRead(restaurantId))
  useEffect(() => {
    setFavs(safeRead(restaurantId))
    if (typeof window === 'undefined') return
    const onLocal = (e: Event) => {
      const detail = (e as CustomEvent).detail as { restaurantId?: string } | undefined
      if (!detail || detail.restaurantId === restaurantId) {
        setFavs(safeRead(restaurantId))
      }
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === keyFor(restaurantId)) setFavs(safeRead(restaurantId))
    }
    window.addEventListener(EVENT_NAME, onLocal)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT_NAME, onLocal)
      window.removeEventListener('storage', onStorage)
    }
  }, [restaurantId])
  return favs
}
