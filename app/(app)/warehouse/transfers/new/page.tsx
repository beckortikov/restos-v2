'use client'

import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { fetchIngredients } from '@/lib/queries/stock'
import { fetchBranches, createTransfer, type Branch } from '@/lib/queries/transfers'
import { type Ingredient } from '@/lib/types'
import { DecimalInput } from '@/components/ui/decimal-input'
import { ArrowLeft, Plus, Trash2, Send } from 'lucide-react'
import { toast } from 'sonner'

interface Row { ingredientId: string; qty: number }

export default function NewTransferPage() {
  const { restaurantId } = useAuth()
  const navigate = useNavigate()
  const [branches, setBranches] = useState<Branch[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [toId, setToId] = useState('')
  const [note, setNote] = useState('')
  const [rows, setRows] = useState<Row[]>([{ ingredientId: '', qty: 0 }])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    Promise.all([fetchBranches(), fetchIngredients()]).then(([b, ing]) => {
      setBranches(b)
      setIngredients(ing)
    })
  }, [])

  // Получатели — все филиалы сети, кроме текущего.
  const receivers = useMemo(() => branches.filter(b => b.id !== restaurantId), [branches, restaurantId])
  // Перемещать можно только ингредиенты, привязанные к сетевой номенклатуре.
  const transferable = useMemo(() => ingredients.filter(i => i.nomenclatureId), [ingredients])

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const addRow = () => setRows(rs => [...rs, { ingredientId: '', qty: 0 }])
  const removeRow = (i: number) => setRows(rs => rs.filter((_, idx) => idx !== i))

  const valid = toId && rows.some(r => r.ingredientId && r.qty > 0)

  const submit = async () => {
    if (!valid) return
    setSaving(true)
    try {
      await createTransfer({
        toRestaurantId: toId,
        note: note || undefined,
        lines: rows.filter(r => r.ingredientId && r.qty > 0).map(r => ({ ingredientId: r.ingredientId, qty: r.qty })),
      })
      toast.success('Перемещение отправлено')
      navigate('/warehouse/transfers')
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось отправить')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-2xl">
      <div className="flex items-center gap-2">
        <button onClick={() => navigate('/warehouse/transfers')} className="rounded-lg p-1.5 hover:bg-muted">
          <ArrowLeft className="size-5" />
        </button>
        <h1 className="text-xl font-bold text-foreground">Новое перемещение</h1>
      </div>

      {receivers.length === 0 && (
        <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
          Нет филиалов-получателей. Ресторан должен быть в сети.
        </div>
      )}
      {transferable.length === 0 && (
        <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
          Нет ингредиентов, привязанных к сетевой номенклатуре. Привяжите их в разделе «Номенклатура сети».
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-muted-foreground">Получатель</label>
        <select
          value={toId}
          onChange={e => setToId(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="">— выберите филиал —</option>
          {receivers.map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-muted-foreground">Позиции</label>
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <select
              value={r.ingredientId}
              onChange={e => setRow(i, { ingredientId: e.target.value })}
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">— ингредиент —</option>
              {transferable.map(ing => (
                <option key={ing.id} value={ing.id}>{ing.name} ({ing.unit})</option>
              ))}
            </select>
            <div className="w-28">
              <DecimalInput value={r.qty} onChange={v => setRow(i, { qty: v })} />
            </div>
            <button onClick={() => removeRow(i)} className="rounded-lg p-2 text-muted-foreground hover:bg-muted" disabled={rows.length === 1}>
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        <button onClick={addRow} className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
          <Plus className="size-4" /> Добавить позицию
        </button>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-muted-foreground">Примечание</label>
        <input
          value={note}
          onChange={e => setNote(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          placeholder="необязательно"
        />
      </div>

      <button
        onClick={submit}
        disabled={!valid || saving}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        <Send className="size-4" /> Отправить
      </button>
    </div>
  )
}
