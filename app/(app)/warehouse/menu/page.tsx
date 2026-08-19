'use client'

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { dDiv, dMul, dRound, dSub } from '@/lib/decimal'
import { type MenuItem, type MenuStation, type TechCardLine, type Ingredient, type SemiFinishedType, STATION_LABELS, STATION_ICONS, ALL_STATIONS } from '@/lib/types'
import { fetchMenuItems, toggleMenuAvailability, updateMenuItem, fetchMenuCategories, syncMenuCategoriesFromItems, deleteMenuItem, archiveMenuItem, fetchStopList, toggleStopListOverride, fetchIngredients, fetchSemiTypes, replaceTechCardLines, recomputeMenuCogs } from '@/lib/queries'
import { Search, ChevronRight, BookOpen, Pencil, OctagonX, ShieldCheck, Ruler, Tags, Trash2, Check, RefreshCw } from 'lucide-react'
import { DishImage } from '@/components/dish-image'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'
import { useDataSync } from '@/hooks/use-data-sync'
import { ManageSizeScalesDialog } from '@/components/dialogs/manage-size-scales-dialog'
import { ManageCategoriesDialog } from '@/components/dialogs/manage-categories-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { DecimalInput } from '@/components/ui/decimal-input'
import { TechCardLinesEditor, emptyTechLine } from '@/components/menu/tech-card-lines-editor'

export default function MenuPage() {
  const navigate = useNavigate()
  const { canDo } = useAuth()
  const canSeeFinancials = canDo('menu.view_cost')
  const canEdit = canDo('menu.edit')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [station, setStation] = useState<'all' | MenuStation>('all')
  const [actionItem, setActionItem] = useState<MenuItem | null>(null)
  const [quickPrice, setQuickPrice] = useState<number>(0)
  const [savingPrice, setSavingPrice] = useState(false)
  const [deletingItem, setDeletingItem] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  // Инлайн-правка техкарты прямо из карточки — без перехода в полный
  // редактор. Справочники (ingredients/semiTypes) тянутся лениво при первом
  // тапе «Редактировать» за сессию и кэшируются в state — action-sheet сам
  // по себе новых запросов не делает (techCard уже есть в it из списка).
  const [editingTechCard, setEditingTechCard] = useState(false)
  const [techCardLines, setTechCardLines] = useState<TechCardLine[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [semiTypes, setSemiTypes] = useState<SemiFinishedType[]>([])
  const [refsLoaded, setRefsLoaded] = useState(false)
  const [loadingRefs, setLoadingRefs] = useState(false)
  const [savingTechCard, setSavingTechCard] = useState(false)
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [menuCategories, setMenuCategories] = useState<string[]>([])
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const [sizeScalesOpen, setSizeScalesOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [recomputingCogs, setRecomputingCogs] = useState(false)
  const [tab, setTab] = useState<'menu' | 'stoplist'>('menu')
  const [stopList, setStopList] = useState<{ menuItemId: string; menuItemName: string; emoji: string; category: string; ingredients: { name: string; qty: number; minQty: number; unit: string }[]; manual?: boolean; unavailable?: boolean }[]>([])

  const reloadAll = async () => {
    // Load independently — if one fails, others still work
    fetchMenuItems().then(setMenuItems).catch(() => {})
    fetchMenuCategories().then(setMenuCategories).catch(() => {})
    // Синхронизируем записи категорий из блюд (для «старых» импортов без записей),
    // чтобы у чипов категорий появились id и работало управление через диалог.
    syncMenuCategoriesFromItems().catch(() => {})
    fetchStopList().then(setStopList).catch(() => {})
  }

  useEffect(() => {
    reloadAll().finally(() => setLoading(false))
  }, [])

  // SSE-driven auto-refresh при изменении меню (другой кассир добавил позицию,
  // менеджер обновил техкарту, и т.п.). 'ingredients' — себестоимость блюда
  // зависит от цены ингредиента; без подписки открытая страница не узнавала
  // бы о её смене, пока не перезайти.
  useDataSync(['menu_items', 'menu_categories', 'tech_card_lines', 'ingredients'], () => { reloadAll().catch(console.error) })

  async function handleRecomputeCogs() {
    if (recomputingCogs) return
    setRecomputingCogs(true)
    try {
      const n = await recomputeMenuCogs()
      await reloadAll()
      toast.success(n > 0 ? `Себестоимость пересчитана: обновлено ${n}` : 'Себестоимость уже актуальна')
    } catch (e) {
      toast.error(humanizeError(e, 'Не удалось пересчитать себестоимость'))
    } finally {
      setRecomputingCogs(false)
    }
  }

  async function handleToggleAvailability(id: string) {
    const item = menuItems.find((m) => m.id === id)
    if (!item) return
    const newVal = !item.isAvailable
    setMenuItems((prev) => prev.map((m) => m.id === id ? { ...m, isAvailable: newVal } : m))
    setActionItem((a) => a && a.id === id ? { ...a, isAvailable: newVal } : a)
    try {
      await toggleMenuAvailability(id, newVal)
    } catch {
      // revert on error
      setMenuItems((prev) => prev.map((m) => m.id === id ? { ...m, isAvailable: !newVal } : m))
      setActionItem((a) => a && a.id === id ? { ...a, isAvailable: !newVal } : a)
    }
  }

  function openSheet(item: MenuItem) {
    setActionItem(item)
    setQuickPrice(item.price)
    setEditingTechCard(false)
  }

  // Тап «Редактировать» у техкарты в карточке — справочники грузятся один
  // раз за сессию страницы (refsLoaded), сами строки уже есть в it.techCard.
  function startEditTechCard(it: MenuItem) {
    setTechCardLines(it.techCard.length > 0 ? it.techCard : [{ ...emptyTechLine }])
    setEditingTechCard(true)
    if (!refsLoaded) {
      setLoadingRefs(true)
      Promise.all([fetchIngredients(), fetchSemiTypes()])
        .then(([i, s]) => { setIngredients(i); setSemiTypes(s); setRefsLoaded(true) })
        .catch(() => toast.error('Не удалось загрузить справочники ингредиентов'))
        .finally(() => setLoadingRefs(false))
    }
  }

  async function handleSaveTechCard() {
    if (!actionItem || savingTechCard) return
    const validLines = techCardLines.filter((l) => l.ingredientId || l.semiId)
    setSavingTechCard(true)
    try {
      await replaceTechCardLines(actionItem.id, validLines)
      setMenuItems((prev) => prev.map((m) => m.id === actionItem.id ? { ...m, techCard: validLines } : m))
      setActionItem((a) => a ? { ...a, techCard: validLines } : a)
      setEditingTechCard(false)
      toast.success('Техкарта сохранена')
    } catch (e) {
      toast.error(humanizeError(e, 'Не удалось сохранить техкарту'))
    } finally {
      setSavingTechCard(false)
    }
  }

  // Быстрая правка цены прямо из карточки-листа — без захода в полный редактор.
  async function handleQuickPriceSave() {
    if (!actionItem || savingPrice || quickPrice === actionItem.price) return
    setSavingPrice(true)
    try {
      await updateMenuItem(actionItem.id, { price: quickPrice })
      setMenuItems((prev) => prev.map((m) => m.id === actionItem.id ? { ...m, price: quickPrice } : m))
      setActionItem((a) => a ? { ...a, price: quickPrice } : a)
      toast.success('Цена обновлена')
    } catch (e) {
      toast.error(humanizeError(e, 'Не удалось обновить цену'))
    } finally {
      setSavingPrice(false)
    }
  }

  async function handleDeleteItem() {
    if (!actionItem || deletingItem) return
    setDeletingItem(true)
    try {
      await deleteMenuItem(actionItem.id)
      setMenuItems((prev) => prev.filter((m) => m.id !== actionItem.id))
      setDeleteConfirmOpen(false)
      setActionItem(null)
      toast.success('Блюдо удалено')
    } catch (e) {
      toast.error(humanizeError(e, 'Не удалось удалить — возможно, есть история заказов'))
    } finally {
      setDeletingItem(false)
    }
  }

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  // Варианты (parentId) скрыты из списка — они управляются из карточки
  // продукта (Атрибуты и варианты). Показываем только продукты/блюда.
  const products = menuItems.filter((m) => !m.parentId)
  const variantCountByParent = new Map<string, number>()
  const variantsByParent = new Map<string, MenuItem[]>()
  for (const m of menuItems) {
    if (m.parentId) {
      variantCountByParent.set(m.parentId, (variantCountByParent.get(m.parentId) ?? 0) + 1)
      variantsByParent.set(m.parentId, [...(variantsByParent.get(m.parentId) ?? []), m])
    }
  }

  // Продукт с атрибутами не имеет своей цены (item.price всегда 0) — цену
  // несут варианты. Показываем диапазон вместо буквального нуля.
  function priceLabel(item: MenuItem): string {
    const variants = variantsByParent.get(item.id)
    if (!variants || variants.length === 0) return formatCurrency(item.price)
    const prices = variants.map((v) => v.price)
    const min = Math.min(...prices)
    const max = Math.max(...prices)
    return min === max ? formatCurrency(min) : `от ${formatCurrency(min)}`
  }

  const filtered = products.filter((m) => {
    const matchSearch = m.name.toLowerCase().includes(search.toLowerCase())
    const matchCat = category === 'all' || m.category === category
    const matchStation = station === 'all' || m.station === station
    return matchSearch && matchCat && matchStation
  })

  // Per-station counters for the station tab badges.
  const stationCounts: Record<MenuStation | 'all', number> = {
    all: products.length,
    hot_kitchen: 0, cold_kitchen: 0, grill: 0, bar: 0, showcase: 0,
  }
  for (const m of products) stationCounts[m.station] = (stationCounts[m.station] ?? 0) + 1

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4 md:space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Меню и техкарты</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{products.length} позиций{stopList.length > 0 ? ` · ${stopList.length} в стоп-листе` : ''}</p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2 w-full sm:w-auto">
            {canSeeFinancials && (
              <button
                onClick={handleRecomputeCogs}
                disabled={recomputingCogs}
                title="Пересчитать себестоимость всех блюд по тех-картам и текущим ценам ингредиентов"
                className="flex items-center gap-2 bg-card border border-border text-foreground px-3 py-2.5 rounded-xl text-sm font-medium hover:bg-muted disabled:opacity-60 transition-colors justify-center"
              >
                <RefreshCw className={`size-4 ${recomputingCogs ? 'animate-spin' : ''}`} />
                {recomputingCogs ? 'Считаем…' : 'Пересчитать с/с'}
              </button>
            )}
            <button
              onClick={() => navigate('/warehouse/menu/new')}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex-1 sm:flex-none justify-center"
            >
              + Добавить блюдо
            </button>
          </div>
        )}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 bg-muted/50 p-1 rounded-xl w-fit">
        <button
          onClick={() => setTab('menu')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${tab === 'menu' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <BookOpen className="size-3.5" />Меню
          <span className="bg-muted px-1.5 py-0.5 rounded text-[10px] font-bold">{products.length}</span>
        </button>
        <button
          onClick={() => setTab('stoplist')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${tab === 'stoplist' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <OctagonX className="size-3.5" />Стоп-лист
          {stopList.length > 0 && (
            <span className="bg-destructive/10 text-destructive px-1.5 py-0.5 rounded text-[10px] font-bold">{stopList.length}</span>
          )}
        </button>
      </div>

      {tab === 'stoplist' ? (
        /* Stop-list view */
        <div className="space-y-3">
          {stopList.length === 0 ? (
            <div className="bg-card rounded-xl border border-border p-8 text-center">
              <ShieldCheck className="size-10 text-emerald-500/40 mx-auto mb-3" />
              <p className="font-medium text-foreground">Стоп-лист пуст</p>
              <p className="text-sm text-muted-foreground mt-1">Все ингредиенты в наличии</p>
            </div>
          ) : (
            stopList.map(item => {
              const menuItem = menuItems.find(m => m.id === item.menuItemId)
              const isOverridden = menuItem?.stopListOverride ?? false
              // Блюдо вручную снято с меню галочкой СТОП (is_available=false).
              const isUnavailable = item.unavailable ?? false
              return (
                <div key={item.menuItemId} className={`bg-card rounded-xl border-2 p-4 ${isUnavailable ? 'border-red-300/60' : isOverridden ? 'border-amber-300/50' : 'border-destructive/30'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground">{item.menuItemName}</span>
                        <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">{item.category}</span>
                        {isUnavailable && (
                          <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded font-medium">СТОП вручную</span>
                        )}
                        {!isUnavailable && isOverridden && (
                          <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded font-medium">Override</span>
                        )}
                      </div>
                      <div className="mt-2 space-y-1">
                        {isUnavailable && item.ingredients.length === 0 && (
                          <p className="text-sm text-muted-foreground">Снято с меню вручную — недоступно в ПОС.</p>
                        )}
                        {item.ingredients.map((ing, idx) => (
                          <div key={idx} className="flex items-center gap-2 text-sm">
                            <OctagonX className="size-3 text-destructive shrink-0" />
                            <span className="text-foreground">{ing.name}</span>
                            <span className="text-destructive font-medium">{formatNum(ing.qty)} {ing.unit}</span>
                            <span className="text-xs text-muted-foreground">(мин. {ing.minQty})</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {canEdit && (
                      isUnavailable ? (
                        <button
                          onClick={async () => {
                            await toggleMenuAvailability(item.menuItemId, true)
                            await reloadAll()
                            toast.success('Блюдо возвращено в меню')
                          }}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 transition-colors shrink-0"
                        >
                          Вернуть в меню
                        </button>
                      ) : (
                        <button
                          onClick={async () => {
                            await toggleStopListOverride(item.menuItemId, !isOverridden)
                            await reloadAll()
                            toast.success(isOverridden ? 'Override снят' : 'Блюдо принудительно включено')
                          }}
                          className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors shrink-0 ${
                            isOverridden
                              ? 'bg-destructive/10 text-destructive border-destructive/30 hover:bg-destructive/20'
                              : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                          }`}
                        >
                          {isOverridden ? 'Вернуть в стоп' : 'Включить'}
                        </button>
                      )
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      ) : (
      <>
      {/* Station tabs — крупные пилюли с иконкой и счётчиком. */}
      <div className="flex flex-wrap gap-1.5 items-center bg-muted/30 p-1.5 rounded-2xl">
        <button
          onClick={() => setStation('all')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-all ${
            station === 'all'
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <span>Все</span>
          <span className="bg-muted px-1.5 py-0.5 rounded-md text-[10px] font-bold tabular-nums">{stationCounts.all}</span>
        </button>
        {ALL_STATIONS.map(s => {
          const count = stationCounts[s] || 0
          const active = station === s
          return (
            <button
              key={s}
              onClick={() => setStation(s)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-all ${
                active
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="text-base leading-none">{STATION_ICONS[s]}</span>
              <span>{STATION_LABELS[s]}</span>
              <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold tabular-nums ${active ? 'bg-primary/10 text-primary' : 'bg-muted'}`}>{count}</span>
            </button>
          )
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Поиск блюда..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-4 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 w-52"
          />
        </div>
        <div className="flex flex-wrap gap-1.5 items-center">
          <button
            onClick={() => setCategory('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${category === 'all' ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'}`}
          >
            Все
          </button>
          {menuCategories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${category === c ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'}`}
            >
              {c}
            </button>
          ))}
          {canEdit && (
            <button
              onClick={() => setCategoriesOpen(true)}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-border text-foreground hover:bg-muted transition-colors flex items-center gap-1.5"
              title="Управление категориями (добавить, переименовать, удалить)"
            >
              <Tags className="size-3.5" />
              Категории
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => setSizeScalesOpen(true)}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-border text-foreground hover:bg-muted transition-colors flex items-center gap-1.5"
              title="Шкалы размеров (25/30/35 см и т.п.)"
            >
              <Ruler className="size-3.5" />
              Шкалы размеров
            </button>
          )}
        </div>
      </div>
      <ManageCategoriesDialog
        open={categoriesOpen}
        onOpenChange={setCategoriesOpen}
        onChanged={(cats) => {
          // Записи категорий не обязаны быть уникальны по имени (диалог
          // умышленно допускает дубли-по-имени как отдельные редактируемые
          // строки — полезно как раз чтобы их слить/удалить), а вот чипы
          // фильтра — плоские строки, дубль имени здесь ломает React key.
          const seen = new Set<string>()
          const names: string[] = []
          for (const c of cats) {
            const key = c.name.toLocaleLowerCase('ru-RU')
            if (seen.has(key)) continue
            seen.add(key)
            names.push(c.name)
          }
          names.sort((a, b) => a.localeCompare(b, 'ru'))
          setMenuCategories(names)
          if (category !== 'all' && !cats.some(c => c.name === category)) setCategory('all')
        }}
      />
      <ManageSizeScalesDialog open={sizeScalesOpen} onOpenChange={setSizeScalesOpen} />

      {/* Card Grid view for waiter/cook/cashier */}
      {!canSeeFinancials && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {filtered.map((item) => (
            <div
              key={item.id}
              className={`relative bg-card rounded-xl border border-border overflow-hidden transition-all hover:shadow-md ${!item.isAvailable ? 'opacity-50' : ''}`}
            >
              {/* Image / Emoji */}
              <div className="aspect-square bg-muted/30 flex items-center justify-center overflow-hidden">
                <DishImage imageUrl={item.imageUrl} emoji={item.emoji} name={item.name} size="fill" />
              </div>

              {item.masterId && <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 bg-primary/90 text-primary-foreground rounded text-[10px] font-medium">из сети</span>}
              {/* Info */}
              <div className="p-3">
                <p className="font-semibold text-foreground text-sm truncate">
                  {item.name}
                  {(variantCountByParent.get(item.id) ?? 0) > 0 && (
                    <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded font-medium align-middle">{variantCountByParent.get(item.id)} вар.</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {item.category}{item.cookTimeMin ? ` · ⏱ ${item.cookTimeMin} мин` : ''}
                  {item.station === 'bar' && <span className="ml-1 text-blue-600">· ☕ Бар</span>}
                  {item.station === 'showcase' && <span className="ml-1 text-amber-600">· 🥟 Витрина</span>}
                </p>
                <div className="flex items-center justify-between mt-2">
                  <p className="text-base font-bold text-primary">{priceLabel(item)}</p>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${item.isAvailable ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                    {item.isAvailable ? 'В наличии' : 'СТОП'}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* List view for manager/accountant/storekeeper/owner — тап открывает
          карточку блюда (техкарта, быстрая цена, действия) */}
      {canSeeFinancials && (
        <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
          {filtered.map((item) => (
            <div
              key={item.id}
              onClick={() => openSheet(item)}
              className="flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-muted/30 cursor-pointer transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <DishImage imageUrl={item.imageUrl} emoji={item.emoji} name={item.name} size="sm" />
                <div className="min-w-0">
                  <p className="font-medium text-foreground text-sm flex items-center gap-1.5">
                    <span className="truncate">{item.name}</span>
                    {item.masterId && <span className="shrink-0 px-1.5 py-0.5 bg-primary/10 text-primary rounded text-[10px] font-medium">из сети</span>}
                    {(variantCountByParent.get(item.id) ?? 0) > 0 && (
                      <span className="shrink-0 text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded font-medium">{variantCountByParent.get(item.id)} вар.</span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {item.category} · {item.techCard.length} ингр.{item.cookTimeMin ? ` · ⏱ ${item.cookTimeMin} мин` : ''}
                    {item.isBatchCooking && <span className="ml-1 px-1.5 py-0.5 bg-amber-100 dark:bg-amber-500/15 text-amber-700 rounded text-[10px] font-medium">Заготовка · {item.preparedQty} порц.</span>}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <div className="text-right">
                  <p className="text-sm font-semibold text-foreground tabular-nums">{priceLabel(item)}</p>
                  <p className="text-xs text-muted-foreground">
                    {variantsByParent.has(item.id)
                      ? 'с/с: по вариантам'
                      : `с/с ${formatCurrency(item.cogs)} · ${item.price > 0 ? dRound(dMul(dDiv(item.cogs, item.price), 100), 0) : 0}%`}
                  </p>
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleToggleAvailability(item.id) }}
                    title={item.isAvailable ? 'В наличии — нажмите, чтобы поставить на стоп' : 'СТОП — нажмите, чтобы вернуть'}
                    className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 shrink-0 ${item.isAvailable ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`}
                  >
                    <span className={`absolute top-[2px] left-[2px] size-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 ${item.isAvailable ? 'translate-x-[18px]' : 'translate-x-0'}`} />
                  </button>
                ) : (
                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${item.isAvailable ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                    {item.isAvailable ? 'В наличии' : 'СТОП'}
                  </span>
                )}
                <ChevronRight className="size-4 text-muted-foreground shrink-0" />
              </div>
            </div>
          ))}
        </div>
      )}

      </>
      )}

      {/* Карточка блюда — тап по строке: техкарта, быстрая цена, действия */}
      <Dialog open={!!actionItem} onOpenChange={(v) => { if (!v) { setActionItem(null); setEditingTechCard(false) } }}>
        <DialogContent className="sm:max-w-lg rounded-xl max-h-[88vh] overflow-y-auto">
          {actionItem && (() => {
            const it = actionItem
            const hasVariants = variantsByParent.has(it.id)
            const margin = it.price > 0 ? dRound(dMul(dDiv(dSub(it.price, it.cogs), it.price), 100), 0) : 0
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2.5">
                    <DishImage imageUrl={it.imageUrl} emoji={it.emoji} name={it.name} size="sm" />
                    <span className="truncate">{it.name}</span>
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-3 py-1">
                  {/* Инфо-чипы */}
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="px-2 py-0.5 rounded bg-muted text-foreground/70 font-medium">{it.category}</span>
                    <span className="px-2 py-0.5 rounded bg-muted text-foreground/70 font-medium">{STATION_LABELS[it.station] ?? it.station}</span>
                    {it.cookTimeMin ? <span className="px-2 py-0.5 rounded bg-muted text-foreground/70 font-medium">⏱ {it.cookTimeMin} мин</span> : null}
                    <span className={`px-2 py-0.5 rounded font-medium ${it.isAvailable ? 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-500' : 'bg-red-100 dark:bg-red-500/15 text-destructive'}`}>
                      {it.isAvailable ? 'В наличии' : 'СТОП'}
                    </span>
                  </div>

                  {/* Быстрая правка цены (без вариантов) */}
                  {!hasVariants && canEdit ? (
                    <div className="rounded-lg border border-border p-3 space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">Цена продажи</label>
                      <div className="flex items-center gap-2">
                        <DecimalInput
                          value={quickPrice}
                          min={0}
                          onChange={setQuickPrice}
                          className="flex-1 h-11 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                        <Button
                          type="button"
                          size="touch"
                          onClick={handleQuickPriceSave}
                          disabled={savingPrice || quickPrice === it.price}
                        >
                          <Check className="size-4" />
                          {savingPrice ? '…' : 'Сохранить'}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        с/с {formatCurrency(it.cogs)} · маржа <span className="text-emerald-600 font-medium">{margin}%</span>
                      </p>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between rounded-lg border border-border p-3">
                      <span className="text-sm text-muted-foreground">Цена</span>
                      <span className="text-base font-bold text-primary">{priceLabel(it)}</span>
                    </div>
                  )}

                  {/* Техкарта — без вариаций правится прямо здесь, с вариациями
                      (VariantTechCardsEditor per-размер) остаётся read-only,
                      «Править» ведёт в полный редактор. */}
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <BookOpen className="size-4 text-primary" />
                        <p className="text-sm font-semibold text-foreground">Техкарта</p>
                        <span className="text-xs text-muted-foreground">
                          ({editingTechCard ? techCardLines.filter((l) => l.ingredientId || l.semiId).length : it.techCard.length})
                        </span>
                      </div>
                      {!hasVariants && canEdit && !editingTechCard && (
                        <button
                          type="button"
                          onClick={() => startEditTechCard(it)}
                          className="flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                        >
                          <Pencil className="size-3.5" />
                          Редактировать
                        </button>
                      )}
                    </div>
                    {editingTechCard ? (
                      loadingRefs ? (
                        <div className="flex justify-center py-6">
                          <div className="size-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <TechCardLinesEditor
                            lines={techCardLines}
                            onChange={setTechCardLines}
                            ingredients={ingredients}
                            semiTypes={semiTypes}
                            onIngredientCreated={(ing) => setIngredients((prev) => [...prev, ing])}
                          />
                          <div className="flex items-center gap-2 justify-end">
                            <Button
                              type="button"
                              size="touch"
                              variant="outline"
                              onClick={() => setEditingTechCard(false)}
                            >
                              Отмена
                            </Button>
                            <Button
                              type="button"
                              size="touch"
                              onClick={handleSaveTechCard}
                              disabled={savingTechCard}
                            >
                              <Check className="size-4" />
                              {savingTechCard ? 'Сохранение...' : 'Сохранить техкарту'}
                            </Button>
                          </div>
                        </div>
                      )
                    ) : it.techCard.length === 0 ? (
                      <p className="text-xs text-muted-foreground px-1 py-2">
                        {!hasVariants && canEdit ? 'Техкарта пуста — нажмите «Редактировать», чтобы добавить ингредиенты.' : 'Техкарта пуста.'}
                      </p>
                    ) : (
                      <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                        {it.techCard.map((line, i) => (
                          <div key={i} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`size-1.5 rounded-full shrink-0 ${line.semiId ? 'bg-primary' : 'bg-muted-foreground'}`} />
                              <span className="text-foreground truncate">{line.name}</span>
                              {line.semiId && <span className="text-[10px] bg-primary/10 text-primary px-1.5 rounded shrink-0">п/ф</span>}
                            </div>
                            <span className="text-muted-foreground tabular-nums whitespace-nowrap">{formatNum(line.qty)} {line.unit}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <DialogFooter className="flex-col-reverse sm:flex-row sm:justify-between gap-2">
                  {canEdit && (
                    <Button
                      type="button"
                      size="touch"
                      variant="ghost"
                      onClick={() => setDeleteConfirmOpen(true)}
                      disabled={deletingItem}
                      className="justify-center text-destructive bg-destructive/10 hover:bg-destructive/15 hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                      Удалить
                    </Button>
                  )}
                  <div className="flex gap-2">
                    {canEdit && (
                      <Button
                        type="button"
                        size="touch"
                        variant="outline"
                        onClick={() => handleToggleAvailability(it.id)}
                      >
                        <OctagonX className="size-4" />
                        {it.isAvailable ? 'На стоп' : 'Снять стоп'}
                      </Button>
                    )}
                    {canEdit && (
                      <Button
                        type="button"
                        size="touch"
                        onClick={() => navigate(`/warehouse/menu/${it.id}`)}
                      >
                        <Pencil className="size-4" />
                        Править
                      </Button>
                    )}
                  </div>
                </DialogFooter>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={(o) => { if (!o) setDeleteConfirmOpen(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить блюдо?</AlertDialogTitle>
            <AlertDialogDescription>
              «{actionItem?.name}» будет удалено безвозвратно.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={cn(buttonVariants({ variant: 'outline', size: 'touch' }))}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteItem}
              disabled={deletingItem}
              className={cn(buttonVariants({ size: 'touch' }), 'bg-destructive text-white hover:bg-destructive/90')}
            >
              {deletingItem ? 'Удаление...' : 'Удалить'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
