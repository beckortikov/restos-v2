'use client'

import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import type { Zone } from '@/lib/types'

interface ZoneForm {
  name: string
}

interface ManageZoneDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  zone?: Zone
  onSubmit: (data: ZoneForm) => void
  onDelete?: (id: string) => void
}

export function ManageZoneDialog({ open, onOpenChange, zone, onSubmit, onDelete }: ManageZoneDialogProps) {
  const [form, setForm] = useState<ZoneForm>({ name: '' })
  const isEditing = !!zone

  useEffect(() => {
    if (open) {
      setForm({ name: String(zone?.name ?? '') })
    }
  }, [open, zone])

  function handleSubmit() {
    onSubmit(form)
    onOpenChange(false)
  }

  function handleDelete() {
    if (zone && onDelete) {
      onDelete(zone.id)
      onOpenChange(false)
    }
  }

  const canSubmit = String(form.name).trim().length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Редактировать зону' : 'Новая зона'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Название</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ name: e.target.value })}
              placeholder="Основной зал"
              className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
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
            {isEditing ? 'Сохранить' : 'Создать зону'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
