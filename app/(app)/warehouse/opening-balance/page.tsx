'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { PackagePlus, Search } from 'lucide-react'

import { fetchIngredients, applyOpeningBalance } from '@/lib/queries'
import type { Ingredient } from '@/lib/types'
import { formatCurrency } from '@/lib/helpers'
import { DecimalInput } from '@/components/ui/decimal-input'

export default function OpeningBalancePage() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [qtyMap, setQtyMap] = useState<Map<string, number>>(new Map())
  const [priceMap, setPriceMap] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  // showSpinner=false — тихое обновление БЕЗ скрытия таблицы. Иначе после
  // «Завести» таблица (и инпуты) на миг размонтировалась, и повторный ввод
  // ломался — инпуты становились недоступны.
  const load = (showSpinner = true) => {
    if (showSpinner) setLoading(true)
    fetchIngredients()
      .then(setIngredients)
      .catch(() => toast.error('Ошибка загрузки ингредиентов'))
      .finally(() => { if (showSpinner) setLoading(false) })
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return ingredients.filter(i => i.name.toLowerCase().includes(q))
  }, [ingredients, search])

  // Группировка по цеху/категории ингредиента — «куда относится». У ингредиента
  // нет станции (это поле блюда), поэтому цех = ingredient.category.
  const grouped = useMemo(() => {
    const m = new Map<string, Ingredient[]>()
    for (const ing of filtered) {
      const cat = ing.category?.trim() || 'Без категории'
      const arr = m.get(cat)
      if (arr) arr.push(ing); else m.set(cat, [ing])
    }
    return [...m.entries()].sort((a, b) => {
      if (a[0] === 'Без категории') return 1
      if (b[0] === 'Без категории') return -1
      return a[0].localeCompare(b[0], 'ru')
    })
  }, [filtered])

  const entered = useMemo(() => [...qtyMap.entries()].filter(([, v]) => v > 0), [qtyMap])
  // Себестоимость единицы: введённая (закуп мог быть по другой цене) или текущая
  // цена ингредиента. Именно она идёт в стоимость склада и в Баланс.
  const costOf = (ing?: Ingredient) => (ing && priceMap.get(ing.id)) ?? ing?.pricePerUnit ?? 0
  const totalValue = useMemo(
    () => entered.reduce((s, [id, v]) => s + v * costOf(ingredients.find(i => i.id === id)), 0),
    [entered, ingredients, priceMap],
  )

  const setQty = (id: string, v: number) =>
    setQtyMap(prev => { const n = new Map(prev); n.set(id, v); return n })
  const setPrice = (id: string, v: number) =>
    setPriceMap(prev => { const n = new Map(prev); n.set(id, v); return n })

  const handleApply = async () => {
    if (entered.length === 0) { toast.error('Введите остаток хотя бы по одной позиции'); return }
    if (!window.confirm(`Завести начальный остаток по ${entered.length} позициям на ${formatCurrency(totalValue)}?\nБудет создана автопроводка в капитал «Взнос собственника».`)) return
    setSaving(true)
    try {
      const res = await applyOpeningBalance(entered.map(([ingredientId, qty]) => ({
        ingredientId, qty, price: costOf(ingredients.find(i => i.id === ingredientId)),
      })))
      toast.success(`Начальный остаток заведён: ${res.applied} позиций на ${formatCurrency(res.inventoryValue)}`)
      setQtyMap(new Map())
      setPriceMap(new Map())
      load(false) // тихое обновление, без размонтирования таблицы
    } catch {
      toast.error('Ошибка при заведении начального остатка')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2"><PackagePlus className="size-5 text-primary" /> Начальный остаток</h1>
          <p className="text-sm text-muted-foreground">Заведите стартовые остатки склада. Это НЕ инвентаризация — позиции не пойдут как «излишек».</p>
        </div>
      </div>

      <div className="rounded-lg border border-blue-100 dark:border-blue-900/40 bg-blue-50/50 dark:bg-blue-950/20 p-3 text-sm text-blue-900 dark:text-blue-200">
        Введённая стоимость отразится в Балансе: вырастет актив «Склад» и встречно — капитал «Взнос собственника». Баланс останется сведённым.
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск ингредиента…"
          className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-lg"
        />
      </div>

      {loading ? (
        <div className="flex h-48 items-center justify-center"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground text-xs border-b border-border bg-muted/30">
                  <th className="text-left font-medium px-3 py-2">Ингредиент</th>
                  <th className="text-right font-medium px-3">Текущий</th>
                  <th className="text-right font-medium px-3 w-32">Себестоимость</th>
                  <th className="text-right font-medium px-3 w-40">Начальный остаток</th>
                  <th className="text-right font-medium px-3">Стоимость</th>
                </tr>
              </thead>
              <tbody>
                {grouped.map(([cat, items]) => (
                  <Fragment key={cat}>
                    <tr className="bg-muted/50 border-b border-border">
                      <td colSpan={5} className="px-3 py-1.5 text-xs font-semibold text-foreground/80 uppercase tracking-wide">
                        {cat} <span className="text-muted-foreground font-normal normal-case">· {items.length}</span>
                      </td>
                    </tr>
                    {items.map(ing => {
                      const v = qtyMap.get(ing.id) ?? 0
                      const cost = priceMap.get(ing.id) ?? ing.pricePerUnit
                      return (
                        <tr key={ing.id} className="border-b border-border/50">
                          <td className="px-3 py-2 font-medium">{ing.name}<span className="text-muted-foreground ml-1 text-xs">({ing.unit})</span></td>
                          <td className="px-3 text-right tabular-nums text-muted-foreground">{ing.qty}</td>
                          <td className="px-3 text-right">
                            <DecimalInput value={cost} onChange={(val: number) => setPrice(ing.id, val)} min={0} placeholder="0"
                              className="w-28 px-2 py-1 text-sm text-right bg-background border border-border rounded-lg" />
                          </td>
                          <td className="px-3 text-right">
                            <DecimalInput value={v} onChange={(val: number) => setQty(ing.id, val)} min={0} placeholder="0"
                              className="w-32 px-2 py-1 text-sm text-right bg-background border border-border rounded-lg" />
                          </td>
                          <td className="px-3 text-right tabular-nums">{v > 0 ? formatCurrency(v * cost) : '—'}</td>
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 bg-background/95 backdrop-blur border-t border-border py-3">
        <div className="text-sm">
          Позиций: <b>{entered.length}</b> · Стоимость склада: <b className="tabular-nums">{formatCurrency(totalValue)}</b>
        </div>
        <button
          onClick={handleApply} disabled={saving || entered.length === 0}
          className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? 'Сохранение…' : 'Завести начальный остаток'}
        </button>
      </div>
    </div>
  )
}
