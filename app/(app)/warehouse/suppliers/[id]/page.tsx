'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, CheckCircle, Tag, Search, Plus, X, Phone, User, Landmark, Trash2, History, ChevronDown, ChevronRight, Pencil, Undo2 } from 'lucide-react'
import { fetchIngredientCategories, fetchSuppliers, updateSupplier, deleteSupplier, fetchReceipts, fetchStockReturns } from '@/lib/queries'
import { DecimalInput } from '@/components/ui/decimal-input'
import { formatCurrency } from '@/lib/helpers'
import { dMul } from '@/lib/decimal'
import { toast } from 'sonner'
import type { Supplier, StockReceipt, StockReturn } from '@/lib/types'

const PAY_BADGE: Record<string, { label: string; cls: string }> = {
  paid: { label: 'Оплачено', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' },
  credit: { label: 'В кредит', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400' },
  partial: { label: 'Частично', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400' },
}

interface SupplierForm {
  name: string
  contactPerson: string
  phone: string
  categories: string[]
  paymentTermsDays: number
  creditLimit: number
}

const emptyForm: SupplierForm = {
  name: '',
  contactPerson: '',
  phone: '',
  categories: [],
  paymentTermsDays: 7,
  creditLimit: 0,
}

const CATEGORY_GROUPS = [
  {
    label: 'Продукты питания',
    items: [
      'Мясо', 'Птица', 'Рыба', 'Морепродукты',
      'Овощи', 'Фрукты', 'Зелень', 'Грибы',
      'Крупы', 'Бобовые', 'Макароны',
      'Мука', 'Хлеб', 'Выпечка',
      'Молочные', 'Сыры', 'Яйца',
      'Масла', 'Специи', 'Соусы',
      'Напитки', 'Чай', 'Кофе', 'Соки',
      'Заморозка', 'Консервы',
      'Сухофрукты', 'Орехи',
      'Кондитерские', 'Сахар', 'Мёд',
      'Прочие продукты',
    ],
  },
  {
    label: 'Хозяйственные товары',
    items: [
      'Салфетки', 'Бумажные полотенца', 'Туалетная бумага',
      'Зубочистки', 'Трубочки',
      'Одноразовая посуда', 'Одноразовые стаканы',
      'Моющие средства', 'Дезинфекция',
      'Губки', 'Тряпки',
      'Перчатки', 'Фартуки',
      'Мусорные мешки',
      'Упаковка', 'Пакеты', 'Контейнеры',
      'Инвентарь',
      'Прочие хозтовары',
    ],
  },
]

const ALL_DEFAULT_CATEGORIES = CATEGORY_GROUPS.flatMap(g => g.items)

export default function EditSupplierPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [supplier, setSupplier] = useState<Supplier | null>(null)
  const [form, setForm] = useState<SupplierForm>(emptyForm)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false) // просмотр по умолчанию, edit — по кнопке
  const [catSearch, setCatSearch] = useState('')
  const [ingredientCategories, setIngredientCategories] = useState<string[]>([])
  const [receipts, setReceipts] = useState<StockReceipt[]>([])
  const [loadingReceipts, setLoadingReceipts] = useState(true)
  const [expandedReceipt, setExpandedReceipt] = useState<string | null>(null)
  const [returns, setReturns] = useState<StockReturn[]>([])

  const totalPurchased = useMemo(() => receipts.reduce((s, r) => s + r.totalAmount, 0), [receipts])
  const totalDebt = useMemo(() => receipts.reduce((s, r) => s + r.debtAmount, 0), [receipts])
  // Действующие возвраты этого поставщика. Без них непонятно, почему долг
  // уменьшился или откуда приход денег — накладная просто «похудела».
  const activeReturns = useMemo(() => returns.filter(r => !r.cancelledAt), [returns])
  const totalReturned = useMemo(() => activeReturns.reduce((s, r) => s + r.totalAmount, 0), [activeReturns])
  const returnsByReceipt = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of activeReturns) m.set(r.receiptId, (m.get(r.receiptId) ?? 0) + r.totalAmount)
    return m
  }, [activeReturns])
  const sortedReceipts = useMemo(
    () => [...receipts].sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    [receipts],
  )

  useEffect(() => {
    if (!id) return
    setLoadingReceipts(true)
    Promise.all([fetchReceipts({ supplierId: id }), fetchStockReturns({ supplierId: id })])
      .then(([rc, rt]) => { setReceipts(rc); setReturns(rt) })
      .catch(() => { setReceipts([]); setReturns([]) })
      .finally(() => setLoadingReceipts(false))
  }, [id])

  useEffect(() => {
    Promise.all([fetchIngredientCategories(), fetchSuppliers()])
      .then(([cats, suppliers]) => {
        setIngredientCategories(cats)
        const found = suppliers.find(s => s.id === id)
        if (found) {
          setSupplier(found)
          setForm({
            name: found.name,
            contactPerson: found.contactPerson,
            phone: found.phone,
            categories: found.categories,
            paymentTermsDays: found.paymentTermsDays,
            creditLimit: found.creditLimit,
          })
        } else {
          toast.error('Поставщик не найден')
          navigate('/warehouse/suppliers')
        }
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [id])

  function toggleCategory(cat: string) {
    setForm((prev) => ({
      ...prev,
      categories: prev.categories.includes(cat)
        ? prev.categories.filter((c) => c !== cat)
        : [...prev.categories, cat],
    }))
  }

  const resetForm = () => {
    if (!supplier) return
    setForm({
      name: supplier.name,
      contactPerson: supplier.contactPerson,
      phone: supplier.phone,
      categories: supplier.categories,
      paymentTermsDays: supplier.paymentTermsDays,
      creditLimit: supplier.creditLimit,
    })
  }

  const handleSubmit = async () => {
    if (!supplier || !form.name.trim() || !form.contactPerson.trim() || !form.phone.trim() || form.categories.length === 0 || saving) return
    setSaving(true)
    try {
      await updateSupplier(supplier.id, {
        name: form.name,
        contact_person: form.contactPerson,
        phone: form.phone,
        categories: form.categories,
        payment_terms_days: form.paymentTermsDays,
        credit_limit: form.creditLimit,
      })
      // Обновляем локально и возвращаемся в просмотр (не уходим со страницы).
      setSupplier({
        ...supplier,
        name: form.name,
        contactPerson: form.contactPerson,
        phone: form.phone,
        categories: form.categories,
        paymentTermsDays: form.paymentTermsDays,
        creditLimit: form.creditLimit,
      })
      setEditing(false)
      toast.success('Поставщик обновлён')
    } catch (e) {
      toast.error('Ошибка обновления поставщика')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!supplier) return
    if (!window.confirm(`Вы действительно хотите удалить поставщика "${supplier.name}"? Это действие необратимо.`)) return
    try {
      await deleteSupplier(supplier.id)
      toast.success('Поставщик удалён')
      navigate('/warehouse/suppliers')
    } catch {
      toast.error('Ошибка удаления. Возможно, есть связанные накладные.')
    }
  }

  const canSubmit = form.name.trim() && form.contactPerson.trim() && form.phone.trim() && form.categories.length > 0

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background border-b border-border">
        <div className="flex items-center gap-3 px-4 md:px-6 py-3">
          <button
            type="button"
            onClick={() => navigate('/warehouse/suppliers')}
            className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:bg-muted px-2.5 py-1.5 rounded-lg transition-colors"
          >
            <ArrowLeft className="size-4" />
            <span>Назад</span>
          </button>
          <h1 className="flex-1 text-base md:text-lg font-bold text-foreground truncate">
            {editing && <span className="text-muted-foreground font-medium">Редактирование: </span>}
            <span className="text-primary">{supplier?.name}</span>
          </h1>
          {editing ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { setEditing(false); resetForm() }}
                className="px-4 py-2 rounded-lg text-sm font-medium text-foreground bg-card border border-border hover:bg-muted transition-colors"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit || saving}
                className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
              >
                <CheckCircle className="size-4" />
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Pencil className="size-4" />
              Редактировать
            </button>
          )}
        </div>
      </div>

      {/* Body — просмотр (сводка read-only) ИЛИ редактирование (форма) */}
      {!editing && (
        <div className="flex-1 p-4 md:p-6 max-w-7xl mx-auto w-full">
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
              <div className="flex items-center gap-2 text-sm">
                <User className="size-4 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Контакт:</span>
                <span className="font-medium text-foreground">{supplier?.contactPerson || '—'}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Phone className="size-4 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Телефон:</span>
                {supplier?.phone
                  ? <a href={`tel:${supplier.phone}`} className="font-medium text-primary hover:underline">{supplier.phone}</a>
                  : <span className="font-medium text-foreground">—</span>}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Landmark className="size-4 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Отсрочка:</span>
                <span className="font-medium text-foreground">{supplier?.paymentTermsDays ? `${supplier.paymentTermsDays} дн.` : 'без отсрочки'}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Наш долг:</span>
                <span className={`font-bold ${(supplier?.currentDebt ?? 0) > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600'}`}>{formatCurrency(supplier?.currentDebt ?? 0)}</span>
                {(supplier?.creditLimit ?? 0) > 0 && <span className="text-xs text-muted-foreground">из {formatCurrency(supplier!.creditLimit)}</span>}
              </div>
            </div>
            {(supplier?.categories?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-3 border-t border-border/60">
                <Tag className="size-4 text-muted-foreground shrink-0" />
                {supplier!.categories.map(c => (
                  <span key={c} className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-md font-medium">{c}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {editing && (
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 p-4 md:p-6 max-w-7xl mx-auto w-full">
        {/* Left Column - Contact Info & Terms */}
        <div className="lg:col-span-6 space-y-6">
          {/* Card 1: Основные контакты */}
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
            <div className="flex items-center gap-2 pb-2 border-b border-border/60">
              <User className="size-4.5 text-primary" />
              <h2 className="text-sm font-bold text-foreground">Контактные данные</h2>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-muted-foreground mb-1 block">Название компании <span className="text-destructive">*</span></label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Например, ООО ПродСнаб"
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground mb-1 block">Контактное лицо <span className="text-destructive">*</span></label>
                  <input
                    type="text"
                    value={form.contactPerson}
                    onChange={(e) => setForm((p) => ({ ...p, contactPerson: e.target.value }))}
                    placeholder="Например, Иван Иванов"
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground mb-1 block">Номер телефона <span className="text-destructive">*</span></label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                    <input
                      type="tel"
                      value={form.phone}
                      onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value.replace(/[^\d+\-\s()]/g, '') }))}
                      placeholder="+992 900 000000"
                      className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Card 2: Условия оплаты */}
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
            <div className="flex items-center gap-2 pb-2 border-b border-border/60">
              <Landmark className="size-4.5 text-primary" />
              <h2 className="text-sm font-bold text-foreground">Финансовые условия</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-muted-foreground mb-1 block">Отсрочка платежа (дней)</label>
                <input
                  type="number"
                  min={0}
                  value={form.paymentTermsDays}
                  onChange={(e) => setForm((p) => ({ ...p, paymentTermsDays: parseInt(e.target.value) || 0 }))}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
                />
                <p className="text-[10px] text-muted-foreground mt-1">0 дней означает оплату сразу при получении</p>
              </div>

              <div>
                <label className="text-xs font-semibold text-muted-foreground mb-1 block">Кредитный лимит (долг)</label>
                <DecimalInput
                  value={form.creditLimit}
                  onChange={(v) => setForm((p) => ({ ...p, creditLimit: v }))}
                  min={0}
                  placeholder="0 = без лимита"
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
                />
                <p className="text-[10px] text-muted-foreground mt-1">Максимально допустимый размер долга перед поставщиком</p>
              </div>
            </div>
          </div>

          {/* Card 3: Опасные действия */}
          <div className="bg-card border border-red-200 dark:border-red-900/40 rounded-xl p-5 shadow-sm space-y-3 bg-red-50/10 dark:bg-red-950/5">
            <h3 className="text-xs font-bold text-red-800 dark:text-red-400">Удаление поставщика</h3>
            <p className="text-xs text-muted-foreground">Если поставщик больше не работает с вами, вы можете удалить его. Обратите внимание, что удаление невозможно, если с ним связаны складские накладные.</p>
            <button
              type="button"
              onClick={handleDelete}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-destructive bg-destructive/10 border border-destructive/20 hover:bg-destructive/20 rounded-lg transition-colors"
            >
              <Trash2 className="size-3.5" />
              Удалить поставщика
            </button>
          </div>
        </div>

        {/* Right Column - Categories Selector */}
        <div className="lg:col-span-6 space-y-6">
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4 flex flex-col h-full">
            <div className="flex items-center gap-2 pb-2 border-b border-border/60 shrink-0">
              <Tag className="size-4.5 text-primary" />
              <h2 className="text-sm font-bold text-foreground">Поставляемые категории товаров <span className="text-destructive">*</span></h2>
            </div>

            {/* Selected tags */}
            {form.categories.length > 0 && (
              <div className="flex flex-wrap gap-1.5 shrink-0 bg-muted/20 border border-border/50 p-3 rounded-lg">
                {form.categories.map(cat => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => toggleCategory(cat)}
                    className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-primary text-primary-foreground flex items-center gap-1 hover:bg-primary/95 transition-colors"
                  >
                    {cat} <X className="size-3" />
                  </button>
                ))}
              </div>
            )}

            {/* Search */}
            <div className="relative shrink-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                type="text"
                value={catSearch}
                onChange={e => setCatSearch(e.target.value)}
                placeholder="Поиск категории..."
                className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
                onKeyDown={e => {
                  if (e.key === 'Enter' && catSearch.trim()) {
                    e.preventDefault()
                    toggleCategory(catSearch.trim())
                    setCatSearch('')
                  }
                }}
              />
            </div>

            {/* Category Groups list */}
            <div className="flex-1 min-h-[250px] overflow-y-auto rounded-lg border border-border divide-y divide-border/60 bg-muted/5">
              {CATEGORY_GROUPS.map(group => {
                const filtered = group.items.filter(c => !catSearch || c.toLowerCase().includes(catSearch.toLowerCase()))
                if (filtered.length === 0) return null
                return (
                  <div key={group.label} className="p-3">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">{group.label}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {filtered.map(cat => {
                        const isSelected = form.categories.includes(cat)
                        return (
                          <button
                            key={cat}
                            type="button"
                            onClick={() => toggleCategory(cat)}
                            className={`px-3 py-1 rounded-lg text-[11px] font-semibold border transition-all ${
                              isSelected
                                ? 'bg-primary/10 text-primary border-primary/40'
                                : 'bg-background border-border text-foreground hover:bg-muted/50'
                            }`}
                          >
                            {cat}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}

              {/* Add custom category button */}
              {catSearch.trim() && !ALL_DEFAULT_CATEGORIES.includes(catSearch.trim()) && (
                <div className="p-3">
                  <button
                    type="button"
                    onClick={() => { toggleCategory(catSearch.trim()); setCatSearch('') }}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    <Plus className="size-3.5" /> Добавить новую категорию &quot;{catSearch.trim()}&quot;
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      )}

      {/* История закупок — накладные этого поставщика */}
      <div className="max-w-7xl mx-auto w-full px-4 md:px-6 pb-8">
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
          <div className="flex items-center justify-between gap-3 pb-2 border-b border-border/60 flex-wrap">
            <div className="flex items-center gap-2">
              <History className="size-4.5 text-primary" />
              <h2 className="text-sm font-bold text-foreground">История закупок</h2>
            </div>
            {receipts.length > 0 && (
              <div className="flex items-center gap-4 text-xs">
                <span className="text-muted-foreground">Накладных: <span className="font-bold text-foreground tabular-nums">{receipts.length}</span></span>
                <span className="text-muted-foreground">Закуплено: <span className="font-bold text-foreground tabular-nums">{formatCurrency(totalPurchased)}</span></span>
                {totalReturned > 0.005 && (
                  <span className="text-muted-foreground">Возвращено: <span className="font-bold text-orange-600 dark:text-orange-400 tabular-nums">{formatCurrency(totalReturned)}</span></span>
                )}
                {totalDebt > 0.005 && (
                  <span className="text-muted-foreground">Долг: <span className="font-bold text-rose-600 dark:text-rose-400 tabular-nums">{formatCurrency(totalDebt)}</span></span>
                )}
              </div>
            )}
          </div>

          {loadingReceipts ? (
            <div className="py-10 flex items-center justify-center">
              <div className="size-6 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
          ) : sortedReceipts.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              У этого поставщика ещё нет накладных
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border/60">
                    <th className="text-left font-semibold py-2 pr-3">Дата</th>
                    <th className="text-left font-semibold py-2 pr-3">Оплата</th>
                    <th className="text-right font-semibold py-2 pr-3">Сумма</th>
                    <th className="text-right font-semibold py-2 pr-3">Оплачено</th>
                    <th className="text-right font-semibold py-2 pr-3">Возврат</th>
                    <th className="text-right font-semibold py-2">Долг</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedReceipts.map((r) => {
                    const badge = PAY_BADGE[r.paymentType] ?? PAY_BADGE.paid
                    const itemsCount = r.lines?.length ?? 0
                    const open = expandedReceipt === r.id
                    return (
                      <React.Fragment key={r.id}>
                      <tr
                        onClick={() => itemsCount > 0 && setExpandedReceipt(open ? null : r.id)}
                        className={`border-b border-border/40 last:border-0 transition-colors ${itemsCount > 0 ? 'cursor-pointer hover:bg-muted/30' : ''} ${open ? 'bg-muted/40' : ''}`}
                      >
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center gap-1.5">
                            {itemsCount > 0
                              ? (open ? <ChevronDown className="size-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />)
                              : <span className="size-3.5 shrink-0" />}
                            <div>
                              <div className="font-medium text-foreground tabular-nums">{r.date || '—'}</div>
                              {itemsCount > 0 && <div className="text-[11px] text-muted-foreground">{itemsCount} позиц.</div>}
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 pr-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${badge.cls}`}>
                            {badge.label}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-right font-semibold text-foreground tabular-nums">
                          {(returnsByReceipt.get(r.id) ?? 0) > 0.005 ? (
                            // Есть возврат — сумма «по факту» (нетто), исходная зачёркнута.
                            <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
                              <span className="text-xs text-muted-foreground line-through font-normal">{formatCurrency(r.totalAmount)}</span>
                              <span>{formatCurrency(r.totalAmount - (returnsByReceipt.get(r.id) ?? 0))}</span>
                            </span>
                          ) : formatCurrency(r.totalAmount)}
                        </td>
                        <td className="py-2.5 pr-3 text-right text-muted-foreground tabular-nums">{formatCurrency(r.paidAmount)}</td>
                        <td className="py-2.5 pr-3 text-right tabular-nums">
                          {(returnsByReceipt.get(r.id) ?? 0) > 0.005 ? (
                            <span className="inline-flex items-center gap-1 text-orange-600 dark:text-orange-400 font-medium">
                              <Undo2 className="size-3" />
                              {formatCurrency(returnsByReceipt.get(r.id) ?? 0)}
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2.5 text-right tabular-nums font-medium">
                          {r.debtAmount > 0.005 ? (() => {
                            const origDebt = r.totalAmount - r.paidAmount
                            const reduced = origDebt > r.debtAmount + 0.005
                            return (
                              <span className="inline-flex items-baseline gap-1 whitespace-nowrap text-rose-600 dark:text-rose-400">
                                {reduced && <span className="text-xs line-through opacity-60 font-normal">{formatCurrency(origDebt)}</span>}
                                <span>{formatCurrency(r.debtAmount)}</span>
                              </span>
                            )
                          })() : <span className="text-muted-foreground">0</span>}
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-muted/20">
                          <td colSpan={6} className="px-3 pb-3 pt-1">
                            <div className="rounded-lg border border-border/60 overflow-hidden">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40">
                                    <th className="text-left font-semibold px-3 py-1.5">Товар</th>
                                    <th className="text-right font-semibold px-3 py-1.5">Кол-во</th>
                                    <th className="text-right font-semibold px-3 py-1.5">Цена</th>
                                    <th className="text-right font-semibold px-3 py-1.5">Сумма</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(r.lines ?? []).map((l, i) => (
                                    <tr key={i} className="border-t border-border/40">
                                      <td className="px-3 py-1.5 text-foreground">{l.name}</td>
                                      <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">{l.qty} {l.unit}</td>
                                      <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">{formatCurrency(l.pricePerUnit)}</td>
                                      <td className="px-3 py-1.5 text-right font-medium text-foreground tabular-nums">{formatCurrency(dMul(l.qty, l.pricePerUnit))}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            {r.note && <p className="text-[11px] text-muted-foreground mt-2">Примечание: {r.note}</p>}
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
