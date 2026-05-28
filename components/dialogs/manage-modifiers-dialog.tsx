'use client'

import { useState, useEffect } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { type ModifierGroup } from '@/lib/types'
import { fetchModifierGroupsForMenuItem, createModifierGroup, deleteModifierGroup, createModifier, deleteModifier } from '@/lib/queries'
import { Plus, X, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  menuItemId: string
  menuItemName: string
}

export function ManageModifiersDialog({ open, onOpenChange, menuItemId, menuItemName }: Props) {
  const [groups, setGroups] = useState<ModifierGroup[]>([])
  const [loading, setLoading] = useState(true)

  // New group form
  const [showNewGroup, setShowNewGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupRequired, setNewGroupRequired] = useState(false)
  const [newGroupMax, setNewGroupMax] = useState(1)

  // New modifier form
  const [addingToGroup, setAddingToGroup] = useState<string | null>(null)
  const [newModName, setNewModName] = useState('')
  const [newModPrice, setNewModPrice] = useState(0)

  const reload = async () => {
    const data = await fetchModifierGroupsForMenuItem(menuItemId)
    setGroups(data)
  }

  useEffect(() => {
    if (open) {
      setLoading(true)
      reload().finally(() => setLoading(false))
    }
  }, [open, menuItemId])

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return
    try {
      await createModifierGroup({
        name: newGroupName.trim(),
        menuItemId,
        isRequired: newGroupRequired,
        maxSelect: newGroupMax,
      })
      setShowNewGroup(false)
      setNewGroupName('')
      setNewGroupRequired(false)
      setNewGroupMax(1)
      await reload()
      toast.success('Группа создана')
    } catch {
      toast.error('Ошибка')
    }
  }

  const handleDeleteGroup = async (id: string) => {
    if (!confirm('Удалить группу модификаторов?')) return
    try {
      await deleteModifierGroup(id)
      await reload()
    } catch {
      toast.error('Ошибка удаления')
    }
  }

  const handleAddModifier = async (groupId: string) => {
    if (!newModName.trim()) return
    try {
      await createModifier({ groupId, name: newModName.trim(), price: newModPrice })
      setAddingToGroup(null)
      setNewModName('')
      setNewModPrice(0)
      await reload()
    } catch {
      toast.error('Ошибка')
    }
  }

  const handleDeleteModifier = async (id: string) => {
    try {
      await deleteModifier(id)
      await reload()
    } catch {
      toast.error('Ошибка')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle>Модификаторы: {menuItemName}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><div className="size-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
        ) : (
          <div className="space-y-4">
            {groups.length === 0 && !showNewGroup && (
              <p className="text-sm text-muted-foreground text-center py-4">Нет групп модификаторов</p>
            )}

            {groups.map(group => (
              <div key={group.id} className="bg-muted/30 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium text-foreground text-sm">{group.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">
                      {group.isRequired ? 'Обязательно' : 'Опционально'} · Макс: {group.maxSelect === 0 ? 'без лимита' : group.maxSelect}
                    </span>
                    {!group.menuItemId && (
                      <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded ml-2">Глобальный</span>
                    )}
                  </div>
                  {group.menuItemId && (
                    <button onClick={() => handleDeleteGroup(group.id)} className="p-1 text-muted-foreground hover:text-destructive">
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>

                {/* Modifiers list */}
                <div className="space-y-1">
                  {group.modifiers.map(mod => (
                    <div key={mod.id} className="flex items-center justify-between px-3 py-1.5 bg-background rounded-lg text-sm">
                      <span className="text-foreground">{mod.name}</span>
                      <div className="flex items-center gap-2">
                        {mod.price > 0 && <span className="text-xs text-primary font-medium">+{mod.price} TJS</span>}
                        <button onClick={() => handleDeleteModifier(mod.id)} className="p-0.5 text-muted-foreground hover:text-destructive">
                          <X className="size-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Add modifier */}
                {addingToGroup === group.id ? (
                  <div className="flex items-center gap-2">
                    <input value={newModName} onChange={e => setNewModName(e.target.value)} placeholder="Название"
                      className="flex-1 px-2 py-1.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                    <input type="number" min={0} step="any" value={newModPrice} onChange={e => setNewModPrice(Number(e.target.value))} placeholder="Цена"
                      className="w-20 px-2 py-1.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                    <button onClick={() => handleAddModifier(group.id)} className="px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium">OK</button>
                    <button onClick={() => setAddingToGroup(null)} className="text-xs text-muted-foreground">Отм.</button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setAddingToGroup(group.id); setNewModName(''); setNewModPrice(0) }}
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                  >
                    <Plus className="size-3" />Добавить модификатор
                  </button>
                )}
              </div>
            ))}

            {/* New group form */}
            {showNewGroup ? (
              <div className="bg-primary/5 rounded-xl p-4 space-y-3 border border-primary/20">
                <p className="text-sm font-medium text-foreground">Новая группа</p>
                <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)} placeholder="Например: Добавки"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input type="checkbox" checked={newGroupRequired} onChange={e => setNewGroupRequired(e.target.checked)} className="rounded" />
                    Обязательно
                  </label>
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    Макс:
                    <input type="number" min={0} max={10} value={newGroupMax} onChange={e => setNewGroupMax(Number(e.target.value))}
                      className="w-16 px-2 py-1 bg-background border border-border rounded-lg text-sm" />
                  </label>
                </div>
                <div className="flex gap-2">
                  <button onClick={handleCreateGroup} disabled={!newGroupName.trim()}
                    className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50">Создать</button>
                  <button onClick={() => setShowNewGroup(false)} className="text-sm text-muted-foreground">Отмена</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowNewGroup(true)}
                className="w-full py-2.5 border-2 border-dashed border-border rounded-xl text-sm text-muted-foreground hover:border-primary/30 hover:text-primary transition-colors flex items-center justify-center gap-1.5"
              >
                <Plus className="size-4" />Добавить группу модификаторов
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
