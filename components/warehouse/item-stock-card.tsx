'use client'

// Карточка складского учёта товара (новый таб «По товарам» истории движений).
// Полная история ОДНОГО товара: сводка куплено/продано/списано/инвентаризация +
// лента всех движений с бегущим остатком, датой, источником и «кто».
//
// «Кто/источник»: у самого stock_movement актора нет — только ref «prefix:id».
// Обогащаем из источников: списание → кто (createdByName) + причина, приход →
// поставщик. Карты обогащения приходят пропсом (страница грузит их один раз).

import { useState, useEffect, useMemo } from 'react'
import type { Ingredient, StockMovement } from '@/lib/types'
import { fetchStockMovements } from '@/lib/queries'
import { formatNum, formatDateTime, formatCurrency } from '@/lib/helpers'
import {
  MOVEMENT_TYPE_META, movementSubtitle, movementRefPrefix, movementRefId, movementKind,
} from '@/lib/warehouse-movements'

export type MovementEnrich = {
  writeoffById: Map<string, { who?: string; reason?: string }>
  receiptById: Map<string, { supplier?: string }>
}

export function ItemStockCard({ ingredient, enrich }: { ingredient: Ingredient; enrich: MovementEnrich }) {
  const [movements, setMovements] = useState<StockMovement[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetchStockMovements({ ingredientId: ingredient.id })
      .then((m) => { if (alive) setMovements(m) })
      .catch(() => { if (alive) setMovements([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [ingredient.id])

  // Новые сверху. Бегущий остаток «после операции» считаем НАЗАД от текущего
  // qty: у самой свежей операции остаток = текущий, у предыдущей = текущий − её
  // изменение, и т.д. (если лента обрезана на 2000, самые старые могут смещаться
  // — редкий край, помечаем «≈» в подписи хвоста мы не делаем: 2000 хватает).
  const rows = useMemo(() => {
    const sorted = [...movements].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
    let running = ingredient.qty
    return sorted.map((m) => {
      const balanceAfter = running
      running = running - m.qty
      return { m, balanceAfter }
    })
  }, [movements, ingredient.qty])

  const kpi = useMemo(() => {
    let bought = 0, sold = 0, off = 0, audit = 0
    for (const m of movements) {
      switch (movementKind(m)) {
        case 'receipt': bought += m.qty; break
        case 'sale': sold += m.qty; break
        case 'writeoff': off += m.qty; break
        case 'audit': audit += m.qty; break
        default: break
      }
    }
    return { bought, sold, off, audit }
  }, [movements])

  const source = (m: StockMovement): { label: string; who?: string } => {
    const prefix = movementRefPrefix(m.description)
    const id = movementRefId(m.description)
    if (prefix === 'writeoff') {
      const w = enrich.writeoffById.get(id)
      return { label: w?.reason ? `Списание · ${w.reason}` : 'Списание', who: w?.who }
    }
    if (prefix === 'receipt') {
      const r = enrich.receiptById.get(id)
      return { label: 'Приход от поставщика', who: r?.supplier }
    }
    return { label: movementSubtitle(m.description) }
  }

  const value = ingredient.qty > 0 ? ingredient.qty * ingredient.pricePerUnit : 0

  return (
    <div className="min-w-0 space-y-3">
      {/* Заголовок товара */}
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-foreground truncate">{ingredient.name}</h2>
          <p className="text-xs text-muted-foreground">
            {ingredient.category} · закупка {formatCurrency(ingredient.pricePerUnit)}/{ingredient.unit}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs text-muted-foreground">Остаток</p>
          <p className="text-2xl font-bold text-foreground">{formatNum(ingredient.qty)} {ingredient.unit}</p>
          <p className="text-[11px] text-muted-foreground">{formatCurrency(value)}</p>
        </div>
      </div>

      {/* Сводка */}
      <div className="grid grid-cols-4 gap-2">
        {([
          ['Куплено', kpi.bought, 'text-emerald-600'],
          ['Продано', kpi.sold, 'text-foreground'],
          ['Списано', kpi.off, 'text-destructive'],
          ['Инвент.', kpi.audit, 'text-amber-600'],
        ] as const).map(([label, val, tone]) => (
          <div key={label} className="bg-muted/40 rounded-lg px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{label}</p>
            <p className={`text-base font-bold tabular-nums ${tone}`}>{val > 0 ? '+' : ''}{formatNum(val)}</p>
          </div>
        ))}
      </div>

      {/* Лента движений товара */}
      {loading ? (
        <div className="py-10 flex items-center justify-center"><div className="size-6 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">По этому товару движений нет</p>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground text-left">
                  <th className="px-3 py-2 font-semibold whitespace-nowrap">Дата</th>
                  <th className="px-3 py-2 font-semibold">Операция</th>
                  <th className="px-3 py-2 font-semibold">Источник · кто</th>
                  <th className="px-3 py-2 font-semibold text-right">Кол-во</th>
                  <th className="px-3 py-2 font-semibold text-right">Остаток</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map(({ m, balanceAfter }) => {
                  const meta = MOVEMENT_TYPE_META[m.type] ?? MOVEMENT_TYPE_META.adj
                  const src = source(m)
                  return (
                    <tr key={m.id} className="hover:bg-muted/20">
                      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{formatDateTime(m.timestamp)}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex text-[11px] px-2 py-0.5 rounded font-medium ${meta.bg} ${meta.color}`}>{meta.label}</span>
                        {m.belowZero && <span className="ml-1 inline-flex text-[11px] px-2 py-0.5 rounded font-medium bg-destructive/10 text-destructive">ниже 0</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        <span className="text-foreground">{src.label}</span>{src.who ? <span> · {src.who}</span> : null}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${m.qty > 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                        {m.qty > 0 ? '+' : ''}{formatNum(m.qty)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium text-foreground">{formatNum(balanceAfter)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
