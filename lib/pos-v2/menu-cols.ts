// Число карточек блюд в ряд в новом POS. Хранится на устройстве (localStorage),
// чтобы касса подстраивала размер карточек под свой экран: 5 в ряд → крупнее,
// 8 → мельче. 'auto' = адаптивная сетка по ширине (прежнее поведение).
// Паттерн — как у флага pos_ui_v2 (lib/pos-v2/flag.tsx): storage-event + локальное
// событие, чтобы страница заказа и настройки обновлялись синхронно на устройстве.
import { useEffect, useState } from 'react'

const KEY = 'pos-v2-menu-cols'
const EVT = 'pos-v2:menu-cols'

export type MenuCols = 'auto' | number

// Варианты для селектора в настройках. 'auto' — дефолт (адаптив по ширине).
export const MENU_COLS_OPTIONS: MenuCols[] = ['auto', 4, 5, 6, 7, 8]

export function getMenuCols(): MenuCols {
  try {
    const v = localStorage.getItem(KEY)
    if (!v || v === 'auto') return 'auto'
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n >= 2 && n <= 12 ? n : 'auto'
  } catch {
    return 'auto'
  }
}

export function setMenuCols(v: MenuCols): void {
  try {
    localStorage.setItem(KEY, v === 'auto' ? 'auto' : String(v))
    // Локальное событие — подписчики в этой вкладке обновятся сразу
    // (`storage` летит только в другие вкладки).
    window.dispatchEvent(new Event(EVT))
  } catch {
    /* ignore storage errors (private mode и т.п.) */
  }
}

/** CSS grid-template-columns для выбранного режима. */
export function menuColsTemplate(cols: MenuCols): string {
  return cols === 'auto'
    ? 'repeat(auto-fill, minmax(clamp(9rem, 13vw, 12rem), 1fr))'
    : `repeat(${cols}, minmax(0, 1fr))`
}

/** Реактивный доступ: [значение, сеттер]. */
export function useMenuCols(): [MenuCols, (v: MenuCols) => void] {
  const [cols, setCols] = useState<MenuCols>(getMenuCols)
  useEffect(() => {
    const sync = () => setCols(getMenuCols())
    window.addEventListener(EVT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(EVT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  const set = (v: MenuCols) => { setMenuCols(v); setCols(v) }
  return [cols, set]
}
