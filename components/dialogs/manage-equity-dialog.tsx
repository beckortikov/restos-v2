'use client'

import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  EQUITY_CATEGORY_LABELS,
  type EquityEntry,
  type EquityCategory,
} from '@/lib/types'
import { DecimalInput } from '@/components/ui/decimal-input'

interface EquityForm {
  name: string
  category: EquityCategory
  amount: number
  note: string
}

interface ManageEquityDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  entry?: EquityEntry
  onSubmit: (data: EquityForm) => void
  onDelete?: (id: string) => void
}

const CATEGORIES = Object.entries(EQUITY_CATEGORY_LABELS) as [EquityCategory, string][]

export function ManageEquityDialog({ open, onOpenChange, entry, onSubmit, onDelete }: ManageEquityDialogProps) {
  const [form, setForm] = useState<EquityForm>({
    name: '',
    category: 'capital',
    amount: 0,
    note: '',
  })

  const isEditing = !!entry

  useEffect(() => {
    if (open) {
      if (entry) {
        setForm({
          name: entry.name,
          category: entry.category,
          amount: entry.amount,
          note: entry.note ?? '',
        })
      } else {
        setForm({ name: '', category: 'capital', amount: 0, note: '' })
      }
    }
  }, [open, entry])

  function handleSubmit() {
    onSubmit(form)
    onOpenChange(false)
  }

  function handleDelete() {
    if (entry && onDelete) {
      onDelete(entry.id)
      onOpenChange(false)
    }
  }

  const canSubmit = form.name.trim().length > 0 && form.amount > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Редактировать капитал' : 'Новая запись капитала'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Название</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="Уставной капитал"
              className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Категория</label>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, category: key }))}
                  className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                    form.category === key
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card text-foreground border-border hover:bg-muted'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Сумма (TJS)</label>
            <DecimalInput
              value={form.amount}
              onChange={(v) => setForm((p) => ({ ...p, amount: v }))}
              min={0}
              placeholder="0"
              className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Примечание</label>
            <textarea
              value={form.note}
              onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))}
              placeholder="Комментарий..."
              rows={2}
              className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            />
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          {isEditing && onDelete && (
            <button
              type="button"
              onClick={handleDelete}
              className="px-4 py-2 text-sm font-medium text-destructive bg-destructive/10 border border-destructive/30 rounded-lg hover:bg-destructive/20 transition-colors sm:mr-auto"
            >
              Удалить
            </button>
          )}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted transition-colors"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            {isEditing ? 'Сохранить' : 'Добавить'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
