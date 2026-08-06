'use client'

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Timer, ArrowLeft, CheckCircle, Network, Plus } from 'lucide-react'
import { DishImageUpload } from '@/components/dish-image'
import {
  UNITS,
  ALL_STATIONS, STATION_LABELS, STATION_ICONS,
  type TechCardLine,
  type Ingredient,
  type SemiFinishedType,
  type MenuStation,
} from '@/lib/types'
import { fetchIngredients, fetchSemiTypes, fetchMenuCategories, createMenuItem as createMenuItemDb, createIngredient, syncMenuAttributes, replaceTechCardLines, updateMenuItem } from '@/lib/queries'
import { createNetworkMenuItem } from '@/lib/queries/transfers'
import { useNetworkStatus } from '@/hooks/use-network-status'
import { DecimalInput } from '@/components/ui/decimal-input'
import { useAuth } from '@/lib/auth-store'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Layers } from 'lucide-react'
import { AttributesForm, ComboPricesEditor, attrsValid, attrsComplete, combosCount, combosOf, comboLabelSetKey, buildCombosPayload, MAX_COMBOS, type AttrForm, type ComboPrices } from '@/components/menu/attributes-editor'
import { TechCardLinesEditor, emptyTechLine } from '@/components/menu/tech-card-lines-editor'
import { ManageCategoriesDialog } from '@/components/dialogs/manage-categories-dialog'

interface MenuItemForm {
  name: string
  category: string
  price: number
  emoji: string
  imageUrl?: string
  cogs: number
  cookTimeMin?: number | null
  station: MenuStation
  isAvailable: boolean
  isBatchCooking?: boolean
  lowStockThreshold?: number
  isPurchased?: boolean
  purchasePrice?: number
  purchaseUnit?: string
  purchaseMinQty?: number
  unit: 'piece' | 'g' | 'kg'
  unitSize: number
  saleStep: number
  techCard: TechCardLine[]
}

// ─── Page Component ──────────────────────────────────────────────────────────
export default function NewMenuItemPage() {
  const navigate = useNavigate()
  const { restaurant } = useAuth()
  const techCardsEnabled = restaurant?.techCardsEnabled ?? true
  // Техкарта ОБЯЗАТЕЛЬНА только в строгом режиме (техкарты + контроль остатков).
  // В мягком режиме (контроль выключен) техкарта необязательна — блюдо можно
  // создать и продавать без списания (бэк: stockcheck ModeTechCardOnly).
  const enforceStockCheck = restaurant?.enforceStockCheck ?? false
  const requireTechCard = techCardsEnabled && enforceStockCheck

  // «Блюдо сети» — сеть определяется реактивно (useNetworkStatus). Тумблер
  // скрыт для вариативных товаров (атрибуты/размеры): NetworkMenuItem — плоская
  // сущность без вариантов (ADR-004, applyNetworkMenu не знает про атрибуты).
  const { inNetwork } = useNetworkStatus()
  const [isNetworkDish, setIsNetworkDish] = useState(false)

  const [form, setForm] = useState<MenuItemForm>({
    name: '',
    category: '',
    price: 0,
    emoji: '',
    cogs: 0,
    cookTimeMin: null,
    station: 'hot_kitchen',
    isAvailable: true,
    unit: 'piece',
    unitSize: 1,
    saleStep: 0,
    techCard: [{ ...emptyTechLine }],
  })

  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [semiTypes, setSemiTypes] = useState<SemiFinishedType[]>([])
  const [menuCategories, setMenuCategories] = useState<string[]>([])
  const [categoriesDialogOpen, setCategoriesDialogOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  // Атрибуты (Размер/Вкус). Когда заданы — у товара нет собственной цены:
  // цены задаются per-комбинация, бэк генерирует варианты после создания.
  const [attrs, setAttrs] = useState<AttrForm[]>([])
  const [comboPrices, setComboPrices] = useState<ComboPrices>({})
  const hasAttrs = attrs.length > 0
  const combos = hasAttrs ? combosOf(attrs) : []
  // Техкарта КАЖДОЙ комбинации атрибутов, введённая ДО первого сохранения
  // товара (варианты ещё не существуют на бэке — храним локально по ключу
  // комбинации, разносим по реальным вариантам в handleSubmit после sync).
  const [techCardsByCombo, setTechCardsByCombo] = useState<Record<string, TechCardLine[]>>({})
  const [selectedComboKey, setSelectedComboKey] = useState('')
  const activeComboKey = combos.some(c => c.key === selectedComboKey) ? selectedComboKey : (combos[0]?.key ?? '')
  const activeCombo = combos.find(c => c.key === activeComboKey)
  const activeComboMatchingSemiIds = activeCombo && activeCombo.sizeScaleValueIds.length > 0
    ? new Set(activeCombo.sizeScaleValueIds)
    : undefined

  // Quick Create States
  const [quickCreateOpen, setQuickCreateOpen] = useState(false)
  const [quickCreateName, setQuickCreateName] = useState('')
  const [quickCreateTargetIndex, setQuickCreateTargetIndex] = useState<number | null>(null)
  // Аналог quickCreateTargetIndex, но для техкарты варианта (per-combo);
  // ровно один из двух target-ов задан, когда открыт диалог quick-create.
  const [quickCreateComboTarget, setQuickCreateComboTarget] = useState<{ comboKey: string; index: number } | null>(null)
  const [newIngUnit, setNewIngUnit] = useState('кг')
  const [newIngCategory, setNewIngCategory] = useState('Продукты')
  const [newIngPrice, setNewIngPrice] = useState(0)
  const [newIngMinQty, setNewIngMinQty] = useState(0)
  const [newIngIsFood, setNewIngIsFood] = useState(true)
  const [creatingIngredient, setCreatingIngredient] = useState(false)

  useEffect(() => {
    Promise.all([fetchIngredients(), fetchSemiTypes(), fetchMenuCategories()])
      .then(([i, s, c]) => {
        setIngredients(i)
        setSemiTypes(s)
        setMenuCategories(c)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  function updateTechLine(index: number, patch: Partial<TechCardLine>) {
    setForm((prev) => {
      const techCard = [...prev.techCard]
      techCard[index] = { ...techCard[index], ...patch }
      return { ...prev, techCard }
    })
  }

  function selectIngredient(index: number, id: string, customIng?: Ingredient) {
    const ing = customIng || ingredients.find((i) => i.id === id)
    if (!ing) return
    updateTechLine(index, { ingredientId: id, semiId: undefined, name: ing.name, unit: ing.unit })
  }

  const handleQuickCreateIngredient = async (e: React.FormEvent) => {
    e.preventDefault()
    if (creatingIngredient || !quickCreateName.trim()) return
    if (quickCreateTargetIndex === null && !quickCreateComboTarget) return
    setCreatingIngredient(true)
    try {
      const ing = await createIngredient({
        name: quickCreateName.trim(),
        category: newIngCategory.trim() || 'Продукты',
        qty: 0,
        min_qty: newIngMinQty || 0,
        unit: newIngUnit,
        price_per_unit: newIngPrice || 0,
        is_food: newIngIsFood,
      })
      if (ing) {
        setIngredients((prev) => [...prev, ing])
        if (quickCreateComboTarget) {
          const { comboKey, index } = quickCreateComboTarget
          setTechCardsByCombo(prev => {
            const lines = [...(prev[comboKey] ?? [])]
            lines[index] = { ...lines[index], ingredientId: ing.id, semiId: undefined, name: ing.name, unit: ing.unit }
            return { ...prev, [comboKey]: lines }
          })
        } else if (quickCreateTargetIndex !== null) {
          selectIngredient(quickCreateTargetIndex, ing.id, ing)
        }
        setQuickCreateOpen(false)
        setQuickCreateName('')
        setQuickCreateTargetIndex(null)
        setQuickCreateComboTarget(null)
        setNewIngUnit('кг')
        setNewIngCategory('Продукты')
        setNewIngPrice(0)
        setNewIngMinQty(0)
        setNewIngIsFood(true)
        toast.success(`Товар «${ing.name}» создан и добавлен в техкарту`)
      }
    } catch (err) {
      toast.error('Ошибка создания товара')
    } finally {
      setCreatingIngredient(false)
    }
  }

  const handleSubmit = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      // Покупной товар целиком ведёт бэк: по is_purchased + purchase_* он сам
      // создаёт складской ингредиент (0 остаток) + 1:1 техкарту + станцию showcase.
      // С атрибутами собственная цена товару не нужна (цены — на значениях).
      const created = await createMenuItemDb({
        ...form,
        price: hasAttrs ? 0 : form.price,
        stopListOverride: false,
        station: form.station,
        preparedQty: 0,
        isBatchCooking: form.isBatchCooking ?? false,
      })
      if (hasAttrs && created?.id) {
        const state = await syncMenuAttributes(
          created.id,
          attrs.map(a => ({
            name: a.name.trim(),
            sizeScaleId: a.sizeScaleId,
            values: a.values.map(v => ({ label: v.label.trim() })),
          })),
          buildCombosPayload(attrs, comboPrices),
        )
        // Разносим локально введённые техкарты по только что созданным
        // вариантам. Матчим по НАБОРУ лейблов (comboLabelSetKey), а не по id —
        // у локальных значений до сохранения нет реального id варианта, а
        // variantValueIds от бэка отсортированы, не в порядке атрибутов.
        const labelById = new Map<string, string>()
        for (const a of state.attributes) for (const v of a.values) labelById.set(v.id, v.label)
        const savePromises: Promise<void>[] = []
        for (const variant of state.variants) {
          const labels = (variant.variantValueIds ?? [])
            .map(id => labelById.get(id))
            .filter((x): x is string => !!x)
          const key = comboLabelSetKey(labels)
          const localCombo = combos.find(c => comboLabelSetKey(c.labels) === key)
          const lines = localCombo ? (techCardsByCombo[localCombo.key] ?? []).filter(l => l.ingredientId || l.semiId) : []
          if (lines.length > 0) savePromises.push(replaceTechCardLines(variant.id, lines))
        }
        if (savePromises.length > 0) await Promise.all(savePromises)
        toast.success(`Товар добавлен · вариантов: ${state.variants.length}`)
      } else {
        toast.success(form.isPurchased ? 'Покупной товар добавлен' : 'Блюдо добавлено')
      }
      // Привязка к сети — отдельным шагом, не откатывает уже созданное блюдо
      // при сбое (тот же паттерн, что и линковка номенклатуры у ингредиента).
      if (isNetworkDish && !hasAttrs && created?.id) {
        try {
          const master = await createNetworkMenuItem({
            name: form.name,
            category: form.category,
            basePrice: form.price,
            station: form.station,
            unit: form.unit,
            emoji: form.emoji,
          })
          await updateMenuItem(created.id, { masterId: master.id })
        } catch {
          toast.error('Блюдо создано, но не удалось сделать его сетевым — привяжите вручную позже')
        }
      }
      navigate('/warehouse/menu')
    } catch {
      toast.error('Ошибка при добавлении блюда')
    } finally {
      setSubmitting(false)
    }
  }

  // Реальные строки техкарты (с ингредиентом/п-ф); пустые строки-плейсхолдеры
  // игнорируем — иначе «Сохранить» серело даже при заполненной техкарте.
  // Весовое сырьё (на развес) техкарты не требует.
  const realTechLines = form.techCard.filter((l) => l.ingredientId || l.semiId)
  const realTechLinesValid = realTechLines.every((l) => l.qty > 0)
  const isWeightItem = form.unit !== 'piece'
  const needTechCard = requireTechCard && !isWeightItem && !form.isPurchased
  // Техкарты по вариантам (per-combo) — та же проверка полноты/валидности,
  // что и у обычной техкарты, но по каждой комбинации атрибутов отдельно.
  const comboTechCardLines = (key: string) => (techCardsByCombo[key] ?? []).filter(l => l.ingredientId || l.semiId)
  const comboTechCardsComplete = combos.every(c => comboTechCardLines(c.key).length > 0)
  const comboTechCardsValid = combos.every(c => comboTechCardLines(c.key).every(l => l.qty > 0))
  // С атрибутами цена товара не задаётся — цены несут значения атрибутов
  // (каждая комбинация должна получиться платной).
  const attrsOk = attrsValid(attrs, comboPrices, form.isPurchased)
  const priceOk = hasAttrs ? attrsOk : form.price > 0
  // С атрибутами закупка тоже на значениях — от товара нужна только единица.
  const purchasedOk = hasAttrs
    ? !!form.purchaseUnit
    : (form.purchasePrice ?? 0) > 0 && !!form.purchaseUnit
  const canSubmit = !!form.name && !!form.category && priceOk && (
    form.isPurchased
      ? purchasedOk
      : hasAttrs
        ? (!needTechCard || comboTechCardsComplete) && comboTechCardsValid
        : needTechCard
          ? realTechLines.length > 0 && realTechLinesValid
          : realTechLinesValid
  )
  const disabledReason = submitting ? ''
    : !form.name ? 'Укажите название'
    : !form.category ? 'Выберите категорию'
    : hasAttrs && !attrsOk ? (
        !attrsComplete(attrs) ? 'Заполните названия атрибутов и значений'
        : combosCount(attrs) > MAX_COMBOS ? 'Слишком много комбинаций атрибутов'
        : combosOf(attrs).some(c => !((comboPrices[c.key]?.price ?? 0) > 0)) ? 'Укажите цену (> 0) у каждого варианта'
        : 'Укажите закупку (> 0) у каждого варианта'
      )
    : !hasAttrs && !(form.price > 0) ? 'Укажите цену больше 0'
    : form.isPurchased && !purchasedOk ? (hasAttrs ? 'Выберите единицу закупки' : 'Заполните закупочную цену и единицу')
    : hasAttrs && needTechCard && !comboTechCardsComplete ? 'Добавьте хотя бы один ингредиент в техкарту каждого варианта'
    : hasAttrs && !comboTechCardsValid ? 'Укажите количество (> 0) во всех строках техкарты вариантов'
    : !hasAttrs && needTechCard && realTechLines.length === 0 ? 'Добавьте хотя бы один ингредиент в техкарту'
    : !hasAttrs && !realTechLinesValid ? 'Укажите количество (> 0) во всех строках техкарты'
    : ''

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
            onClick={() => navigate('/warehouse/menu')}
            className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:bg-muted px-2.5 py-1.5 rounded-lg transition-colors"
          >
            <ArrowLeft className="size-4" />
            <span>Назад</span>
          </button>
          <h1 className="flex-1 text-base md:text-lg font-bold text-foreground truncate">
            Новое блюдо
          </h1>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            title={disabledReason || undefined}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            <CheckCircle className="size-4" />
            {submitting ? 'Сохранение...' : 'Добавить блюдо'}
          </button>
        </div>
        {!canSubmit && disabledReason && (
          <div className="px-4 md:px-6 pb-2 -mt-1 text-xs font-medium text-amber-600">Нельзя сохранить: {disabledReason}</div>
        )}
      </div>

      {/* Main Body */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 p-4 md:p-6 max-w-7xl mx-auto w-full">
        {/* Left Column - Main Info */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
            <h2 className="text-sm font-bold text-foreground">Основная информация</h2>

            {/* Photo Upload */}
            <div className="flex items-start gap-4 p-3 rounded-lg bg-muted/20 border border-border/50">
              <DishImageUpload
                imageUrl={form.imageUrl}
                emoji={form.emoji || undefined}
                onImageUploaded={(url) => setForm((p) => ({ ...p, imageUrl: url }))}
              />
              <div className="text-xs text-muted-foreground pt-1.5 space-y-0.5">
                <p className="font-semibold text-foreground">Фото блюда</p>
                <p>Нажмите чтобы загрузить. Если нет фото — отобразится эмодзи.</p>
              </div>
            </div>

            {/* Name & Category */}
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="text-xs font-semibold text-muted-foreground mb-1 block">Название</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Например, Плов с говядиной"
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground mb-1 block">Категория</label>
                <div className="flex items-center gap-1.5">
                  <select
                    value={form.category}
                    onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}
                    className="flex-1 min-w-0 px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
                  >
                    <option value="">Выберите категорию</option>
                    {menuCategories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <button
                    type="button"
                    onClick={() => setCategoriesDialogOpen(true)}
                    title="Новая категория"
                    className="shrink-0 size-9 flex items-center justify-center border border-dashed border-primary/40 text-primary rounded-lg hover:bg-primary/5 transition-colors"
                  >
                    <Plus className="size-4" />
                  </button>
                </div>
              </div>
            </div>
            <ManageCategoriesDialog
              open={categoriesDialogOpen}
              onOpenChange={setCategoriesDialogOpen}
              onCreated={(cat) => {
                setMenuCategories((prev) => prev.some((c) => c.toLocaleLowerCase('ru-RU') === cat.name.toLocaleLowerCase('ru-RU')) ? prev : [...prev, cat.name].sort((a, b) => a.localeCompare(b, 'ru')))
                setForm((p) => ({ ...p, category: cat.name }))
                setCategoriesDialogOpen(false)
              }}
            />

            {/* Price & CookTime. С атрибутами своей цены нет — цены на значениях. */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-muted-foreground mb-1 block">
                  {form.unit === 'g' ? 'Цена за 100г' : 'Цена продажи'}
                </label>
                {hasAttrs ? (
                  <div className="w-full px-3 py-2 text-xs bg-muted/30 border border-dashed border-border rounded-lg text-muted-foreground">
                    Задаётся атрибутами →
                  </div>
                ) : (
                  <DecimalInput
                    value={form.price}
                    onChange={(v) => setForm((p) => ({ ...p, price: v }))}
                    min={0}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
                  />
                )}
              </div>
              {!form.isPurchased ? (
                <div>
                  <label className="text-xs font-semibold text-muted-foreground mb-1 block flex items-center gap-1">
                    <Timer className="size-3.5 text-muted-foreground" /> Готовность (мин)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={form.cookTimeMin ?? ''}
                    onChange={(e) => setForm((p) => ({ ...p, cookTimeMin: e.target.value ? parseInt(e.target.value) : null }))}
                    placeholder="Например, 15"
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
                  />
                </div>
              ) : (
                <div>
                  <label className="text-xs font-semibold text-muted-foreground mb-1 block">Доступно</label>
                  <button
                    type="button"
                    onClick={() => setForm((p) => ({ ...p, isAvailable: !p.isAvailable }))}
                    className={`w-full px-3 py-2 text-sm font-semibold rounded-lg border transition-colors ${form.isAvailable ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : 'bg-background border-border text-muted-foreground'}`}
                  >
                    {form.isAvailable ? 'Да' : 'Нет'}
                  </button>
                </div>
              )}
            </div>

            {!form.isPurchased && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground mb-1 block">Себестоимость вручную</label>
                  <DecimalInput
                    value={form.cogs}
                    onChange={(v) => setForm((p) => ({ ...p, cogs: v }))}
                    min={0}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground mb-1 block">Доступно</label>
                  <button
                    type="button"
                    onClick={() => setForm((p) => ({ ...p, isAvailable: !p.isAvailable }))}
                    className={`w-full px-3 py-2 text-sm font-semibold rounded-lg border transition-colors ${form.isAvailable ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : 'bg-background border-border text-muted-foreground'}`}
                  >
                    {form.isAvailable ? 'Да' : 'Нет'}
                  </button>
                </div>
              </div>
            )}

            {/* Station */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground block">Рабочая станция</label>
              <div className="grid grid-cols-5 gap-1.5">
                {(form.isPurchased ? (['bar', 'showcase'] as const) : ALL_STATIONS).map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setForm((p) => ({ ...p, station: s }))}
                    className={`flex flex-col items-center gap-1 py-2 rounded-lg border transition-all ${form.station === s ? 'border-primary bg-primary/5 text-primary ring-2 ring-primary/20' : 'border-border hover:border-muted-foreground/30 text-foreground bg-background'}`}
                  >
                    <span className="text-lg">{STATION_ICONS[s]}</span>
                    <span className="text-[9px] font-bold leading-tight">{STATION_LABELS[s]}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Switch Toggles */}
            <div className="space-y-2 pt-2 border-t border-border">
              {/* Покупной товар доступен всегда (не зависит от учёта по техкартам):
                  бэк сам заводит складской ингредиент. Раньше галочка пропадала
                  при выключенных техкартах. */}
              <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-muted/10">
                <div>
                  <p className="text-xs font-semibold text-foreground">Покупной товар</p>
                  <p className="text-[10px] text-muted-foreground">Продается как есть, без техкарты</p>
                </div>
                <button
                  type="button"
                  // Дефолт единицы закупки «шт.» — чтобы пустой селект не блокировал сохранение.
                  onClick={() => setForm(p => ({ ...p, isPurchased: !p.isPurchased, isBatchCooking: false, station: !p.isPurchased ? 'showcase' : p.station, purchaseUnit: p.purchaseUnit || 'шт.' }))}
                  className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-2 ${form.isPurchased ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform ${form.isPurchased ? 'translate-x-5' : ''}`} />
                </button>
              </div>

              <div className="px-3 py-2.5 rounded-lg border border-border bg-muted/10">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold text-foreground">Заготовочное блюдо</p>
                    <p className="text-[10px] text-muted-foreground">{techCardsEnabled ? 'Готовится партиями' : 'Счётчик порций'}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setForm(p => ({ ...p, isBatchCooking: !p.isBatchCooking, isPurchased: false }))}
                    className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-2 ${form.isBatchCooking ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform ${form.isBatchCooking ? 'translate-x-5' : ''}`} />
                  </button>
                </div>
                {form.isBatchCooking && (
                  <div className="mt-2 pt-2 border-t border-border/50 flex items-center gap-2 justify-between">
                    <label className="text-[10px] text-muted-foreground font-medium">Порог «заканчивается» (порц.)</label>
                    <input
                      type="number"
                      min={1}
                      max={999}
                      value={form.lowStockThreshold ?? 5}
                      onChange={e => setForm(p => ({ ...p, lowStockThreshold: Math.max(1, Number(e.target.value) || 5) }))}
                      className="w-16 px-2 py-1 text-xs text-center bg-background border border-border rounded-md"
                    />
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-muted/10">
                <div>
                  <p className="text-xs font-semibold text-foreground">Весовой товар</p>
                  <p className="text-[10px] text-muted-foreground">Продажа на вес в граммах</p>
                </div>
                <button
                  type="button"
                  onClick={() => setForm(p => ({ ...p, unit: p.unit === 'g' ? 'piece' : 'g', unitSize: p.unit === 'g' ? 1 : 100, saleStep: p.unit === 'g' ? 0 : 50 }))}
                  className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-2 ${form.unit === 'g' ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform ${form.unit === 'g' ? 'translate-x-5' : ''}`} />
                </button>
              </div>

              {inNetwork && !hasAttrs && (
                <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-muted/10">
                  <div className="flex items-start gap-2">
                    <Network className="size-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <div>
                      <p className="text-xs font-semibold text-foreground">Блюдо сети</p>
                      <p className="text-[10px] text-muted-foreground">Появится в меню всех филиалов сети</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsNetworkDish(v => !v)}
                    className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-2 ${isNetworkDish ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform ${isNetworkDish ? 'translate-x-5' : ''}`} />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column - Tech Card or Purchase Fields */}
        <div className="lg:col-span-7 space-y-6">
          {form.isPurchased ? (
            /* Purchased fields */
            <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
              <h2 className="text-sm font-bold text-foreground flex items-center gap-1.5">
                Закупочные данные
              </h2>
              <div className="grid grid-cols-3 gap-3 bg-blue-50/50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/40 p-4 rounded-lg">
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-muted-foreground block">Цена закупки</label>
                  {hasAttrs ? (
                    <div className="w-full px-3 py-1.5 text-xs bg-muted/30 border border-dashed border-border rounded-lg text-muted-foreground">
                      Задаётся атрибутами ↓
                    </div>
                  ) : (
                    <DecimalInput
                      value={form.purchasePrice || 0}
                      onChange={v => setForm(p => ({ ...p, purchasePrice: v, cogs: v }))}
                      min={0}
                      placeholder="0"
                      className="w-full px-3 py-1.5 text-sm bg-background border border-border rounded-lg"
                    />
                  )}
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-muted-foreground block">Ед. измерения</label>
                  <select
                    value={form.purchaseUnit || ''}
                    onChange={e => setForm(p => ({ ...p, purchaseUnit: e.target.value }))}
                    className="w-full px-3 py-1.5 text-sm bg-background border border-border rounded-lg"
                  >
                    <option value="">Выберите</option>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-muted-foreground block">Мин. остаток</label>
                  <DecimalInput
                    value={form.purchaseMinQty || 0}
                    onChange={v => setForm(p => ({ ...p, purchaseMinQty: v }))}
                    min={0}
                    placeholder="0"
                    className="w-full px-3 py-1.5 text-sm bg-background border border-border rounded-lg"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground bg-muted/20 border border-border/50 p-3 rounded-lg leading-relaxed">
                Система автоматически создаст ингредиент на складе с аналогичным названием и привяжет его к этому товару. Приход этого товара будет осуществляться через накладные.
              </p>
            </div>
          ) : techCardsEnabled && !hasAttrs ? (
            /* Tech Card — только без атрибутов; с атрибутами техкарта
               задаётся отдельно по каждой комбинации ниже (не дважды). */
            <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-foreground">Техкарта и ингредиенты</h2>
                <span className="text-xs text-muted-foreground font-semibold bg-muted px-2.5 py-1 rounded-full">
                  Ингредиентов: {form.techCard.filter(l => l.ingredientId || l.semiId).length}
                </span>
              </div>

              <TechCardLinesEditor
                lines={form.techCard}
                onChange={(next) => setForm((p) => ({ ...p, techCard: next }))}
                ingredients={ingredients}
                semiTypes={semiTypes}
                onQuickCreate={(name, idx) => {
                  setQuickCreateName(name)
                  setQuickCreateTargetIndex(idx)
                  setQuickCreateComboTarget(null)
                  setQuickCreateOpen(true)
                }}
              />
            </div>
          ) : null}

          {/* Атрибуты (Размер/Вкус): цены задаются на значениях, варианты
              генерирует бэк сразу после создания товара. */}
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
            <h2 className="text-sm font-bold text-foreground flex items-center gap-1.5">
              <Layers className="size-4 text-primary" />
              Атрибуты и варианты
            </h2>
            {!hasAttrs && (
              <p className="text-xs text-muted-foreground leading-relaxed">
                Один товар в нескольких размерах или вкусах? Добавьте атрибут
                (например «Размер»: 1 л / 1.5 л) и укажите цену каждого значения —
                система сама создаст варианты{form.isPurchased ? ' с отдельным складским учётом' : ''}.
                На кассе будет одна карточка товара с выбором.
              </p>
            )}
            <AttributesForm attrs={attrs} onChange={setAttrs} />
            <ComboPricesEditor attrs={attrs} prices={comboPrices} onChange={setComboPrices} showPurchase={form.isPurchased} />
            {hasAttrs && (
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                Укажите цену каждого варианта{form.isPurchased ? ' и его закупку — у каждого будет свой складской товар' : ''}.
                Варианты появятся после сохранения товара.
              </p>
            )}
          </div>

          {/* Техкарты по вариантам — заполняются ДО сохранения (варианты ещё
              не существуют на бэке): один раз, отдельно на каждую комбинацию
              атрибутов, без промежуточной «общей» техкарты товара. */}
          {!form.isPurchased && techCardsEnabled && hasAttrs && combos.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-foreground">Техкарты по вариантам</h2>
                <span className="text-xs text-muted-foreground font-semibold bg-muted px-2.5 py-1 rounded-full">
                  Ингредиентов: {comboTechCardLines(activeComboKey).length}
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                У каждого размера/вкуса — своя техкарта: граммовки не масштабируются
                линейно, задайте их отдельно для каждого варианта.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {combos.map(c => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setSelectedComboKey(c.key)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${activeComboKey === c.key
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-muted/30 border-border text-foreground hover:bg-muted'}`}
                  >
                    {c.title}
                  </button>
                ))}
              </div>
              <TechCardLinesEditor
                lines={techCardsByCombo[activeComboKey] ?? [{ ...emptyTechLine }]}
                onChange={next => setTechCardsByCombo(prev => ({ ...prev, [activeComboKey]: next }))}
                ingredients={ingredients}
                semiTypes={semiTypes}
                matchingSemiIds={activeComboMatchingSemiIds}
                onQuickCreate={(name, idx) => {
                  setQuickCreateName(name)
                  setQuickCreateComboTarget({ comboKey: activeComboKey, index: idx })
                  setQuickCreateTargetIndex(null)
                  setQuickCreateOpen(true)
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Dialog for Quick Ingredient Creation */}
      <Dialog open={quickCreateOpen} onOpenChange={setQuickCreateOpen}>
        <DialogContent className="sm:max-w-md rounded-xl z-[60]">
          <DialogHeader>
            <DialogTitle>Создать новый продукт</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleQuickCreateIngredient} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-semibold text-foreground">Название</label>
              <input
                type="text"
                required
                value={quickCreateName}
                onChange={(e) => setQuickCreateName(e.target.value)}
                placeholder="Например, Картофель свежий"
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground">Ед. измерения</label>
                <select
                  value={newIngUnit}
                  onChange={(e) => setNewIngUnit(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  {['кг', 'г', 'л', 'мл', 'шт', 'порц', 'бут', 'пач'].map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
              
              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground">Категория</label>
                <input
                  type="text"
                  value={newIngCategory}
                  onChange={(e) => setNewIngCategory(e.target.value)}
                  placeholder="Продукты"
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-semibold text-foreground">Тип товара</label>
              <div className="flex gap-2">
                {(
                  [
                    { v: true, label: 'Продукт / ингредиент' },
                    { v: false, label: 'Хозтовары / другое' },
                  ] as { v: boolean; label: string }[]
                ).map((t) => (
                  <button
                    key={t.label}
                    type="button"
                    onClick={() => setNewIngIsFood(t.v)}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                      newIngIsFood === t.v
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-border text-foreground hover:bg-muted'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground">Мин. остаток</label>
                <DecimalInput
                  min={0}
                  value={newIngMinQty}
                  onChange={(v) => setNewIngMinQty(v)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground">Закупочная цена</label>
                <DecimalInput
                  min={0}
                  value={newIngPrice}
                  onChange={(v) => setNewIngPrice(v)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>

            <DialogFooter className="pt-2">
              <button
                type="button"
                onClick={() => setQuickCreateOpen(false)}
                className="px-4 py-2 text-sm font-semibold text-foreground bg-background border border-border rounded-lg hover:bg-muted transition-colors"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={creatingIngredient || !quickCreateName.trim()}
                className="px-4 py-2 text-sm font-semibold text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
              >
                {creatingIngredient ? 'Создание...' : 'Создать и добавить'}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
