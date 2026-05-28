'use client'

import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { UNITS, type Ingredient } from '@/lib/types'
import { fetchIngredientCategories } from '@/lib/queries'
import { DecimalInput } from '@/components/ui/decimal-input'

interface IngredientForm {
  name: string
  category: string
  unit: string
  initialQty: number
  minQty: number
  pricePerUnit: number
  wastePercent: number
  isFood: boolean
}

interface ManageIngredientDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ingredient?: Ingredient
  defaultIsFood?: boolean
  onSubmit: (data: IngredientForm) => void
  onDelete?: (id: string) => void
}

export function ManageIngredientDialog({ open, onOpenChange, ingredient, defaultIsFood = true, onSubmit, onDelete }: ManageIngredientDialogProps) {
  const [form, setForm] = useState<IngredientForm>({
    name: '',
    category: '',
    unit: '',
    initialQty: 0,
    minQty: 0,
    pricePerUnit: 0,
    wastePercent: 0,
    isFood: true,
  })

  const [categories, setCategories] = useState<string[]>([])
  const [dataLoaded, setDataLoaded] = useState(false)
  const isEditing = !!ingredient

  const DEFAULT_FOOD_CATEGORIES = [
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
  ]
  const DEFAULT_SUPPLY_CATEGORIES = [
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
  ]

  useEffect(() => {
    if (open && !dataLoaded) {
      fetchIngredientCategories().then((c) => { setCategories(c); setDataLoaded(true) })
    }
  }, [open, dataLoaded])

  useEffect(() => {
    if (open) {
      if (ingredient) {
        setForm({
          name: ingredient.name,
          category: ingredient.category,
          unit: ingredient.unit,
          initialQty: ingredient.qty,
          minQty: ingredient.minQty,
          pricePerUnit: ingredient.pricePerUnit,
          wastePercent: ingredient.wastePercent ?? 0,
          isFood: ingredient.isFood ?? true,
        })
      } else {
        setForm({ name: '', category: '', unit: '', initialQty: 0, minQty: 0, pricePerUnit: 0, wastePercent: 0, isFood: defaultIsFood })
      }
    }
  }, [open, ingredient])

  function handleSubmit() {
    onSubmit(form)
    onOpenChange(false)
  }

  function handleDelete() {
    if (ingredient && onDelete) {
      onDelete(ingredient.id)
      onOpenChange(false)
    }
  }

  const canSubmit = form.name.trim().length > 0 && form.category.length > 0 && form.unit.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? (form.isFood ? 'Редактировать ингредиент' : 'Редактировать хозтовар') : (form.isFood ? 'Новый ингредиент' : 'Новый хозтовар')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Название</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="Рис басмати"
              className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Категория</label>
              <select
                value={form.category}
                onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Выберите категорию</option>
                {(form.isFood
                  ? [...new Set([...DEFAULT_FOOD_CATEGORIES, ...categories])]
                  : DEFAULT_SUPPLY_CATEGORIES
                ).sort().map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Единица измерения</label>
              <select
                value={form.unit}
                onChange={(e) => setForm((p) => ({ ...p, unit: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Выберите ед.</option>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Food / Supply toggle */}
          <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-muted/30">
            <div>
              <p className="text-xs font-medium text-foreground">Хозтовар</p>
              <p className="text-[10px] text-muted-foreground">Непищевой материал (салфетки, моющие и т.д.)</p>
            </div>
            <button type="button" onClick={() => setForm(p => ({ ...p, isFood: !p.isFood, wastePercent: p.isFood ? 0 : p.wastePercent }))}
              className={`relative w-10 h-5 rounded-full transition-colors ${!form.isFood ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
              <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform ${!form.isFood ? 'translate-x-5' : ''}`} />
            </button>
          </div>

          <div className={`grid grid-cols-1 ${form.isFood ? 'sm:grid-cols-4' : 'sm:grid-cols-3'} gap-3`}>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">{isEditing ? 'Остаток' : 'Нач. остаток'}</label>
              <DecimalInput
                value={form.initialQty}
                onChange={(v) => setForm((p) => ({ ...p, initialQty: v }))}
                min={0}
                placeholder="0"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Мин. остаток</label>
              <DecimalInput
                value={form.minQty}
                onChange={(v) => setForm((p) => ({ ...p, minQty: v }))}
                min={0}
                placeholder="0"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Цена за ед.</label>
              <DecimalInput
                value={form.pricePerUnit}
                onChange={(v) => setForm((p) => ({ ...p, pricePerUnit: v }))}
                min={0}
                placeholder="0"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            {form.isFood && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Отходы (%)</label>
                <DecimalInput
                  value={form.wastePercent}
                  onChange={(v) => setForm((p) => ({ ...p, wastePercent: v }))}
                  min={0}
                  max={90}
                  placeholder="0"
                  className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <p className="text-[10px] text-muted-foreground">Очистка, кожура и т.д.</p>
              </div>
            )}
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
            {isEditing ? 'Сохранить' : form.isFood ? 'Добавить ингредиент' : 'Добавить хозтовар'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
