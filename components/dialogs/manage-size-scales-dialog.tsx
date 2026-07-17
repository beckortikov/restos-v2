'use client'

import { useState, useEffect } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { type SizeScale } from '@/lib/types'
import { fetchSizeScales, createSizeScale, updateSizeScale, deleteSizeScale } from '@/lib/queries'
import { Plus, X, Trash2, Pencil } from 'lucide-react'
import { toast } from 'sonner'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface ValueRow {
  id?: string
  code: string
  title: string
  isDefault: boolean
}

const emptyRow = (): ValueRow => ({ code: '', title: '', isDefault: false })

// ManageSizeScalesDialog — справочник переиспользуемых шкал размеров
// («Пиццы 25/30/35»): продукт (attributes-editor) и заготовка (полуфабрикат)
// ссылаются на одну и ту же шкалу вместо того, чтобы заводить значения
// размера с нуля на каждой карточке — так «30» у пиццы и у теста гарантированно
// один и тот же размер (см. pizza-sizes-spec.md §3.2).
export function ManageSizeScalesDialog({ open, onOpenChange }: Props) {
  const [scales, setScales] = useState<SizeScale[]>([])
  const [loading, setLoading] = useState(true)

  const [showNewScale, setShowNewScale] = useState(false)
  const [newScaleName, setNewScaleName] = useState('')
  const [newScaleValues, setNewScaleValues] = useState<ValueRow[]>([emptyRow(), emptyRow()])

  const [editingScaleId, setEditingScaleId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editValues, setEditValues] = useState<ValueRow[]>([])

  const reload = async () => {
    const data = await fetchSizeScales()
    setScales(data)
  }

  useEffect(() => {
    if (open) {
      setLoading(true)
      reload().finally(() => setLoading(false))
    }
  }, [open])

  const handleCreateScale = async () => {
    const name = newScaleName.trim()
    const values = newScaleValues.filter(v => v.code.trim())
    if (!name || values.length === 0) return
    try {
      await createSizeScale(name, values.map((v, i) => ({
        code: v.code.trim(), title: v.title.trim() || undefined, sortOrder: i, isDefault: v.isDefault,
      })))
      setShowNewScale(false)
      setNewScaleName('')
      setNewScaleValues([emptyRow(), emptyRow()])
      await reload()
      toast.success('Шкала создана')
    } catch {
      toast.error('Ошибка')
    }
  }

  const handleDeleteScale = async (id: string) => {
    if (!confirm('Удалить шкалу размеров? Привязанные товары и заготовки останутся, но потеряют привязку.')) return
    try {
      await deleteSizeScale(id)
      await reload()
    } catch {
      toast.error('Ошибка удаления')
    }
  }

  const startEdit = (scale: SizeScale) => {
    setEditingScaleId(scale.id)
    setEditName(scale.name)
    setEditValues(scale.values.map(v => ({ id: v.id, code: v.code, title: v.title ?? '', isDefault: v.isDefault })))
  }

  const handleSaveEdit = async () => {
    if (!editingScaleId) return
    const name = editName.trim()
    const values = editValues.filter(v => v.code.trim())
    if (!name || values.length === 0) return
    try {
      await updateSizeScale(editingScaleId, {
        name,
        values: values.map((v, i) => ({
          id: v.id, code: v.code.trim(), title: v.title.trim() || undefined, sortOrder: i, isDefault: v.isDefault,
        })),
      })
      setEditingScaleId(null)
      await reload()
      toast.success('Шкала обновлена')
    } catch {
      toast.error('Ошибка')
    }
  }

  const renderValueRows = (rows: ValueRow[], setRows: (r: ValueRow[]) => void) => (
    <div className="space-y-1.5">
      {rows.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={v.code}
            onChange={e => setRows(rows.map((r, ri) => ri === i ? { ...r, code: e.target.value } : r))}
            placeholder="25"
            className="w-16 px-2 py-1.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <input
            value={v.title}
            onChange={e => setRows(rows.map((r, ri) => ri === i ? { ...r, title: e.target.value } : r))}
            placeholder="Название (опц.)"
            className="flex-1 px-2 py-1.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <label className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
            <input
              type="radio"
              checked={v.isDefault}
              onChange={() => setRows(rows.map((r, ri) => ({ ...r, isDefault: ri === i })))}
              className="rounded"
            />
            по умолч.
          </label>
          <button onClick={() => setRows(rows.filter((_, ri) => ri !== i))} className="p-0.5 text-muted-foreground hover:text-destructive">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        onClick={() => setRows([...rows, emptyRow()])}
        className="text-xs text-primary hover:underline flex items-center gap-1"
      >
        <Plus className="size-3" />Добавить значение
      </button>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle>Шкалы размеров</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><div className="size-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Общий список размеров (например «25/30/35 см»), на который может ссылаться несколько
              товаров и заготовок — чтобы «30» у пиццы и у теста гарантированно означало одно и то же.
            </p>

            {scales.length === 0 && !showNewScale && (
              <p className="text-sm text-muted-foreground text-center py-4">Нет шкал размеров</p>
            )}

            {scales.map(scale => (
              <div key={scale.id} className="bg-muted/30 rounded-xl p-4 space-y-3">
                {editingScaleId === scale.id ? (
                  <div className="space-y-3">
                    <input
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    {renderValueRows(editValues, setEditValues)}
                    <div className="flex gap-2">
                      <button onClick={handleSaveEdit} disabled={!editName.trim() || editValues.filter(v => v.code.trim()).length === 0}
                        className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50">Сохранить</button>
                      <button onClick={() => setEditingScaleId(null)} className="text-sm text-muted-foreground">Отмена</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-foreground text-sm">{scale.name}</span>
                      <div className="flex items-center gap-1">
                        <button onClick={() => startEdit(scale)} className="p-1 text-muted-foreground hover:text-primary">
                          <Pencil className="size-3.5" />
                        </button>
                        <button onClick={() => handleDeleteScale(scale.id)} className="p-1 text-muted-foreground hover:text-destructive">
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {scale.values.map(v => (
                        <span key={v.id} className="px-2 py-1 bg-background rounded-lg text-xs text-foreground">
                          {v.title || v.code}
                          {v.isDefault && <span className="text-primary ml-1">•</span>}
                        </span>
                      ))}
                      {scale.values.length === 0 && (
                        <span className="text-xs text-muted-foreground">Нет значений</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}

            {showNewScale ? (
              <div className="bg-primary/5 rounded-xl p-4 space-y-3 border border-primary/20">
                <p className="text-sm font-medium text-foreground">Новая шкала</p>
                <input value={newScaleName} onChange={e => setNewScaleName(e.target.value)} placeholder="Например: Пиццы 25/30/35"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                {renderValueRows(newScaleValues, setNewScaleValues)}
                <div className="flex gap-2">
                  <button onClick={handleCreateScale} disabled={!newScaleName.trim() || newScaleValues.filter(v => v.code.trim()).length === 0}
                    className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50">Создать</button>
                  <button onClick={() => setShowNewScale(false)} className="text-sm text-muted-foreground">Отмена</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowNewScale(true)}
                className="w-full py-2.5 border-2 border-dashed border-border rounded-xl text-sm text-muted-foreground hover:border-primary/30 hover:text-primary transition-colors flex items-center justify-center gap-1.5"
              >
                <Plus className="size-4" />Добавить шкалу размеров
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
