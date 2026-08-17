'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { UNITS, type Ingredient, type StockMovement, type StockMovementType } from '@/lib/types'
import { fetchIngredientCategories, fetchStockMovements } from '@/lib/queries'
import { DecimalInput } from '@/components/ui/decimal-input'
import { formatTime, formatNum } from '@/lib/helpers'
import { ArrowDownToLine, ArrowUpFromLine, FlaskConical, ClipboardCheck, SlidersHorizontal, CookingPot, History, Undo2 } from 'lucide-react'

// Стиль движений — как в «Истории движений» (warehouse/history), чтобы карточка
// товара читалась одинаково с общей историей.
const MOVE_META: Record<StockMovementType, { label: string; color: string; bg: string; Icon: React.ElementType }> = {
  in:    { label: 'Приход',         color: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-950/40', Icon: ArrowDownToLine },
  out:   { label: 'Расход',         color: 'text-destructive', bg: 'bg-red-100 dark:bg-red-950/40',         Icon: ArrowUpFromLine },
  return: { label: 'Возврат',       color: 'text-orange-600',  bg: 'bg-orange-100 dark:bg-orange-950/40',   Icon: Undo2 },
  batch: { label: 'Приготовление',  color: 'text-purple-600',  bg: 'bg-purple-100 dark:bg-purple-950/40',   Icon: CookingPot },
  semi:  { label: 'Производство',   color: 'text-blue-600',    bg: 'bg-blue-100 dark:bg-blue-950/40',       Icon: FlaskConical },
  audit: { label: 'Инвентаризация', color: 'text-amber-600',   bg: 'bg-amber-100 dark:bg-amber-950/40',     Icon: ClipboardCheck },
  adj:   { label: 'Корректировка',  color: 'text-muted-foreground', bg: 'bg-muted',                         Icon: SlidersHorizontal },
}

interface IngredientForm {
  name: string
  category: string
  unit: string
  initialQty: number
  minQty: number
  pricePerUnit: number
  wastePercent: number
  unitWeight: number
  unitWeightUnit: string
  isFood: boolean
}

// Штучные единицы (нет универсального метрического коэффициента к г/мл).
// Для них тех-карта в весе/объёме требует per-unit фактор («1 банка = 340 г»).
const DISCRETE_UNITS = ['шт', 'порц', 'уп', 'бут']
function isDiscreteUnit(u: string): boolean {
  const n = u.toLowerCase().trim().replace(/\.$/, '')
  return DISCRETE_UNITS.includes(n)
}

interface ManageIngredientDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ingredient?: Ingredient
  defaultIsFood?: boolean
  allIngredients?: Ingredient[]
  onSubmit: (data: IngredientForm) => void
  onDelete?: (id: string) => void
}

export function ManageIngredientDialog({ open, onOpenChange, ingredient, defaultIsFood = true, allIngredients, onSubmit, onDelete }: ManageIngredientDialogProps) {
  const [form, setForm] = useState<IngredientForm>({
    name: '',
    category: '',
    unit: '',
    initialQty: 0,
    minQty: 0,
    pricePerUnit: 0,
    wastePercent: 0,
    unitWeight: 0,
    unitWeightUnit: 'г',
    isFood: true,
  })

  const [categories, setCategories] = useState<string[]>([])
  const [dataLoaded, setDataLoaded] = useState(false)
  const [movements, setMovements] = useState<StockMovement[]>([])
  const [loadingMovements, setLoadingMovements] = useState(false)
  const isEditing = !!ingredient

  // Движения товара (приход → расход/продажа) — грузим при открытии карточки
  // существующего товара. Для нового (create) движений ещё нет.
  useEffect(() => {
    if (!open || !ingredient?.id) { setMovements([]); return }
    setLoadingMovements(true)
    fetchStockMovements({ ingredientId: ingredient.id })
      .then(setMovements)
      .catch(() => setMovements([]))
      .finally(() => setLoadingMovements(false))
  }, [open, ingredient?.id])

  const moveSummary = useMemo(() => {
    let received = 0, consumed = 0
    for (const m of movements) {
      if (m.qty > 0) received += m.qty
      else consumed += -m.qty
    }
    return { received, consumed }
  }, [movements])

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
          unitWeight: ingredient.unitWeight ?? 0,
          unitWeightUnit: ingredient.unitWeightUnit || 'г',
          isFood: ingredient.isFood ?? true,
        })
      } else {
        setForm({ name: '', category: '', unit: '', initialQty: 0, minQty: 0, pricePerUnit: 0, wastePercent: 0, unitWeight: 0, unitWeightUnit: 'г', isFood: defaultIsFood })
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

  // Тёзка среди уже существующих товаров — не блокирует сохранение, только
  // предупреждает (одинаковые названия в разных категориях путают в закупе/кассе).
  const nameMatch = useMemo(() => {
    const q = form.name.trim().toLowerCase()
    if (!q || !allIngredients) return null
    return allIngredients.find((i) => i.id !== ingredient?.id && i.name.trim().toLowerCase() === q) ?? null
  }, [form.name, allIngredients, ingredient?.id])

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
            {nameMatch && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                Такое название уже есть: «{nameMatch.name}» ({nameMatch.isFood === false ? 'Хозтовар' : 'Продукт'}
                {nameMatch.category ? `, ${nameMatch.category}` : ''}). Возможно, это тот же товар.
              </p>
            )}
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

          {/* Per-unit фактор: только для штучных пищевых ингредиентов, у которых
              тех-карта пишется в весе/объёме (1 банка = 340 г). Опционально. */}
          {form.isFood && isDiscreteUnit(form.unit) && (
            <div className="space-y-1.5 px-3 py-2.5 rounded-lg border border-border bg-muted/30">
              <label className="text-sm font-medium text-foreground">Вес/объём одной единицы (необязательно)</label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground whitespace-nowrap">1 {form.unit || 'шт.'} =</span>
                <DecimalInput
                  value={form.unitWeight}
                  onChange={(v) => setForm((p) => ({ ...p, unitWeight: v }))}
                  min={0}
                  placeholder="0"
                  className="flex-1 min-w-0 px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <select
                  value={form.unitWeightUnit}
                  onChange={(e) => setForm((p) => ({ ...p, unitWeightUnit: e.target.value }))}
                  className="px-2 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <option value="г">г</option>
                  <option value="кг">кг</option>
                  <option value="мл">мл</option>
                  <option value="л">л</option>
                </select>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Для пересчёта расхода в тех-карте (в г/мл) в штучный остаток. Оставьте 0, если не нужно.
              </p>
            </div>
          )}
        </div>

        {isEditing && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-2 mb-2.5">
              <div className="flex items-center gap-2">
                <History className="size-4 text-primary" />
                <h3 className="text-sm font-bold text-foreground">Движение товара</h3>
              </div>
              {movements.length > 0 && (
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="text-muted-foreground">Приход <span className="font-bold text-emerald-600 tabular-nums">+{formatNum(moveSummary.received)}</span></span>
                  <span className="text-muted-foreground">Расход <span className="font-bold text-destructive tabular-nums">−{formatNum(moveSummary.consumed)}</span></span>
                </div>
              )}
            </div>

            {loadingMovements ? (
              <div className="py-6 flex items-center justify-center">
                <div className="size-5 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
              </div>
            ) : movements.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">Движений по товару пока нет</p>
            ) : (
              <div className="max-h-56 overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
                {movements.map((m) => {
                  const meta = MOVE_META[m.type] ?? MOVE_META.adj
                  const Icon = meta.Icon
                  return (
                    <div key={m.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/30 transition-colors">
                      <div className={`size-7 rounded-lg flex items-center justify-center shrink-0 ${meta.bg}`}>
                        <Icon className={`size-3.5 ${meta.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${meta.bg} ${meta.color}`}>{meta.label}</span>
                          {m.belowZero && <span className="text-[11px] px-1.5 py-0.5 rounded font-medium bg-destructive/10 text-destructive">ниже 0</span>}
                        </div>
                        {m.description && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{m.description}</p>}
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`text-sm font-semibold tabular-nums ${m.qty > 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                          {m.qty > 0 ? '+' : ''}{formatNum(m.qty)} {m.unit}
                        </p>
                        <p className="text-[11px] text-muted-foreground">{formatTime(m.timestamp)}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

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
