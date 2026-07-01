'use client'

import { useState, useEffect } from 'react'
import {
  fetchNetworkMenu, createNetworkMenuItem, updateNetworkMenuItem,
  type NetworkMenuItem,
} from '@/lib/queries/transfers'
import { formatCurrency } from '@/lib/helpers'
import { BookOpen, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { DecimalInput } from '@/components/ui/decimal-input'

const STATIONS = ['hot_kitchen', 'cold_kitchen', 'grill', 'bar', 'showcase']

export default function NetworkMenuPage() {
  const [items, setItems] = useState<NetworkMenuItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [price, setPrice] = useState(0)
  const [station, setStation] = useState('hot_kitchen')
  const [creating, setCreating] = useState(false)

  const reload = async () => {
    try {
      setItems(await fetchNetworkMenu())
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось загрузить')
    }
  }
  useEffect(() => { reload().finally(() => setLoading(false)) }, [])

  const onCreate = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      await createNetworkMenuItem({ name: name.trim(), category: category.trim() || undefined, basePrice: price, station })
      toast.success('Блюдо добавлено в меню сети')
      setName(''); setCategory(''); setPrice(0)
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
      await updateNetworkMenuItem(it.id, { name: it.name, basePrice: value, category: it.category ?? undefined, station: it.station ?? undefined })
      toast.success('Цена обновлена')
      await reload()
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось обновить')
    }
  }

  if (loading) {
    return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
  }
  if (error) {
    return <div className="p-6"><div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700">{error} — вероятно, ресторан не в сети.</div></div>
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-3xl">
      <div className="flex items-center gap-2">
        <BookOpen className="size-5 text-primary" />
        <h1 className="text-xl font-bold text-foreground">Меню сети</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Общее меню сети. Филиалы наследуют эти блюда; цену и доступность каждый филиал задаёт у себя.
      </p>

      {/* Создать */}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border p-3">
        <div className="flex-1 min-w-40 space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Название</label>
          <input value={name} onChange={e => setName(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="напр. Плов" />
        </div>
        <div className="w-32 space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Категория</label>
          <input value={category} onChange={e => setCategory(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="Горячее" />
        </div>
        <div className="w-28 space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Базовая цена</label>
          <DecimalInput value={price} onChange={setPrice} />
        </div>
        <div className="w-32 space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Станция</label>
          <select value={station} onChange={e => setStation(e.target.value)} className="w-full rounded-lg border border-border bg-background px-2 py-2 text-sm">
            {STATIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <button onClick={onCreate} disabled={!name.trim() || creating} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          <Plus className="size-4" /> Добавить
        </button>
      </div>

      {/* Каталог */}
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Блюдо</th>
              <th className="px-3 py-2 text-left font-medium">Категория</th>
              <th className="px-3 py-2 text-left font-medium">Станция</th>
              <th className="px-3 py-2 text-right font-medium">Базовая цена</th>
            </tr>
          </thead>
          <tbody>
            {items.map(it => (
              <tr key={it.id} className="border-t border-border">
                <td className="px-3 py-2">{it.name}</td>
                <td className="px-3 py-2 text-muted-foreground">{it.category || '—'}</td>
                <td className="px-3 py-2 text-muted-foreground">{it.station}</td>
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
