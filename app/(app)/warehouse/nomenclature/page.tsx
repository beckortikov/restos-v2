'use client'

import { useState, useEffect, useMemo } from 'react'
import { fetchIngredients } from '@/lib/queries/stock'
import { fetchIngredientCategories } from '@/lib/queries'
import {
  fetchNomenclature, createNomenclature, linkIngredientNomenclature,
  type Nomenclature,
} from '@/lib/queries/transfers'
import { UNITS, type Ingredient } from '@/lib/types'
import { Boxes, Plus, Link2, Search, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { NotInNetwork, isNotInNetwork } from '@/components/network-empty'

export default function NomenclaturePage() {
  const [items, setItems] = useState<Nomenclature[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [notInNetwork, setNotInNetwork] = useState(false)
  const [name, setName] = useState('')
  const [unit, setUnit] = useState('')
  const [category, setCategory] = useState('')
  const [creating, setCreating] = useState(false)
  const [linkSearch, setLinkSearch] = useState('')
  const [onlyUnlinked, setOnlyUnlinked] = useState(true)

  const reload = async () => {
    try {
      const [n, ing, cats] = await Promise.all([fetchNomenclature(), fetchIngredients(), fetchIngredientCategories()])
      setItems(n)
      setIngredients(ing)
      setCategories(cats)
      setNotInNetwork(false)
    } catch (e) {
      if (isNotInNetwork(e)) setNotInNetwork(true)
      else throw e
    }
  }
  useEffect(() => {
    reload().catch(() => {}).finally(() => setLoading(false))
  }, [])

  // Не блокирует создание — просто предупреждает, что похожая запись уже есть
  // (дубли по имени не запрещены на бэке, это чисто UX-подсказка).
  const isDuplicateName = useMemo(() => {
    const n = name.trim().toLowerCase()
    if (!n) return false
    return items.some(i => i.name.trim().toLowerCase() === n)
  }, [name, items])

  const onCreate = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      await createNomenclature({ name: name.trim(), unit: unit || undefined, category: category || undefined })
      toast.success('Продукт добавлен в каталог сети')
      setName(''); setUnit(''); setCategory('')
      await reload()
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось создать')
    } finally {
      setCreating(false)
    }
  }

  const onLink = async (ingredientId: string, nomenclatureId: string) => {
    try {
      await linkIngredientNomenclature(ingredientId, nomenclatureId)
      toast.success('Ингредиент привязан')
      await reload()
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось привязать')
    }
  }

  const filteredIngredients = ingredients.filter(ing => {
    if (onlyUnlinked && ing.nomenclatureId) return false
    if (linkSearch && !ing.name.toLowerCase().includes(linkSearch.toLowerCase())) return false
    return true
  })

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  if (notInNetwork) {
    return (
      <div className="p-4 md:p-6 space-y-5 max-w-3xl">
        <div className="flex items-center gap-2">
          <Boxes className="size-5 text-primary" />
          <h1 className="text-xl font-bold text-foreground">Номенклатура сети</h1>
        </div>
        <NotInNetwork what="номенклатуру сети" />
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-3xl">
      <div className="flex items-center gap-2">
        <Boxes className="size-5 text-primary" />
        <h1 className="text-xl font-bold text-foreground">Номенклатура сети</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Общий каталог продуктов сети. Привяжите к нему ингредиенты филиалов — тогда их можно перемещать между точками.
      </p>

      {/* Создать продукт */}
      <div className="space-y-2 rounded-xl border border-border p-3">
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Название</label>
            <input value={name} onChange={e => setName(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="напр. Мясо говяжье" />
          </div>
          <div className="w-40 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Категория</label>
            <select value={category} onChange={e => setCategory(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
              <option value="">Без категории</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="w-28 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Ед.</label>
            <select value={unit} onChange={e => setUnit(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
              <option value="">Выберите ед.</option>
              {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <button onClick={onCreate} disabled={!name.trim() || creating} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            <Plus className="size-4" /> Добавить
          </button>
        </div>
        {isDuplicateName && (
          <p className="flex items-center gap-1.5 text-xs text-amber-600">
            <AlertTriangle className="size-3.5 shrink-0" /> В каталоге уже есть запись с похожим названием — проверьте, не дубль ли это.
          </p>
        )}
      </div>

      {/* Каталог */}
      <div>
        <h2 className="mb-2 text-sm font-semibold text-foreground">Каталог ({items.length})</h2>
        {items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Каталог пуст</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {items.map(n => (
              <span key={n.id} className="rounded-full bg-muted px-3 py-1 text-sm">{n.name}{n.unit ? ` · ${n.unit}` : ''}</span>
            ))}
          </div>
        )}
      </div>

      {/* Привязка ингредиентов */}
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Link2 className="size-4" /> Привязка ингредиентов
          </h2>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={onlyUnlinked} onChange={e => setOnlyUnlinked(e.target.checked)} className="rounded border-border" />
            Только непривязанные
          </label>
        </div>
        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={linkSearch}
            onChange={e => setLinkSearch(e.target.value)}
            placeholder="Поиск по названию ингредиента…"
            className="w-full rounded-lg border border-border bg-background py-1.5 pl-8 pr-3 text-sm"
          />
        </div>
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Ингредиент</th>
                <th className="px-3 py-2 text-left font-medium">Номенклатура сети</th>
              </tr>
            </thead>
            <tbody>
              {filteredIngredients.length === 0 && (
                <tr><td colSpan={2} className="px-3 py-6 text-center text-muted-foreground">
                  {onlyUnlinked ? 'Все ингредиенты уже привязаны' : 'Ничего не найдено'}
                </td></tr>
              )}
              {filteredIngredients.map(ing => (
                <tr key={ing.id} className="border-t border-border">
                  <td className="px-3 py-2">{ing.name} <span className="text-muted-foreground">({ing.unit})</span></td>
                  <td className="px-3 py-2">
                    <select
                      value={ing.nomenclatureId ?? ''}
                      onChange={e => e.target.value && onLink(ing.id, e.target.value)}
                      className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
                    >
                      <option value="">— не привязан —</option>
                      {items.map(n => (
                        <option key={n.id} value={n.id}>{n.name}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
