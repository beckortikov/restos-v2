'use client'

import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency } from '@/lib/helpers'
import type { Customer } from '@/lib/types'
import {
  fetchCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} from '@/lib/queries'
import {
  Users, Plus, Search, Pencil, Trash2, X, Check, ChevronDown, ChevronRight,
  Phone, Mail, Cake, StickyNote, TrendingUp, Hash, CalendarDays,
} from 'lucide-react'
import { toast } from 'sonner'

export default function CustomersPage() {
  const { canDo } = useAuth()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  // Expanded customer
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Edit form
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: '', phone: '', email: '', birthDate: '', notes: '' })
  const [savingEdit, setSavingEdit] = useState(false)

  // Add form
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ name: '', phone: '', email: '', birthDate: '', notes: '' })
  const [addingCustomer, setAddingCustomer] = useState(false)

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const loadCustomers = async () => {
    try {
      const data = await fetchCustomers()
      setCustomers(data)
    } catch {
      toast.error('Ошибка загрузки клиентов')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadCustomers() }, [])

  // Filtered customers
  const filtered = useMemo(() => {
    if (!search.trim()) return customers
    const q = search.toLowerCase()
    return customers.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.phone && c.phone.toLowerCase().includes(q))
    )
  }, [customers, search])

  // Stats
  const totalCustomers = customers.length
  const avgCheck = totalCustomers > 0
    ? Math.round(customers.reduce((s, c) => s + c.avgCheck, 0) / totalCustomers)
    : 0
  const avgVisits = totalCustomers > 0
    ? (customers.reduce((s, c) => s + c.visitsCount, 0) / totalCustomers).toFixed(1)
    : '0'

  // ─── Add customer ──────────────────────────────────────────────────────────
  const handleAdd = async () => {
    if (!addForm.name.trim()) { toast.error('Имя обязательно'); return }
    setAddingCustomer(true)
    try {
      const created = await createCustomer({
        name: addForm.name.trim(),
        phone: addForm.phone.trim() || undefined,
        email: addForm.email.trim() || undefined,
        birthDate: addForm.birthDate || undefined,
        notes: addForm.notes.trim() || undefined,
      })
      setCustomers(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
      setAddForm({ name: '', phone: '', email: '', birthDate: '', notes: '' })
      setShowAdd(false)
      toast.success('Клиент добавлен')
    } catch {
      toast.error('Ошибка создания клиента')
    } finally {
      setAddingCustomer(false)
    }
  }

  // ─── Edit customer ─────────────────────────────────────────────────────────
  const startEdit = (c: Customer) => {
    setEditingId(c.id)
    setEditForm({
      name: c.name,
      phone: c.phone || '',
      email: c.email || '',
      birthDate: c.birthDate || '',
      notes: c.notes || '',
    })
  }

  const handleSaveEdit = async () => {
    if (!editingId) return
    if (!editForm.name.trim()) { toast.error('Имя обязательно'); return }
    setSavingEdit(true)
    try {
      await updateCustomer(editingId, {
        name: editForm.name.trim(),
        phone: editForm.phone.trim(),
        email: editForm.email.trim(),
        birthDate: editForm.birthDate,
        notes: editForm.notes.trim(),
      })
      setCustomers(prev => prev.map(c => c.id === editingId ? {
        ...c,
        name: editForm.name.trim(),
        phone: editForm.phone.trim() || undefined,
        email: editForm.email.trim() || undefined,
        birthDate: editForm.birthDate || undefined,
        notes: editForm.notes.trim() || undefined,
      } : c))
      setEditingId(null)
      toast.success('Клиент обновлён')
    } catch {
      toast.error('Ошибка обновления')
    } finally {
      setSavingEdit(false)
    }
  }

  // ─── Delete customer ───────────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    try {
      await deleteCustomer(id)
      setCustomers(prev => prev.filter(c => c.id !== id))
      setDeletingId(null)
      setExpandedId(null)
      toast.success('Клиент удалён')
    } catch {
      toast.error('Ошибка удаления')
    }
  }

  // ─── Guards ────────────────────────────────────────────────────────────────
  if (!canDo('customers.manage')) {
    return <div className="p-6 flex items-center justify-center h-64"><p className="text-muted-foreground">Нет доступа</p></div>
  }
  if (loading) {
    return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Users className="size-5" /> База клиентов
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">{totalCustomers} клиентов</p>
        </div>
        <button
          onClick={() => { setShowAdd(true); setEditingId(null) }}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-primary text-primary-foreground text-sm rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus className="size-4" /> Клиент
        </button>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border bg-card p-4">
          <div className="text-muted-foreground text-xs font-medium">Всего клиентов</div>
          <div className="text-2xl font-bold mt-1">{totalCustomers}</div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-muted-foreground text-xs font-medium">Средний чек</div>
          <div className="text-2xl font-bold mt-1">{formatCurrency(avgCheck)}</div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-muted-foreground text-xs font-medium">Среднее визитов</div>
          <div className="text-2xl font-bold mt-1">{avgVisits}</div>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Поиск по имени или телефону..."
          className="w-full pl-9 pr-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>

      {/* Add customer form */}
      {showAdd && (
        <div className="rounded-xl border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm">Новый клиент</h3>
            <button onClick={() => setShowAdd(false)} className="p-1 rounded hover:bg-muted"><X className="size-4" /></button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              value={addForm.name}
              onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Имя *"
              className="px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <input
              value={addForm.phone}
              onChange={e => setAddForm(f => ({ ...f, phone: e.target.value.replace(/[^\d+\-\s()]/g, '') }))}
              placeholder="Телефон"
              inputMode="tel"
              className="px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <input
              value={addForm.email}
              onChange={e => setAddForm(f => ({ ...f, email: e.target.value }))}
              placeholder="Email"
              className="px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <input
              type="date"
              value={addForm.birthDate}
              onChange={e => setAddForm(f => ({ ...f, birthDate: e.target.value }))}
              placeholder="Дата рождения"
              className="px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <textarea
            value={addForm.notes}
            onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))}
            placeholder="Заметки"
            rows={2}
            className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
          />
          <button
            onClick={handleAdd}
            disabled={addingCustomer}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground text-sm rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {addingCustomer ? 'Сохранение...' : 'Добавить клиента'}
          </button>
        </div>
      )}

      {/* Customer list */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">
          {search ? 'Ничего не найдено' : 'Нет клиентов'}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(c => {
            const isExpanded = expandedId === c.id
            const isEditing = editingId === c.id
            const isDeleting = deletingId === c.id

            return (
              <div key={c.id} className="rounded-xl border bg-card overflow-hidden">
                {/* Row summary */}
                <button
                  onClick={() => { setExpandedId(isExpanded ? null : c.id); setEditingId(null); setDeletingId(null) }}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
                >
                  {isExpanded ? <ChevronDown className="size-4 text-muted-foreground shrink-0" /> : <ChevronRight className="size-4 text-muted-foreground shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{c.name}</div>
                    <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                      {c.phone && <span className="flex items-center gap-1"><Phone className="size-3" />{c.phone}</span>}
                      {c.email && <span className="flex items-center gap-1"><Mail className="size-3" />{c.email}</span>}
                    </div>
                  </div>
                  <div className="hidden sm:flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                    <span className="flex items-center gap-1" title="Визиты"><Hash className="size-3" />{c.visitsCount}</span>
                    <span className="flex items-center gap-1" title="Сумма"><TrendingUp className="size-3" />{formatCurrency(c.totalSpent)}</span>
                    <span title="Средний чек">{formatCurrency(c.avgCheck)}</span>
                  </div>
                </button>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="border-t px-4 py-3 space-y-3">
                    {/* Mobile stats */}
                    <div className="sm:hidden grid grid-cols-3 gap-2 text-center">
                      <div><div className="text-xs text-muted-foreground">Визиты</div><div className="font-semibold text-sm">{c.visitsCount}</div></div>
                      <div><div className="text-xs text-muted-foreground">Сумма</div><div className="font-semibold text-sm">{formatCurrency(c.totalSpent)}</div></div>
                      <div><div className="text-xs text-muted-foreground">Ср. чек</div><div className="font-semibold text-sm">{formatCurrency(c.avgCheck)}</div></div>
                    </div>

                    {isEditing ? (
                      /* Edit form */
                      <div className="space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <input
                            value={editForm.name}
                            onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                            placeholder="Имя *"
                            className="px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                          <input
                            value={editForm.phone}
                            onChange={e => setEditForm(f => ({ ...f, phone: e.target.value.replace(/[^\d+\-\s()]/g, '') }))}
                            placeholder="Телефон"
                            inputMode="tel"
                            className="px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                          <input
                            value={editForm.email}
                            onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))}
                            placeholder="Email"
                            className="px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                          <input
                            type="date"
                            value={editForm.birthDate}
                            onChange={e => setEditForm(f => ({ ...f, birthDate: e.target.value }))}
                            className="px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                        </div>
                        <textarea
                          value={editForm.notes}
                          onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                          placeholder="Заметки"
                          rows={2}
                          className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={handleSaveEdit}
                            disabled={savingEdit}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground text-sm rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                          >
                            <Check className="size-3.5" /> {savingEdit ? 'Сохранение...' : 'Сохранить'}
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border hover:bg-muted transition-colors"
                          >
                            Отмена
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* Detail view */
                      <div className="space-y-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                          {c.birthDate && (
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <Cake className="size-3.5" /> Д/р: {new Date(c.birthDate).toLocaleDateString('ru-RU')}
                            </div>
                          )}
                          {c.lastVisitAt && (
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <CalendarDays className="size-3.5" /> Последний визит: {new Date(c.lastVisitAt).toLocaleDateString('ru-RU')}
                            </div>
                          )}
                        </div>
                        {c.notes && (
                          <div className="flex items-start gap-2 text-sm text-muted-foreground">
                            <StickyNote className="size-3.5 mt-0.5 shrink-0" />
                            <span>{c.notes}</span>
                          </div>
                        )}
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={() => startEdit(c)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border hover:bg-muted transition-colors"
                          >
                            <Pencil className="size-3.5" /> Изменить
                          </button>
                          {isDeleting ? (
                            <div className="flex items-center gap-2">
                              <span className="text-sm text-destructive">Удалить?</span>
                              <button
                                onClick={() => handleDelete(c.id)}
                                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                              >
                                Да
                              </button>
                              <button
                                onClick={() => setDeletingId(null)}
                                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border hover:bg-muted transition-colors"
                              >
                                Нет
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setDeletingId(c.id)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border text-destructive hover:bg-destructive/10 transition-colors"
                            >
                              <Trash2 className="size-3.5" /> Удалить
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
