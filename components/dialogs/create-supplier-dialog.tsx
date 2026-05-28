'use client'

import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { fetchIngredientCategories } from '@/lib/queries'
import type { Supplier } from '@/lib/types'
import { DecimalInput } from '@/components/ui/decimal-input'

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

interface CreateSupplierDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (supplier: SupplierForm) => void
  editingSupplier?: Supplier | null
}

const CATEGORY_GROUPS = [
  {
    label: 'Продукты',
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
    label: 'Хозтовары',
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

export function CreateSupplierDialog({ open, onOpenChange, onSubmit, editingSupplier }: CreateSupplierDialogProps) {
  const [ingredientCategories, setIngredientCategories] = useState<string[]>([])
  const [form, setForm] = useState<SupplierForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [catSearch, setCatSearch] = useState('')

  useEffect(() => {
    fetchIngredientCategories().then(setIngredientCategories)
  }, [])

  // ingredientCategories loaded but we use only DEFAULT groups

  // Reset form when dialog opens / editing supplier changes
  useEffect(() => {
    if (open) {
      if (editingSupplier) {
        setForm({
          name: editingSupplier.name,
          contactPerson: editingSupplier.contactPerson,
          phone: editingSupplier.phone,
          categories: editingSupplier.categories,
          paymentTermsDays: editingSupplier.paymentTermsDays,
          creditLimit: editingSupplier.creditLimit,
        })
      } else {
        setForm(emptyForm)
      }
    }
  }, [open, editingSupplier])

  function toggleCategory(cat: string) {
    setForm((prev) => ({
      ...prev,
      categories: prev.categories.includes(cat)
        ? prev.categories.filter((c) => c !== cat)
        : [...prev.categories, cat],
    }))
  }

  async function handleSubmit() {
    setSaving(true)
    try {
      await onSubmit(form)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const isEditing = !!editingSupplier
  const canSubmit = form.name.trim() && form.contactPerson.trim() && form.phone.trim() && form.categories.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Редактировать поставщика' : 'Новый поставщик'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Название <span className="text-destructive">*</span></label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="ООО Поставщик"
              className="w-full px-3 py-2.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Контактное лицо <span className="text-destructive">*</span></label>
              <input
                type="text"
                value={form.contactPerson}
                onChange={(e) => setForm((p) => ({ ...p, contactPerson: e.target.value }))}
                placeholder="Иванов Иван"
                className="w-full px-3 py-2.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Телефон <span className="text-destructive">*</span></label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value.replace(/[^\d+\-\s()]/g, '') }))}
                inputMode="tel"
                placeholder="+992 900 000000"
                className="w-full px-3 py-2.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          {/* Categories multi-select with search */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Категории товаров <span className="text-destructive">*</span></label>

            {/* Selected categories */}
            {form.categories.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {form.categories.map(cat => (
                  <button key={cat} type="button" onClick={() => toggleCategory(cat)}
                    className="px-2.5 py-1 rounded-lg text-xs font-medium bg-primary text-primary-foreground flex items-center gap-1">
                    {cat} <span className="text-primary-foreground/70">×</span>
                  </button>
                ))}
              </div>
            )}

            {/* Search input */}
            <input
              type="text"
              value={catSearch}
              onChange={e => setCatSearch(e.target.value)}
              placeholder="Поиск категории..."
              className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              onKeyDown={e => {
                if (e.key === 'Enter' && catSearch.trim()) {
                  e.preventDefault()
                  toggleCategory(catSearch.trim())
                  setCatSearch('')
                }
              }}
            />

            {/* Category groups */}
            <div className="max-h-48 overflow-y-auto rounded-lg border border-border divide-y divide-border">
              {CATEGORY_GROUPS.map(group => {
                const filtered = group.items.filter(c => !catSearch || c.toLowerCase().includes(catSearch.toLowerCase()))
                if (filtered.length === 0) return null
                return (
                  <div key={group.label} className="p-2">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">{group.label}</p>
                    <div className="flex flex-wrap gap-1">
                      {filtered.map(cat => (
                        <button key={cat} type="button" onClick={() => toggleCategory(cat)}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                            form.categories.includes(cat)
                              ? 'bg-primary/10 text-primary border-primary/30'
                              : 'bg-card border-border text-foreground hover:bg-muted'
                          }`}>
                          {cat}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
              {/* Extra categories from DB (only if they exist and match search) */}
              {/* Add custom on Enter */}
              {catSearch.trim() && !ALL_DEFAULT_CATEGORIES.includes(catSearch.trim()) && (
                <div className="p-2">
                  <button type="button" onClick={() => { toggleCategory(catSearch.trim()); setCatSearch('') }}
                    className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-primary text-primary-foreground">
                    + Добавить &quot;{catSearch.trim()}&quot;
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Отсрочка (дней)</label>
              <input
                type="number"
                min={0}
                value={form.paymentTermsDays}
                onChange={(e) => setForm((p) => ({ ...p, paymentTermsDays: parseInt(e.target.value) || 0 }))}
                className="w-full px-3 py-2.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <p className="text-xs text-muted-foreground">0 = оплата сразу</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Кредитный лимит</label>
              <DecimalInput
                value={form.creditLimit}
                onChange={(v) => setForm((p) => ({ ...p, creditLimit: v }))}
                min={0}
                placeholder="0 = без лимита"
                className="w-full px-3 py-2.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <p className="text-xs text-muted-foreground">Максимальная сумма долга</p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="px-4 py-2.5 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted transition-colors"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || saving}
            className="px-5 py-2.5 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            {saving ? 'Сохранение...' : isEditing ? 'Сохранить' : 'Добавить'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
