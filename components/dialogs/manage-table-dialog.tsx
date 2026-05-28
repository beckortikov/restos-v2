'use client'

import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import type { Table, Zone, User } from '@/lib/types'

interface TableForm {
  name: string
  number: number
  capacity: number
  zone: string
  waiterId: string
}

interface ManageTableDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  table?: Table
  zones: Zone[]
  waiters: User[]
  onSubmit: (data: TableForm) => void
  onDelete?: (id: string) => void
}

export function ManageTableDialog({ open, onOpenChange, table, zones, waiters, onSubmit, onDelete }: ManageTableDialogProps) {
  const [form, setForm] = useState<TableForm>({
    name: '',
    number: 0,
    capacity: 2,
    zone: '',
    waiterId: '',
  })
  const isEditing = !!table

  const filteredWaiters = waiters.filter((w) => w.role === 'waiter')

  useEffect(() => {
    if (open) {
      if (table) {
        setForm({
          name: String(table.name ?? ''),
          number: Number(table.number) || 0,
          capacity: Number(table.capacity) || 0,
          zone: String(table.zone ?? ''),
          waiterId: table.waiterId ?? '',
        })
      } else {
        setForm({ name: '', number: 0, capacity: 2, zone: '', waiterId: '' })
      }
    }
  }, [open, table])

  function handleSubmit() {
    onSubmit(form)
    onOpenChange(false)
  }

  function handleDelete() {
    if (table && onDelete) {
      onDelete(table.id)
      onOpenChange(false)
    }
  }

  const canSubmit = String(form.name).trim().length > 0 && form.number > 0 && form.capacity > 0 && String(form.zone).length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Редактировать стол' : 'Новый стол'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Название</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="Стол у окна"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Номер</label>
              <input
                type="number"
                min={1}
                value={form.number || ''}
                onChange={(e) => setForm((p) => ({ ...p, number: parseInt(e.target.value) || 0 }))}
                placeholder="1"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Вместимость</label>
              <input
                type="number"
                min={1}
                value={form.capacity || ''}
                onChange={(e) => setForm((p) => ({ ...p, capacity: parseInt(e.target.value) || 0 }))}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Зона</label>
              <select
                value={form.zone}
                onChange={(e) => setForm((p) => ({ ...p, zone: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Выберите зону</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Официант</label>
              <select
                value={form.waiterId}
                onChange={(e) => setForm((p) => ({ ...p, waiterId: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Не назначен</option>
                {filteredWaiters.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
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
            {isEditing ? 'Сохранить' : 'Создать стол'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
