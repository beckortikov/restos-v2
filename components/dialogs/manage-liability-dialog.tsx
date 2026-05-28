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
  LIABILITY_CATEGORY_LABELS,
  type Liability,
  type LiabilityCategory,
} from '@/lib/types'
import { formatCurrency } from '@/lib/helpers'
import { DecimalInput } from '@/components/ui/decimal-input'

interface LiabilityForm {
  name: string
  category: LiabilityCategory
  totalAmount: number
  paidAmount: number
  creditor: string
  dueDate: string
  monthlyPayment: number
  interestRate: number
  note: string
}

interface ManageLiabilityDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  liability?: Liability
  onSubmit: (data: LiabilityForm) => void
  onDelete?: (id: string) => void
}

const CATEGORIES = Object.entries(LIABILITY_CATEGORY_LABELS) as [LiabilityCategory, string][]

export function ManageLiabilityDialog({ open, onOpenChange, liability, onSubmit, onDelete }: ManageLiabilityDialogProps) {
  const [form, setForm] = useState<LiabilityForm>({
    name: '',
    category: 'credit',
    totalAmount: 0,
    paidAmount: 0,
    creditor: '',
    dueDate: '',
    monthlyPayment: 0,
    interestRate: 0,
    note: '',
  })

  const isEditing = !!liability

  useEffect(() => {
    if (open) {
      if (liability) {
        setForm({
          name: liability.name,
          category: liability.category,
          totalAmount: liability.totalAmount,
          paidAmount: liability.paidAmount,
          creditor: liability.creditor ?? '',
          dueDate: liability.dueDate ?? '',
          monthlyPayment: liability.monthlyPayment ?? 0,
          interestRate: liability.interestRate ?? 0,
          note: liability.note ?? '',
        })
      } else {
        setForm({ name: '', category: 'credit', totalAmount: 0, paidAmount: 0, creditor: '', dueDate: '', monthlyPayment: 0, interestRate: 0, note: '' })
      }
    }
  }, [open, liability])

  function handleSubmit() {
    onSubmit(form)
    onOpenChange(false)
  }

  function handleDelete() {
    if (liability && onDelete) {
      onDelete(liability.id)
      onOpenChange(false)
    }
  }

  const remaining = form.totalAmount - form.paidAmount
  const canSubmit = form.name.trim().length > 0 && form.totalAmount > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Редактировать обязательство' : 'Новое обязательство'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Название</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="Кредит в банке"
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
              <label className="text-sm font-medium text-foreground">Общая сумма (TJS)</label>
              <DecimalInput
                value={form.totalAmount}
                onChange={(v) => setForm((p) => ({ ...p, totalAmount: v }))}
                min={0}
                placeholder="0"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Оплачено (TJS)</label>
              <DecimalInput
                value={form.paidAmount}
                onChange={(v) => setForm((p) => ({ ...p, paidAmount: v }))}
                min={0}
                placeholder="0"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          {/* Calculated remaining */}
          <div className="px-3 py-2 bg-muted/50 rounded-lg flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Остаток к оплате</span>
            <span className={`text-sm font-bold ${remaining > 0 ? 'text-destructive' : 'text-emerald-600'}`}>
              {formatCurrency(remaining)}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Кредитор</label>
              <input
                type="text"
                value={form.creditor}
                onChange={(e) => setForm((p) => ({ ...p, creditor: e.target.value }))}
                placeholder="Название банка/лица"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Срок погашения</label>
              <input
                type="date"
                value={form.dueDate}
                onChange={(e) => setForm((p) => ({ ...p, dueDate: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Ежемес. платёж (TJS)</label>
              <DecimalInput
                value={form.monthlyPayment}
                onChange={(v) => setForm((p) => ({ ...p, monthlyPayment: v }))}
                min={0}
                placeholder="0"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Процентная ставка (%)</label>
              <DecimalInput
                value={form.interestRate}
                onChange={(v) => setForm((p) => ({ ...p, interestRate: v }))}
                min={0}
                max={100}
                placeholder="0"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
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
            {isEditing ? 'Сохранить' : 'Добавить обязательство'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
