'use client'

import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Trash2, Timer, ArrowLeft, CheckCircle, Archive, Network, Plus } from 'lucide-react'
import { DishImageUpload } from '@/components/dish-image'
import {
  UNITS,
  ALL_STATIONS, STATION_LABELS, STATION_ICONS,
  type TechCardLine,
  type Ingredient,
  type SemiFinishedType,
  type SemiFinishedStock,
  type MenuItem,
  type MenuStation,
  type MenuAttribute,
} from '@/lib/types'
import { fetchIngredients, fetchSemiTypes, fetchSemiStock, fetchMenuCategories, fetchMenuItems, updateMenuItem, deleteMenuItem, archiveMenuItem, createIngredient, previewTechCardCogs } from '@/lib/queries'
import { createNetworkMenuItem, updateNetworkMenuItem } from '@/lib/queries/transfers'
import { useNetworkStatus } from '@/hooks/use-network-status'
import { DecimalInput } from '@/components/ui/decimal-input'
import { useAuth } from '@/lib/auth-store'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'
import { AttributesEditor } from '@/components/menu/attributes-editor'
import { VariantTechCardsEditor } from '@/components/menu/variant-tech-cards-editor'
import { TechCardLinesEditor, emptyTechLine } from '@/components/menu/tech-card-lines-editor'
import { ManageCategoriesDialog } from '@/components/dialogs/manage-categories-dialog'
import { BundleSlotsEditor } from '@/components/menu/bundle-slots-editor'

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
  isBundle?: boolean
  unit: 'piece' | 'g' | 'kg'
  unitSize: number
  saleStep: number
  techCard: TechCardLine[]
}

// ─── Page Component ──────────────────────────────────────────────────────────
export default function EditMenuItemPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { restaurant, canDo } = useAuth()
  const canEdit = canDo('menu.edit')
  const techCardsEnabled = restaurant?.techCardsEnabled ?? true
  // Техкарта обязательна только в строгом режиме (техкарты + контроль остатков).
  const enforceStockCheck = restaurant?.enforceStockCheck ?? false
  const requireTechCard = techCardsEnabled && enforceStockCheck

  const [menuItem, setMenuItem] = useState<MenuItem | null>(null)
  // У продукта с атрибутами нет собственной цены — её несут значения
  // атрибутов (AttributesEditor сообщает через onHasAttributesChange).
  const [hasAttributes, setHasAttributes] = useState(false)
  // Атрибуты/цены вариантов сохраняются отдельной кнопкой («Сохранить
  // варианты») — «Сохранить изменения» их не трогает. Без этого флага
  // человек печатает цены, жмёт привычную верхнюю кнопку и молча теряет
  // правки: форма уходит на /warehouse/menu, AttributesEditor размонтируется.
  const [attrsDirty, setAttrsDirty] = useState(false)
  // Живые варианты продукта + их атрибуты — для «Техкарты по вариантам»
  // (independent от AttributesEditor: та же PUT /attributes-эндпойнт, но
  // отдельный fetch проще, чем поднимать состояние наверх через колбэк).
  const [variantAttributes, setVariantAttributes] = useState<MenuAttribute[]>([])
  const [productVariants, setProductVariants] = useState<MenuItem[]>([])
  // «Блюдо сети»: уже привязанные (masterId) — держим мастер в синхроне на
  // каждое сохранение, без тумблера (см. handleSubmit). Ещё не привязанные —
  // тумблер, скрыт для вариативных товаров (NetworkMenuItem без атрибутов).
  const { inNetwork } = useNetworkStatus()
  const [isNetworkDish, setIsNetworkDish] = useState(false)
  // Полный список меню — нужен BundleSlotsEditor (поиск компонентов сета).
  const [allMenuItems, setAllMenuItems] = useState<MenuItem[]>([])
  const [form, setForm] = useState<MenuItemForm>({
    name: '',
    category: '',
    price: 0,
    emoji: '',
    cogs: 0,
    cookTimeMin: null,
    station: 'hot_kitchen',
    isAvailable: true,
    lowStockThreshold: 5,
    unit: 'piece',
    unitSize: 1,
    saleStep: 0,
    techCard: [{ ...emptyTechLine }],
  })

  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [semiTypes, setSemiTypes] = useState<SemiFinishedType[]>([])
  const [semiStock, setSemiStock] = useState<SemiFinishedStock[]>([])
  const [menuCategories, setMenuCategories] = useState<string[]>([])
  const [categoriesDialogOpen, setCategoriesDialogOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    Promise.all([fetchIngredients(), fetchSemiTypes(), fetchSemiStock(), fetchMenuCategories(), fetchMenuItems()])
      .then(([i, s, ss, c, items]) => {
        setIngredients(i)
        setSemiTypes(s)
        setSemiStock(ss)
        setMenuCategories(c)
        setAllMenuItems(items)
        const found = items.find((item) => item.id === id)
        if (found) {
          setMenuItem(found)
          // Стор-флаг (бэк), с фолбэком на старую эвристику для блюд, созданных
          // до появления поля is_purchased.
          const isPurchased = found.isPurchased ?? (found.station === 'showcase' && found.techCard.length === 1 && found.techCard[0].qty === 1)
          const backing = isPurchased && found.techCard[0]?.ingredientId ? i.find(x => x.id === found.techCard[0].ingredientId) : undefined
          setForm({
            name: found.name,
            category: found.category,
            price: found.price,
            emoji: found.emoji,
            imageUrl: found.imageUrl,
            cogs: found.cogs,
            cookTimeMin: found.cookTimeMin ?? null,
            station: found.station || 'hot_kitchen',
            isAvailable: found.isAvailable,
            isBatchCooking: found.isBatchCooking ?? false,
            lowStockThreshold: found.lowStockThreshold ?? 5,
            isPurchased,
            purchasePrice: backing?.pricePerUnit ?? found.cogs,
            purchaseUnit: backing?.unit ?? found.techCard[0]?.unit ?? '',
            purchaseMinQty: backing?.minQty ?? 0,
            isBundle: found.isBundle ?? false,
            unit: found.unit || 'piece',
            unitSize: found.unitSize ?? 1,
            saleStep: found.saleStep ?? 0,
            techCard: found.techCard.length > 0 ? [...found.techCard] : [{ ...emptyTechLine }],
          })
        } else {
          toast.error('Блюдо не найдено')
          navigate('/warehouse/menu')
        }
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [id])

  const handleSubmit = async () => {
    if (!menuItem || submitting) return
    // Цены вариантов сохраняются отдельно (кнопка «Сохранить варианты» в
    // блоке атрибутов). Эта кнопка их не отправляет — уйти со страницы сейчас
    // значит молча потерять введённые цены.
    if (attrsDirty) {
      toast.error('Сначала сохраните варианты (кнопка «Сохранить варианты» в блоке атрибутов) — иначе введённые цены потеряются')
      return
    }
    setSubmitting(true)
    try {
      // Покупной товар целиком ведёт бэк: по is_purchased + purchase_* он сам
      // создаёт/обновляет складской ингредиент (0 остаток) + 1:1 техкарту +
      // станцию showcase. Фронт лишь передаёт поля формы.
      await updateMenuItem(menuItem.id, form)
      // Сеть: уже привязанное блюдо держим в синхроне (только наследуемые
      // поля — цену мастера трогать нельзя, её задаёт каждый филиал у себя,
      // см. applyNetworkMenu). Ещё не привязанное — создаём мастер по тумблеру.
      if (menuItem.masterId) {
        try {
          await updateNetworkMenuItem(menuItem.masterId, {
            name: form.name, category: form.category, station: form.station,
            unit: form.unit, emoji: form.emoji,
          })
        } catch {
          toast.error('Блюдо обновлено локально, но не синхронизировалось с мастером сети')
        }
      } else if (isNetworkDish && !hasAttributes && !menuItem.parentId) {
        try {
          const master = await createNetworkMenuItem({
            name: form.name, category: form.category, basePrice: form.price,
            station: form.station, unit: form.unit, emoji: form.emoji,
          })
          await updateMenuItem(menuItem.id, { masterId: master.id })
          setMenuItem(prev => prev ? { ...prev, masterId: master.id } : prev)
        } catch {
          toast.error('Блюдо обновлено, но не удалось сделать его сетевым — привяжите вручную позже')
        }
      }
      toast.success('Блюдо обновлено')
      navigate('/warehouse/menu')
    } catch {
      toast.error('Ошибка при обновлении блюда')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!menuItem) return
    if (!window.confirm('Вы действительно хотите удалить это блюдо? Это действие необратимо.')) return
    try {
      await deleteMenuItem(menuItem.id)
      toast.success('Блюдо удалено')
      navigate('/warehouse/menu')
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка при удалении блюда'))
    }
  }

  const handleArchive = async () => {
    if (!menuItem) return
    if (!window.confirm('Архивировать это блюдо? Оно исчезнет из активного меню.')) return
    try {
      await archiveMenuItem(menuItem.id)
      toast.success('Блюдо архивировано')
      navigate('/warehouse/menu')
    } catch {
      toast.error('Ошибка при архивировании блюда')
    }
  }

  // Реальные строки техкарты (с ингредиентом/п-ф). ПУСТЫЕ строки-плейсхолдеры
  // (по умолчанию форма держит одну) игнорируем — иначе «Сохранить» залипало
  // серым даже при заполненной техкарте: `.every()` падал на пустой строке.
  const alreadyLinked = !!menuItem?.masterId
  const realTechLines = form.techCard.filter((l) => l.ingredientId || l.semiId)
  const realTechLinesValid = realTechLines.every((l) => l.qty > 0)
  // Живой предпросмотр себестоимости по введённым строкам — только подсказка,
  // настоящую себестоимость посчитает и запишет бэк при сохранении тех-карты.
  const techCardPreviewCogs = previewTechCardCogs(form.techCard, ingredients, semiStock)
  // Весовое сырьё (на развес) продаётся по весу и НЕ требует техкарты-рецепта.
  const isWeightItem = form.unit !== 'piece'
  const needTechCard = requireTechCard && !isWeightItem && !form.isPurchased && !form.isBundle
  // С атрибутами цена и закупка живут на значениях атрибутов.
  const purchasedOk = hasAttributes
    ? !!form.purchaseUnit
    : (form.purchasePrice ?? 0) > 0 && !!form.purchaseUnit
  const canSubmit = !!form.name && !!form.category && (hasAttributes || form.price > 0) && (
    form.isPurchased
      ? purchasedOk
      : needTechCard
        ? realTechLines.length > 0 && realTechLinesValid
        : realTechLinesValid
  )
  // Почему «Сохранить» недоступно — показываем явно (раньше кнопка просто серая).
  const disabledReason = submitting ? ''
    : !form.name ? 'Укажите название'
    : !form.category ? 'Выберите категорию'
    : !hasAttributes && !(form.price > 0) ? 'Укажите цену больше 0'
    : form.isPurchased && !purchasedOk ? (hasAttributes ? 'Выберите единицу закупки' : 'Заполните закупочную цену и единицу')
    : needTechCard && realTechLines.length === 0 ? 'Добавьте хотя бы один ингредиент в техкарту'
    : !realTechLinesValid ? 'Укажите количество (> 0) во всех строках техкарты'
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
            Редактирование: <span className="text-primary">{menuItem?.name}</span>
          </h1>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            title={disabledReason || undefined}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            <CheckCircle className="size-4" />
            {submitting ? 'Сохранение...' : 'Сохранить изменения'}
          </button>
        </div>
        {!canSubmit && disabledReason && (
          <div className="px-4 md:px-6 pb-2 -mt-1 text-xs font-medium text-amber-600">Нельзя сохранить: {disabledReason}</div>
        )}
        {attrsDirty && (
          <div className="px-4 md:px-6 pb-2 -mt-1 text-xs font-medium text-amber-600">
            Есть несохранённые цены вариантов — нажмите «Сохранить варианты» в блоке атрибутов, иначе они потеряются.
          </div>
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
                {hasAttributes ? (
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
                  {realTechLines.length > 0 && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Из тех-карты ниже: ≈{techCardPreviewCogs.toFixed(2)} — при сохранении заменит это поле
                    </p>
                  )}
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
              {/* Покупной товар доступен всегда (не зависит от учёта по техкартам). */}
              <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-muted/10">
                <div>
                  <p className="text-xs font-semibold text-foreground">Покупной товар</p>
                  <p className="text-[10px] text-muted-foreground">Продается как есть, без техкарты</p>
                </div>
                <button
                  type="button"
                  onClick={() => setForm(p => ({ ...p, isPurchased: !p.isPurchased, isBatchCooking: false, isBundle: false, station: !p.isPurchased ? 'showcase' : p.station, purchaseUnit: p.purchaseUnit || 'шт.' }))}
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
                    onClick={() => setForm(p => ({ ...p, isBatchCooking: !p.isBatchCooking, isPurchased: false, isBundle: false }))}
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

              {/* Сет — фастфуд-комбо из настоящих пунктов меню (слоты ниже). */}
              <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-muted/10">
                <div>
                  <p className="text-xs font-semibold text-foreground">Сет (комбо)</p>
                  <p className="text-[10px] text-muted-foreground">Собран из других блюд — своя техкарта не нужна</p>
                </div>
                <button
                  type="button"
                  onClick={() => setForm(p => ({ ...p, isBundle: !p.isBundle, isPurchased: false, isBatchCooking: false }))}
                  className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-2 ${form.isBundle ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform ${form.isBundle ? 'translate-x-5' : ''}`} />
                </button>
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

              {inNetwork && (
                alreadyLinked ? (
                  <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-primary/20 bg-primary/5">
                    <Network className="size-3.5 text-primary shrink-0" />
                    <div>
                      <p className="text-xs font-semibold text-primary">Блюдо сети — привязано</p>
                      <p className="text-[10px] text-muted-foreground">Название/категория/станция/ед. синхронизируются с мастером при сохранении</p>
                    </div>
                  </div>
                ) : !hasAttributes && !menuItem?.parentId ? (
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
                ) : null
              )}
            </div>

            {/* Actions for delete/archive */}
            {canEdit && (
              <div className="flex gap-2 pt-4 border-t border-border">
                <button
                  type="button"
                  onClick={handleArchive}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors"
                >
                  <Archive className="size-3.5" />
                  Архивировать
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-destructive bg-destructive/10 hover:bg-destructive/20 border border-destructive/20 rounded-lg transition-colors"
                >
                  <Trash2 className="size-3.5" />
                  Удалить блюдо
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right Column - Tech Card or Purchase Fields */}
        <div className="lg:col-span-7 space-y-6">
          {form.isBundle && menuItem ? (
            <BundleSlotsEditor bundleMenuItemId={menuItem.id} menuItems={allMenuItems} />
          ) : form.isPurchased ? (
            /* Purchased fields */
            <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
              <h2 className="text-sm font-bold text-foreground flex items-center gap-1.5">
                Закупочные данные
              </h2>
              <div className="grid grid-cols-3 gap-3 bg-blue-50/50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/40 p-4 rounded-lg">
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-muted-foreground block">Цена закупки</label>
                  {hasAttributes ? (
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
                Покупной товар. Приёмка и списание осуществляются через накладные и складские операции.
              </p>
            </div>
          ) : techCardsEnabled ? (
            /* Tech Card */
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
                onIngredientCreated={(ing) => setIngredients((prev) => [...prev, ing])}
              />
            </div>
          ) : null}

          {/* Атрибуты (Размер/Вкус) — только у продукта-родителя, не у варианта. */}
          {menuItem && !menuItem.parentId && !form.isBundle && (
            <AttributesEditor
              productId={menuItem.id}
              isPurchased={form.isPurchased}
              onHasAttributesChange={setHasAttributes}
              onDirtyChange={setAttrsDirty}
              onVariantsChange={(attrs, variants) => { setVariantAttributes(attrs); setProductVariants(variants) }}
              onEnsurePurchased={async () => {
                // Конвертация в покупной ещё не сохранена на бэке (тумблер
                // переключён, но «Сохранить изменения» не нажимали) → делаем
                // это ПЕРЕД синком вариантов, иначе бэк отбросит закупку по
                // вариациям. Реюзаем handleSubmit-payload (form целиком).
                if (form.isPurchased && menuItem && !menuItem.isPurchased) {
                  await updateMenuItem(menuItem.id, form)
                  setMenuItem({ ...menuItem, isPurchased: true })
                }
              }}
            />
          )}

          {/* Техкарта по размерам/вкусам — своя граммовка у каждого варианта. */}
          {menuItem && !menuItem.parentId && techCardsEnabled && !form.isPurchased && !form.isBundle && productVariants.length > 0 && (
            <VariantTechCardsEditor
              variants={productVariants}
              ingredients={ingredients}
              semiTypes={semiTypes}
              productAttributes={variantAttributes}
            />
          )}
        </div>
      </div>
    </div>
  )
}
