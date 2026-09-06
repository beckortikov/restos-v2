'use client'

import { useState, useEffect, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, CheckCircle, Tag, Search, Plus, X, Phone, User, Landmark, Trash2, History, ChevronDown, ChevronRight, Pencil, Undo2, Banknote } from 'lucide-react'
import { fetchIngredientCategories, fetchSuppliers, updateSupplier, deleteSupplier, fetchReceipts, fetchStockReturns, createSupplierOpeningDebt, updateSupplierOpeningDebt, fetchFinancialOperations } from '@/lib/queries'
import { DecimalInput } from '@/components/ui/decimal-input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { RETURN_REASON_LABELS } from '@/lib/types'
import { dMul } from '@/lib/decimal'
import { toast } from 'sonner'
import type { Supplier, StockReceipt, StockReturn, FinancialOperation } from '@/lib/types'

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
  // Платежи поставщику (гашение долга) — supplier_payment из financial_operations.
  // Раньше на карточке их не было: платёж лишь уменьшал долг у накладной, а
  // «когда и сколько заплатили» нигде не показывалось (запрос владельца).
  const [supplierPayments, setSupplierPayments] = useState<FinancialOperation[]>([])

  // Долг поставщику без накладной (067) — перенос задолженности с момента до
  // перехода на систему.
  const [showOpeningDebt, setShowOpeningDebt] = useState(false)
  const [debtAmount, setDebtAmount] = useState(0)
  const [debtNote, setDebtNote] = useState('')
  const [debtDate, setDebtDate] = useState('')
  const [savingDebt, setSavingDebt] = useState(false)
  // editingDebt — правим уже внесённый долг (id записи + сколько по нему уже
  // оплачено: ниже этой суммы бэк не даст опустить, показываем это в форме).
  const [editingDebt, setEditingDebt] = useState<{ id: string; paid: number } | null>(null)

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
  // Сами документы возвратов по накладной — чтобы в раскрытой накладной было
  // видно, ЧТО и сколько вернули (а не только итоговую сумму). Отменённые тоже
  // показываем — зачёркнутыми, чтобы ошибка и её исправление были видны.
  const returnDocsByReceipt = useMemo(() => {
    const m = new Map<string, StockReturn[]>()
    for (const r of returns) {
      const arr = m.get(r.receiptId) ?? []
      arr.push(r)
      m.set(r.receiptId, arr)
    }
    return m
  }, [returns])
  const sortedReceipts = useMemo(
    () => [...receipts].sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    [receipts],
  )
  // Платежи именно этого поставщика: новые привязаны по source_ref=supplier.id
  // (переименование не теряет их), старые — по имени контрагента.
  const payments = useMemo(() => {
    const name = supplier?.name
    return supplierPayments
      .filter(p => p.sourceRef === id || (!!name && p.counterparty === name))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  }, [supplierPayments, id, supplier?.name])
  const totalPaid = useMemo(() => payments.reduce((s, p) => s + p.amount, 0), [payments])

  useEffect(() => {
    if (!id) return
    setLoadingReceipts(true)
    Promise.all([fetchReceipts({ supplierId: id }), fetchStockReturns({ supplierId: id }), fetchFinancialOperations()])
      .then(([rc, rt, ops]) => {
        setReceipts(rc); setReturns(rt)
        setSupplierPayments(ops.filter(o => o.category === 'supplier_payment'))
      })
      .catch(() => { setReceipts([]); setReturns([]); setSupplierPayments([]) })
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

  function openDebtEditor(r: StockReceipt) {
    // «Погашено» = total − debt, а не paidAmount: гашение долга (/pay-debt)
    // уменьшает только debt_amount и paidAmount не ведёт — у частично
    // погашенного начального долга он остаётся нулём. Ниже этой суммы бэк
    // не пустит (409).
    setEditingDebt({ id: r.id, paid: Math.max(0, r.totalAmount - r.debtAmount) })
    setDebtAmount(r.totalAmount)
    setDebtNote(r.note ?? '')
    setDebtDate(r.date ?? '')
    setShowOpeningDebt(true)
  }

  async function handleSaveOpeningDebt() {
    if (!supplier || debtAmount <= 0 || savingDebt) return
    if (editingDebt && debtAmount < editingDebt.paid - 0.001) return
    setSavingDebt(true)
    try {
      if (editingDebt) {
        await updateSupplierOpeningDebt(supplier.id, editingDebt.id, {
          amount: debtAmount, note: debtNote.trim(), date: debtDate || undefined,
        })
        toast.success('Долг изменён')
      } else {
        await createSupplierOpeningDebt(supplier.id, debtAmount, debtNote.trim() || undefined, debtDate || undefined)
        toast.success(`Долг ${formatCurrency(debtAmount)} внесён`)
      }
      // Долг и накладные перечитываем с сервера: при правке дельта считается
      // на бэке (сумма минус уже оплаченное), локально её не угадать.
      fetchSuppliers().then(list => {
        const fresh = list.find(s => s.id === supplier.id)
        if (fresh) setSupplier(fresh)
      }).catch(() => {})
      fetchReceipts({ supplierId: supplier.id }).then(setReceipts).catch(() => {})
      setShowOpeningDebt(false)
      setEditingDebt(null)
      setDebtAmount(0)
      setDebtNote('')
      setDebtDate('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить долг')
    } finally {
      setSavingDebt(false)
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
                <button
                  type="button"
                  onClick={() => { setEditingDebt(null); setDebtAmount(0); setDebtNote(''); setDebtDate(''); setShowOpeningDebt(true) }}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  title="Долг, который был у поставщика до перехода на эту кассу — без накладной"
                >
                  <Plus className="size-3" />указать долг
                </button>
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

      {/* Платежи — гашение долга (supplier_payment): когда и сколько заплатили.
          Раньше на карточке их не было — платёж лишь «худил» долг накладной. */}
      <div className="max-w-7xl mx-auto w-full px-4 md:px-6 pb-2">
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between gap-3 pb-2 border-b border-border/60">
            <div className="flex items-center gap-2">
              <Banknote className="size-4.5 text-primary" />
              <h2 className="text-sm font-bold text-foreground">Платежи</h2>
            </div>
            {payments.length > 0 && (
              <span className="text-xs text-muted-foreground">
                Всего оплачено: <span className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{formatCurrency(totalPaid)}</span> · {payments.length}
              </span>
            )}
          </div>
          {loadingReceipts ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Загрузка…</p>
          ) : payments.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Платежей поставщику ещё не было</p>
          ) : (
            <div className="divide-y divide-border/60">
              {payments.map(p => (
                <div key={p.id} className="flex items-center gap-3 py-2.5">
                  <span className="text-xs text-muted-foreground tabular-nums w-24 shrink-0">{p.date || '—'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">{p.description || 'Оплата долга'}</p>
                    {p.accountName && <p className="text-[11px] text-muted-foreground truncate">со счёта «{p.accountName}»</p>}
                  </div>
                  <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400 tabular-nums shrink-0">{formatCurrency(p.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

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
                {totalPaid > 0.005 && (
                  <span className="text-muted-foreground">Оплачено: <span className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{formatCurrency(totalPaid)}</span></span>
                )}
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
            <div className="space-y-2">
              {sortedReceipts.map((r) => {
                const badge = r.isOpeningDebt
                  ? { label: 'Начальный долг', cls: 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400' }
                  : (PAY_BADGE[r.paymentType] ?? PAY_BADGE.paid)
                const itemsCount = r.lines?.length ?? 0
                const expandable = itemsCount > 0 || r.isOpeningDebt
                const open = expandedReceipt === r.id
                const ret = returnsByReceipt.get(r.id) ?? 0
                const origDebt = r.totalAmount - r.paidAmount
                const debtReduced = r.debtAmount > 0.005 && origDebt > r.debtAmount + 0.005
                return (
                  <div key={r.id} className="rounded-lg border border-border overflow-hidden">
                    <button
                      type="button"
                      onClick={() => expandable && setExpandedReceipt(open ? null : r.id)}
                      className={`w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors ${expandable ? 'hover:bg-muted/40' : ''} ${open ? 'bg-muted/30' : ''}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-foreground tabular-nums">{r.date || '—'}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${badge.cls}`}>{badge.label}</span>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground mt-1">
                          {r.isOpeningDebt ? (
                            <span>внесён вручную, без накладной</span>
                          ) : itemsCount > 0 && <span>{itemsCount} позиц.</span>}
                          {r.paidAmount > 0.005 && <span>оплачено {formatCurrency(r.paidAmount)}</span>}
                          {ret > 0.005 && (
                            <span className="text-orange-600 dark:text-orange-400 inline-flex items-center gap-0.5">
                              <Undo2 className="size-2.5" />возврат {formatCurrency(ret)}
                            </span>
                          )}
                          {r.debtAmount > 0.005 && (
                            <span className="text-rose-600 dark:text-rose-400 font-medium inline-flex items-baseline gap-1">
                              долг
                              {debtReduced && <span className="line-through opacity-60">{formatCurrency(origDebt)}</span>}
                              <span className="font-bold">{formatCurrency(r.debtAmount)}</span>
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {ret > 0.005 ? (
                          <span className="flex items-baseline gap-1 whitespace-nowrap">
                            <span className="text-xs text-muted-foreground line-through tabular-nums">{formatCurrency(r.totalAmount)}</span>
                            <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(r.totalAmount - ret)}</span>
                          </span>
                        ) : (
                          <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(r.totalAmount)}</span>
                        )}
                        {expandable && (open
                          ? <ChevronDown className="size-4 text-muted-foreground" />
                          : <ChevronRight className="size-4 text-muted-foreground" />)}
                      </div>
                    </button>
                    {open && (
                      <div className="border-t border-border bg-muted/20">
                        <div className="divide-y divide-border/60">
                          {(r.lines ?? []).map((l, i) => (
                            <div key={i} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                              <span className="flex-1 text-foreground truncate">{l.name}</span>
                              <span className="text-muted-foreground tabular-nums whitespace-nowrap">{l.qty} {l.unit} × {formatCurrency(l.pricePerUnit)}</span>
                              <span className="font-medium text-foreground tabular-nums w-20 text-right">{formatCurrency(dMul(l.qty, l.pricePerUnit))}</span>
                            </div>
                          ))}
                        </div>
                        {r.note && <p className="text-[11px] text-muted-foreground px-3 py-2 border-t border-border/60">Примечание: {r.note}</p>}

                        {/* Начальный долг правится только отсюда: у записи нет
                            товарных строк, и общий редактор накладных вывел бы
                            сумму из них (то есть ноль). */}
                        {r.isOpeningDebt && (
                          <div className="border-t border-border/60 px-3 py-2">
                            <button
                              type="button"
                              onClick={() => openDebtEditor(r)}
                              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                            >
                              <Pencil className="size-3" />
                              Изменить долг
                            </button>
                          </div>
                        )}

                        {/* Возвраты по этой накладной — какие позиции и на сколько
                            вернули (в т.ч. частичный). Отменённые — зачёркнуты. */}
                        {(returnDocsByReceipt.get(r.id) ?? []).length > 0 && (
                          <div className="border-t border-border p-3 space-y-2">
                            <p className="text-[11px] font-semibold text-orange-600 dark:text-orange-400 flex items-center gap-1.5">
                              <Undo2 className="size-3" /> Возвраты по накладной
                            </p>
                            {(returnDocsByReceipt.get(r.id) ?? []).map((ret) => {
                              const cancelled = !!ret.cancelledAt
                              return (
                                <div key={ret.id} className={`rounded-lg border border-border bg-card overflow-hidden ${cancelled ? 'opacity-55' : ''}`}>
                                  <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-orange-50 dark:bg-orange-500/10 border-b border-border">
                                    <span className="text-[11px] font-medium text-foreground">
                                      {ret.date} · {RETURN_REASON_LABELS[ret.reason]}
                                      {cancelled && <span className="ml-1.5 text-muted-foreground">(отменён)</span>}
                                    </span>
                                    <span className={`text-[11px] font-bold tabular-nums ${cancelled ? 'line-through text-muted-foreground' : 'text-orange-600 dark:text-orange-400'}`}>
                                      −{formatCurrency(ret.totalAmount)}
                                    </span>
                                  </div>
                                  <div className="divide-y divide-border/60">
                                    {ret.lines.map((l) => (
                                      <div key={l.id} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                                        <span className="flex-1 text-foreground truncate">{l.name}</span>
                                        <span className="text-muted-foreground tabular-nums whitespace-nowrap">{formatNum(l.qty)} {l.unit}</span>
                                        <span className="font-medium text-foreground tabular-nums w-20 text-right">{formatCurrency(dMul(l.qty, l.pricePerUnit))}</span>
                                      </div>
                                    ))}
                                  </div>
                                  {ret.note && <p className="text-[11px] text-muted-foreground px-3 py-1.5 border-t border-border/60">Комментарий: {ret.note}</p>}
                                </div>
                              )
                            })}
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
      </div>

      {/* Долг без накладной — перенос задолженности с момента до перехода на систему. */}
      <Dialog
        open={showOpeningDebt}
        onOpenChange={(v) => {
          setShowOpeningDebt(v)
          if (!v) { setDebtAmount(0); setDebtNote(''); setDebtDate(''); setEditingDebt(null) }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingDebt ? 'Изменить начальный долг' : 'Долг поставщику без накладной'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {editingDebt ? (
                <>Исправьте сумму, дату или комментарий. Задолженность поставщика пересчитается
                  на разницу — остатки склада это не тронет.</>
              ) : (
                <>Если у {supplier?.name || 'поставщика'} уже был долг ещё до перехода на эту кассу —
                  впишите сумму здесь. Остатки склада это не тронет: долг сразу встанет в общую
                  задолженность и гасится обычной оплатой, как по накладной.</>
              )}
            </p>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Сумма долга</label>
              <DecimalInput
                value={debtAmount}
                onChange={setDebtAmount}
                min={0}
                placeholder="0"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              {/* Часть долга могла быть уже погашена — ниже этой суммы бэк не
                  пустит (иначе по записи получилась бы необъяснимая переплата). */}
              {editingDebt && editingDebt.paid > 0.005 && (
                <p className={`text-xs ${debtAmount < editingDebt.paid - 0.001 ? 'text-destructive' : 'text-muted-foreground'}`}>
                  Уже погашено {formatCurrency(editingDebt.paid)} — сумма не может быть меньше.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Дата возникновения <span className="text-muted-foreground font-normal">(необязательно)</span>
              </label>
              <input
                type="date"
                value={debtDate}
                onChange={(e) => setDebtDate(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Комментарий <span className="text-muted-foreground font-normal">(необязательно)</span>
              </label>
              <input
                type="text"
                value={debtNote}
                onChange={(e) => setDebtNote(e.target.value)}
                placeholder="Например: долг по старой системе учёта"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setShowOpeningDebt(false)}
              disabled={savingDebt}
              className="px-4 py-2 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={handleSaveOpeningDebt}
              disabled={debtAmount <= 0 || savingDebt || (!!editingDebt && debtAmount < editingDebt.paid - 0.001)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
            >
              <Banknote className="size-4" />
              {savingDebt ? 'Сохраняю…' : editingDebt ? 'Сохранить' : 'Внести долг'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
