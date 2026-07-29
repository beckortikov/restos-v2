'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  fetchNetworkMenu, createNetworkMenuItem, updateNetworkMenuItem,
  type NetworkMenuItem,
} from '@/lib/queries/transfers'
import { fetchMenuCategories } from '@/lib/queries/menu'
import { UNITS, ALL_STATIONS, STATION_LABELS, STATION_ICONS, type MenuStation } from '@/lib/types'
import { BookOpen, Plus, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { DecimalInput } from '@/components/ui/decimal-input'
import { NotInNetwork, isNotInNetwork } from '@/components/network-empty'

const NEW_CATEGORY = '__new__'

export default function NetworkMenuPage() {
  const [items, setItems] = useState<NetworkMenuItem[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notInNetwork, setNotInNetwork] = useState(false)
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [newCategoryName, setNewCategoryName] = useState('')
  const [price, setPrice] = useState(0)
  const [station, setStation] = useState<MenuStation>('hot_kitchen')
  const [unit, setUnit] = useState('piece')
  const [emoji, setEmoji] = useState('')
  const [creating, setCreating] = useState(false)

  const reload = async () => {
    try {
      const [menu, cats] = await Promise.all([fetchNetworkMenu(), fetchMenuCategories()])
      setItems(menu)
      setCategories(cats)
      setError(null)
      setNotInNetwork(false)
    } catch (e: any) {
      if (isNotInNetwork(e)) { setNotInNetwork(true); setError(null) }
      else setError(e?.message ?? 'Не удалось загрузить')
    }
  }
  useEffect(() => { reload().finally(() => setLoading(false)) }, [])

  const isDuplicateName = useMemo(() => {
    const n = name.trim().toLowerCase()
    if (!n) return false
    return items.some(i => i.name.trim().toLowerCase() === n)
  }, [name, items])

  const onCreate = async () => {
    if (!name.trim()) return
    const resolvedCategory = category === NEW_CATEGORY ? newCategoryName.trim() : category
    setCreating(true)
    try {
      await createNetworkMenuItem({
        name: name.trim(), category: resolvedCategory || undefined, basePrice: price,
        station, unit, emoji: emoji || undefined,
      })
      toast.success('Блюдо добавлено в меню сети')
      setName(''); setCategory(''); setNewCategoryName(''); setPrice(0); setEmoji('')
      await reload()
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось создать')
    } finally {
      setCreating(false)
    }
  }

  const onPrice = async (it: NetworkMenuItem, value: number) => {
    if (value === it.basePrice) return
    try {
      // ВАЖНО: PATCH на бэке перезаписывает category/station/unit/emoji тем, что
      // пришло (даже пустой строкой → NULL) — передаём все текущие поля, иначе
      // правка одной только цены стирает остальное.
      await updateNetworkMenuItem(it.id, {
        name: it.name, basePrice: value, category: it.category ?? undefined,
        station: it.station ?? undefined, unit: it.unit ?? undefined, emoji: it.emoji ?? undefined,
      })
      toast.success('Цена обновлена')
      await reload()
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось обновить')
    }
  }

  if (loading) {
    return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
  }
  if (notInNetwork) {
    return (
      <div className="p-4 md:p-6 space-y-5 max-w-3xl">
        <div className="flex items-center gap-2">
          <BookOpen className="size-5 text-primary" />
          <h1 className="text-xl font-bold text-foreground">Меню сети</h1>
        </div>
        <NotInNetwork what="меню сети" />
      </div>
    )
  }
  if (error) {
    return <div className="p-6"><div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700">{error}</div></div>
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-3xl">
      <div className="flex items-center gap-2">
        <BookOpen className="size-5 text-primary" />
        <h1 className="text-xl font-bold text-foreground">Меню сети</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Общее меню сети. Название/категория/станция/ед. изм. наследуются филиалами автоматически.
        Базовая цена и доступность — только СТАРТОВОЕ значение для филиала, который ещё не получал это блюдо;
        для уже подключённых филиалов правьте цену у них на месте — сюда их правки не долетают.
      </p>

      {/* Создать */}
      <div className="space-y-2 rounded-xl border border-border p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-40 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Название</label>
            <input value={name} onChange={e => setName(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="напр. Плов" />
          </div>
          <div className="w-36 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Категория</label>
            <select value={category} onChange={e => setCategory(e.target.value)} className="w-full rounded-lg border border-border bg-background px-2 py-2 text-sm">
              <option value="">Без категории</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
              <option value={NEW_CATEGORY}>+ Новая категория…</option>
            </select>
          </div>
          <div className="w-28 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Базовая цена</label>
            <DecimalInput value={price} onChange={setPrice} />
          </div>
          <div className="w-36 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Станция</label>
            <select value={station} onChange={e => setStation(e.target.value as MenuStation)} className="w-full rounded-lg border border-border bg-background px-2 py-2 text-sm">
              {ALL_STATIONS.map(s => <option key={s} value={s}>{STATION_ICONS[s]} {STATION_LABELS[s]}</option>)}
            </select>
          </div>
          <div className="w-24 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Ед. изм.</label>
            <select value={unit} onChange={e => setUnit(e.target.value)} className="w-full rounded-lg border border-border bg-background px-2 py-2 text-sm">
              <option value="piece">шт.</option>
              {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div className="w-16 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Эмодзи</label>
            <input value={emoji} onChange={e => setEmoji(e.target.value)} maxLength={4} className="w-full rounded-lg border border-border bg-background px-2 py-2 text-center text-sm" placeholder="🍽️" />
          </div>
          <button onClick={onCreate} disabled={!name.trim() || creating} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            <Plus className="size-4" /> Добавить
          </button>
        </div>
        {category === NEW_CATEGORY && (
          <input
            value={newCategoryName}
            onChange={e => setNewCategoryName(e.target.value)}
            placeholder="Название новой категории"
            className="w-full max-w-xs rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        )}
        {isDuplicateName && (
          <p className="flex items-center gap-1.5 text-xs text-amber-600">
            <AlertTriangle className="size-3.5 shrink-0" /> В меню сети уже есть блюдо с похожим названием — проверьте, не дубль ли это.
          </p>
        )}
      </div>

      {/* Каталог */}
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Блюдо</th>
              <th className="px-3 py-2 text-left font-medium">Категория</th>
              <th className="px-3 py-2 text-left font-medium">Станция</th>
              <th className="px-3 py-2 text-right font-medium">Стартовая цена</th>
            </tr>
          </thead>
          <tbody>
            {items.map(it => (
              <tr key={it.id} className="border-t border-border">
                <td className="px-3 py-2">{it.emoji ? `${it.emoji} ` : ''}{it.name}</td>
                <td className="px-3 py-2 text-muted-foreground">{it.category || '—'}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {it.station && it.station in STATION_LABELS
                    ? `${STATION_ICONS[it.station as MenuStation]} ${STATION_LABELS[it.station as MenuStation]}`
                    : (it.station || '—')}
                </td>
                <td className="px-3 py-2">
                  <div className="w-28 ml-auto">
                    <DecimalInput value={it.basePrice} onChange={v => onPrice(it, v)} />
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">Меню сети пусто</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
