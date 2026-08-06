'use client'

import { useState, useEffect } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { type MenuCategory, fetchMenuCategoriesFull, createMenuCategory, updateMenuCategory, deleteMenuCategory } from '@/lib/queries'
import { Plus, Trash2, Pencil, Check, X } from 'lucide-react'
import { toast } from 'sonner'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Родитель (menu/page.tsx) держит свой список категорий для чипов-фильтра
  // отдельно от этого диалога — колбэк даёт обновить его без релоада страницы.
  onChanged?: (categories: MenuCategory[]) => void
}

// ManageCategoriesDialog — справочник категорий меню, 1:1 по образцу
// ManageSizeScalesDialog (карточки + инлайн-переименование + добавление
// снизу), но проще: у категории нет вложенных значений, только name.
// Удаление — через AlertDialog (не window.confirm — тот же класс бага,
// что и в остальном репо: Electron/Windows не всегда возвращает фокус
// после native-confirm).
export function ManageCategoriesDialog({ open, onOpenChange, onChanged }: Props) {
  const [categories, setCategories] = useState<MenuCategory[]>([])
  const [loading, setLoading] = useState(true)

  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [saving, setSaving] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<MenuCategory | null>(null)
  const [deleting, setDeleting] = useState(false)

  const reload = async () => {
    const data = (await fetchMenuCategoriesFull()).sort((a, b) => a.sortOrder - b.sortOrder)
    setCategories(data)
    onChanged?.(data)
  }

  useEffect(() => {
    if (open) {
      setLoading(true)
      reload().finally(() => setLoading(false))
    } else {
      setShowNew(false)
      setNewName('')
      setEditingId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name || creating) return
    setCreating(true)
    try {
      await createMenuCategory(name)
      setNewName('')
      setShowNew(false)
      await reload()
      toast.success(`Категория «${name}» создана`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка создания')
    } finally {
      setCreating(false)
    }
  }

  const startEdit = (c: MenuCategory) => {
    setEditingId(c.id)
    setEditName(c.name)
  }

  const handleSaveEdit = async () => {
    if (!editingId || saving) return
    const name = editName.trim()
    if (!name) return
    setSaving(true)
    try {
      await updateMenuCategory(editingId, { name })
      setEditingId(null)
      await reload()
      toast.success('Категория переименована')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await deleteMenuCategory(deleteTarget.id)
      const name = deleteTarget.name
      setDeleteTarget(null)
      await reload()
      toast.success(`Категория «${name}» удалена`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка удаления')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto rounded-xl">
          <DialogHeader>
            <DialogTitle>Категории меню</DialogTitle>
          </DialogHeader>

          {loading ? (
            <div className="flex justify-center py-8"><div className="size-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
          ) : (
            <div className="space-y-3">
              {categories.length === 0 && !showNew && (
                <p className="text-sm text-muted-foreground text-center py-4">Нет категорий</p>
              )}

              <div className="space-y-2">
                {categories.map((c) => (
                  <div key={c.id} className="flex items-center gap-1.5 bg-muted/30 rounded-xl pl-3 pr-1.5 py-1.5">
                    {editingId === c.id ? (
                      <>
                        <input
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveEdit()
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          className="flex-1 h-11 px-3 bg-background border border-primary rounded-lg text-sm focus:outline-none"
                        />
                        <Button type="button" size="icon-touch" variant="ghost" onClick={handleSaveEdit} disabled={saving || !editName.trim()} className="text-primary hover:text-primary shrink-0">
                          <Check className="size-4" />
                        </Button>
                        <Button type="button" size="icon-touch" variant="ghost" onClick={() => setEditingId(null)} className="text-muted-foreground shrink-0">
                          <X className="size-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 min-w-0 truncate text-sm font-medium text-foreground py-1.5">{c.name}</span>
                        <Button type="button" size="icon-touch" variant="ghost" onClick={() => startEdit(c)} className="text-muted-foreground hover:text-primary shrink-0">
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button type="button" size="icon-touch" variant="ghost" onClick={() => setDeleteTarget(c)} className="text-muted-foreground hover:text-destructive shrink-0">
                          <Trash2 className="size-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </div>

              {showNew ? (
                <div className="bg-primary/5 rounded-xl p-3 space-y-2 border border-primary/20">
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreate()
                      if (e.key === 'Escape') { setShowNew(false); setNewName('') }
                    }}
                    placeholder="Например: Десерты"
                    className="w-full h-11 px-3 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <div className="flex gap-2">
                    <Button type="button" size="touch" onClick={handleCreate} disabled={creating || !newName.trim()}>
                      {creating ? 'Создание...' : 'Создать'}
                    </Button>
                    <Button type="button" size="touch" variant="outline" onClick={() => { setShowNew(false); setNewName('') }}>
                      Отмена
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowNew(true)}
                  className="w-full min-h-11 py-2.5 border-2 border-dashed border-border rounded-xl text-sm text-muted-foreground hover:border-primary/30 hover:text-primary transition-colors flex items-center justify-center gap-1.5"
                >
                  <Plus className="size-4" />Добавить категорию
                </button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить категорию?</AlertDialogTitle>
            <AlertDialogDescription>
              «{deleteTarget?.name}» будет удалена из списка категорий. Блюда, у которых она указана, её не потеряют — категория пропадёт только из справочника.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={cn(buttonVariants({ variant: 'outline', size: 'touch' }))}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className={cn(buttonVariants({ size: 'touch' }), 'bg-destructive text-white hover:bg-destructive/90')}
            >
              {deleting ? 'Удаление...' : 'Удалить'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
