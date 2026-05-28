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
  ASSET_CATEGORY_LABELS,
  type Asset,
  type AssetCategory,
} from '@/lib/types'
import { DecimalInput } from '@/components/ui/decimal-input'

interface AssetForm {
  name: string
  category: AssetCategory
  amount: number
  purchaseDate: string
  usefulLifeMonths: number | null
  note: string
}

interface ManageAssetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  asset?: Asset
  onSubmit: (data: AssetForm) => void
  onDelete?: (id: string) => void
}

const CATEGORIES = Object.entries(ASSET_CATEGORY_LABELS) as [AssetCategory, string][]

export function ManageAssetDialog({ open, onOpenChange, asset, onSubmit, onDelete }: ManageAssetDialogProps) {
  const [form, setForm] = useState<AssetForm>({
    name: '',
    category: 'equipment',
    amount: 0,
    purchaseDate: '',
    usefulLifeMonths: null,
    note: '',
  })

  const isEditing = !!asset

  useEffect(() => {
    if (open) {
      if (asset) {
        setForm({
          name: asset.name,
          category: asset.category,
          amount: asset.amount,
          purchaseDate: asset.purchaseDate ?? '',
          usefulLifeMonths: asset.usefulLifeMonths ?? null,
          note: asset.note ?? '',
        })
      } else {
        setForm({ name: '', category: 'equipment', amount: 0, purchaseDate: '', usefulLifeMonths: null, note: '' })
      }
    }
  }, [open, asset])

  function handleSubmit() {
    onSubmit(form)
    onOpenChange(false)
  }

  function handleDelete() {
    if (asset && onDelete) {
      onDelete(asset.id)
      onOpenChange(false)
    }
  }

  const canSubmit = form.name.trim().length > 0 && form.amount > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Редактировать актив' : 'Новый актив'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Название</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="Холодильник Samsung"
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <label className="text-sm font-medium text-foreground">Дата покупки</label>
              <input
                type="date"
                value={form.purchaseDate}
                onChange={(e) => setForm((p) => ({ ...p, purchaseDate: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Срок полезного использования (мес.)</label>
            <input
              type="number"
              min={0}
              value={form.usefulLifeMonths ?? ''}
              onChange={(e) => setForm((p) => ({ ...p, usefulLifeMonths: e.target.value ? parseInt(e.target.value) : null }))}
              placeholder="Необязательно"
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
            {isEditing ? 'Сохранить' : 'Добавить актив'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
