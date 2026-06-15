'use client'

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, CheckCircle, Tag, Search, Plus, X, Phone, User, Landmark } from 'lucide-react'
import { fetchIngredientCategories, createSupplier } from '@/lib/queries'
import { DecimalInput } from '@/components/ui/decimal-input'
import { toast } from 'sonner'

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

export default function NewSupplierPage() {
  const navigate = useNavigate()
  const [form, setForm] = useState<SupplierForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [catSearch, setCatSearch] = useState('')
  const [ingredientCategories, setIngredientCategories] = useState<string[]>([])

  useEffect(() => {
    fetchIngredientCategories().then(setIngredientCategories).catch(console.error)
  }, [])

  function toggleCategory(cat: string) {
    setForm((prev) => ({
      ...prev,
      categories: prev.categories.includes(cat)
        ? prev.categories.filter((c) => c !== cat)
        : [...prev.categories, cat],
    }))
  }

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.contactPerson.trim() || !form.phone.trim() || form.categories.length === 0 || saving) return
    setSaving(true)
    try {
      await createSupplier({ ...form, currentDebt: 0 })
      toast.success('Поставщик добавлен')
      navigate('/warehouse/suppliers')
    } catch (e) {
      toast.error('Ошибка создания поставщика')
    } finally {
      setSaving(false)
    }
  }

  const canSubmit = form.name.trim() && form.contactPerson.trim() && form.phone.trim() && form.categories.length > 0

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
            Новый поставщик
          </h1>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || saving}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            <CheckCircle className="size-4" />
            {saving ? 'Сохранение...' : 'Добавить поставщика'}
          </button>
        </div>
      </div>

      {/* Body */}
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
    </div>
  )
}
