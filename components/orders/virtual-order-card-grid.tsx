'use client'

// Виртуализованный card-grid для активных заказов. Используется в
// ActiveOrdersTab когда количество видимых заказов превышает порог
// (см. VIRTUALIZE_THRESHOLD в active-orders-tab.tsx) — на 100+ заказов
// рендер всех карточек в DOM сразу даёт ощутимый лаг при скролле и
// перерисовке. Делаем chunk'и по columnsCount, виртуализируем строки
// через @tanstack/react-virtual.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

/**
 * Динамическое определение колонок по media-query (без useResizeObserver —
 * нам важно лишь чтобы число колонок совпадало с tailwind-breakpoint'ами
 * исходного `grid grid-cols-1 md:2 lg:3 xl:4`).
 */
export function useColumnCount(): number {
  const [n, setN] = useState<number>(() => {
    if (typeof window === 'undefined') return 1
    const w = window.innerWidth
    if (w >= 1280) return 4
    if (w >= 1024) return 3
    if (w >= 768) return 2
    return 1
  })
  useEffect(() => {
    const calc = () => {
      const w = window.innerWidth
      if (w >= 1280) setN(4)
      else if (w >= 1024) setN(3)
      else if (w >= 768) setN(2)
      else setN(1)
    }
    calc()
    window.addEventListener('resize', calc)
    return () => window.removeEventListener('resize', calc)
  }, [])
  return n
}

interface Props<T> {
  items: T[]
  columnsCount: number
  renderItem: (item: T) => ReactNode
  /** Стабильный ключ для строки/элемента (id-based, чтобы virtualizer корректно ре-юзал DOM). */
  getKey: (item: T) => string
  estimateRowHeight?: number
}

export function VirtualOrderCardGrid<T>({
  items,
  columnsCount,
  renderItem,
  getKey,
  estimateRowHeight = 200,
}: Props<T>) {
  const parentRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const out: T[][] = []
    for (let i = 0; i < items.length; i += columnsCount) {
      out.push(items.slice(i, i + columnsCount))
    }
    return out
  }, [items, columnsCount])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 3,
  })

  return (
    <div ref={parentRef} className="overflow-auto" style={{ maxHeight: 'calc(100vh - 240px)' }}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index]
          return (
            <div
              key={vi.key}
              ref={virtualizer.measureElement}
              data-index={vi.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
                display: 'grid',
                gridTemplateColumns: `repeat(${columnsCount}, minmax(0, 1fr))`,
                gap: '0.75rem',
                paddingBottom: '0.75rem',
              }}
            >
              {row.map((item) => (
                <div key={getKey(item)}>{renderItem(item)}</div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
