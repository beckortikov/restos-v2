// Матрица карточек блюд в новом POS: сколько колонок × рядов показывать на экран.
// Хранится на устройстве (localStorage), как флаг pos_ui_v2. Меньше клеток →
// крупнее карточки. Матрица (а не только колонки) нужна, чтобы карточки не были
// «широкими и низкими»: ряды подгоняются под высоту экрана, карточки — квадратнее.
// 'auto' = прежняя адаптивная сетка по ширине (высота карточки по контенту).
import { useEffect, useState, type CSSProperties } from 'react'

const KEY = 'pos-v2-menu-grid'
const EVT = 'pos-v2:menu-grid'

export type MenuGrid = 'auto' | { cols: number; rows: number }

// Пресеты для селектора в настройках.
export const MENU_GRID_OPTIONS: MenuGrid[] = [
  'auto',
  { cols: 4, rows: 4 }, { cols: 4, rows: 5 },
  { cols: 5, rows: 5 }, { cols: 5, rows: 6 },
  { cols: 6, rows: 5 }, { cols: 6, rows: 6 },
]

export function menuGridLabel(g: MenuGrid): string {
  return g === 'auto' ? 'Авто' : `${g.cols}×${g.rows}`
}

function parse(v: string | null): MenuGrid {
  if (!v || v === 'auto') return 'auto'
  const m = /^(\d+)x(\d+)$/.exec(v)
  if (!m) return 'auto'
  const cols = parseInt(m[1], 10), rows = parseInt(m[2], 10)
  if (cols >= 2 && cols <= 12 && rows >= 2 && rows <= 12) return { cols, rows }
  return 'auto'
}

export function getMenuGrid(): MenuGrid {
  try { return parse(localStorage.getItem(KEY)) } catch { return 'auto' }
}

export function setMenuGrid(v: MenuGrid): void {
  try {
    localStorage.setItem(KEY, v === 'auto' ? 'auto' : `${v.cols}x${v.rows}`)
    // Локальное событие — подписчики в этой вкладке обновятся сразу.
    window.dispatchEvent(new Event(EVT))
  } catch {
    /* ignore storage errors (private mode и т.п.) */
  }
}

/** Реактивный доступ: [значение, сеттер]. */
export function useMenuGrid(): [MenuGrid, (v: MenuGrid) => void] {
  const [grid, setGrid] = useState<MenuGrid>(getMenuGrid)
  useEffect(() => {
    const sync = () => setGrid(getMenuGrid())
    window.addEventListener(EVT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(EVT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  const set = (v: MenuGrid) => { setMenuGrid(v); setGrid(v) }
  return [grid, set]
}

// Сравнение пресетов (для подсветки активного в селекторе).
export function sameGrid(a: MenuGrid, b: MenuGrid): boolean {
  if (a === 'auto' || b === 'auto') return a === b
  return a.cols === b.cols && a.rows === b.rows
}

// CSS для контейнера сетки. Матрица {cols, rows} = РОВНАЯ сетка: ровно cols
// колонок (карточки одинаковой ширины), высота ряда подгоняется под видимую
// область (areaH, px), чтобы на экран влезло ровно rows рядов. Лишние блюда —
// под скролл. Текст/цена внутри карточки масштабируются под её размер
// (container-query cqmin в самой карточке — DishTile), поэтому НЕ обрезаются
// даже на мелкой сетке (5×5/6×6). 'auto' = адаптивная сетка по ширине.
export function menuGridStyle(grid: MenuGrid, areaH: number): CSSProperties {
  if (grid === 'auto') {
    return {
      display: 'grid',
      gap: 'clamp(0.4rem,0.7vw,0.7rem)',
      gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(9rem, 13vw, 12rem), 1fr))',
    }
  }
  const gap = 10 // px — фиксированный интервал в матричном режиме
  const pad = 24 // px — верт. паддинги скролл-контейнера (прибл.)
  const rowH = areaH > 0
    ? Math.max(88, Math.floor((areaH - pad - (grid.rows - 1) * gap) / grid.rows))
    : undefined
  return {
    display: 'grid',
    gap: `${gap}px`,
    gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
    gridAutoRows: rowH ? `${rowH}px` : undefined,
  }
}
